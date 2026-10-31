'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// packManager.js — Device Family Pack manager.
//
// Newer Microchip compilers (XC8 v4+, XC32 v5+, XC-DSC v4+) no longer ship
// device-support files inside the compiler: a DFP must be supplied via -mdfp.
// This module makes that painless:
//   • detect()      — where each DFP is installed (our own store + MPLAB X)
//   • forDevice()   — device → the pack(s) that contain it (bundled catalog)
//   • download()    — fetch the .atpack into our store (Node https, progress)
//   • extract()     — unpack ZIP asynchronously with bounded, validated entry streams
//   • ensureFor()   — one call: device → pack present? → download+extract
//
// Store: ~/.pic-mdf/packs/Microchip/<PackName>/<version>/  (own, never touch
// MPLAB X's ~/.mchp_packs — but READ it as an additional source).
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const H      = require('./helpers');
const _declinedThisSession = new Set();
const BundledCatalog = require('./packCatalogData');
let _catalogCache = null;
let _catalogMtime = -1;

function _versionCompare(a, b) {
    const pa = String(a || '').split(/[.+-]/).map(x => /^\d+$/.test(x) ? Number(x) : x);
    const pb = String(b || '').split(/[.+-]/).map(x => /^\d+$/.test(x) ? Number(x) : x);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] === undefined ? 0 : pa[i], y = pb[i] === undefined ? 0 : pb[i];
        if (x === y) continue;
        if (typeof x === 'number' && typeof y === 'number') return x - y;
        return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
    }
    return 0;
}

function _makeCatalog(records) {
    const byName = new Map();
    for (const p of records) {
        if (!p || typeof p.n !== 'string' || !p.n || typeof p.v !== 'string' || !p.v || typeof p.u !== 'string' || !p.u || !Array.isArray(p.d)) continue;
        const old = byName.get(p.n);
        if (!old || _versionCompare(p.v, old.v) >= 0) byName.set(p.n, { n: p.n, v: p.v, u: p.u, d: [...new Set(p.d.filter(x => typeof x === 'string' && x.trim()))] });
    }
    const PACKS = [...byName.values()].filter(p => p.d.length).sort((a, b) => a.n.localeCompare(b.n));
    const DEVICE_INDEX = {}; const BY_NAME = {};
    for (const p of PACKS) {
        BY_NAME[p.n] = p;
        for (const d of p.d) { const k = BundledCatalog.normDev(d); (DEVICE_INDEX[k] = DEVICE_INDEX[k] || []).push(p.n); }
    }
    return { URL_PREFIX: BundledCatalog.URL_PREFIX, PACKS, DEVICE_INDEX, BY_NAME, normDev: BundledCatalog.normDev };
}

function getCatalog(force = false) {
    let livePath = path.join(storeDir(), 'pack_catalog.live.json');
    let mtime = -1; try { mtime = fs.statSync(livePath).mtimeMs; } catch {}
    if (!force && _catalogCache && mtime === _catalogMtime) return _catalogCache;
    let records = BundledCatalog.PACKS.slice();
    try {
        const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
        if (Array.isArray(live)) records = records.concat(live);
    } catch {}
    _catalogCache = _makeCatalog(records);
    _catalogMtime = mtime;
    return _catalogCache;
}

// Where PIC-MDF keeps the packs it downloads itself. Overridable via the
// machine-overridable pic.packStorePath setting (empty = ~/.pic-mdf/packs,
// previously declared but never read).
function storeDir() {
    const custom = String(H.cfg('packStorePath') || '').trim();
    if (!custom) return path.join(os.homedir(), '.pic-mdf', 'packs');
    // Expand a leading ~ (path.resolve alone leaves it literal).
    const expanded = custom.startsWith('~') ? path.join(os.homedir(), custom.slice(1)) : custom;
    return path.resolve(expanded);
}
const STORE = storeDir(); // legacy load-time snapshot kept for compatibility
const MCHP_PACKS = [
    path.join(os.homedir(), '.mchp_packs'),
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents', 'MPLAB', 'packs'),
];

