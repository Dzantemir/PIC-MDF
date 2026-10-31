'use strict';

// ╔══════════════════════════════════════════════════════════════════╗
// ║  COMPONENT MODEL  (pure Node — no `vscode` dependency)             ║
// ╚══════════════════════════════════════════════════════════════════╝
//
// Shared by pic-mdf, avr-mdf and sdcc-mdf — the "components" infrastructure
// modelled on esp8266-idf: a project is `main` plus any number of components.
//
//   main        → the application. Its settings live in the project file
//                 (<x>-project.json) as before: "sources", "includes",
//                 "libraries" (+ optional "requires").
//   components  → folders. Every sub-folder of <project>/components/ is one
//                 (implicit root); extra component roots / single component
//                 folders can be listed in the project's "components" array.
//                 A component carries an optional `component.json` manifest:
//
//                   {
//                     "description": "Soft-SPI driver",
//                     "sources":   ["src", {"path":"extra","pattern":"*.c"}],
//                     "includes":  ["include"],
//                     "libraries": ["lib/libfoo.a"],        // files or folders
//                     "requires":  ["hal"]                   // other components
//                   }
//
//                 Paths are relative to the component folder. A component
//                 WITHOUT a manifest (or with a manifest that omits a key)
//                 keeps the pre-components behaviour: all sources found below
//                 the folder, "inc"/"include" as header folders, no libraries.
//   disabling   → project key "disabled_components": ["name", …] (the sidebar
//                 checkbox, like esp8266-idf's EXCLUDE_COMPONENTS).
//
// The module never touches the compiler specifics: source-rule collection is
// delegated to the extension's own collector (`opts.collectSources`), the
// library file extensions come from `opts.libExts`.

const fs   = require('fs');
const path = require('path');

const COMPONENT_FILE = 'component.json';
const MAIN = 'main';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WIN_RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);

// ─── small helpers ───────────────────────────────────────────────────────────
function _isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function _isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function _posix(p) { return String(p).replace(/\\/g, '/'); }
function _abs(root, p) { return path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p); }
function _arr(v) { return Array.isArray(v) ? v : []; }
function _strs(v) { return _arr(v).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()); }
/** Paths: strings, or (SDCC project files) {path} / {file} objects → their string. */
function _paths(v, key) {
    return _arr(v).map(x => (x && typeof x === 'object' && !Array.isArray(x) && typeof x[key] === 'string') ? x[key] : x)
        .filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
}
function _same(a, b) {
    const x = path.resolve(a), y = path.resolve(b);
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
/** Relative path from `base` (posix) when the target is inside it; the absolute path otherwise. */
function portable(base, target) {
    const rel = path.relative(base, target);
    if (rel === '') return '.';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return _posix(target);
    return _posix(rel);
}

function validateName(name) {
    const s = String(name == null ? '' : name).trim();
    if (!s) return 'Component name is required.';
    if (!NAME_RE.test(s)) return 'Use Latin letters, digits, "-" and "_" (the first character must be a letter, max. 64).';
    if (s.toLowerCase() === MAIN) return '"main" is reserved for the application.';
    if (WIN_RESERVED.has(s.toUpperCase())) return `"${s}" is a reserved Windows device name.`;
    return null;
}

// ─── manifest ────────────────────────────────────────────────────────────────
function readManifest(dir) {
    const file = path.join(dir, COMPONENT_FILE);
    if (!_isFile(file)) return { status: 'none', file };
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'broken', file, error: 'the file must contain a JSON object' };
        return { status: 'ok', file, raw };
    } catch (e) {
        return { status: 'broken', file, error: e.message };
    }
}

