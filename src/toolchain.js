'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// toolchain.js — detection of the FOUR Microchip compiler toolchains.
//
//   xc8    8-bit PIC          bin/xc8-cc         (baseline/mid/enhanced/PIC18)
//   xc16   16-bit PIC24/dsPIC  bin/xc16-gcc       (24x / 30x / 33x families)
//   xc32   32-bit PIC32M/C     bin/xc32-gcc       (MIPS PIC32M + ARM PIC32C)
//   xcdsc  dsPIC33A/C/E/F+30   bin/xc-dsc-gcc     (DSC v4)
//
// The distribution root holds the per-compiler subfolders, e.g.
//   Microchip/xc8/v4.00, xc16/v2.10, xc32/v6.00, xc-dsc/v4.00
// and each subfolder carries bin/ with the driver + binutils.
//
// Everything the build/flash/reference views need is resolved here and put
// into the cache: driver path + version, bin dir, companion tools (by name),
// system include dirs, the device-family list (from deviceSupport.xml where
// the distribution ships one, else from the device header/linker-script
// listings) and the linker-script directory.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const cp     = require('child_process');
const H      = require('./helpers');

const EXE = H.IS_WIN ? '.exe' : '';

// ─── The four toolchain descriptors ──────────────────────────────────────────
// driver      — the compiler driver executable name
// binutils    — companion tools resolved next to the driver (by bare name)
// deviceFlag  — how the device is passed on the command line
// hasSimulator— whether the distribution ships a command-line simulator
const TOOLCHAINS = {
    xc8: {
        id: 'xc8',
        label: 'MPLAB XC8 (8-bit PIC)',
        arch: '8-bit PIC',
        driver: 'xc8-cc',
        deviceFlag: (d) => [`-mcpu=${d}`],
        families: ['16c5x', '16x', '18x'],
        binutils: ['xc8-ar', 'xc8-clangd', 'xc-ccov', 'pic-objcopy', 'pic-objdump', 'pic-as', 'hexmate'],
        hasSimulator: false,
        // the actual device support list ships as deviceSupport.xml in bin/
        deviceSupport: 'bin/deviceSupport.xml',
        // where the device headers live (used by IntelliSense + reference view)
        includeHints: ['pic/include', 'pic/include/c99', 'avr/include'],
        linkerDirs: [],
    },
    xc16: {
        id: 'xc16',
        label: 'MPLAB XC16 (16-bit PIC24 / dsPIC33)',
        arch: '16-bit PIC24/dsPIC',
        driver: 'xc16-gcc',
        deviceFlag: (d) => [`-mcpu=${d}`],
        families: ['24x', '30x', '33x'],
        binutils: ['xc16-ar', 'xc16-as', 'xc16-bin2hex', 'xc16-ld', 'xc16-nm', 'xc16-objcopy', 'xc16-objdump', 'xc16-ranlib', 'xc16-readelf', 'xc16-size', 'xc16-strip', 'xc16-pa'],
        hasSimulator: true,
        simulator: 'sim30',
        deviceSupport: 'bin/deviceSupport.xml',
        includeHints: ['include', 'support/generic/h'],
        // per-family header + linker-script folders under support/<FAMILY>/
        supportFamilies: ['PIC24F', 'PIC24H', 'PIC24E', 'dsPIC30F', 'dsPIC33F', 'dsPIC33E', 'dsPIC33C', 'generic'],
        linkerDirs: ['support'],
    },
    xc32: {
        id: 'xc32',
        label: 'MPLAB XC32 (32-bit PIC32M / PIC32C)',
        arch: '32-bit PIC32',
        driver: 'xc32-gcc',
        deviceFlag: (d) => [`-mprocessor=${d}`],
        families: ['32m', '32c'],
        binutils: ['xc32-ar', 'xc32-as', 'xc32-bin2hex', 'xc32-ld', 'xc32-nm', 'xc32-objcopy', 'xc32-objdump', 'xc32-ranlib', 'xc32-readelf', 'xc32-size', 'xc32-strip', 'xc32-addr2line', 'xc32-c++filt'],
        hasSimulator: false,
        // no deviceSupport.xml — the device list is derived from the linker
        // scripts + the pic32m/pic32c header folders
        deviceSupport: null,
        includeHints: ['pic32m/include', 'pic32c/include'],
        linkerDirs: ['pic32m/lib/ldscripts', 'pic32c/lib/ldscripts'],
        subBackends: {
            pic32m: { prefix: 'pic32m', includeDirs: ['pic32m/include'], linkerDir: 'pic32m/lib/ldscripts' },
            pic32c: { prefix: 'pic32c', includeDirs: ['pic32c/include'], linkerDir: 'pic32c/lib/ldscripts' },
        },
    },
    xcdsc: {
        id: 'xcdsc',
        label: 'MPLAB XC-DSC (dsPIC33A/C/E/F + dsPIC30)',
        arch: '16-bit dsPIC DSC',
        driver: 'xc-dsc-gcc',
        deviceFlag: (d) => [`-mcpu=${d}`],
        families: ['33A', '33C', '33E', '33F', '30'],
        binutils: ['xc-dsc-ar', 'xc-dsc-as', 'xc-dsc-bin2hex', 'xc-dsc-ld', 'xc-dsc-nm', 'xc-dsc-objcopy', 'xc-dsc-objdump', 'xc-dsc-ranlib', 'xc-dsc-readelf', 'xc-dsc-strip', 'xc-dsc-pa', 'xc-dsc-g++'],
        hasSimulator: false,
        deviceSupport: null,
        includeHints: ['include', 'support/generic/h'],
        linkerDirs: ['support', 'lib'],
    },
};
const TOOLCHAIN_IDS = Object.keys(TOOLCHAINS);