// ─── Installed-pack detection ────────────────────────────────────────────────
// A pack is "installed" when <root>/<PackName>/<version>/<toolchain>/ exists,
// where toolchain ∈ {xc8, xc16, xc32, xc-dsc}. Returns a map
// packName -> {version, dir, toolchainDir, source}.
function _findToolchainDirs(versionDir) {
    const out = {};
    for (const n of ['xc8', 'xc16', 'xc32', 'xc-dsc']) {
        const d = path.join(versionDir, n);
        try { if (fs.statSync(d).isDirectory()) out[n] = d; } catch {}
    }
    return out;
}
function _latestRecord(a, b) {
    if (!a) return b;
    const cmp = _versionCompare(b.version, a.version);
    if (cmp > 0) return b;
    if (cmp < 0) return a;
    // On equal versions, keep an already detected PIC-MDF copy; otherwise prefer
    // the most recently scanned source (MPLAB X packs are usually better located).
    return b.source === 'mplabx' && a.source !== 'pic-mdf' ? b : a;
}
function detect() {
    const out = {};
    const scan = (root, source) => {
        if (!root || !fs.existsSync(root)) return;
        const micro = path.join(root, 'Microchip');
        const bases = fs.existsSync(micro) ? [micro, root] : [root];
        for (const base of bases) {
            let packs; try { packs = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
            for (const p of packs) {
                if (!p.isDirectory() || !/_DFP$/i.test(p.name)) continue;
                const packDir = path.join(base, p.name);
                let vers; try { vers = fs.readdirSync(packDir, { withFileTypes: true }); } catch { continue; }
                for (const v of vers) {
                    if (!v.isDirectory()) continue;
                    const vdir = path.join(packDir, v.name);
                    const toolchainDirs = _findToolchainDirs(vdir);
                    if (!Object.keys(toolchainDirs).length) continue;
                    const primaryName = Object.keys(toolchainDirs)[0];
                    const rec = { version: v.name, dir: vdir, toolchainDir: toolchainDirs[primaryName], toolchain: primaryName, toolchainDirs, source };
                    out[p.name] = _latestRecord(out[p.name], rec);
                }
            }
        }
    };
    scan(storeDir(), 'pic-mdf');
    for (const m of MCHP_PACKS) scan(m, 'mplabx');
    return out;
}

function pathForToolchain(inst, toolchainId, toolchainVersion) {
    if (!inst || !inst.dir) return '';
    const id = toolchainId === 'xcdsc' ? 'xc-dsc' : String(toolchainId || '');
    const dirs = inst.toolchainDirs || _findToolchainDirs(inst.dir);
    if (!dirs[id] && !(id === 'xc-dsc' && dirs.xc16)) return '';
    if (id === 'xc32') {
        // Current XC32 online documentation: -mdfp points to the DFP directory
        // containing xc32, while older releases documented the xc32 subfolder.
        const major = parseInt(String(toolchainVersion || '').split('.')[0], 10);
        if (!Number.isFinite(major) || major >= 5) return inst.dir;
    }
    return dirs[id] || (id === 'xc-dsc' ? dirs.xc16 : '');
}

function findToolchainDir(versionDir) {
    const dirs = _findToolchainDirs(versionDir);
    const name = Object.keys(dirs)[0];
    return name ? { dir: dirs[name], name } : null;
}

// ─── Device → pack mapping ───────────────────────────────────────────────────
// Uses the bundled catalog (device names normalised: PIC/dsPIC prefix dropped).
// One device may live in several packs (e.g. PIC24EP… is in both a PIC24 and a
// dsPIC33E pack); the caller picks by toolchain when possible.
function packsForDevice(device) {
    const cat = getCatalog();
    const key = cat.normDev(device);
    const byName = cat.DEVICE_INDEX[key] || [];
    return byName.map(n => cat.BY_NAME[n]).filter(Boolean);
}

// Which pack for the given device AND toolchain? Prefer a name that matches
// the toolchain family; fall back to the first.
function packForDevice(device, toolchain) {
    const cands = packsForDevice(device);
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    const want = toolchain === 'xcdsc' ? /dsPIC33|dsPIC30/i : toolchain === 'xc16' ? /PIC24|dsPIC/i : toolchain === 'xc32' ? /PIC32|SAM/i : toolchain === 'xc8' ? /PIC10|PIC12|PIC16|PIC18/i : null;
    if (want) {
        const hit = cands.find(p => want.test(p.n));
        if (hit) return hit;
    }
    return cands[0];
}

// ─── Download + extract ──────────────────────────────────────────────────────
// Streaming ZIP extraction and atomic HTTPS downloads; no external tar needed.
const { download, extract } = require('./packIO');

// ─── ensureFor: the one-call entry point ─────────────────────────────────────
// device: 'PIC18F4550' | '24FJ128GA010' | …
// Returns { ok, toolchainDir, pack, version, installed } or { ok:false, error }
async function ensureFor(device, toolchain, { quiet = false } = {}) {
    const pack = packForDevice(device, toolchain);
    if (!pack) {
        if (!quiet) vscode.window.showWarningMessage(`PIC: no Device Family Pack is known for "${device}" — the build may fail. You can install one manually via MPLAB X → Tools → Packs.`);
        return { ok: false, error: 'no pack known for ' + device };
    }
    // already installed (ours or MPLAB X)?
    const inst = detect();
    if (inst[pack.n] && pathForToolchain(inst[pack.n], toolchain)) {
        return { ok: true, toolchainDir: pathForToolchain(inst[pack.n], toolchain), pack: pack.n, version: inst[pack.n].version, installed: true };
    }
    // honour the auto-install setting
    const mode = String(H.cfg('autoInstallDfp') || 'ask').toLowerCase();
    if (mode === 'never') {
        if (!quiet) vscode.window.showWarningMessage(`PIC: ${pack.n} pack (v${pack.v}) for ${device} is not installed — build may fail. Install via "PIC: Install Pack for Project" or Board Manager.`);
        return { ok: false, error: 'disabled by setting' };
    }
    // session cooldown: don't re-prompt for the same pack
    if (mode === 'ask' && _declinedThisSession.has(pack.n)) {
        return { ok: false, error: 'declined earlier this session' };
    }
    let go = true;
    if (mode === 'ask' && !quiet) {
        go = await promptInstall(pack);
        if (!go) _declinedThisSession.add(pack.n);
    }
    if (!go) return { ok: false, error: 'declined' };
    const result = await installPack(pack);
    return result;
}

async function promptInstall(pack) {
    const pick = await vscode.window.showInformationMessage(
        `PIC: device support for this chip needs the ${pack.n} pack (v${pack.v}). Download and install it now?`,
        { modal: false }, 'Download', 'Cancel', "Don't ask again");
    if (pick === "Don't ask again") {
        try { await H.setCfg('autoInstallDfp', 'never'); } catch {}
        _declinedThisSession.add(pack.n);
        return false;
    }
    return pick === 'Download';
}

// Download + extract a single pack into our store.
async function installPack(pack, onProgress) {
    if (!pack || !/^[A-Za-z0-9_.-]+$/.test(pack.n || '') || !/^[A-Za-z0-9_.+-]+$/.test(pack.v || '') || ['.', '..'].includes(pack.n) || ['.', '..'].includes(pack.v)) return { ok: false, error: 'Invalid pack name/version' };
    const cat = getCatalog();
    const url = /^https?:\/\//i.test(pack.u) ? pack.u : cat.URL_PREFIX + pack.u;
    const store = storeDir();
    const tmpDir = path.join(store, '.tmp');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    const workDir = await fs.promises.mkdtemp(path.join(tmpDir, 'install-'));
    const atpack = path.join(workDir, 'pack.atpack');
    const destDir = path.join(store, 'Microchip', pack.n, pack.v);
    try {
        H.log(`[pack] downloading ${pack.n} v${pack.v} …`);
        await download(url, atpack, onProgress);
        H.log(`[pack] extracting ${pack.n} → ${destDir}`);
        await extract(atpack, destDir);
        try { fs.unlinkSync(atpack); } catch {}
        const dirs = _findToolchainDirs(destDir);
        const tc = findToolchainDir(destDir);
        H.log(`[pack] installed ${pack.n} v${pack.v} (toolchains: ${Object.keys(dirs).join(', ') || 'NOT FOUND'})`);
        return { ok: true, toolchainDir: tc ? tc.dir : null, toolchainDirs: dirs, pack: pack.n, version: pack.v, installed: false };
    } catch (e) {
        H.log(`[pack] install FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
    }
}

// ─── Command: install a pack for the active project's device ─────────────────
async function cmdInstallPackForProject() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const Validator = require('./validator');
    const Boards = require('./boards');
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const board = Boards.getBoard(proj.board);
    if (!board) { vscode.window.showErrorMessage(`PIC: board "${proj.board}" not found.`); return; }
    const tcId = H.resolveToolchain(proj);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `PIC: installing device pack for ${board.build.device}`, cancellable: false }, async (progress) => {
        const res = await ensureFor(board.build.device, tcId);
        if (res.ok) vscode.window.showInformationMessage(`✅ PIC: ${res.pack} v${res.version} ${res.installed ? 'already installed' : 'installed'}.`);
        else if (res.error !== 'declined') vscode.window.showErrorMessage(`PIC: pack install failed — ${res.error}`);
    });
}

// ─── More commands ───────────────────────────────────────────────────────────
async function cmdInstallPackByName() {
    const cat = getCatalog();
    const items = cat.PACKS.slice().sort((a, b) => a.n.localeCompare(b.n)).map(p => ({
        label: p.n, description: `v${p.v}`, detail: `${p.d.length} device(s)`,
        packName: p.n,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: 'PIC: install a Device Pack', placeHolder: 'Choose a pack', matchOnDescription: true, matchOnDetail: true });
    if (!pick) return;
    const pack = getCatalog().BY_NAME[pick.packName];
    const inst = detect()[pack.n];
    if (inst) {
        const go = await vscode.window.showInformationMessage(`${pack.n} v${inst.version} is already installed (${inst.source}). Re-download v${pack.v}?`, { modal: true }, 'Re-download');
        if (go !== 'Re-download') return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `PIC: installing ${pack.n}`, cancellable: false }, async () => {
        const res = await installPack(pack);
        if (res.ok) vscode.window.showInformationMessage(`✅ PIC: ${pack.n} v${pack.v} installed.`);
        else vscode.window.showErrorMessage(`PIC: install failed — ${res.error}`);
    });
}

function cmdListPacks() {
    const inst = detect();
    const names = Object.keys(inst).sort();
    const ch = vscode.window.createOutputChannel('PIC — Device Packs');
    ch.clear();
    ch.appendLine(`Installed Device Family Packs (${names.length}):`);
    ch.appendLine('');
    if (!names.length) ch.appendLine('  (none — use "PIC: Install Device Pack for This Project")');
    for (const n of names) {
        const p = inst[n];
        ch.appendLine(`  ${n}  v${p.version}  [${p.source}]`);
        ch.appendLine(`      ${p.toolchainDir}`);
    }
    ch.appendLine('');
    ch.appendLine(`Store: ${storeDir()}`);
    const cat = getCatalog();
    ch.appendLine(`Catalog: ${cat.PACKS.length} packs / ${Object.keys(cat.DEVICE_INDEX).length} devices (${_catalogMtime >= 0 ? 'live snapshot merged with bundled fallback' : 'bundled snapshot'}).`);
    ch.show(true);
}

// Refresh the catalog from the live repository page (best-effort).
async function cmdUpdateCatalog() {
    const url = 'https://packs.download.microchip.com/';
    const store = storeDir();
    const target = path.join(store, 'pack_catalog.live.json');
    const htmlTmp = path.join(store, 'pack_catalog.download.html');
    try {
        fs.mkdirSync(store, { recursive: true });
        await download(url, htmlTmp);
        const html = fs.readFileSync(htmlTmp, 'utf8');
        try { fs.unlinkSync(htmlTmp); } catch {}
        const parsed = parseRepositoryHtml(html);
        if (!parsed.length) { vscode.window.showWarningMessage('PIC: the repository page was fetched but no packs parsed. The previous catalog was kept.'); return; }
        if (parsed.length < 50) { vscode.window.showWarningMessage(`PIC: repository parser found only ${parsed.length} packs; previous catalog was kept as a safety check.`); return; }
        fs.writeFileSync(target, JSON.stringify(parsed, null, 2) + '\n');
        getCatalog(true);
        vscode.window.showInformationMessage(`✅ PIC: live catalog loaded — ${parsed.length} current packs. Search and installation use it immediately.`);
    } catch (e) {
        try { fs.unlinkSync(htmlTmp); } catch {}
        vscode.window.showErrorMessage(`PIC: catalog update failed — ${e.message}`);
    }
}

// Parse the repository HTML the same way zzz/parse2.js does (kept minimal).
function parseRepositoryHtml(t) {
    const artRe = /<article class="pack-card"([\s\S]*?)<\/article>/g;
    const byName = new Map();
    let m;
    const cmp = (a, b) => {
        const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x - y; }
        return 0;
    };
    while ((m = artRe.exec(t)) !== null) {
        const b = m[1];
        const sub = (/<div class="pack-subtitle">([^<]*)<\/div>/.exec(b) || [])[1] || '';
        const href = (/href="(https:\/\/packs\.download\.microchip\.com\/[^"]+\.atpack)"/.exec(b) || [])[1] || '';
        const ver = (/class="pack-version"[^>]*>v?([^<]+)<\/a>/.exec(b) || [])[1] || '';
        const packName = sub.split('\u2022').pop().trim();
        const devs = []; const dr = /class="device-chip"[^>]*id="([^"]+)"/g; let d;
        while ((d = dr.exec(b)) !== null) devs.push(d[1]);
        if (packName && href) {
            const rec = { n: packName, v: ver, u: href.replace('https://packs.download.microchip.com/Microchip.', ''), d: devs };
            const cur = byName.get(packName);
            if (!cur || cmp(ver, cur.v) > 0) byName.set(packName, rec);
        }
    }
    return [...byName.values()].filter(p => p.d.length);
}

function cmdOpenStore() {
    const store = storeDir();
    try { fs.mkdirSync(store, { recursive: true }); } catch {}
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(store));
}


// ─── Config Bits from DFP chipinfo ──────────────────────────────────────────
// Returns { fields: { name: { values:[], default: string, desc: string } } }
// for the given device, parsed from the installed DFP's chip HTML. null if no
// DFP / no chip file / parse failure.
function getConfigBits(device, toolchain) {
    if (!device) return null;
    const insts = detect();
    // find an installed pack that actually contains this device's chip html
    let inst = null;
    for (const name of Object.keys(insts)) {
        const it = insts[name];
        let dev = String(device).toLowerCase();
        if (dev.startsWith('pic')) dev = dev.slice(3);
        for (const tc of ['xc8','xc16','xc32','xc-dsc']) {
            const d = (it.toolchainDirs && it.toolchainDirs[tc]) || null;
            const bases = d ? [d, path.dirname(d)] : [it.dir];
            for (const b of bases) {
                const cand = path.join(b, 'docs', 'chips', dev + '.html');
                try { if (fs.statSync(cand).isFile()) { inst = it; break; } } catch {}
            }
            if (inst) break;
        }
        if (inst) break;
    }
    if (!inst || !inst.dir) return null;
    let dev = String(device).toLowerCase();
    if (dev.startsWith('pic')) dev = dev.slice(3);
    // candidate chip html paths
    const cands = [];
    for (const tc of ['xc8','xc16','xc32','xc-dsc']) {
        const d = inst.toolchainDirs && inst.toolchainDirs[tc];
        if (d) {
            const base = path.dirname(d); // version dir level? d is .../xc8
            // d is .../<version>/xc8 ; docs at .../<version>/xc8/docs or .../<version>/docs
            cands.push(path.join(d, 'docs', 'chips', dev + '.html'));
            cands.push(path.join(path.dirname(d), 'docs', 'chips', dev + '.html'));
        }
        cands.push(path.join(inst.dir, tc, 'docs', 'chips', dev + '.html'));
    }
    cands.push(path.join(inst.dir, 'docs', 'chips', dev + '.html'));
    let html = null, htmlPath = null;
    for (const c of cands) {
        try { if (fs.statSync(c).isFile()) { html = fs.readFileSync(c, 'utf8'); htmlPath = c; break; } } catch {}
    }
    if (!html) return null;
    // parse defaults from example pragma config line
    const defaults = {};
    const pragmaMatch = html.match(/#pragma config ([^<]+)/i);
    if (pragmaMatch) {
        for (const part of pragmaMatch[1].split(',')) {
            const m = part.trim().match(/^([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_]+)/);
            if (m) defaults[m[1]] = m[2];
        }
    }
    // parse Configuration Registers & Settings section
    let secIdx = html.indexOf('Configuration Registers & Settings');
    if (secIdx < 0) secIdx = html.indexOf('Configuration Registers &amp; Settings');
    if (secIdx < 0) return null;
    const section = html.slice(secIdx);
    const rows = section.match(/<tr[^>]*>(.*?)<\/tr>/gs) || [];
    const fields = {};
    let cur = null;
    for (const r of rows) {
        if (/<b><tt>/.test(r)) {
            const m = r.match(/<b><tt>([^<]+)<\/tt><\/b>/);
            if (m) {
                cur = m[1].trim();
                if (!fields[cur]) fields[cur] = { values: [], default: defaults[cur] || null, desc: '' };
                const m2 = r.match(/<\/td>\s*<td[^>]*>(.*?)<\/td>/s);
                if (m2) fields[cur].desc = m2[1].replace(/<[^>]+>/g, '').trim();
                continue;
            }
        }
        const m = r.match(/<tt>([^<]+)<\/tt>/);
        if (m && cur && !/<b><tt>/.test(r)) {
            const val = m[1].trim();
            const m2 = r.match(/<\/td>\s*<td[^>]*>(.*?)<\/td>/s);
            const desc = m2 ? m2[1].replace(/<[^>]+>/g, '').trim() : '';
            if (!fields[cur]) fields[cur] = { values: [], default: defaults[cur] || null, desc: '' };
            fields[cur].values.push({ value: val, desc });
            if (!fields[cur].default && defaults[cur] === val) fields[cur].default = val;
            continue;
        }
        if (/Register:/.test(r)) { cur = null; }
    }
    // apply defaults: if no default found, use first value
    for (const k of Object.keys(fields)) {
        if (!fields[k].default && fields[k].values.length) fields[k].default = fields[k].values[0].value;
    }
    if (!Object.keys(fields).length) return null;
    return { fields, htmlPath };
}

module.exports = {
    STORE, storeDir, detect, packsForDevice, packForDevice, pathForToolchain, getCatalog,
    download, extract, ensureFor, installPack, getConfigBits,
    cmdInstallPackForProject, cmdInstallPackByName, cmdListPacks,
    cmdUpdateCatalog, cmdOpenStore, parseRepositoryHtml,
};