/** Rules may be a string, or {path, pattern?, flags?, exclude?}. Anything else is dropped. */
function _rules(v) {
    return _arr(v).filter(r => (typeof r === 'string' && r.trim()) ||
        (r && typeof r === 'object' && !Array.isArray(r) && (typeof r.path === 'string' || Array.isArray(r.exclude) || Array.isArray(r.files))));
}
/** Normalised manifest. A key that is ABSENT stays `undefined` (→ legacy default); [] means "none". */
function normalizeManifest(raw) {
    raw = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const out = {
        description: typeof raw.description === 'string' ? raw.description : '',
        sources:   Array.isArray(raw.sources)   ? _rules(raw.sources) : undefined,
        includes:  Array.isArray(raw.includes)  ? _paths(raw.includes, 'path') : undefined,
        libraries: Array.isArray(raw.libraries) ? _paths(raw.libraries, 'file') : undefined,
        requires:  Array.isArray(raw.requires)  ? _strs(raw.requires) : undefined,
        // per-component -D list — used by SDCC (every component library has its own); no editor field
        defines:   Array.isArray(raw.defines)   ? _strs(raw.defines) : undefined,
    };
    return out;
}
/** Write `component.json`, keeping unknown keys of the previous file and a stable key order. */
function writeManifest(dir, manifest) {
    const prev = readManifest(dir);
    const base = (prev.status === 'ok') ? prev.raw : {};
    const known = ['description', 'sources', 'includes', 'libraries', 'requires', 'defines'];
    const out = {};
    if (manifest.description) out.description = manifest.description;
    for (const k of ['sources', 'includes', 'libraries', 'requires', 'defines']) {
        if (manifest[k] !== undefined) out[k] = manifest[k];
    }
    for (const k of Object.keys(base)) if (!known.includes(k)) out[k] = base[k];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, COMPONENT_FILE), JSON.stringify(out, null, 2) + '\n');
}

/** main's manifest is the project file itself. */
function manifestFromProj(proj) {
    proj = proj || {};
    return {
        description: '',
        sources: Array.isArray(proj.sources) ? _rules(proj.sources) : ['src'],
        includes: _paths(proj.includes, 'path'),
        libraries: _paths(proj.libraries, 'file'),
        requires: _strs(proj.requires),
    };
}
function applyManifestToProj(proj, m) {
    proj.sources = _arr(m.sources);
    proj.includes = _arr(m.includes);
    proj.libraries = _arr(m.libraries);
    if (_arr(m.requires).length) proj.requires = m.requires.slice(); else delete proj.requires;
    return proj;
}

// ─── discovery ───────────────────────────────────────────────────────────────
function _subdirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => e.name).sort((a, b) => a.localeCompare(b));
    } catch { return []; }
}
/** Legacy object entry {path, name?, includes?, pattern?, flags?} → manifest (paths relative to the component dir). */
function _legacyManifest(root, dir, entry, opts) {
    const m = { description: '', sources: undefined, includes: undefined, libraries: undefined, requires: undefined, defines: undefined };
    const flags = Array.isArray(entry.flags) ? entry.flags : null;
    const pattern = (typeof entry.pattern === 'string' && entry.pattern.trim()) ? entry.pattern.trim() : null;
    const files = Array.isArray(entry.files) ? entry.files.filter(f => typeof f === 'string' && f.trim()) : null;
    if (files) {
        // SDCC: an explicit file list (relative to the component folder)
        const r = { path: '.', files };
        if (flags) r.flags = flags;
        m.sources = [r];
    } else if (pattern || flags) {
        const r = { path: '.' };
        if (pattern) r.pattern = pattern;
        if (flags) r.flags = flags;
        m.sources = [r];
    }
    if (Array.isArray(entry.includes)) {
        // legacy include paths were relative to the PROJECT root (pic / avr) — or to the
        // component folder (SDCC: opts.legacyIncludesBase === 'component')
        const list = _strs(entry.includes);
        m.includes = (opts && opts.legacyIncludesBase === 'component') ? list : list.map(i => portable(dir, _abs(root, i)));
    }
    if (Array.isArray(entry.defines)) m.defines = _strs(entry.defines);
    return m;
}

/**
 * List every component of a project: main first, then local / listed / SDK ones.
 * opts.extSdk — resolved external-SDK folder ('' when unused).
 */