// ─── Low-level helpers ───────────────────────────────────────────────────────
function _stat(p) { try { return fs.statSync(p); } catch { return null; } }
function _isDir(p) { const s = _stat(p); return !!(s && s.isDirectory()); }
function _isFile(p) { const s = _stat(p); return !!(s && s.isFile()); }
function _which(bare) {
    try {
        const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const exts = H.IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
        for (const d of dirs) for (const e of exts) {
            const c = path.join(d, bare + e);
            if (_isFile(c)) return c;
        }
    } catch {}
    return null;
}

// ─── Driver probing ──────────────────────────────────────────────────────────
// A given folder may be the distribution root (with bin/<driver>), the bin
// folder itself, or any parent (the Microchip folder, with xc8/v4.00/...).
// We probe a bounded set of candidate folders for each toolchain id.
function _driverCandidates(tc, root) {
    const name = tc.driver + EXE;
    const out = [];
    const push = (d) => { if (d && !out.includes(d)) out.push(d); };

    // 1) manual setting (file / bin / root)
    const manual = String(H.cfg(tc.id + '.path') || '').trim();
    if (manual) {
        if (_isFile(manual)) { push(path.dirname(manual)); }
        else if (_isDir(manual)) {
            push(manual);
            push(path.join(manual, 'bin'));
        }
    }
    // 2) the shared root setting
    const rootSetting = String(H.cfg('rootPath') || '').trim();
    for (const r of [rootSetting, root]) {
        if (!r) continue;
        push(path.join(r, tc.id, 'bin'));
        // xc8/v4.00, xc16/v2.10 … (version folders)
        const verDir = path.join(r, tc.id);
        if (_isDir(verDir)) {
            try {
                for (const e of fs.readdirSync(verDir, { withFileTypes: true })) {
                    if (e.isDirectory()) push(path.join(verDir, e.name, 'bin'));
                }
            } catch {}
        }
        push(path.join(r, 'bin'));
    }
    // 3) PATH
    const w = _which(tc.driver);
    if (w) push(path.dirname(w));
    return { dirs: out, name };
}

function _probeDriver(tc, root) {
    const { dirs, name } = _driverCandidates(tc, root);
    for (const d of dirs) {
        const full = path.join(d, name);
        if (_isFile(full)) return full;
    }
    return null;
}

