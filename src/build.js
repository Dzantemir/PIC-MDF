'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// build.js — the PIC-MDF build pipeline for the FOUR Microchip toolchains.
//
//   xc8   : ONE xc8-cc invocation compiles+assembles+links all sources and
//           emits the ELF *and* the Intel HEX (User Guide §4.4.1: "Unless
//           otherwise specified, a HEX file and ELF file are produced").
//           `xc8-cc -mcpu=<dev> [opts] -o <out>.elf <src…>`
//
//   xc16  : compile each source (`-c -o <obj>`) then link with the device
//           linker script: `-mcpu=<dev> -T p<dev>.gld -o <out>.elf <objs>`,
//           then `<xc16-bin2hex> <out>.elf` → <out>.hex.
//
//   xc32  : compile then link (`-mprocessor=<dev> -o <out>.elf <objs>`), then
//           `<xc32-bin2hex> <out>.elf` → <out>.hex.
//
//   xcdsc : same shape as xc16 — `-mcpu=<dev> -T p<dev>.gld`, then
//           `<xc-dsc-bin2hex> <out>.elf` → <out>.hex.
//
// Incremental compilation tracks the contents of project-local headers and the
// exact compiler command. Each compile completes before its fingerprint is saved,
// so a failed compile can never poison the cache.
// ─────────────────────────────────────────────────────────────────────────────
const vscode   = require('vscode');
const path     = require('path');
const fs       = require('fs');
const cp       = require('child_process');
const crypto   = require('crypto');
const H        = require('./helpers');
const Toolchain = require('./toolchain');
const Boards   = require('./boards');
const Hooks    = require('./hooks');
const Validator = require('./validator');
const Memory   = require('./memory');
const { resolveProject } = require('./sources');

const TERM = 'PIC';
const EXE = H.IS_WIN ? '.exe' : '';

// ─── Build variables (hooks / output-path expansion) ─────────────────────────
function buildVars(root, proj, board, extra = {}) {
    const { outDirAbs: outDir, outName } = H.expandOutPaths(root, proj);
    const device = board ? board.build.device : String(proj.board || '');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    // git:hash / git:branch are lazy — a plain value would run `git rev-parse`
    // on EVERY build/flash even when no ${git:…} placeholder is used
    // (audit 0.3.0 item 10).
    let _git = null;
    const git = () => (_git || (_git = H.gitInfo(root)));
    const vars = {
        'workspaceFolder': root,
        'workspaceFolderBasename': root ? path.basename(root) : '',
        'project.name': proj.name || path.basename(root),
        'project.root': root,
        'toolchain': H.resolveToolchain(proj),
        'board.id': proj.board || '',
        'board.device': device,
        'board.name': board ? (board.name || device) : (proj.board || ''),
        'board.family': board ? (board.build.family || '') : '',
        'board.fcpu': board ? (_effectiveClockHz(proj, board) ? `${_effectiveClockHz(proj, board)}UL` : (board.build.f_cpu || '')) : '',
        'board.flash': String((board && board.build.memory && board.build.memory.flash) || 0),
        'board.ram': String((board && board.build.memory && board.build.memory.ram) || 0),
        'board.eeprom': String((board && board.build.memory && board.build.memory.eeprom) || 0),
        'outputDir': outDir,
        'outputName': outName,
        'outputElf': path.join(outDir, outName + '.elf'),
        'outputHex': path.join(outDir, outName + '.hex'),
        'outputBin': path.join(outDir, outName + '.bin'),
        'outputMap': path.join(outDir, outName + '.map'),
        'buildMode': String(H.cfg('buildMode') || 'release').toLowerCase(),
        get 'git:hash'() { return git().hash; },
        get 'git:branch'() { return git().branch; },
        'date': date, 'time': time, 'datetime': `${date}_${time}`,
        'unixtime': Math.floor(now.getTime() / 1000),
        'pathSeparator': path.sep,
        'userHome': require('os').homedir(),
    };
    return extendVars(vars, extra);
}
// Copy a vars object PRESERVING its lazy getters. A spread / Object.assign
// would evaluate git:hash / git:branch immediately and reintroduce the
// per-build `git rev-parse` cost.
function extendVars(vars, extra) {
    const out = {};
    for (const key of Object.getOwnPropertyNames(vars)) {
        const d = Object.getOwnPropertyDescriptor(vars, key);
        if (d.get) Object.defineProperty(out, key, { enumerable: true, configurable: true, get: d.get });
        else Object.defineProperty(out, key, { enumerable: true, configurable: true, writable: true, value: d.value });
    }
    return Object.assign(out, extra);
}

// ─── Optimization / mode flags ───────────────────────────────────────────────
function optimizationFlag(toolchain, proj = {}) {
    const key = toolchain === 'xc8' ? 'xc8.optimization'
        : toolchain === 'xc16' ? 'xc16.optimization'
        : toolchain === 'xc32' ? 'xc32.optimization'
        : 'xcdsc.optimization';
    const projectValue = String(proj && proj.build && proj.build.optimization != null ? proj.build.optimization : '').trim().toLowerCase();
    const globalValue = String(H.cfg(key) || 'default').trim().toLowerCase();
    // Missing/empty/'default' project overrides inherit the per-toolchain
    // setting, matching the Project Editor's "Use global setting" option.
    const v = (!projectValue || projectValue === 'default') ? globalValue : projectValue;
    const debug = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug';
    if (debug) return ['-O0', '-g'];
    if (v === 'default' || v === '') return [];
    if (v === 's' || v === 'size') return ['-Os'];
    if (/^[0-3]$/.test(v)) return [`-O${v}`];
    H.log(`[build] ignoring unsupported optimization override "${v}"`);
    return [];
}