function discover(root, proj, opts) {
    opts = opts || {};
    proj = proj || {};
    const disabled = new Set(_strs(proj.disabled_components).map(s => s.toLowerCase()));
    const issues = [];
    const list = [];
    const byName = new Map();
    const seenDirs = [];

    const add = (c) => {
        const key = c.name.toLowerCase();
        if (key === MAIN) { issues.push({ level: 'warn', component: c.name, text: `component folder "${c.dir}" is called "main" — the name is reserved for the application; rename the folder` }); return; }
        // the same folder reached twice (the default project lists "components" AND the
        // implicit <root>/components is scanned) is not a problem — only two DIFFERENT folders are
        if (seenDirs.some(d => _same(d, c.dir))) return;
        if (byName.has(key)) {
            issues.push({ level: 'warn', component: c.name, text: `component "${c.name}" exists twice (${byName.get(key).dir} and ${c.dir}) — only the first one is used` });
            return;
        }
        seenDirs.push(c.dir);
        c.excluded = disabled.has(key);
        byName.set(key, c);
        list.push(c);
    };

    // main — manifest = project file
    list.push({
        name: MAIN, kind: 'main', dir: root, rel: '.', excluded: false, editable: true,
        hasManifest: true, manifestStatus: 'ok', manifestFile: null,
        manifest: manifestFromProj(proj), legacy: false,
    });
    byName.set(MAIN, list[0]);

    const makeLocal = (name, dir, kind, entry) => {
        const rm = readManifest(dir);
        let manifest, legacy = false;
        if (rm.status === 'ok') manifest = normalizeManifest(rm.raw);
        else {
            legacy = true;
            manifest = entry ? _legacyManifest(root, dir, entry, opts) : normalizeManifest({});
            if (rm.status === 'broken') issues.push({ level: 'error', component: name, text: `${COMPONENT_FILE} of "${name}" is not valid JSON — ${rm.error}` });
        }
        add({
            name, kind, dir, rel: portable(root, dir), editable: kind !== 'sdk',
            hasManifest: rm.status === 'ok', manifestStatus: rm.status, manifestFile: rm.file,
            manifest, legacy, excluded: false,
        });
    };
    const scanRoot = (rootDir, kind) => {
        for (const sub of _subdirs(rootDir)) makeLocal(sub, path.join(rootDir, sub), kind, null);
    };

    // 1. the implicit root <project>/components
    const implicit = path.join(root, 'components');
    const listedRoots = [];
    // 2. entries of proj.components
    for (const entry of _arr(proj.components)) {
        if (typeof entry === 'string' && entry.trim()) {
            const abs = _abs(root, entry.trim());
            if (!_isDir(abs)) { issues.push({ level: 'warn', component: '', text: `components: "${entry}" is not a folder` }); continue; }
            if (_isFile(path.join(abs, COMPONENT_FILE))) makeLocal(path.basename(abs), abs, 'listed', null);
            else listedRoots.push(abs);
        } else if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
            const abs = _abs(root, entry.path);
            if (!_isDir(abs)) { issues.push({ level: 'warn', component: '', text: `components: "${entry.path}" is not a folder` }); continue; }
            makeLocal(typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : path.basename(abs), abs, 'listed', entry);
        }
    }
    if (_isDir(implicit)) scanRoot(implicit, 'local');
    for (const r of listedRoots) scanRoot(r, _same(r, implicit) ? 'local' : 'listed');

    // 3. external SDK
    const sdk = String(opts.extSdk || '').trim();
    if (sdk) {
        for (const sub of ['components']) {
            const d = path.join(sdk, sub);
            if (_isDir(d)) scanRoot(d, 'sdk');
        }
    }
    // sidebar order: main, local, listed, sdk — alphabetical inside each group
    const rank = { local: 0, listed: 1, sdk: 2 };
    const rest = list.slice(1).sort((a, b) => (rank[a.kind] - rank[b.kind]) || a.name.localeCompare(b.name));
    return { components: [list[0], ...rest], issues };
}

// ─── resolve (what the build consumes) ───────────────────────────────────────
function _defaultIncludes(dir) {
    return ['include', 'inc'].filter(n => _isDir(path.join(dir, n)));
}
/**
 * Classify the "libraries" entries of a component.
 *   → [{entry, abs, state:'missing'|'file'|'dir'|'badext', files:[abs…]}]
 * A folder contributes every library file below it (sorted); a file must carry one of libExts.
 */