// ─── Companion (binutils) resolution ─────────────────────────────────────────
// XC32 and XC-DSC also carry per-backend prefixed binutils in <bin>/bin/
// (pic32m-gcc.exe, elf-objcopy.exe …) — resolve those as a fallback when the
// plain name is missing (the driver's own folder is searched first).
function _findCompanion(binDir, name) {
    if (!binDir) return null;
    const cands = [path.join(binDir, name + EXE)];
    if (H.IS_WIN) cands.push(path.join(binDir, name + '.cmd'), path.join(binDir, name + '.bat'));
    cands.push(path.join(binDir, name));
    for (const c of cands) if (_isFile(c)) return c;
    // nested bin/ of the toolchain (XC32/XC-DSC): <bin>/bin/<name>
    const nested = path.join(binDir, 'bin', name + EXE);
    if (_isFile(nested)) return nested;
    return null;
}

function _resolveModules(tc, binDir) {
    const mods = {};
    for (const n of tc.binutils) {
        const p = _findCompanion(binDir, n);
        if (p) mods[n] = p;
    }
    return mods;
}

// ─── Version ─────────────────────────────────────────────────────────────────
function _getVersion(driver) {
    return new Promise((resolve) => {
        try {
            cp.execFile(driver, ['--version'], { timeout: 6000, windowsHide: true }, (err, stdout, stderr) => {
                if (err && !stdout && !stderr) { resolve(null); return; }
                const out = String(stdout || '') + String(stderr || '');
                // XC8/XC16/XC32/XC-DSC print e.g. "xc8-cc (XC8) 4.00" or
                // "xc16-gcc (XC16) 2.10" — grab the first x.y[.z] version
                const m = out.match(/\b(\d+\.\d+(?:\.\d+)?)\b/);
                resolve(m ? m[1] : null);
            });
        } catch { resolve(null); }
    });
}

// ─── deviceSupport.xml parser ────────────────────────────────────────────────
// The file lists families and devices:
//   <mp:family mp:family="18x">
//     <mp:device mp:name="PIC18F4550"/>
// We parse it into { family: [deviceName, …] } with a cheap regex pass (the
// file is a flat list; a full XML parse would need a dependency).
function parseDeviceSupport(file) {
    const out = {};
    try {
        const raw = fs.readFileSync(file, 'utf8');
        let family = null;
        const re = /<mp:family\s+mp:family="([^"]+)"|<mp:device\s+mp:name="([^"]+)"/g;
        let m;
        while ((m = re.exec(raw)) !== null) {
            if (m[1] !== undefined) { family = m[1]; if (!out[family]) out[family] = []; }
            else if (m[2] !== undefined && family) { out[family].push(m[2]); }
        }
    } catch {}
    return out;
}

// ─── Device list from headers / linker scripts (XC32, XC-DSC) ────────────────
// XC32: pic32m/lib/ldscripts/pic32m.x is generic, so the device list comes from
// the pic32m/pic32c header folders + the family-specific lib dirs. XC-DSC v4
// carries per-family link scripts under support/. We walk the obvious folders
// and collect the DISTINCT device tokens, and are honest when the list is thin.
function _devicesFromDirs(dirs, prefixRe) {
    const set = new Set();
    for (const dir of dirs) {
        if (!dir || !_isDir(dir)) continue;
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (!e.isFile()) continue;
                const base = e.name.replace(/\.[^.]+$/, '').toUpperCase();
                if (prefixRe.test(base)) set.add(base);
            }
        } catch {}
    }
    return [...set].sort();
}

