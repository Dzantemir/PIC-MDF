'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// boards.js — the MCU database (Microchip PIC device JSON files).
// Priority: project .pic/boards/ → pic.boardsDir → ~/.pic-mdf/boards →
// the built-in boards/ shipped with the extension. Also: the board picker,
// the per-architecture main.c templates and the build-flag resolution.
//
// A board JSON looks like:
//   { name, vendor, toolchain, build:{ device, family, f_cpu, f_cpu_hz,
//     memory:{flash,ram,eeprom}, config_bits?, extra_flags? }, upload:{…} }
// The device is the MPLAB spelling the drivers expect (PIC18F4550, 24FJ…,
// 32MZ…, 33CK…). toolchain ∈ {xc8,xc16,xc32,xcdsc}.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const H      = require('./helpers');

const BUILTIN_DIR = path.join(path.dirname(__dirname), 'boards');
const GLOBAL_DIR  = path.join(os.homedir(), '.pic-mdf', 'boards');

// ─── Loading ─────────────────────────────────────────────────────────────────
function _scanDir(dir, out, origin) {
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { _scanDir(path.join(dir, entry.name), out, origin); continue; }
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
            if (entry.name === 'boards-index.json') continue;
            const id = entry.name.replace(/\.json$/i, '').toLowerCase();
            const full = path.join(dir, entry.name);
            const { ok, data, error } = H.readJsonFile(full);
            if (!ok || !data || !data.build || !data.build.device) {
                H.log(`[boards] skipped ${full}: ${error || 'no build.device'}`);
                continue;
            }
            out.set(id, Object.assign({}, data, { id, _path: full, _origin: origin }));
        }
    } catch {}
}

function loadBoards() {
    const cached = H.getBoardCache();
    if (cached && cached.stamp === _stamp()) return cached.map;

    const map = new Map();
    _scanDir(BUILTIN_DIR, map, 'builtin');
    try { fs.mkdirSync(GLOBAL_DIR, { recursive: true }); _scanDir(GLOBAL_DIR, map, 'global'); } catch {}
    const extra = String(H.cfg('boardsDir') || '');
    if (extra && fs.existsSync(extra)) _scanDir(extra, map, 'dir');
    const root = H.getActiveRoot();
    if (root) _scanDir(path.join(root, '.pic', 'boards'), map, 'project');

    H.setBoardCache({ stamp: _stamp(), map });
    return map;
}
function invalidate() { H.setBoardCache(null); }
let _stampCache = null;
function _stamp() {
    if (_stampCache) return _stampCache;
    _stampCache = JSON.stringify([H.cfg('boardsDir'), H.getActiveRoot()]);
    setTimeout(() => { _stampCache = null; }, 0).unref?.();
    return _stampCache;
}

function getBoard(id) {
    if (!id) return null;
    const map = loadBoards();
    if (map.has(String(id).toLowerCase())) return map.get(String(id).toLowerCase());
    for (const b of map.values()) if (String(b.build.device).toLowerCase() === String(id).toLowerCase()) return b;
    return null;
}
function allBoards() { return [...loadBoards().values()]; }

