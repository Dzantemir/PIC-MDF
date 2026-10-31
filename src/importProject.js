'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// importProject.js — "PIC: Import Project…". Since 0.4.1 it runs through the menu
// (QuickPick + native dialogs — the avr-mdf / sdcc-mdf way); the old webview page
// ("PIC-MDF — Import Project", media/importProject.html) is gone.
//
//   1. what to import (MPLAB X project / Makefile / plain folder)  — QuickPick
//   2. pick the folder / file                                       — native dialog
//   3. analysis (+ MCU pick when the device has no definition)      — QuickPick
//   4. overwrite guard, review of the draft, write, adopt           — modal / QuickPick
//
// Sources the importer understands:
//   • MPLAB X project  nbproject/configurations.xml — device, language
//                      toolchain (XC8 / XC16 / XC32 / XC-DSC), programmer tool,
//                      source + header items, include directories, macros,
//                      optimization level
//   • Makefile         -mcpu / -mprocessor, compiler driver name, -I / -D / -O,
//                      source file tokens
//   • any folder       a plain scan (src/, include/, source files, headers)
//
// Design rules:
//   1. IMPORT IN PLACE — only pic-project.json is written, next to the
//      original project. Nothing is moved, copied or deleted.
//   2. BEST-EFFORT AND HONEST — everything that was guessed, skipped or
//      rewritten is listed in `notes` and shown in the review step before anything
//      is written. The MCU is only pre-selected when it matches a definition.
//   3. NEVER A SILENT OVERWRITE — an existing pic-project.json is replaced
//      only after a modal confirmation.
//   4. VALIDATE BEFORE WRITING — the draft goes through the same validator the
//      Project Editor uses.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Boards = require('./boards');
const Validator = require('./validator');

const SRC_RE  = /\.(?:c|cc|cpp|cxx|s|asm)$/i;
const HDR_RE  = /\.(?:h|hpp|hh|inc)$/i;
const LIB_RE  = /\.a$/i;
const SKIP_DIRS = /^(?:\.|build$|dist$|out$|nbproject$|node_modules$|_build$|debug$|release$|objs?$)/i;
const MAX_FILE = 2 * 1024 * 1024;