function libEntries(dir, entries, libExts) {
    const extOk = (n) => libExts.some(e => n.toLowerCase().endsWith(e));
    const walk = (d, out) => {
        try {
            for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                if (e.name.startsWith('.')) continue;
                const full = path.join(d, e.name);
                if (e.isDirectory()) walk(full, out);
                else if (e.isFile() && extOk(e.name)) out.push(full);
            }
        } catch { /* unreadable folder */ }
        return out;
    };
    return _arr(entries).map(entry => {
        const abs = _abs(dir, entry);
        if (_isDir(abs)) return { entry, abs, state: 'dir', files: walk(abs, []) };
        if (_isFile(abs)) return extOk(abs) ? { entry, abs, state: 'file', files: [abs] } : { entry, abs, state: 'badext', files: [] };
        return { entry, abs, state: 'missing', files: [] };
    });
}
function _libFiles(dir, entries, libExts, missing) {
    const out = [];
    for (const e of libEntries(dir, entries, libExts)) {
        out.push(...e.files);
        if (missing) {
            if (e.state === 'missing') missing.libraries.push(e.entry);
            else if (e.state === 'badext') missing.libraries.push(`${e.entry} (not a ${libExts.join('/')} file)`);
        }
    }
    return out;
}

/** The manifest with every omitted key replaced by the value the build really uses (for the editor). */
function effectiveManifest(comp) {
    const m = comp.manifest || {};
    return {
        description: m.description || '',
        sources: m.sources !== undefined ? m.sources : (comp.kind === 'main' ? ['src'] : ['.']),
        includes: m.includes !== undefined ? m.includes : (comp.kind === 'main' ? [] : _defaultIncludes(comp.dir)),
        libraries: m.libraries !== undefined ? m.libraries : [],
        requires: m.requires !== undefined ? m.requires : [],
    };
}

/**
 * Resolve ONE component with an explicit manifest (the editor's live preview).
 * Does not de-duplicate against other components. → comp copy with
 * sources / includeDirs / libraries / missing filled in.
 */
function resolveOne(comp, manifest, opts) {
    opts = opts || {};
    const libExts = (opts.libExts && opts.libExts.length ? opts.libExts : ['.a']).map(e => e.toLowerCase());
    const c = Object.assign({}, comp, { manifest, sources: [], includeDirs: [], libraries: [], defines: _strs(manifest.defines), missing: { sources: [], includes: [], libraries: [] } });
    const dir = c.dir;
    const rules = manifest.sources !== undefined ? manifest.sources : (c.kind === 'main' ? ['src'] : ['.']);
    if (rules.length && typeof opts.collectSources === 'function') {
        let got;
        try { got = opts.collectSources(dir, { sources: rules }); } catch (e) { got = { sources: [], errors: [e.message] }; }
        const arr = Array.isArray(got) ? got : (got && got.sources) || [];
        if (got && Array.isArray(got.errors)) for (const e of got.errors) c.missing.sources.push(String(e).replace(/^sources:\s*/, ''));
        for (const s of arr) c.sources.push(Object.assign({}, s, { component: c.name }));
    }
    const incs = manifest.includes !== undefined ? manifest.includes : (c.kind === 'main' ? [] : _defaultIncludes(dir));
    for (const i of incs) {
        const abs = _abs(dir, i);
        if (_isDir(abs)) c.includeDirs.push(abs); else c.missing.includes.push(i);
    }
    const seenLib = new Set();
    for (const file of _libFiles(dir, manifest.libraries !== undefined ? manifest.libraries : [], libExts, c.missing)) {
        const k = process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);
        if (seenLib.has(k)) continue;           // a folder entry + a file entry inside it
        seenLib.add(k);
        c.libraries.push({ file, component: c.name });
    }
    return c;
}

/**
 * Resolve every component to concrete files.
 * opts.collectSources(baseDir, rules) → [{file, kind, flags, ext, extRaw}]  (REQUIRED — the extension's own collector)
 * opts.libExts       ['.a']                                                  library file extensions
 * opts.extSdk        resolved SDK folder ('' = none): its components/ are discovered; its lib/ files join main's libraries
 * opts.legacyIncludesBase  'project' (default) | 'component' — what the "includes" of an old {path,…} entry of
 *                    "components" are relative to (SDCC: the component folder)
 */