// ─── Driver/binutils resolution ──────────────────────────────────────────────
function _tool(tc, name) {
    if (tc && tc.modules && tc.modules[name]) return tc.modules[name];
    return null;
}
function _bin2hexName(id) {
    return id === 'xc16' ? 'xc16-bin2hex' : id === 'xc32' ? 'xc32-bin2hex' : id === 'xcdsc' ? 'xc-dsc-bin2hex' : null;
}
function _objdumpName(id) {
    return id === 'xc8' ? 'pic-objdump' : id === 'xc16' ? 'xc16-objdump' : id === 'xc32' ? 'xc32-objdump' : 'xc-dsc-objdump';
}
function _objcopyName(id) {
    return id === 'xc8' ? 'pic-objcopy' : id === 'xc16' ? 'xc16-objcopy' : id === 'xc32' ? 'xc32-objcopy' : 'xc-dsc-objcopy';
}
function _nmName(id) {
    return id === 'xc8' ? 'pic-objdump' /* no pic-nm; objdump used for symbols */ : id === 'xc16' ? 'xc16-nm' : id === 'xc32' ? 'xc32-nm' : 'xc-dsc-nm';
}
function _arName(id) {
    return id === 'xc8' ? 'xc8-ar' : id === 'xc16' ? 'xc16-ar' : id === 'xc32' ? 'xc32-ar' : 'xc-dsc-ar';
}
function _findGld(tc, device) {
    const want = ('p' + String(device || '')).toLowerCase();
    const plain = String(device || '').toLowerCase();
    for (const dir of (tc.linkerDirs || [])) {
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (!e.isFile()) continue;
                const base = e.name.replace(/\.[^.]+$/, '').toLowerCase();
                if (base === want || base === plain) return path.join(dir, e.name);
            }
        } catch {}
    }
    return null;
}