// ─── Normalised summaries (Project Editor dropdown) ──────────────────────────
function _fCpuHz(build) {
    const v = build && build.f_cpu_hz;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    const raw = build && build.f_cpu;
    if (typeof raw === 'string') {
        const n = Number(raw.replace(/[_\s]*(?:UL|ul|U|u|L|l)?$/, '').replace(/_/g, ''));
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}
function listBoardsDetailed() {
    return allBoards()
        .map(b => ({
            id: b.id,
            name: b.name || b.id,
            vendor: b.vendor || 'Microchip',
            toolchain: b.toolchain || 'xc8',
            device: b.build.device,
            family: b.build.family || '',
            flash: (b.build.memory && b.build.memory.flash) ?? null,
            ram: (b.build.memory && b.build.memory.ram) ?? null,
            eeprom: (b.build.memory && b.build.memory.eeprom) ?? null,
            f_cpu_hz: _fCpuHz(b.build),
            protocol: (b.upload && b.upload.protocol) || '',
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function boardInfoLine(id) {
    const b = getBoard(id);
    if (!b) return '';
    const seg = (label, n) => {
        const v = Number(n);
        if (!Number.isFinite(v) || v <= 0) return null;
        return label + ' ' + ((v >= 1024 && v % 1024 === 0) ? String(v / 1024) + 'K' : String(v)) + 'B';
    };
    const parts = [String(b.name || id), String(b.toolchain || 'xc8'), String(b.build.device)];
    let s;
    if ((s = seg('flash', b.build.memory && b.build.memory.flash))) parts.push(s);
    if ((s = seg('RAM', b.build.memory && b.build.memory.ram))) parts.push(s);
    if ((s = seg('EEPROM', b.build.memory && b.build.memory.eeprom))) parts.push(s);
    const hz = _fCpuHz(b.build);
    if (hz) parts.push(String(Math.round(hz / 1e4) / 100) + ' MHz');
    if (b.build.family) parts.push(String(b.build.family));
    return parts.join(' · ');
}

// ─── Build flags ─────────────────────────────────────────────────────────────
// All device flags come from the toolchain descriptor; F_CPU from the board.
// F_CPU is the XC convention: XC8 uses _XTAL_FREQ (or F_CPU for the AVR
// backend), the 16/32-bit compilers set FOSC via config bits and derive the
// clock; we still pass -DF_CPU=<hz> as a portable convenience.
function buildFlags(board) {
    const Toolchain = require('./toolchain');
    const tcId = board.toolchain || 'xc8';
    const flags = Toolchain.deviceFlags(tcId, board.build.device);
    const hz = _fCpuHz(board.build);
    if (hz) {
        flags.push(`-DF_CPU=${hz}UL`);
        if (tcId === 'xc8') flags.push(`-D_XTAL_FREQ=${hz}UL`);
    }
    for (const f of (board.build.extra_flags || [])) flags.push(f);
    return flags;
}

// ─── Board picker (grouped by toolchain, searchable) ─────────────────────────
async function selectBoard(currentId, { placeHolder } = {}) {
    const map = loadBoards();
    const groups = new Map();
    for (const b of map.values()) {
        const g = b.toolchain || 'xc8';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(b);
    }
    const Toolchain = require('./toolchain');
    const items = [];
    for (const g of ['xc8', 'xc16', 'xc32', 'xcdsc']) {
        const list = groups.get(g);
        if (!list || !list.length) continue;
        const spec = Toolchain.TOOLCHAINS[g];
        items.push({ label: spec ? spec.label : g, kind: vscode.QuickPickItemKind.Separator });
        for (const b of list.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
            const mem = b.build.memory || {};
            const flash = mem.flash || 0, ram = mem.ram || 0, eeprom = mem.eeprom || 0;
            const fcpuHz = _fCpuHz(b.build) || 0;
            const sz = n => (n >= 1024 && n % 1024 === 0) ? String(n / 1024) + 'K' : String(n);
            items.push({
                label: (b.id === currentId ? '$(check) ' : '') + (b.name || b.id),
                description: b.build.device,
                detail: `${b.build.family || ''}` +
                    (flash ? ` · flash ${sz(flash)}B` : '') +
                    (ram ? ` · RAM ${sz(ram)}B` : '') +
                    (eeprom ? ` · EEPROM ${sz(eeprom)}B` : '') +
                    (fcpuHz ? ` · ${(fcpuHz / 1e6).toFixed(fcpuHz % 1e6 ? 1 : 0)} MHz` : '') +
                    (b.upload && b.upload.protocol ? ` · ${b.upload.protocol}` : ''),
                board: b,
            });
        }
    }
    const pick = await vscode.window.showQuickPick(items, {
        matchOnDescription: true, matchOnDetail: true,
        placeHolder: placeHolder || 'Select the target PIC device',
    });
    return pick && pick.board ? pick.board.id : null;
}

// ─── main.c templates (per architecture / toolchain) ─────────────────────────
function mainTemplate(board, toolchain) {
    const tcId = toolchain || (board && board.toolchain) || 'xc8';
    const dev = board ? board.build.device : 'PIC18F4550';
    const name = board ? (board.name || dev) : dev;
    const fcpuHz = board ? (_fCpuHz(board.build) || 8000000) : 8000000;
    if (tcId === 'xc8') return _tplXc8(name, dev, fcpuHz, board);
    return _tplGccLike(name, dev, fcpuHz, tcId, board);
}

// XC8 8-bit PIC blink: <xc.h>, #pragma config, __delay_ms (needs _XTAL_FREQ).
function _tplXc8(name, dev, fcpuHz, board) {
    // Configuration bits are NOT emitted here — the build injects a generated
    // _pic_config_bits.c (one single source of truth; two copies would be a
    // duplicate-config error). Edit them in the Configuration Bits editor.
    const cfgLines = `// Configuration bits are set by the generated _pic_config_bits.c\n// (PIC: Open Configuration Bits Editor…).`;
    const hasEeprom = board && board.build.memory && board.build.memory.eeprom;
    return `/*
 * ${name} — bare-metal blink (MPLAB XC8, 8-bit PIC)
 * Device: ${dev}
 * Build with the PIC-MDF pipeline (xc8-cc). _XTAL_FREQ feeds __delay_ms().
 */
#include <xc.h>
#include <stdint.h>

${cfgLines}

#define _XTAL_FREQ ${fcpuHz}UL

int main(void)
{
    /* Configure the LED pin as output — adjust to your wiring. */
    TRISBbits.TRISB0 = 0;   /* RB0 output (classic mid-range/PIC18) */

    for (;;)
    {
        LATBbits.LATB0 = 1;   /* on  */
        __delay_ms(500);
        LATBbits.LATB0 = 0;   /* off */
        __delay_ms(500);
    }
}
`;
}

// 16/32-bit XC compilers: <xc.h>, FOSC config, __delay_ms where available.
function _tplGccLike(name, dev, fcpuHz, tcId, board) {
    const archNote = tcId === 'xc16' ? '16-bit (XC16)'
        : tcId === 'xc32' ? '32-bit (XC32)'
        : 'dsPIC DSC (XC-DSC)';
    // See _tplXc8: the generated _pic_config_bits.c is the single source of
    // configuration bits for every toolchain.
    const cfgLines = `// Configuration bits are set by the generated _pic_config_bits.c.`;
    return `/*
 * ${name} — bare-metal blink (Microchip ${archNote})
 * Device: ${dev}
 */
#include <xc.h>
#include <stdint.h>

${cfgLines}

#define FCY ${fcpuHz}UL

int main(void)
{
    /* Configure an output pin — adjust to your wiring. */
    TRISAbits.TRISA0 = 0;

    for (;;)
    {
        LATAbits.LATA0 ^= 1;
        __delay_ms(500);
    }
}
`;
}

module.exports = {
    loadBoards, invalidate, getBoard, allBoards,
    listBoardsDetailed, boardInfoLine,
    buildFlags, selectBoard, mainTemplate,
    GLOBAL_DIR,
};