function resolve(root, proj, opts) {
    opts = opts || {};
    const libExts = (opts.libExts && opts.libExts.length ? opts.libExts : ['.a']).map(e => e.toLowerCase());
    const collect = opts.collectSources;
    const found = discover(root, proj, opts);
    const issues = found.issues.slice();
    const comps = found.components;
    const byName = new Map(comps.map(c => [c.name.toLowerCase(), c]));
    const seenFiles = new Set();
    const norm = (f) => process.platform === 'win32' ? path.normalize(f).toLowerCase() : path.normalize(f);

    for (const c of comps) {
        c.requires = _strs(c.manifest.requires);
        if (c.excluded) { c.sources = []; c.includeDirs = []; c.libraries = []; c.defines = []; c.missing = { sources: [], includes: [], libraries: [] }; continue; }
        const one = resolveOne(c, c.manifest, { collectSources: collect, libExts });
        c.includeDirs = one.includeDirs; c.libraries = one.libraries; c.defines = one.defines; c.missing = one.missing;
        c.sources = [];
        for (const s of one.sources) {
            const k = norm(s.file);
            if (seenFiles.has(k)) continue;
            seenFiles.add(k);
            c.sources.push(s);
        }
    }

    // external SDK lib/ → main's libraries (the pre-components behaviour)
    const sdk = String(opts.extSdk || '').trim();
    if (sdk) {
        const main = comps[0];
        for (const sub of ['lib', 'Lib']) {
            const d = path.join(sdk, sub);
            if (_isDir(d)) for (const f of _libFiles(d, ['.'], libExts)) main.libraries.push({ file: f, component: MAIN, fromSdk: true });
        }
    }

    // requires: unknown / disabled / cycles
    for (const c of comps) {
        for (const r of c.requires) {
            const t = byName.get(r.toLowerCase());
            if (!t) issues.push({ level: 'warn', component: c.name, text: `"${c.name}" requires "${r}", which does not exist` });
            else if (t.excluded && !c.excluded) issues.push({ level: 'warn', component: c.name, text: `"${c.name}" requires "${t.name}", which is disabled in the project` });
        }
    }
    const order = linkOrder(comps, issues);

    // flatten — main first, then dependency order
    const sources = [], libraries = [], includeDirs = [], includeSet = new Set();
    for (const c of order) {
        for (const s of c.sources) sources.push(s);
        for (const i of c.includeDirs) { const k = norm(i); if (!includeSet.has(k)) { includeSet.add(k); includeDirs.push(i); } }
    }
    const libSeen = new Set();
    for (const c of order) {
        for (const l of c.libraries) { const k = norm(l.file); if (!libSeen.has(k)) { libSeen.add(k); libraries.push(l); } }
    }
    // missing paths → issues
    for (const c of comps) {
        if (c.excluded) continue;
        for (const m of c.missing.sources) issues.push({ level: 'warn', component: c.name, text: `${c.name}: sources — ${m}` });
        for (const m of c.missing.includes) issues.push({ level: 'warn', component: c.name, text: `${c.name}: include folder not found: ${m}` });
        for (const m of c.missing.libraries) issues.push({ level: 'warn', component: c.name, text: `${c.name}: library not found: ${m}` });
    }
    return { components: comps, order, sources, includeDirs, libraries, issues };
}

/**
 * Components in link order: main first, then — for A requires B — A before B
 * (static libraries must follow the objects/libraries that use them).
 * Cycles are reported (warning) and broken deterministically.
 */
function linkOrder(comps, issues) {
    const byName = new Map(comps.map(c => [c.name.toLowerCase(), c]));
    const main = comps.find(c => c.kind === 'main');
    const rest = comps.filter(c => c !== main).sort((a, b) => a.name.localeCompare(b.name));
    // post-order DFS over `requires` gives dependencies first; reverse → dependents first
    const state = new Map();  // name → 1 visiting, 2 done
    const post = [];
    const visit = (c, stack) => {
        const k = c.name.toLowerCase();
        const st = state.get(k);
        if (st === 2) return;
        if (st === 1) {
            if (issues) issues.push({ level: 'warn', component: c.name, text: `dependency cycle: ${[...stack, c.name].join(' → ')}` });
            return;
        }
        state.set(k, 1);
        for (const r of _strs(c.requires || (c.manifest && c.manifest.requires))) {
            const t = byName.get(r.toLowerCase());
            if (t && t !== main) visit(t, [...stack, c.name]);
        }
        state.set(k, 2);
        post.push(c);
    };
    if (main) visit(main, []);
    for (const c of rest) visit(c, []);
    const order = post.reverse().filter(c => c !== main);
    return main ? [main, ...order] : order;
}