// ─── Detection entry point ───────────────────────────────────────────────────
function detect() {
    const cached = H.getToolchainCache();
    if (cached && cached.stamp === _stamp()) return cached;

    const tc = { stamp: _stamp(), found: [], anyFound: false };
    for (const id of TOOLCHAIN_IDS) {
        const spec = TOOLCHAINS[id];
        const driver = _probeDriver(spec, H.getActiveRoot());
        if (!driver) { tc[id] = null; continue; }
        const binDir = path.dirname(driver);
        const root = _toolchainRoot(spec, binDir);
        const modules = _resolveModules(spec, binDir);
        tc[id] = {
            id,
            label: spec.label,
            arch: spec.arch,
            driver,
            binDir,
            root,
            modules,
            devices: _deviceList(spec, root, binDir),
            includeDirs: _includeDirs(spec, root, binDir),
            linkerDirs: _linkerDirs(spec, root, binDir),
            simulator: spec.hasSimulator ? _findCompanion(binDir, spec.simulator) : null,
            version: null,
        };
    }
    H.setToolchainCache(tc);

    // versions are async — kick a background fill that updates the cache when
    // they arrive (the tree re-renders on the next refresh)
    (async () => {
        for (const id of TOOLCHAIN_IDS) {
            if (!tc[id]) continue;
            try { tc[id].version = await _getVersion(tc[id].driver); } catch {}
        }
        H.log('[toolchain] ' + TOOLCHAIN_IDS.map(id => {
            const t = tc[id];
            return `${id}: ${t ? (t.driver + (t.version ? ' v' + t.version : '')) : 'not found'} (${t ? Object.keys(t.modules).length + '/' + TOOLCHAINS[id].binutils.length + ' tools' : '-'})`;
        }).join(' | '));
    })();

    return tc;
}

function _toolchainRoot(spec, binDir) {
    // binDir = <root>/bin ; the toolchain root is its parent
    return path.dirname(binDir);
}