// ─── small helpers ───────────────────────────────────────────────────────────
function readText(file) {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) throw new Error(`${path.basename(file)} is too large or not a file`);
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}
function decodeXml(s) {
    return String(s == null ? '' : s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}
function firstTag(block, tag) {
    const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(block || '');
    return m ? decodeXml(m[1].trim()) : '';
}
function allTags(block, tag) {
    const out = [];
    const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'gi');
    let m; while ((m = re.exec(block || ''))) out.push(decodeXml(m[1].trim()));
    return out;
}
function attrs(tagText) {
    const out = {};
    const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let m; while ((m = re.exec(tagText))) out[m[1]] = decodeXml(m[2]);
    return out;
}
function dedupe(a) { return [...new Set(a)]; }
function posix(p) { return String(p).replace(/\\/g, '/'); }
function splitList(v) {
    return String(v || '').split(/;|\r?\n/).map(s => s.trim()).filter(Boolean);
}
// project-relative when inside the root, absolute otherwise (same rule as the Project Editor)
function portable(root, abs) {
    const a = path.resolve(abs);
    const rel = path.relative(root, a);
    if (rel === '') return '.';
    if (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    return a.split(path.sep).join('/');
}
function resolveFrom(base, p) {
    const q = posix(p).replace(/^["']|["']$/g, '');
    return path.resolve(base, q);
}
function sanitizeName(raw, fallback) {
    let s = String(raw || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
    if (!s) s = String(fallback || 'imported-project').replace(/[^A-Za-z0-9_-]+/g, '-');
    if (!/^[A-Za-z]/.test(s)) s = 'pic-' + s;
    if (s.length > 64) s = s.slice(0, 64);
    return s;
}

// ─── device name → MCU definition ────────────────────────────────────────────
// MPLAB X writes "PIC18F4550" / "dsPIC33EP512MU810"; Makefiles often carry the
// bare "18F4550" / "33EP512MU810" (XC8 / XC16 -mcpu=) or "32MX795F512L" (XC32).
function deviceVariants(hint) {
    const h = String(hint || '').trim();
    if (!h) return [];
    const v = [h];
    if (/^(?:10|12|16|18)[A-Za-z]/.test(h)) v.push('PIC' + h);
    else if (/^24[A-Za-z]/.test(h)) v.push('PIC' + h);
    else if (/^(?:30|33)[A-Za-z]/.test(h)) v.push('dsPIC' + h);
    else if (/^32[A-Za-z]/.test(h)) v.push('PIC' + h);
    return v;
}
const normId = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function matchBoard(hint) {
    const boards = Boards.allBoards();
    const variants = deviceVariants(hint).map(normId).filter(Boolean);
    for (const h of variants) {
        const hit = boards.find(b => normId(b.id) === h || normId(b.name) === h || (b.build && normId(b.build.device) === h));
        if (hit) return { board: hit, exact: true };
    }
    // unique partial match only (e.g. "PIC18F4550-I/P" or a package suffix)
    for (const h of variants) {
        if (h.length < 6) continue;
        const hits = boards.filter(b => {
            const id = normId(b.id);
            return id.length >= 6 && (h.startsWith(id) || id.startsWith(h));
        });
        if (hits.length === 1) return { board: hits[0], exact: false };
    }
    return { board: null, exact: false };
}
function toolchainFromName(s) {
    const t = String(s || '').toLowerCase();
    if (/xc-?dsc/.test(t)) return 'xcdsc';
    if (/xc32|pic32/.test(t)) return 'xc32';
    if (/xc16/.test(t)) return 'xc16';
    if (/xc8|pic-as|hi-tech/.test(t)) return 'xc8';
    return '';
}

// ─── programmer tool (MPLAB X platformTool) → pic-mdf upload recipe ──────────
function programmerFor(platformTool) {
    const t = String(platformTool || '').toLowerCase();
    if (!t) return null;
    if (/pickit\s*5|pk5/.test(t))  return { programmer: 'ipecmd', hardware: 'PK5' };
    if (/pickit\s*4|pk4/.test(t))  return { programmer: 'ipecmd', hardware: 'PK4' };
    if (/pickit\s*3|pk3/.test(t))  return { programmer: 'pk3cmd', hardware: 'PK3' };
    if (/pickit\s*2|pk2/.test(t))  return { programmer: 'pk2cmd', hardware: 'PK2' };
    if (/snap/.test(t))            return { programmer: 'ipecmd', hardware: 'SNAP' };
    if (/icd\s*5/.test(t))         return { programmer: 'ipecmd', hardware: 'ICD5' };
    if (/icd\s*4/.test(t))         return { programmer: 'ipecmd', hardware: 'ICD4' };
    if (/icd\s*3/.test(t))         return { programmer: 'ipecmd', hardware: 'ICD3' };
    if (/real\s*ice|rice/.test(t)) return { programmer: 'ipecmd', hardware: 'RICE' };
    return null;   // Simulator, third-party tools …
}

// ─── MPLAB X: nbproject/configurations.xml ───────────────────────────────────
function findMplabProject(root) {
    const has = d => fs.existsSync(path.join(d, 'nbproject', 'configurations.xml'));
    if (has(root)) return { dir: root, others: [] };
    const found = [];
    const walk = (d, depth) => {
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (!e.isDirectory() || (SKIP_DIRS.test(e.name) && !/\.X$/i.test(e.name))) continue;
            const sub = path.join(d, e.name);
            if (has(sub)) found.push(sub);
            else if (depth < 2) walk(sub, depth + 1);
            if (found.length >= 12) return;
        }
    };
    walk(root, 1);
    found.sort((a, b) => (/\.X$/i.test(b) ? 1 : 0) - (/\.X$/i.test(a) ? 1 : 0));
    return found.length ? { dir: found[0], others: found.slice(1) } : null;
}

function parseConfigurations(xml) {
    const confRe = /<conf\s+([^>]*)>([\s\S]*?)<\/conf>/gi;
    const confs = [];
    let m;
    while ((m = confRe.exec(xml))) confs.push({ name: attrs(m[1]).name || '', body: m[2] });
    // top-level items (outside <confs>): logical folders + itemPath entries
    const top = xml.replace(/<confs>[\s\S]*<\/confs>/i, '');
    const itemPaths = allTags(top, 'itemPath');
    const roots = allTags(top, 'Elem');
    const conf = confs[0] || { name: '', body: xml };
    // per-file <item …> blocks hold per-file overrides — they must not feed the project-wide settings
    const projectLevel = conf.body.replace(/<item\b[^>]*?\/>/gi, '').replace(/<item\b[\s\S]*?<\/item>/gi, '');
    const excluded = new Set();
    const itemRe = /<item\b([^>]*)>/gi;
    while ((m = itemRe.exec(conf.body))) {
        const a = attrs(m[1]);
        if (a.path && String(a.ex).toLowerCase() === 'true') excluded.add(posix(a.path));
    }
    const props = [];
    const propRe = /<property\b([^>]*?)\/?>/gi;
    while ((m = propRe.exec(projectLevel))) {
        const a = attrs(m[1]);
        if (a.key) props.push({ key: a.key, value: a.value || '' });
    }
    return {
        confNames: confs.map(c => c.name),
        confName: conf.name,
        device: firstTag(projectLevel, 'targetDevice'),
        platformTool: firstTag(projectLevel, 'platformTool'),
        language: firstTag(projectLevel, 'languageToolchain'),
        languageVersion: firstTag(projectLevel, 'languageToolchainVersion'),
        packs: [...projectLevel.matchAll(/<pack\b([^>]*)\/?>/gi)].map(x => attrs(x[1]).name).filter(Boolean),
        props, itemPaths, roots, excluded,
    };
}

function analyzeMplab(dir, notes, others) {
    const xml = readText(path.join(dir, 'nbproject', 'configurations.xml'));
    const c = parseConfigurations(xml);
    if (others && others.length) notes.push(`${others.length + 1} MPLAB X projects found under the chosen folder — importing "${path.basename(dir)}"; the others: ${others.map(o => path.basename(o)).join(', ')}.`);
    if (c.confNames.length > 1) notes.push(`${c.confNames.length} MPLAB X configurations (${c.confNames.join(', ')}) — the first one, "${c.confName}", was read.`);

    // sources / headers / libraries (paths are relative to the project folder, may leave it)
    const missing = [];
    const sources = [], headerDirs = [], libs = [];
    for (const raw of dedupe(c.itemPaths.map(posix))) {
        const abs = resolveFrom(dir, raw);
        if (c.excluded.has(raw)) continue;
        if (SRC_RE.test(raw)) {
            if (fs.existsSync(abs)) sources.push(abs); else missing.push(raw);
        } else if (HDR_RE.test(raw)) {
            if (fs.existsSync(abs)) headerDirs.push(path.dirname(abs));
        } else if (LIB_RE.test(raw)) {
            if (fs.existsSync(abs)) libs.push(abs);
        }
    }
    if (missing.length) notes.push(`${missing.length} source item(s) listed in configurations.xml do not exist on disk and were skipped (e.g. ${missing.slice(0, 3).join(', ')}).`);
    if (c.excluded.size) notes.push(`${c.excluded.size} item(s) excluded from the build in MPLAB X were left out.`);

    // settings (HI-TECH-COMP / C30 / C32 … property keys)
    const incs = [], defs = [], opts = [];
    for (const p of c.props) {
        if (/include-director/i.test(p.key)) incs.push(...splitList(p.value));
        else if (/^(?:define-macros|preprocessor-macros|defines?)$/i.test(p.key)) defs.push(...splitList(p.value));
        else if (/^(?:optimization-level|opt-level)$/i.test(p.key) || /^optimization$/i.test(p.key)) opts.push(p.value);
    }
    const incAbs = dedupe(incs.map(i => resolveFrom(dir, i)));
    const incMissing = incAbs.filter(a => !fs.existsSync(a));
    if (incMissing.length) notes.push(`${incMissing.length} include folder(s) from the MPLAB X settings do not exist and were skipped (${incMissing.slice(0, 3).map(a => portable(dir, a)).join(', ')}).`);
    const includes = dedupe([
        ...incAbs.filter(a => fs.existsSync(a)),
        ...headerDirs,
    ]).map(a => portable(dir, a));
    const defines = dedupe(defs.map(d => d.replace(/^-D\s*/, '').trim()).filter(Boolean));
    let optimization = 'default';
    for (const o of opts) {
        const m2 = /^\s*(?:-O)?\s*([0-3s])\s*$/i.exec(o);
        if (m2) optimization = m2[1].toLowerCase();
    }
    if (c.props.some(p => /\$\{/.test(p.value))) notes.push('Some values contain MPLAB X ${…} variables — they were copied as written; check them in the Project Editor.');

    // toolchain / device / programmer
    let toolchain = toolchainFromName(c.language);
    if (c.language && !toolchain) notes.push(`MPLAB X language toolchain "${c.language}" is not an XC compiler this extension drives — the compiler follows the MCU you pick.`);
    const prog = programmerFor(c.platformTool);
    if (c.platformTool && !prog) notes.push(`Debug/programming tool "${c.platformTool}" has no ipecmd mapping — left on ipecmd; set the tool in the Project Editor.`);
    if (c.languageVersion) notes.push(`MPLAB X used ${c.language || 'the compiler'} ${c.languageVersion}.`);
    if (c.packs.length) notes.push(`Device pack(s) used by MPLAB X: ${c.packs.join(', ')} (pic-mdf fetches the matching DFP itself).`);
    if (c.roots.length) notes.push('Source root list found — files are imported as the explicit items MPLAB X builds.');
    notes.push('Sources are imported as explicit files, exactly the set MPLAB X builds. Replace them by a folder to pick up new files automatically.');

    return {
        device: c.device, toolchain,
        sourceFiles: sources, includes, defines, libraries: libs.map(a => portable(dir, a)),
        optimization, programmer: prog,
    };
}

// ─── Makefile ────────────────────────────────────────────────────────────────
function findMakefile(dir) {
    for (const n of ['Makefile', 'makefile', 'GNUmakefile']) {
        const f = path.join(dir, n);
        if (fs.existsSync(f)) return f;
    }
    return null;
}
function analyzeMakefile(dir, file, notes) {
    let text = readText(file);
    text = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map(l => l.replace(/(^|\s)#.*$/, '$1')).join('\n');
    const device = (/-m(?:cpu|processor)[= ]\s*([A-Za-z0-9_-]+)/.exec(text) || [])[1]
        || (/^\s*(?:MCU|MMCU|DEVICE|CHIP|PART|PROC|PROCESSOR|TARGET_DEVICE)\s*[:?+]?=\s*(\S+)/mi.exec(text) || [])[1] || '';
    const toolchain = toolchainFromName(((/\b(xc-?dsc[\w-]*|xc32[\w-]*|xc16[\w-]*|xc8[\w-]*|pic-as)\b/i.exec(text)) || [])[1] || '');
    const tokens = text.split(/\s+/).filter(Boolean);
    const includes = [], defines = [], srcs = [];
    let opt = 'default';
    const strip = t => t.replace(/^["']|["']$/g, '');
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        let m;
        if ((m = /^-I(.*)$/.exec(t))) { const v = strip(m[1] || tokens[++i] || ''); if (v && !/\$[({]/.test(v)) includes.push(v); }
        else if ((m = /^-D(.*)$/.exec(t))) { const v = strip(m[1] || tokens[++i] || ''); if (v && !/\$[({]/.test(v)) defines.push(v); }
        else if ((m = /^-O([0-3s])$/.exec(t))) opt = m[1];
        else if (SRC_RE.test(t) && !/[$%*()=]/.test(t)) srcs.push(strip(t));
    }
    const sourceFiles = [];
    for (const s of dedupe(srcs)) {
        const abs = resolveFrom(dir, s);
        if (fs.existsSync(abs)) sourceFiles.push(abs);
    }
    notes.push('Makefile read as text (variables and conditionals are not evaluated) — check the result.');
    return {
        device, toolchain, sourceFiles,
        includes: dedupe(includes.map(i => resolveFrom(dir, i)).filter(a => fs.existsSync(a)).map(a => portable(dir, a))),
        defines: dedupe(defines), libraries: [], optimization: opt, programmer: null,
    };
}

// ─── plain folder scan ───────────────────────────────────────────────────────
function scanFolder(dir) {
    const sourceDirs = new Set(), headerDirs = new Set(), topSources = [];
    let count = 0;
    const walk = (d, depth) => {
        if (count > 5000 || depth > 5) return;
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) walk(p, depth + 1); }
            else if (SRC_RE.test(e.name)) { count++; if (d === dir) topSources.push(p); else sourceDirs.add(path.relative(dir, d).split(path.sep)[0]); }
            else if (HDR_RE.test(e.name)) headerDirs.add(d);
        }
    };
    walk(dir, 0);
    const sources = [];
    if (fs.existsSync(path.join(dir, 'src')) && sourceDirs.has('src')) sources.push('src');
    else for (const d of [...sourceDirs].sort()) sources.push(d);
    for (const f of topSources) sources.push(path.basename(f));
    const includes = [];
    for (const n of ['include', 'inc', 'includes']) if (fs.existsSync(path.join(dir, n))) includes.push(n);
    for (const d of [...headerDirs].slice(0, 8)) { const r = portable(dir, d); if (r !== '.' && !includes.includes(r)) includes.push(r); }
    return { sources, includes, count };
}
function listSourceFiles(dir, rules) {
    // count + preview of what the (folder / file) rules will compile
    const files = [];
    const walk = (d, depth) => {
        if (files.length > 5000 || depth > 8) return;
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) walk(p, depth + 1); }
            else if (SRC_RE.test(e.name)) files.push(p);
        }
    };
    for (const r of rules) {
        const abs = resolveFrom(dir, typeof r === 'string' ? r : (r && r.path) || '');
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.isDirectory()) walk(abs, 0); else if (SRC_RE.test(abs)) files.push(abs);
    }
    return dedupe(files);
}

// ─── the analysis ────────────────────────────────────────────────────────────
// opts.kind: 'auto' (MPLAB X, then a Makefile, then the folder) | 'mplab' | 'makefile' | 'folder'
// opts.makefile: the Makefile to read (any file name) when kind is 'makefile'
function analyze(rootIn, opts = {}) {
    const kind = opts.kind || 'auto';
    const notes = [];
    let root = path.resolve(String(rootIn || ''));
    let st; try { st = fs.statSync(root); } catch { throw new Error(`"${rootIn}" does not exist.`); }
    if (st.isFile()) root = path.dirname(root);

    let dir = root, hasMplab = false, hasMakefile = false, data = null;
    const mp = (kind === 'auto' || kind === 'mplab') ? findMplabProject(root) : null;
    if (mp) {
        dir = mp.dir; hasMplab = true;
        data = analyzeMplab(dir, notes, mp.others);
        const mk = findMakefile(dir);
        hasMakefile = !!(mk && !/nbproject[\\/]Makefile-impl\.mk/.test(readText(mk)));
    } else if (kind === 'auto' || kind === 'makefile') {
        const mk = opts.makefile || findMakefile(root);
        if (mk) { hasMakefile = true; data = analyzeMakefile(root, mk, notes); }
    }

    const scan = scanFolder(dir);
    let sources, sourceFiles;
    if (data && data.sourceFiles && data.sourceFiles.length) {
        sourceFiles = data.sourceFiles;
        sources = sourceFiles.map(f => portable(dir, f));
    } else {
        sources = scan.sources;
        sourceFiles = listSourceFiles(dir, sources);
        if (data) notes.push('No source files were found in the project file — the folder was scanned instead.');
        else notes.push(kind === 'folder' ? 'The folder was scanned (sources, headers).' : 'No MPLAB X project or Makefile found — the folder was scanned (sources, headers).');
    }
    const includes = dedupe([...((data && data.includes) || []), ...scan.includes]).filter(i => i !== '.');

    // MCU / toolchain
    const detectedDevice = (data && data.device) || '';
    const mb = detectedDevice ? matchBoard(detectedDevice) : { board: null, exact: false };
    // The compiler is not stored — it follows the MCU (helpers.resolveToolchain).
    if (detectedDevice && !mb.board) notes.push(`Device "${detectedDevice}" has no MCU definition — you pick the MCU in the next step (or add one in MCU Definitions).`);
    else if (mb.board && !mb.exact) notes.push(`Device "${detectedDevice}" was matched to "${mb.board.id}" by name — verify it.`);
    if (!detectedDevice) notes.push('The target device was not found — you pick the MCU in the next step.');
    if (mb.board && data && data.toolchain && mb.board.toolchain && mb.board.toolchain !== data.toolchain) {
        notes.push(`The MCU definition targets ${mb.board.toolchain}, but the imported project used ${data.toolchain} — PIC-MDF always compiles with the compiler of the MCU definition (${mb.board.toolchain}).`);
    }
    const clockDefs = ((data && data.defines) || []).filter(d => /^(?:F_CPU|FCY|_XTAL_FREQ)\b/.test(d));
    if (clockDefs.length) notes.push(`Defines ${clockDefs.join(', ')} were kept; the clock can also be set in the Project Editor ("Clock frequency override").`);

    const draft = {
        name: sanitizeName(path.basename(dir).replace(/\.X$/i, ''), 'pic-project'),
        board: mb.board ? mb.board.id : '',
        sources,
        includes,
        defines: (data && data.defines) || [],
        libraries: (data && data.libraries) || [],
        components: [],
        build: { output_dir: 'build', output_name: 'firmware', optimization: (data && data.optimization) || 'default' },
        upload: Object.assign({ programmer: 'ipecmd' }, (data && data.programmer) || {}),
    };
    const rel = f => portable(dir, f);
    const result = {
        root: dir, draft, hasMplab, hasMakefile,
        sourceCount: sourceFiles.length,
        detectedDevice,
        boardMatched: !!(mb.board && mb.exact),
        notes,
        sourcePreview: sourceFiles.slice(0, 10).map(rel),
        existingProject: fs.existsSync(path.join(dir, Validator.PROJECT_FILE)),
    };
    return result;
}

// ─── the menu flow ───────────────────────────────────────────────────────────
async function cmdImportProject() {
    if (H.checkBusy()) return;
    // the multi-step flow holds the busy latch — a concurrent config write (or a second
    // import) resolving inside this window would be a silent last-writer-wins on
    // pic-project.json. The flow releases the latch right after the draft is written
    // (the Project Editor it opens busy-gates itself); every cancel / error return
    // lands in the finally below.
    H.setBusy('Import');
    try {
        await importProjectFlow();
    } finally {
        if (H.getGlobalBusyName() === 'Import') H.clearBusy();
    }
}

function _summary(proj, result) {
    const board = Boards.getBoard(proj.board);
    const tcId = H.resolveToolchain(proj);
    const Toolchain = require('./toolchain');
    const tcLabel = (Toolchain.TOOLCHAINS[tcId] && Toolchain.TOOLCHAINS[tcId].label) || tcId;
    const list = a => (a || []).map(x => typeof x === 'string' ? x : (x && (x.path || x.file)) || JSON.stringify(x));
    const srcLine = result.sourceCount
        ? `${result.sourceCount} file(s): ${result.sourcePreview.slice(0, 6).join(', ')}${result.sourceCount > 6 ? ', …' : ''}`
        : 'none found — add them in the Component Editor (main)';
    const up = proj.upload || {};
    return [
        `name:     ${proj.name}`,
        `MCU:      ${board ? (board.name || board.id) : proj.board} (${proj.board}) → ${tcLabel}` + (result.detectedDevice ? `   [read from the project: ${result.detectedDevice}]` : ''),
        `sources:  ${srcLine}`,
        list(proj.includes).length ? `includes: ${list(proj.includes).join(', ')}` : null,
        list(proj.defines).length ? `defines:  ${list(proj.defines).join(' ')}` : null,
        list(proj.libraries).length ? `libs:     ${list(proj.libraries).join(', ')}` : null,
        `build:    ${proj.build.output_dir}/${proj.build.output_name}` + (proj.build.optimization ? `, -O${proj.build.optimization}` : ''),
        `upload:   ${up.programmer}${up.hardware ? ' (' + up.hardware + ')' : ''}`,
    ].filter(Boolean).join('\n') + (result.notes.length ? '\n\nNotes:\n• ' + result.notes.join('\n• ') : '');
}

async function importProjectFlow() {
    // Step 1 — what is imported?
    const FORMATS = [
        { id: 'mplab',    label: '$(chip)  MPLAB X project — the .X folder (nbproject)', detail: 'device, compiler, programmer tool, source + header items, include folders, macros, optimization' },
        { id: 'makefile', label: '$(settings-gear)  Makefile', detail: '-mcpu / -mprocessor, -I / -D / -O, source file tokens (variables and conditionals are not evaluated)' },
        { id: 'folder',   label: '$(folder)  Plain folder', detail: 'a scan of src/, include/, sources and headers — the MCU is chosen afterwards' },
    ];
    const fmt = await vscode.window.showQuickPick(FORMATS, {
        title: 'PIC: Import Project — where does it come from?',
        placeHolder: 'Choose what to import (the project is imported IN PLACE — nothing moves)',
    });
    if (!fmt) return;

    // Step 2 — pick the folder / the Makefile
    const picked = await vscode.window.showOpenDialog(fmt.id === 'makefile'
        ? {
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            openLabel: 'Import This Project',
            title: 'PIC: Import — pick the Makefile (Makefile / GNUmakefile / *.mk — any name)',
            // "Makefile" has no extension — an extension filter cannot name it
            filters: { 'All files': ['*'] },
        }
        : {
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            openLabel: 'Import This Folder',
            title: fmt.id === 'mplab'
                ? 'PIC: Import — pick the MPLAB X project folder (Name.X, or a folder that contains one)'
                : 'PIC: Import — pick the project folder',
        });
    if (!picked || !picked.length) return;
    let target = picked[0].fsPath;

    // MPLAB X: the folder must hold nbproject/configurations.xml (it may be one level down)
    if (fmt.id === 'mplab') {
        let mp = null;
        try { mp = findMplabProject(target); } catch {}
        if (!mp) {
            vscode.window.showErrorMessage(`PIC: no MPLAB X project (nbproject/configurations.xml) found in "${path.basename(target)}" or its subfolders — pick the .X folder.`);
            return;
        }
        if (mp.others.length) {
            const chosen = await vscode.window.showQuickPick(
                [mp.dir, ...mp.others].map(d => ({ label: path.basename(d), description: path.relative(target, d) || '.', dir: d })),
                { title: 'PIC: Import — which MPLAB X project?', placeHolder: `${mp.others.length + 1} MPLAB X projects found under "${path.basename(target)}"` });
            if (!chosen) return;
            target = chosen.dir;
        } else {
            target = mp.dir;
        }
    }

    // Step 3 — analysis (every failure ends in a clear message, never a dead end)
    let result;
    try {
        result = fmt.id === 'makefile'
            ? analyze(path.dirname(target), { kind: 'makefile', makefile: target })
            : analyze(target, { kind: fmt.id });
    } catch (e) {
        vscode.window.showErrorMessage(`PIC: import failed while reading "${path.basename(target)}": ${e.message}`);
        H.log(`[import] analysis failed: ${e && e.stack || e}`);
        return;
    }
    const root = result.root;
    const proj = result.draft;
    proj.build.hooks = {};

    // Step 4 — the MCU: pre-selected only when it matches a definition, otherwise ask
    if (!proj.board) {
        const id = await Boards.selectBoard(null, {
            placeHolder: result.detectedDevice
                ? `Device "${result.detectedDevice}" has no MCU definition — pick the target MCU`
                : 'Pick the target MCU of the imported project',
        });
        if (!id) { vscode.window.showInformationMessage('PIC: import cancelled — no MCU was chosen. Nothing was written.'); return; }
        proj.board = id;
    }

    // Step 5 — validate the draft with the same validator the Project Editor uses
    const report = Validator.validateProjectConfig(proj, root, { countSources: false });
    if (report.errors.length) {
        vscode.window.showErrorMessage(`PIC: the imported draft is not valid — ${report.errors.slice(0, 4).join(' · ')}`);
        H.log(`[import] draft rejected: ${report.errors.join(' | ')}`);
        return;
    }

    // Step 6 — refuse silent overwrites
    const cfgPath = path.join(root, Validator.PROJECT_FILE);
    if (fs.existsSync(cfgPath)) {
        const ans = await vscode.window.showWarningMessage(
            `PIC: "${path.basename(root)}" already contains ${Validator.PROJECT_FILE} — import will REPLACE it.`,
            { modal: true }, 'Replace');
        if (ans !== 'Replace') return;
    }

    // Step 7 — review: the summary rides in `detail` (the property a QuickPick renders)
    const summary = _summary(proj, result);
    const go = await vscode.window.showQuickPick(
        [{ label: '$(check) Import', description: `→ ${cfgPath}`, detail: summary },
         { label: '$(x) Cancel' }],
        { title: 'PIC: Import — review the draft', placeHolder: 'MCU mapping and skipped pieces are listed in the detail below' });
    if (!go || go.label.includes('Cancel')) return;

    // Step 8 — write (guarded), release the latch, adopt the folder
    try {
        fs.writeFileSync(cfgPath, JSON.stringify(proj, null, 2) + '\n');
    } catch (e) {
        vscode.window.showErrorMessage(`PIC: could not write ${Validator.PROJECT_FILE} into "${root}": ${e.message}`);
        H.log(`[import] write failed: ${e.message}`);
        return;
    }
    H.log(`[import] ${Validator.PROJECT_FILE} written → ${cfgPath}`);
    for (const n of result.notes) H.log(`[import] ${n}`);
    H.clearBusy();
    adoptProject(root, proj);
    vscode.window.showInformationMessage(`✅ Imported "${proj.name}" (MCU: ${proj.board}, ${H.resolveToolchain(proj)}). Review it in the Project Editor.`);
}

// make the folder part of the workspace and the active project, then refresh everything
function adoptProject(root, proj) {
    const rootUri = vscode.Uri.file(root);
    const alreadyOpen = !!(vscode.workspace.workspaceFolders || []).some(f => {
        const rel = path.relative(f.uri.fsPath, root);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!alreadyOpen) {
        try {
            const idx = (vscode.workspace.workspaceFolders || []).length;
            vscode.workspace.updateWorkspaceFolders(idx, 0, { uri: rootUri, name: path.basename(root) });
        } catch (e) { H.log(`[import] updateWorkspaceFolders threw: ${e.message}`); }
    }
    H.setActiveRoot(root);
    try { H.getCtx()?.workspaceState?.update('picActiveRoot', root); } catch {}
    Boards.invalidate();
    if (H.getProvider()) H.getProvider().refresh();
    if (H.getRefProvider()) H.getRefProvider().refresh();
    try { require('./statusBar').refreshStatusBar(); } catch {}
    try { require('./memoryView').refresh(); } catch {}

    // updateWorkspaceFolders registers the folder asynchronously — wait (bounded) until the
    // owning-folder lookups of the tasks/launch syncs can see it
    const visible = () => { try { return !!vscode.workspace.getWorkspaceFolder(rootUri); } catch { return false; } };
    const waitFolder = (ms) => new Promise(res => {
        if (visible()) return res(true);
        let sub = null;
        const done = () => { clearTimeout(timer); if (sub) { try { sub.dispose(); } catch {} } res(visible()); };
        const timer = setTimeout(done, ms);
        try { sub = vscode.workspace.onDidChangeWorkspaceFolders(() => { if (visible()) done(); }); } catch {}
    });
    (async () => {
        if (!visible() && !await waitFolder(2500)) await new Promise(r => setTimeout(r, 1000));
        try { await require('./intellisense').syncAfterProjectChange(); } catch (e) { H.log(`[import] intellisense sync failed: ${e.message}`); }
        try { require('./tasks').syncAfterProjectChange(); } catch (e) { H.log(`[import] tasks sync failed: ${e.message}`); }
        try { require('./launchJson').syncAfterProjectChange(); } catch (e) { H.log(`[import] launch.json sync failed: ${e.message}`); }
        try { require('./projectEditor').openProjectEditor(); } catch (e) { H.log(`[import] opening the Project Editor failed: ${e.message}`); }
        try {
            const b = Boards.getBoard(proj.board);
            const dev = b && b.build && b.build.device;
            if (dev) require('./packManager').ensureFor(dev, H.resolveToolchain(proj));
        } catch (e) { H.log(`[import] pack prompt failed: ${e.message}`); }
    })().catch(e => H.log('[import] post-import sync failed: ' + (e && e.message || e)));
}

module.exports = { cmdImportProject, _analyze: analyze, _parseConfigurations: parseConfigurations, _summary };