/** Plain data for the sidebar (the extensions map it onto their own TreeItem classes). */
function describe(resolved) {
    const issuesBy = new Map();
    for (const i of resolved.issues) {
        const k = (i.component || '').toLowerCase();
        if (!issuesBy.has(k)) issuesBy.set(k, []);
        issuesBy.get(k).push(i);
    }
    return resolved.components.map(c => ({
        name: c.name, kind: c.kind, dir: c.dir, rel: c.rel, excluded: !!c.excluded, editable: !!c.editable,
        legacy: !!c.legacy, hasManifest: !!c.hasManifest,
        srcCount: c.sources.length, libCount: c.libraries.length, includeCount: c.includeDirs.length,
        requires: c.requires.slice(),
        libs: c.libraries.map(l => path.basename(l.file)),
        issues: (issuesBy.get(c.name.toLowerCase()) || []).map(i => ({ level: i.level, text: i.text })),
    }));
}

/** Validator hook: errors / warnings strings for the project file report. */
function validateAll(resolved) {
    const errors = [], warnings = [];
    for (const i of resolved.issues) (i.level === 'error' ? errors : warnings).push(`components: ${i.text}`);
    return { errors, warnings };
}

// ─── create / delete ─────────────────────────────────────────────────────────
function _guard(name) {
    return String(name || '').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}
/**
 * Templates for a new component.
 *   kind 'source'   → src/<name>.c + include/<name>.h
 *   kind 'prebuilt' → include/<name>.h + lib/ (drop the library there, then add it in the editor)
 * ext = { src: '.c', hdr: '.h' } (SDCC/XC all use .c/.h)
 */
function createComponent(root, name, kind, opts) {
    opts = opts || {};
    const bad = validateName(name);
    if (bad) throw new Error(bad);
    const baseDir = opts.baseDir || path.join(root, 'components');
    const dir = path.join(baseDir, name);
    if (fs.existsSync(dir)) throw new Error(`"${portable(root, dir)}" already exists.`);
    const created = [];
    const put = (rel, text) => {
        const f = path.join(dir, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, text);
        created.push(f);
    };
    const g = _guard(name) + '_H';
    if (kind === 'prebuilt') {
        put(COMPONENT_FILE, JSON.stringify({
            description: `Prebuilt library ${name}`,
            sources: [], includes: ['include'], libraries: ['lib'],
        }, null, 2) + '\n');
        put(path.join('include', name + '.h'),
            `#ifndef ${g}\n#define ${g}\n\n/* Declarations exported by the prebuilt library.\n * Copy the library's public header(s) into this folder. */\n\n#endif /* ${g} */\n`);
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        put(path.join('lib', 'README.txt'), 'Put the prebuilt library (e.g. lib' + name + '.a) in this folder, then open the component and check the "Prebuilt libraries" section.\n');
    } else {
        put(COMPONENT_FILE, JSON.stringify({
            description: opts.description || '',
            sources: ['src'], includes: ['include'], libraries: [], requires: [],
        }, null, 2) + '\n');
        put(path.join('include', name + '.h'),
            `#ifndef ${g}\n#define ${g}\n\nvoid ${name}_init(void);\n\n#endif /* ${g} */\n`);
        put(path.join('src', name + '.c'),
            `#include "${name}.h"\n\nvoid ${name}_init(void)\n{\n    /* TODO */\n}\n`);
    }
    return { dir, files: created };
}

/** Is `dir` a component folder this project owns (inside <root>/components or <root>)? Used before deleting. */
function ownsDir(root, dir) {
    const rel = path.relative(path.join(root, 'components'), dir);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = {
    COMPONENT_FILE, MAIN,
    validateName, readManifest, normalizeManifest, writeManifest, manifestFromProj, applyManifestToProj,
    discover, resolve, resolveOne, effectiveManifest, libEntries, linkOrder, describe, validateAll, createComponent, ownsDir, portable,
};