function _deviceList(spec, root, binDir) {
    // 1) deviceSupport.xml when present
    if (spec.deviceSupport) {
        const f = path.join(root, spec.deviceSupport.replace(/^bin\//, 'bin/'));
        if (_isFile(f)) {
            const fam = parseDeviceSupport(f);
            const flat = [];
            for (const arr of Object.values(fam)) flat.push(...arr);
            return { byFamily: fam, all: [...new Set(flat)].sort() };
        }
    }
    // 2) header / linker-script listing (XC32, XC-DSC)
    const dirs = [];
    if (spec.id === 'xc32') {
        dirs.push(path.join(root, 'pic32m', 'lib', 'ldscripts'), path.join(root, 'pic32c', 'lib', 'ldscripts'));
    } else if (spec.id === 'xcdsc') {
        for (const d of ['support/generic', 'lib', 'src']) dirs.push(path.join(root, d));
    }
    const re = spec.id === 'xc32' ? /^PIC32/ : /^DSPIC/;
    const all = _devicesFromDirs(dirs, re);
    return { byFamily: {}, all };
}

function _includeDirs(spec, root, binDir) {
    const out = [];
    for (const h of (spec.includeHints || [])) {
        const d = path.join(root, h);
        if (_isDir(d)) out.push(d);
    }
    if (spec.supportFamilies) {
        for (const fam of spec.supportFamilies) {
            const h = path.join(root, 'support', fam, 'h');
            if (_isDir(h)) out.push(h);
        }
    }
    return out;
}

function _linkerDirs(spec, root, binDir) {
    const out = [];
    for (const l of (spec.linkerDirs || [])) {
        const d = path.join(root, l);
        if (_isDir(d)) out.push(d);
    }
    if (spec.supportFamilies) {
        for (const fam of spec.supportFamilies) {
            const g = path.join(root, 'support', fam, 'gld');
            if (_isDir(g)) out.push(g);
            const inc = path.join(root, 'support', fam, 'inc');
            if (_isDir(inc)) out.push(inc);
        }
    }
    return out;
}

// ─── Cache stamp ─────────────────────────────────────────────────────────────
let _stampCache = null;
function _stamp() {
    if (_stampCache) return _stampCache;
    _stampCache = JSON.stringify([
        H.cfg('rootPath'), H.cfg('xc8.path'), H.cfg('xc16.path'),
        H.cfg('xc32.path'), H.cfg('xcdsc.path'),
    ]);
    setTimeout(() => { _stampCache = null; }, 0).unref?.();
    return _stampCache;
}
function invalidate() { H.setToolchainCache(null); }

// ─── Device flag builders (per toolchain) ────────────────────────────────────
// The Microchip drivers take the device WITHOUT the PIC/dsPIC prefix
// (manual examples: -mcpu=18F4550, -mcpu=33EP512MU810, -mprocessor=32MZ2048EFM144).
// Boards store the human spelling (PIC18F4550) — normalise here once.
function driverDeviceName(raw) {
    return String(raw || '').trim().toUpperCase().replace(/^(?:DSPIC|PIC)/, '');
}
function deviceFlags(toolchainId, device) {
    const spec = TOOLCHAINS[toolchainId];
    if (!spec) return [];
    return spec.deviceFlag(driverDeviceName(device));
}
// MPLAB spelling normalisation for a device token from a board JSON.
// The Microchip drivers accept the bare part number, e.g. "PIC18F4550",
// "24FJ128GA010", "32MZ2048EFH144", "33CK256MP508".
function mplabDeviceName(raw) {
    return String(raw || '').trim().toUpperCase();
}

// ─── require* helpers with actionable errors ─────────────────────────────────
function requireToolchain(id) {
    const tc = detect();
    const t = tc[id];
    if (t) return t;
    const spec = TOOLCHAINS[id] || { label: id };
    vscode.window.showErrorMessage(
        `PIC: ${spec.label} (${spec.driver}) was not found. Install it, or point PIC-MDF at its folder.`,
        'Select Toolchain'
    ).then(a => { if (a === 'Select Toolchain') vscode.commands.executeCommand('pic.selectToolchain'); });
    return null;
}

// ─── Select toolchain command ────────────────────────────────────────────────
async function cmdSelectToolchain() {
    if (H.checkBusy()) return null;
    const tc = detect();
    const items = [];
    for (const id of TOOLCHAIN_IDS) {
        const spec = TOOLCHAINS[id];
        const t = tc[id];
        items.push({
            label: `${t ? '$(check)' : '$(warning)'} ${spec.label}`,
            description: t ? `${t.driver}${t.version ? ' v' + t.version : ''}` : 'not found',
            detail: t ? `${Object.keys(t.modules).length}/${spec.binutils.length} tools · ${t.devices.all.length} devices known` : 'Install it or browse to its folder.',
            id,
        });
    }
    items.push({ label: '$(folder-opened) Browse for a compiler folder…', browse: true });
    const pick = await vscode.window.showQuickPick(items, {
        title: 'PIC-MDF › Select Compiler Toolchain',
        placeHolder: 'Detected Microchip compilers — or browse',
        matchOnDescription: true, matchOnDetail: true,
    });
    if (!pick) return null;
    if (pick.browse) {
        const sel = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: 'PIC-MDF: select the compiler folder (with bin/xc8-cc.exe, xc16-gcc.exe …)',
        });
        if (!sel || !sel.length) return null;
        const folder = sel[0].fsPath;
        // figure out WHICH toolchain the folder contains by probing the drivers
        let matched = null;
        for (const id of TOOLCHAIN_IDS) {
            const spec = TOOLCHAINS[id];
            if (_isFile(path.join(folder, 'bin', spec.driver + EXE)) || _isFile(path.join(folder, spec.driver + EXE))) {
                matched = id; break;
            }
        }
        if (!matched) {
            vscode.window.showErrorMessage(`PIC: no known compiler driver found in "${folder}" (looked for bin/xc8-cc, xc16-gcc, xc32-gcc, xc-dsc-gcc).`);
            return null;
        }
        await H.setCfg(matched + '.path', folder);
        vscode.window.showInformationMessage(`PIC: ${TOOLCHAINS[matched].label} path set to "${folder}".`);
        invalidate();
        const fresh = detect();
        if (H.getDevtoolsProvider()) H.getDevtoolsProvider().refresh();
        try { require('./statusBar').refreshStatusBar(); } catch {}
        return fresh;
    }
    if (pick.id) {
        const t = tc[pick.id];
        vscode.window.showInformationMessage(t ? `PIC: ${t.label} — ${t.driver}${t.version ? ' v' + t.version : ''}` : `PIC: ${TOOLCHAINS[pick.id].label} not found.`);
    }
    return null;
}

module.exports = {
    TOOLCHAINS, TOOLCHAIN_IDS,
    detect, invalidate, deviceFlags, mplabDeviceName,
    requireToolchain, cmdSelectToolchain,
    parseDeviceSupport,
};