// ─── Command line helpers ────────────────────────────────────────────────────
function _quoteArg(a) { return /[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a; }
function _cmdLine(exe, argv) { return [H.exe(exe), ...argv.map(_quoteArg)].join(' '); }

function _effectiveClockHz(proj, board) {
    const override = Number(proj && proj.build && proj.build.f_cpu_hz);
    if (Number.isSafeInteger(override) && override > 0) return override;
    const build = board && board.build || {};
    const hz = Number(build.f_cpu_hz);
    if (Number.isSafeInteger(hz) && hz > 0) return hz;
    const raw = String(build.f_cpu || '').replace(/[_\s]*(?:UL|ul|U|u|L|l)?$/, '').replace(/_/g, '');
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function _uniquePaths(paths) {
    const out = [], seen = new Set();
    for (const item of paths || []) {
        if (!item) continue;
        const resolved = path.resolve(item);
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (seen.has(key)) continue;
        seen.add(key); out.push(resolved);
    }
    return out;
}

// A broken component.json would silently fall back to the folder defaults — refuse to build instead.
function _inputsProblem(inputs) {
    for (const i of inputs.issues || []) if (i.level !== 'error') H.log(`[components] warning: ${i.text}`);
    const bad = (inputs.issues || []).find(i => i.level === 'error');
    return bad ? `components: ${bad.text}` : null;
}

function _collectInputs(root, proj) {
    const extSdk = String(H.cfg('externalSdkPath') || '').trim();
    const res = resolveProject(root, proj, extSdk);
    const sources = res.sources.slice().sort((a, b) => a.file.localeCompare(b.file));
    return {
        collected: { sources, errors: [] },
        components: res.components, libraries: res.libraries, issues: res.issues,
        includeDirs: _uniquePaths(res.includeDirs), extSdk,
    };
}

// Best-effort resolver for project-local includes. Device headers that are
// supplied by the compiler/DFP but are outside configured project include paths
// are intentionally ignored; changing any discovered project header still
// invalidates the object.
function _resolveLocalInclude(name, quoted, sourceDir, includeDirs) {
    const candidates = [];
    if (quoted) candidates.push(path.resolve(sourceDir, name));
    for (const dir of includeDirs || []) candidates.push(path.resolve(dir, name));
    for (const candidate of candidates) {
        try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
    return null;
}

function _dependencyFiles(sourceFile, includeDirs) {
    // Keep the original path spelling for filesystem access, but deduplicate
    // case-insensitively on Windows. Returning a lower-cased path can fail on
    // case-sensitive mounted volumes and makes cache records less readable.
    const found = new Map();
    const visit = (file, depth = 0) => {
        const abs = path.resolve(file);
        const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
        if (found.has(key) || depth > 128) return;
        let text;
        try { if (!fs.statSync(abs).isFile()) return; text = fs.readFileSync(abs, 'utf8'); } catch { return; }
        found.set(key, abs);
        const refs = [];
        const quoted = /^\s*#\s*include\s*"([^"\r\n]+)"/gm;
        const angled = /^\s*#\s*include\s*<([^>\r\n]+)>/gm;
        const asmInclude = /^\s*(?:\.include|include)\s+["']([^"'\r\n]+)["']/gim;
        let match;
        while ((match = quoted.exec(text))) refs.push({ name: match[1], quoted: true });
        while ((match = angled.exec(text))) refs.push({ name: match[1], quoted: false });
        while ((match = asmInclude.exec(text))) refs.push({ name: match[1], quoted: true });
        for (const ref of refs) {
            const dependency = _resolveLocalInclude(ref.name, ref.quoted, path.dirname(abs), includeDirs);
            if (dependency) visit(dependency, depth + 1);
        }
    };
    visit(sourceFile);
    return [...found.values()].sort();
}

function _parseDependencyFile(depFile, root) {
    let text;
    try { text = fs.readFileSync(depFile, 'utf8'); } catch { return null; }
    // GCC/make depfiles can wrap long rules and escape spaces. Do not split on
    // the first colon: Windows absolute paths contain a drive-letter colon.
    text = text.replace(/\\\r?\n/g, ' ');
    let separator = -1;
    for (let i = 0; i < text.length - 1; i++) {
        if (text[i] === ':' && /\s/.test(text[i + 1])) { separator = i; break; }
    }
    if (separator < 0) return null;
    const rhs = text.slice(separator + 1);
    const tokens = [];
    let token = '', escaped = false;
    for (let i = 0; i < rhs.length; i++) {
        const ch = rhs[i];
        if (escaped) { token += ch; escaped = false; continue; }
        if (ch === '\\') {
            const next = rhs[i + 1];
            // In make depfiles, backslash escapes whitespace/special tokens,
            // but must remain a path separator in Windows paths (C:\dir\x.h).
            if (next && (/[\s#:\\]/.test(next))) { escaped = true; continue; }
            token += '\\';
            continue;
        }
        if (/\s/.test(ch)) { if (token) { tokens.push(token); token = ''; } continue; }
        token += ch;
    }
    if (escaped) token += '\\';
    if (token) tokens.push(token);
    const base = root || process.cwd();
    const resolved = [...new Set(tokens.map(t => path.resolve(base, t)))];
    return resolved.length ? resolved : null;
}

function _sourceFingerprint(sourceFile, argv, depFile, includeDirs, hashCache, root) {
    // C/C++ dependencies come from the compiler's own -MD/-MF output and thus
    // include headers resolved from toolchain/DFP directories. Assembly uses
    // a conservative local .include scanner because assembler support differs.
    const files = depFile ? _parseDependencyFile(depFile, root) : _dependencyFiles(sourceFile, includeDirs);
    if (!files || !files.some(f => path.resolve(f) === path.resolve(sourceFile))) return null;
    const deps = files.map(file => {
        const key = process.platform === 'win32' ? file.toLowerCase() : file;
        if (!hashCache.has(key)) {
            try { hashCache.set(key, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')); }
            catch { hashCache.set(key, 'missing'); }
        }
        return [file, hashCache.get(key)];
    });
    return crypto.createHash('sha256').update(JSON.stringify({ version: 3, argv, deps })).digest('hex');
}

function _isUpToDate(srcFile, objFile, metaFile, fingerprint) {
    try {
        if (!fs.statSync(objFile).isFile()) return false;
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        return meta && meta.version === 3 && meta.fingerprint === fingerprint;
    } catch { return false; }
}

function _objectPath(root, objDir, sourceFile) {
    const abs = path.resolve(sourceFile);
    const objRoot = path.resolve(objDir);
    const relObjRoot = path.relative(objRoot, abs);
    if (relObjRoot === '' || (!relObjRoot.startsWith('..' + path.sep) && relObjRoot !== '..' && !path.isAbsolute(relObjRoot))) {
        const basename = path.basename(abs).replace(/\.[^.]+$/, '') + '.o';
        return path.join(objDir, basename);
    }
    const rel = path.relative(root, abs);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        const digest = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12);
        const basename = path.basename(abs).replace(/\.[^.]+$/, '');
        return path.join(objDir, '_external', `${basename}-${digest}.o`);
    }
    const objRel = rel.replace(/\\+/g, '/').replace(/\.[^.]+$/, '') + '.o';
    return path.join(objDir, objRel);
}

function _sourceCompileFlags(proj, src) {
    const b = (proj && proj.build) || {};
    const ext = String(src.ext || path.extname(src.file)).toLowerCase();
    const typed = ext === '.cpp' || ext === '.cc' || ext === '.cxx'
        ? (b.cxx_flags || []) : (src.kind === 'asm' ? (b.asm_flags || []) : (b.c_flags || []));
    const local = Array.isArray(src.flags) ? src.flags : [];
    return [...typed, ...local].filter(x => typeof x === 'string' && x.trim());
}
function _removeStale(objFile) {
    try {
        if (!fs.existsSync(objFile)) return true;
        try { fs.rmSync(objFile, { force: true }); } catch {}
        if (!fs.existsSync(objFile)) return true;
        try { fs.chmodSync(objFile, 0o666); fs.rmSync(objFile, { force: true }); } catch {}
        return !fs.existsSync(objFile);
    } catch { return false; }
}

// ─── Common device + include flags ───────────────────────────────────────────
// ─── Configuration-bit source injection ──────────────────────────────────────
// The Configuration Bits editor writes pic-project.json → build.config_bits.
// Those become #pragma config lines in a generated translation unit that is
// compiled with the rest, so the config lands in the .hex exactly as edited.
// The project's bits override the board's defaults.
function _ensureConfigSource(root, proj, board, dir) {
    const bits = (proj.build && proj.build.config_bits) || (board && board.build && board.build.config_bits) || null;
    if (!bits || !Object.keys(bits).length) return null;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, '_pic_config_bits.c');
        const lines = Object.entries(bits).map(([k, v]) => `#pragma config ${k} = ${v}`).join('\n');
        fs.writeFileSync(f, `/* generated by PIC-MDF from the Configuration Bits editor */\n${lines}\n`);
        H.log(`[build] config source: ${Object.keys(bits).length} bit field(s)`);
        return f;
    } catch (e) { H.log(`[build] config source failed: ${e.message}`); return null; }
}
function _sourceFileList(root, proj, board, sources, outDir) {
    const list = sources.map(s => s.file);
    const cfg = _ensureConfigSource(root, proj, board, path.join(outDir, 'obj'));
    if (cfg) list.push(cfg);
    return list;
}
function _deviceFlags(tc, board) {
    return Toolchain.deviceFlags(tc.id, board ? board.build.device : '');
}
// ─── Device Family Pack (-mdfp) ──────────────────────────────────────────────
// XC8 v4.00+ no longer ships device-support files inside the compiler: the
// readme is explicit ("the internal device-support files are no longer shipped
// with the compiler, and whenever you build a project, a DFP must be specified
// using the [−mdfp] option"). Newer XC16/XC32/XC-DSC follow the same rule. We
// accept an explicit path (project build.dfp / pic.dfpPath) and otherwise look
// for an unpacked pack under the common Microchip pack folders.
function _findDfp(tcId, tcVersion) {
    const os = require('os');
    const roots = [
        path.join(os.homedir(), '.mchp_packs'),
        path.join(process.env.USERPROFILE || os.homedir(), '.mchp_packs'),
        path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents', 'MPLAB', 'packs'),
        String(H.cfg('rootPath') || ''),
    ].filter(Boolean);
    const sub = tcId === 'xcdsc' ? 'xc-dsc' : tcId;
    const major = parseInt(String(tcVersion || '').split('.')[0], 10);
    for (const root of roots) {
        try {
            if (!root || !fs.existsSync(root)) continue;
            const stack = [root];
            let guard = 0;
            while (stack.length && guard++ < 20000) {
                const d = stack.pop();
                let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
                for (const e of entries) {
                    if (!e.isDirectory()) continue;
                    const full = path.join(d, e.name);
                    if (e.name.toLowerCase() === sub.toLowerCase() &&
                        (fs.existsSync(path.join(full, 'pic')) || fs.existsSync(path.join(full, 'deviceSupport')) || fs.existsSync(path.join(full, 'include')))) {
                        // Current XC32 docs specify the DFP root containing xc32;
                        // XC8/XC16/XC-DSC specify their toolchain subdirectory.
                        if (tcId === 'xc32' && (!Number.isFinite(major) || major >= 5)) return path.dirname(full);
                        return full;
                    }
                    stack.push(full);
                }
            }
        } catch {}
    }
    return '';
}

function _normalizeDfpPath(raw, tc) {
    const input = String(raw || '').trim();
    if (!input || !tc) return input;
    const abs = path.resolve(input);
    const id = tc.id;
    const folder = id === 'xcdsc' ? 'xc-dsc' : id;
    const major = parseInt(String(tc.version || '').split('.')[0], 10);
    try {
        if (id === 'xc32' && (!Number.isFinite(major) || major >= 5)) {
            if (path.basename(abs).toLowerCase() === 'xc32') return path.dirname(abs);
            if (fs.existsSync(path.join(abs, 'xc32'))) return abs;
        } else {
            if (path.basename(abs).toLowerCase() === folder.toLowerCase()) return abs;
            const child = path.join(abs, folder);
            if (fs.existsSync(child) && fs.statSync(child).isDirectory()) return child;
            // Accept legacy XC-DSC DFP packages documented with an xc16 path.
            if (id === 'xcdsc') {
                const legacy = path.join(abs, 'xc16');
                if (fs.existsSync(legacy) && fs.statSync(legacy).isDirectory()) return legacy;
            }
        }
    } catch {}
    return abs;
}

// Device-aware DFP resolution: pick the pack that actually CONTAINS the
// board's device (the old _findDfp returned any pack with the right toolchain
// subfolder — wrong when several packs are installed). Order:
//   1. explicit project build.dfp / pic.dfpPath setting
//   2. packManager's store + MPLAB X packs, via the bundled device→pack catalog
//   3. legacy blind scan (last resort)
function _resolveDfp(proj, tc, board) {
    const explicit = String((proj.build && proj.build.dfp) || H.cfg('dfpPath') || '').trim();
    if (explicit) return { dir: _normalizeDfpPath(explicit, tc), source: 'setting' };
    if (!tc) return { dir: '', source: '' };
    try {
        const PM = require('./packManager');
        const device = board ? board.build.device : '';
        if (device) {
            const pack = PM.packForDevice(device, tc.id);
            if (pack) {
                const inst = PM.detect()[pack.n];
                if (inst) {
                    const dir = PM.pathForToolchain ? PM.pathForToolchain(inst, tc.id, tc.version) : inst.toolchainDir;
                    if (dir) {
                        H.log(`[build] DFP for ${device}: ${pack.n} v${inst.version} (${inst.source}) → ${dir}`);
                        return { dir, source: pack.n, pack };
                    }
                }
                // not installed yet — remember which pack is needed
                return { dir: '', source: '', needed: pack };
            }
        }
    } catch (e) { H.log(`[build] packManager lookup failed: ${e.message}`); }
    const auto = _findDfp(tc.id, tc.version);
    if (auto) return { dir: auto, source: 'scan' };
    return { dir: '', source: '' };
}
function _dfpFlag(proj, tc, board) {
    const r = _resolveDfp(proj, tc, board);
    return r.dir ? [`-mdfp=${r.dir}`] : [];
}
// Which compilers REQUIRE a DFP (device support moved out of the compiler)?
// Verified live in this workspace: XC8 v4.00 → "(2103) no device-support files
// specified; use the -mdfp option"; XC32 v6.00 → "No DFP location has been
// provided. The -mdfp option is required when using -mprocessor". XC16 v2.10
// still carries device support built in (builds without -mdfp). XC-DSC v4
// likewise reads its support from a pack. Version-aware, so an older compiler
// that still bundles support is never blocked.
function _needsDfp(tc) {
    if (!tc) return false;
    const v = String(tc.version || '');
    const major = parseInt(v.split('.')[0], 10);
    if (tc.id === 'xc8') return !Number.isFinite(major) || major >= 4;
    if (tc.id === 'xc32') return !Number.isFinite(major) || major >= 5;
    if (tc.id === 'xcdsc') return !Number.isFinite(major) || major >= 4;
    return false; // xc16 carries support in the tested versions
}
// Pre-flight: if the toolchain needs a DFP and neither the project, the
// setting nor auto-detection supplied one, stop with an actionable message
// instead of letting the raw compiler error (2103)/(2104) surface.
async function _checkDfp(proj, tc, board) {
    if (!_needsDfp(tc)) return true;
    const r = _resolveDfp(proj, tc, board);
    if (r.dir) return true;
    // Not installed. If we know WHICH pack the device needs, offer to install
    // it right here (packManager downloads + unpacks it).
    if (r.needed) {
        const PM = require('./packManager');
        const pick = await vscode.window.showWarningMessage(
            `PIC: ${tc.label} needs the ${r.needed.n} device pack (v${r.needed.v}) for ${board ? board.build.device : 'this device'} — it is not installed. Download and install it now?`,
            { modal: true }, 'Download & install');
        if (pick === 'Download & install') {
            const res = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `PIC: installing ${r.needed.n}`, cancellable: false },
                async () => PM.installPack(r.needed));
            if (res.ok && res.toolchainDir) {
                vscode.window.showInformationMessage(`✅ PIC: ${r.needed.n} installed — continuing the build.`);
                return true;
            }
            vscode.window.showErrorMessage(`PIC: pack install failed — ${res.error || 'unknown error'}`);
            return false;
        }
        return false;
    }
    vscode.window.showErrorMessage(
        `PIC: ${tc.label} requires a Device Family Pack (DFP). No pack is known for "${board ? board.build.device : '?'}" — install one manually (MPLAB X → Tools → Packs, or https://packs.download.microchip.com/).`,
        'Open Settings'
    ).then(a => { if (a === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'pic.dfpPath'); });
    return false;
}
// Clock macros the extension adds with -D (F_CPU / FCY / _XTAL_FREQ). XC8's
// manual has the user write `#define _XTAL_FREQ 8000000` in the source; a -D of
// the same name with a different spelling (…UL) would raise a "macro redefined"
// warning, so when the project's own code already defines one, ours is skipped.
const _AUTO_CLOCK_MACROS = ['F_CPU', 'FCY', '_XTAL_FREQ'];
function _scanUserMacros(root, inputs) {
    const found = new Set();
    const re = /^[ \t]*#[ \t]*define[ \t]+(F_CPU|FCY|_XTAL_FREQ)\b/gm;
    const seen = new Set();
    const scanFile = (file) => {
        try {
            const abs = path.resolve(file);
            if (seen.has(abs) || seen.size > 3000) return;
            seen.add(abs);
            const st = fs.statSync(abs);
            if (!st.isFile() || st.size > 1024 * 1024) return;
            const text = fs.readFileSync(abs, 'utf8');
            let m; re.lastIndex = 0;
            while ((m = re.exec(text))) {
                // `#ifndef F_CPU` / `#if !defined(F_CPU)` right above = a DEFAULT that a -D is meant
                // to override — it is not a user definition, so our -D stays.
                const before = text.slice(0, m.index).split(/\r?\n/).filter(l => l.trim()).pop() || '';
                const guarded = new RegExp('^\\s*#\\s*(?:ifndef\\s+' + m[1] + '\\b|if\\s*!\\s*defined\\s*\\(?\\s*' + m[1] + '\\b)').test(before);
                if (!guarded) found.add(m[1]);
            }
        } catch {}
    };
    for (const s of (inputs && inputs.collected && inputs.collected.sources) || []) scanFile(s.file);
    const rootAbs = path.resolve(root || '.');
    for (const dir of (inputs && inputs.includeDirs) || []) {
        const dAbs = path.resolve(dir);
        if (!(dAbs + path.sep).startsWith(rootAbs + path.sep)) continue;   // project headers only
        const walk = (d, depth) => {
            let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const f = path.join(d, e.name);
                if (e.isFile() && /\.(?:h|hpp|inc)$/i.test(e.name)) scanFile(f);
                else if (e.isDirectory() && depth < 3 && !/^(?:\.|node_modules$)/.test(e.name)) walk(f, depth + 1);
            }
        };
        walk(dAbs, 0);
    }
    return found;
}

function _commonFlags(tc, board, proj, userMacros) {
    const flags = [..._deviceFlags(tc, board)];
    const hz = _effectiveClockHz(proj, board);
    const userDefined = userMacros || new Set();
    if (hz) {
        const add = (name) => { if (!userDefined.has(name)) flags.push(`-D${name}=${hz}UL`); };
        add('F_CPU'); add('FCY');
        if (tc.id === 'xc8') add('_XTAL_FREQ');
    }
    flags.push(..._dfpFlag(proj, tc, board));
    flags.push(...optimizationFlag(tc.id, proj));
    if (tc.id === 'xc8') {
        // pic.xc8.cStandard (previously declared but never read).
        const std = String(H.cfg('xc8.cStandard') || 'c99').trim().toLowerCase();
        if (std === 'c90' || std === 'c99') flags.push(`-std=${std}`);
    }
    if (String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug') {
        // Microchip documents __DEBUG=1 for IDE-compatible Debug builds.
        // Keep DEBUG too for user projects that use the conventional macro.
        flags.push('-D__DEBUG=1', '-DDEBUG=1');
    }
    const build = (proj && proj.build) || {};
    // -flto: documented for XC32 only (XC32 User Guide, optimization options);
    // the XC8, XC16 and XC-DSC guides have no LTO option.
    if (build.lto) {
        if (tc.id === 'xc32') flags.push('-flto');
        else H.log(`[build] LTO is not supported by ${tc.label || tc.id} — build.lto ignored`);
    }
    // -Wall: described for XC16/XC32/XC-DSC (GCC drivers). The XC8 for PIC guide
    // has no -Wall — its driver controls warnings with -mwarn / -W[no-]msg / -w —
    // and its default level already reports all normal warnings.
    if (H.cfg('warnings') !== false && tc.id !== 'xc8') flags.push('-Wall');
    const autoClockMacros = new Set(['F_CPU', 'FCY', '_XTAL_FREQ']);
    for (const d of (proj.defines || [])) {
        const dv = typeof d === 'string' ? d : (d && d.name ? d.name + (d.value !== undefined ? '=' + d.value : '') : null);
        if (!dv) continue;
        const name = String(dv).split('=')[0].replace(/^\s+/, '');
        if (hz && autoClockMacros.has(name)) continue;
        if (String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug' && (name === '__DEBUG' || name === 'DEBUG')) continue;
        flags.push(`-D${dv}`);
    }
    const extra = String(H.cfg('extraArgs') || '').trim();
    if (extra) flags.push(..._splitArgList(extra));
    for (const f of build.extra_flags || []) if (typeof f === 'string' && f.trim()) flags.push(f);
    return flags;
}

// Quote-aware splitter for the pic.extraArgs string: `-DX="a b" -O1` must
// yield two flags, not four (0.3.0 audit minor: naive \s+ split).
function _splitArgList(s) {
    const out = [];
    let cur = '', quote = null;
    for (const ch of String(s || '')) {
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (/\s/.test(ch)) {
            if (cur) { out.push(cur); cur = ''; }
        } else {
            cur += ch;
        }
    }
    if (cur) out.push(cur);
    return out;
}
function _includeFlags(root, proj, includeDirs) {
    return _uniquePaths(includeDirs || []).map(inc => `-I${inc}`);
}

// ─── Run a step in the terminal (with exit marker) ───────────────────────────
async function runStep(line, label) {
    const ec = await H.runInTerminal(TERM, [line]);
    if (ec === 0) return 0;
    if (ec === -1) {
        vscode.window.showErrorMessage(`PIC: ${label} interrupted (no exit code seen).`);
        return ec;
    }
    H.log(`✖ ${label} failed (exit ${ec}) — replaying hidden for diagnostics`);
    replayHidden(line, label, ec);
    return ec;
}

// Replay a failing command hidden to capture stderr for the Problems panel.
function replayHidden(line, label, ec) {
    try {
        // naive token split (the line is already shell-quoted; we strip quotes)
        const toks = (H.tokenizeCommandLine ? H.tokenizeCommandLine(line) : String(line).split(/\s+/))
            .map(t => t.replace(/^['"]|['"]$/g, ''));
        const exe = toks[0];
        const args = toks.slice(1);
        const r = cp.spawnSync(exe, args, { timeout: 30000, encoding: 'utf8', windowsHide: true, cwd: H.getActiveRoot() || undefined });
        const stderr = String(r.stderr || '');
        const stdout = String(r.stdout || '');
        const diags = [];
        for (const l of (stderr + '\n' + stdout).split('\n')) {
            const d = H.parseGccDiagLine(l, H.getActiveRoot() || process.cwd());
            if (d) diags.push(d);
        }
        // XC32 v6.00 (MIPS) release notes, "Tentative Definitions": the C compiler
        // default changed from -fcommon to -fno-common, so a global defined (even
        // tentatively, e.g. `int a;` in a header) in several files no longer merges.
        if (/multiple definition of/.test(stderr + stdout) && /xc32/i.test(path.basename(exe))) {
            H.log('[build] hint: XC32 v6 builds with -fno-common — a variable defined in several files is now a link error. ' +
                'Declare it "extern" in the header and define it in ONE .c file; for legacy code add -fcommon to pic.extraArgs.');
            vscode.window.showWarningMessage(
                'PIC: "multiple definition" — XC32 v6 defaults to -fno-common, so tentative definitions (e.g. `int a;` in a header) are no longer merged. ' +
                'Declare the variable `extern` in the header and define it once, or add -fcommon to pic.extraArgs for legacy code.');
        }
        if (diags.length) {
            H.reportDiagnostics(diags, H.getActiveRoot());
            H.log(`[build] ${diags.length} diagnostic(s) → Problems panel`);
        } else {
            H.getOutputChannel().appendLine(`── ${label} failed (exit ${ec}) ──\n${stderr || stdout || '(no output captured)'}`);
            H.getOutputChannel().show(true);
        }
    } catch (e) {
        H.log(`[build] hidden replay failed: ${e.message}`);
    }
}

// ─── Section sizes (objdump -h) ──────────────────────────────────────────────
function sectionSizes(tc, elfPath) {
    return new Promise((resolve) => {
        try {
            const objdump = _tool(tc, _objdumpName(tc.id));
            if (!objdump) { resolve(null); return; }
            const r = cp.spawnSync(objdump, ['-h', elfPath], { timeout: 15000, encoding: 'utf8', windowHide: true });
            resolve(Memory.parseObjdumpSections(String(r.stdout || '')));
        } catch { resolve(null); }
    });
}

// ─── Success toast ───────────────────────────────────────────────────────────
function _notifyBuildSuccess(prefix, outName, t0) {
    let usage = '';
    try { usage = Memory.lastUsageHuman ? Memory.lastUsageHuman() : ''; } catch {}
    const dt = (Date.now() - t0) / 1000;
    const tTxt = dt < 10 ? `${dt.toFixed(1)}s` : `${Math.round(dt)}s`;
    const msg = `✅ ${prefix} › Build succeeded in ${tTxt} — ${outName}.elf${usage ? ` (${usage})` : ''}`;
    vscode.window.showInformationMessage(msg, 'Flash', 'Memory').then(a => {
        if (a === 'Flash') vscode.commands.executeCommand('pic.flash');
        else if (a === 'Memory') vscode.commands.executeCommand('pic.memoryView.focus');
    });
}

// ─── Main build ──────────────────────────────────────────────────────────────
async function build() {
    if (H.checkBusy()) return;
    const t0 = Date.now();
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }

    const { status, proj, parseError } = Validator.readProjectConfig(root);
    if (status === 'missing') {
        vscode.window.showErrorMessage('PIC: no pic-project.json in the project folder.', 'Create Project')
            .then(a => { if (a === 'Create Project') vscode.commands.executeCommand('pic.createProject'); });
        return;
    }
    if (status === 'broken') {
        vscode.window.showErrorMessage(`PIC: pic-project.json is broken JSON — ${parseError}`);
        return;
    }
    const report = Validator.validateProjectConfig(proj, root, { countSources: false });
    if (report.errors.length) {
        vscode.window.showErrorMessage(`PIC: pic-project.json has ${report.errors.length} error(s) — build blocked.`, 'Show Problems')
            .then(a => { if (a === 'Show Problems') vscode.commands.executeCommand('pic.showProblems'); });
        return;
    }
    const toolchainId = H.resolveToolchain(proj);
    const tc = Toolchain.requireToolchain(toolchainId);
    if (!tc) return;

    const board = Boards.getBoard(proj.board);
    if (!board) {
        vscode.window.showErrorMessage(`PIC: board "${proj.board}" is not in the MCU database — pick a device first.`);
        return;
    }
    // Pre-flight: the newer compilers need a Device Family Pack (-mdfp) —
    // resolve it device-aware and offer an in-place install when missing.
    if (!await _checkDfp(proj, tc, board)) return;
    let vars;
    try { vars = buildVars(root, proj, board, { toolchain: toolchainId }); }
    catch (e) { vscode.window.showErrorMessage(e.message); return false; }

    H.setBusy('Build');
    try {
        try { await vscode.workspace.saveAll(false); } catch {}
        if (toolchainId === 'xc8') return await _buildXc8(root, proj, board, tc, vars, t0);
        return await _buildGccLike(root, proj, board, tc, vars, t0);
    } finally {
        H.clearBusy();
    }
}

// ─── XC8 pipeline (one-step) ─────────────────────────────────────────────────
async function _buildXc8(root, proj, board, tc, vars, t0) {
    const outDir = vars['outputDir'];
    const outName = vars['outputName'];
    const elfPath = path.join(outDir, outName + '.elf');
    const hexPath = path.join(outDir, outName + '.hex');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

    const inputs = _collectInputs(root, proj);
    const inputsError = _inputsProblem(inputs);
    if (inputsError) { vscode.window.showErrorMessage(`PIC: ${inputsError}`); return; }
    const collected = inputs.collected;
    if (!collected.sources.length) {
        vscode.window.showErrorMessage('PIC: no source files found — check the application (main) and the components (Components group in the sidebar).');
        return;
    }
    const includeDirs = inputs.includeDirs;
    const includeFlags = _includeFlags(root, proj, includeDirs);
    if (collected.sources.some(src => Array.isArray(src.flags) && src.flags.length)) {
        vscode.window.showErrorMessage('PIC: per-source flags cannot be applied safely by the XC8 one-step driver. Move them to Project Editor → Build → C flags / Assembly flags, or select XC16/XC32/XC-DSC where per-source flags are supported.');
        return;
    }

    const preEc = await Hooks.runHook(proj, 'pre_build', vars, TERM);
    if (preEc !== 0) {
        vscode.window.showErrorMessage(`PIC: pre_build hook failed (exit ${preEc}) — build aborted.`);
        return;
    }

    const projectBuild = proj.build || {};
    const sharedFlags = [
        ...(projectBuild.c_flags || []), ...(projectBuild.cxx_flags || []), ...(projectBuild.asm_flags || []),
        ...(projectBuild.link_flags || []),
    ].filter(x => typeof x === 'string' && x.trim());
    const argv = [
        ..._commonFlags(tc, board, proj, _scanUserMacros(root, inputs)), ...sharedFlags,
        ...includeFlags,
        '-o', elfPath,
        ..._sourceFileList(root, proj, board, collected.sources, outDir),
        // prebuilt libraries of the components (a plain archive on the XC8 command line)
        ...(inputs.libraries || []).map(l => l.file),
    ];
    H.log(`[build:xc8] ${_cmdLine(tc.driver, argv)}`);
    const ec = await runStep(_cmdLine(tc.driver, argv), `xc8-cc ${outName}`);
    if (ec !== 0) return;

    // XC8 emits the .hex automatically; if for some reason it is absent,
    // try the pic-objcopy front end as a fallback.
    if (!fs.existsSync(hexPath)) {
        const objcopy = _tool(tc, 'pic-objcopy');
        if (objcopy) {
            H.log('[build:xc8] .hex not auto-produced — falling back to pic-objcopy');
            const ec2 = await runStep(_cmdLine(objcopy, ['-O', 'ihex', elfPath, hexPath]), 'pic-objcopy → .hex');
            if (ec2 !== 0) return;
        } else {
            H.log('[build:xc8] warning: no .hex produced and no pic-objcopy found');
        }
    }

    const sections = await sectionSizes(tc, elfPath);
    await _emitBinaries(tc, elfPath, hexPath, sections);

    const postLinkEc = await Hooks.runHook(proj, 'post_link', vars, TERM);
    if (postLinkEc !== 0) { vscode.window.showErrorMessage(`PIC: post_link hook failed (exit ${postLinkEc}) — build aborted.`); return; }
    const postBuildEc = await Hooks.runHook(proj, 'post_build', vars, TERM);
    if (postBuildEc !== 0) { vscode.window.showErrorMessage(`PIC: post_build hook failed (exit ${postBuildEc}).`); return; }

    try {
        await Memory.generate(root, proj, board, {
            elfPath, hexPath, sections, mapPath: null, toolchain: tc, outDir, nmPath: null,
            historyLimit: H.cfg('memory.historyLimit'),
        });
    } catch (e) { H.log(`[memory] report generation failed: ${e.message}`); }

    H.flashBarFeedback('build', '$(check) Build OK', '$(tools) Build');
    H.log(`✔ Build OK (XC8): ${hexPath}`);
    _notifyBuildSuccess('PIC (XC8)', outName, t0);

    if (String(H.cfg('postBuildAction') || 'none') === 'flash') {
        H.clearBusy();
        return await require('./flash').flash();
    }
    return true;
}

// ─── XC16 / XC32 / XC-DSC pipeline (compile → link → bin2hex) ────────────────
async function _buildGccLike(root, proj, board, tc, vars, t0) {
    const outDir = vars['outputDir'];
    const outName = vars['outputName'];
    const elfPath = path.join(outDir, outName + '.elf');
    const hexPath = path.join(outDir, outName + '.hex');
    const objDir = path.join(outDir, 'obj');
    try { fs.mkdirSync(objDir, { recursive: true }); } catch {}

    const inputs = _collectInputs(root, proj);
    const inputsError = _inputsProblem(inputs);
    if (inputsError) { vscode.window.showErrorMessage(`PIC: ${inputsError}`); return; }
    const collected = inputs.collected;
    if (!collected.sources.length) {
        vscode.window.showErrorMessage('PIC: no source files found — check the application (main) and the components (Components group in the sidebar).');
        return;
    }
    const includeDirs = inputs.includeDirs;
    const includeFlags = _includeFlags(root, proj, includeDirs);

    const device = board.build.device;
    const preEc = await Hooks.runHook(proj, 'pre_build', vars, TERM);
    if (preEc !== 0) { vscode.window.showErrorMessage(`PIC: pre_build hook failed (exit ${preEc}) — build aborted.`); return; }

    // ── compile phase (batched) ──────────────────────────────────────────
    const _cfg = _ensureConfigSource(root, proj, board, objDir);
    if (_cfg) collected.sources.push({ file: _cfg, kind: 'c', ext: '.c', extRaw: '.c' });
    const common = [..._commonFlags(tc, board, proj, _scanUserMacros(root, inputs)), ...includeFlags];
    const objects = [];
    let skipped = 0;
    let compiled = 0;
    const incremental = H.cfg('incrementalBuild') !== false;
    const hashCache = new Map();

    for (const src of collected.sources) {
        const obj = _objectPath(root, objDir, src.file);
        const metaFile = obj + '.picmdf.json';
        try { fs.mkdirSync(path.dirname(obj), { recursive: true }); } catch {}
        objects.push(obj);
        const isCSource = src.kind !== 'asm' && /\.(?:c|cc|cpp|cxx)$/i.test(String(src.file));
        const depFile = isCSource ? obj + '.d' : null;
        const argv = [...common, ..._sourceCompileFlags(proj, src)];
        // XC16/XC32/XC-DSC GCC-based drivers document -MD/-MF. Let the
        // compiler resolve actual DFP, system and user header dependencies.
        if (depFile) argv.push('-MD', '-MF', depFile, '-MQ', obj);
        argv.push('-c', src.file, '-o', obj);
        const fingerprint = _sourceFingerprint(src.file, [tc.driver, tc.version || '', ...argv], depFile, includeDirs, hashCache, root);
        if (incremental && fingerprint && _isUpToDate(src.file, obj, metaFile, fingerprint)) { skipped++; continue; }
        if (!_removeStale(obj)) {
            vscode.window.showErrorMessage(`PIC: cannot remove the stale object "${path.relative(root, obj)}" — build aborted.`);
            return;
        }
        try { fs.rmSync(metaFile, { force: true }); } catch {}
        if (depFile) { try { fs.rmSync(depFile, { force: true }); } catch {} }
        H.log(`[build:${tc.id}] compiling ${path.relative(root, src.file) || src.file}`);
        const ec = await runStep(_cmdLine(tc.driver, argv), `compile ${path.basename(src.file)}`);
        if (ec !== 0) return;
        const newFingerprint = _sourceFingerprint(src.file, [tc.driver, tc.version || '', ...argv], depFile, includeDirs, hashCache, root);
        if (newFingerprint) {
            try {
                fs.writeFileSync(metaFile, JSON.stringify({ version: 3, fingerprint: newFingerprint, source: path.resolve(src.file), depFile: depFile || null }) + '\n', 'utf8');
            } catch (e) {
                H.log(`[build:${tc.id}] could not save incremental state for ${src.file}: ${e.message}`);
            }
        } else {
            H.log(`[build:${tc.id}] dependency data unavailable for ${path.basename(src.file)}; it will be recompiled on next build for safety`);
        }
        compiled++;
    }
    if (compiled) H.log(`[build:${tc.id}] compiled ${compiled} object(s), ${skipped} object(s) up to date`);
    else if (skipped) H.log(`[build:${tc.id}] incremental: all ${skipped} object(s) up to date — link only`);
    // ── link phase ───────────────────────────────────────────────────────
    const buildOptions = proj.build || {};
    const linkArgv = [
        ..._deviceFlags(tc, board),
        ...optimizationFlag(tc.id, proj),
        ..._dfpFlag(proj, tc, board),
    ];
    if (buildOptions.gc_sections) linkArgv.push('-Wl,--gc-sections');
    if (buildOptions.lto && tc.id === 'xc32') linkArgv.push('-flto');   // XC32 only — see _commonFlags
    // 16-bit / DSC linkers need the device linker script when available
    let gld = null;
    if (tc.id === 'xc16' || tc.id === 'xcdsc') {
        gld = _findGld(tc, device);
        if (gld) linkArgv.push('-T', gld);
        else H.log(`[build:${tc.id}] no linker script found for "${device}" — relying on the driver default`);
    }
    linkArgv.push(`-Wl,-Map=${path.join(outDir, outName + '.map')}`);
    for (const f of (proj.build && proj.build.link_flags) || []) linkArgv.push(f);
    linkArgv.push(...objects);
    // user prebuilt libraries
    // (main first, then each component's libraries in dependency order — see componentModel.linkOrder)
    const libs = inputs.libraries || [];
    if (libs.length > 1) linkArgv.push('-Wl,--start-group');
    for (const lib of libs) linkArgv.push(lib.file);
    if (libs.length > 1) linkArgv.push('-Wl,--end-group');
    linkArgv.push('-o', elfPath);

    const ec = await runStep(_cmdLine(tc.driver, linkArgv), `link ${outName}`);
    if (ec !== 0) {
        // surface missing-object diagnostics (batched compiles that failed)
        return;
    }

    const postLinkEc = await Hooks.runHook(proj, 'post_link', vars, TERM);
    if (postLinkEc !== 0) { vscode.window.showErrorMessage(`PIC: post_link hook failed (exit ${postLinkEc}) — build aborted.`); return; }

    // ── bin2hex ──────────────────────────────────────────────────────────
    const bin2hex = _tool(tc, _bin2hexName(tc.id));
    if (bin2hex) {
        const ec2 = await runStep(_cmdLine(bin2hex, [elfPath]), `bin2hex → .hex`);
        if (ec2 !== 0) return;
    } else {
        vscode.window.showWarningMessage(`PIC: the ELF is built, but no ${_bin2hexName(tc.id)} was found to produce the .hex.`);
    }

    const sections = await sectionSizes(tc, elfPath);
    await _emitBinaries(tc, elfPath, hexPath, sections);

    const postBuildEc = await Hooks.runHook(proj, 'post_build', vars, TERM);
    if (postBuildEc !== 0) { vscode.window.showErrorMessage(`PIC: post_build hook failed (exit ${postBuildEc}).`); return; }

    try {
        await Memory.generate(root, proj, board, {
            elfPath, hexPath, sections,
            mapPath: path.join(outDir, outName + '.map'),
            toolchain: tc, outDir,
            nmPath: _tool(tc, _nmName(tc.id)),
            historyLimit: H.cfg('memory.historyLimit'),
        });
    } catch (e) { H.log(`[memory] report generation failed: ${e.message}`); }

    H.flashBarFeedback('build', '$(check) Build OK', '$(tools) Build');
    H.log(`✔ Build OK (${tc.id}): ${hexPath}`);
    _notifyBuildSuccess(`PIC (${tc.id.toUpperCase()})`, outName, t0);

    if (String(H.cfg('postBuildAction') || 'none') === 'flash') {
        H.clearBusy();
        return await require('./flash').flash();
    }
    return true;
}

// ─── pic.autoHexBin: raw .bin (and .eep for data-EEPROM parts) ───────────────
// Best-effort artifacts on top of the .hex: failures are logged, never fatal.
async function _emitBinaries(tc, elfPath, hexPath, sections) {
    if (H.cfg('autoHexBin') === false) return;
    const objcopy = _tool(tc, _objcopyName(tc.id));
    if (!objcopy || !fs.existsSync(elfPath)) {
        H.log('[build] autoHexBin: no objcopy front end / no ELF — .bin skipped');
        return;
    }
    const binPath = hexPath.replace(/\.hex$/i, '.bin');
    const label = `objcopy → ${path.basename(binPath)}`;
    const ec = await runStep(_cmdLine(objcopy, ['-O', 'binary', elfPath, binPath]), label);
    if (ec !== 0) H.log(`[build] autoHexBin: .bin emission failed (exit ${ec}, ignored)`);
    // .eep only when the ELF actually carries a data-EEPROM section.
    const hasEeprom = !!(sections && Object.keys(sections).some(n => /^\.(ee|eeprom)/.test(n)));
    if (hasEeprom) {
        const eepPath = hexPath.replace(/\.hex$/i, '.eep');
        const ec2 = await runStep(_cmdLine(objcopy, ['-j', '.eedata', '-O', 'binary', elfPath, eepPath]), `objcopy → ${path.basename(eepPath)}`);
        if (ec2 !== 0) { try { fs.rmSync(eepPath, { force: true }); } catch {} }
    }
}

// ─── Clean ───────────────────────────────────────────────────────────────────
async function clean() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }

    let outDir;
    try { outDir = H.expandOutPaths(root, proj); }
    catch (e) { vscode.window.showErrorMessage(e.message); return false; }
    const outDirAbs = outDir.outDirAbs;
    if (!H.checkOutputDir(root, outDirAbs).ok) {
        vscode.window.showErrorMessage(
            `PIC: refusing to clean — build.output_dir (${outDir.outDirRel}) is unsafe; select a real subdirectory inside the project.`);
        return;
    }
    if (!fs.existsSync(outDirAbs)) {
        vscode.window.showInformationMessage('PIC: build folder does not exist — nothing to clean.');
        return;
    }
    H.setBusy('Clean');
    try {
        const kind = H.shellKind();
        let ec;
        if (kind === H.SHELL_CMD) {
            ec = await H.runInTerminal(TERM, [`rmdir /s /q ${H.q(outDirAbs)}`]);
        } else if (kind === H.SHELL_POWERSHELL) {
            ec = await H.runInTerminal(TERM, [`Remove-Item -Recurse -Force -LiteralPath ${H.q(outDirAbs)}`]);
        } else {
            ec = await H.runInTerminal(TERM, [`rm -rf ${H.q(outDirAbs)}`]);
        }
        H.clearDiagnostics();
        Memory.reset();
        if (H.getProvider()) H.getProvider().refresh();
        if (ec === 0) {
            H.flashBarFeedback('clean', '$(check) Cleaned', '$(trash) Clean');
            vscode.window.showInformationMessage(`PIC: removed ${outDir.outDirRel}/`);
        } else {
            vscode.window.showErrorMessage(`PIC: clean failed (exit ${ec}).`);
        }
        return ec === 0;
    } finally {
        H.clearBusy();
    }
}

module.exports = { build, clean, buildVars, extendVars, _cmdLine, _splitArgList, _commonFlags, _findGld, _findDfp, _dfpFlag, _needsDfp, _resolveDfp };
