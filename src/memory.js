'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// memory.js — the memory report engine (pure node, no vscode).
// Section sizes come from `<objdump> -h <elf>` (available in every Microchip
// toolchain), mapped per architecture to flash/RAM/EEPROM. The avr-style
// avr-size is NOT present in the 16/32-bit distributions, so objdump is the
// one tool that works everywhere.
// History is persisted per project in build/.pic-memory-history.json.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const cp   = require('child_process');

const HIST_FILE = '.pic-memory-history.json';

// ─── Section → area mapping per toolchain ────────────────────────────────────
// 8-bit PIC (XC8): program = .text/.const/.data(init)/.config ; RAM = .data/.bss
// 16-bit (XC16/XC-DSC): program = .text/.const/.dinit/.data ; RAM = .data/.bss/.nbss/.ndata
// 32-bit (XC32): program = .text/.rodata/.data ; RAM = .data/.bss/.sbss
const FLASH_SECTIONS = new Set([
    '.text', '.rodata', '.const', '.dinit', '.data', '.init', '.fini',
    '.init_array', '.fini_array', '.config', '.text.startup', '.text.hot',
    '.gnu.linkonce.r', '.gnu.linkonce.t',
]);
const RAM_SECTIONS = new Set([
    '.data', '.bss', '.nbss', '.ndata', '.sbss', '.sdata', '.noinit', '.heap', '.stack',
]);
const EEPROM_SECTIONS = new Set(['.eeprom', '.eedata', '.eeprom_data']);

// `objdump -h` gives both size and flags; sections with A (alloc) + not W are
// const/program; W sections are RAM. We keep it simple and map by name, then
// fall back to flags for unknown names.
function parseObjdumpSections(text) {
    const sections = {};
    const lines = String(text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        // header:  3 .text         00000100  00000000  00000000  00001000  2**2
        const m = /^\s*\d+\s+(\.\S+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)/.exec(lines[i]);
        if (m) {
            const name = m[1];
            const size = parseInt(m[2], 16);
            if (Number.isFinite(size)) sections[name] = (sections[name] || 0) + size;
        }
    }
    return Object.keys(sections).length ? sections : null;
}

function computeUsage(sections, board) {
    let flash = 0, ram = 0, eeprom = 0;
    for (const [name, size] of Object.entries(sections || {})) {
        if (EEPROM_SECTIONS.has(name)) { eeprom += size; continue; }
        if (RAM_SECTIONS.has(name)) { ram += size; continue; }
        if (FLASH_SECTIONS.has(name)) { flash += size; continue; }
        if (name.startsWith('.text') || name.startsWith('.rodata') || name.startsWith('.const')) flash += size;
        else if (name.startsWith('.bss') || name.startsWith('.data')) ram += size;
    }
    const limits = board && board.build && board.build.memory
        ? board.build.memory
        : { flash: 0, ram: 0, eeprom: 0 };
    return {
        flash: { used: flash, total: limits.flash || 0 },
        ram:   { used: ram,   total: limits.ram || 0 },
        eeprom:{ used: eeprom, total: limits.eeprom || 0 },
        sections,
    };
}

function usageText(usage) {
    const parts = [];
    const pct = (u, t) => t > 0 ? `${Math.round(u / t * 100)}%` : '?';
    if (usage.flash.total) parts.push(`Flash ${usage.flash.used}/${usage.flash.total}B (${pct(usage.flash.used, usage.flash.total)})`);
    if (usage.ram.total) parts.push(`RAM ${usage.ram.used}/${usage.ram.total}B (${pct(usage.ram.used, usage.ram.total)})`);
    return parts.join(' · ');
}

function _fmtHuman(n) {
    if (n >= 1024 * 1024) { const r = Math.round(n / (1024 * 1024) * 10) / 10; return (r % 1 ? r.toFixed(1) : String(r)) + 'M'; }
    if (n >= 1024) { const r = Math.round(n / 1024 * 10) / 10; return (r % 1 ? r.toFixed(1) : String(r)) + 'K'; }
    return `${n}B`;
}
function usageHuman(usage) {
    const u = usage || {};
    const parts = [];
    const pct = (used, total) => total > 0 ? `${Math.round(used / total * 100)}%` : '?';
    if (u.ram && u.ram.total) parts.push(`RAM ${_fmtHuman(u.ram.used)}/${_fmtHuman(u.ram.total)} (${pct(u.ram.used, u.ram.total)})`);
    if (u.eeprom && u.eeprom.used > 0 && u.eeprom.total) parts.push(`EEPROM ${_fmtHuman(u.eeprom.used)}/${_fmtHuman(u.eeprom.total)} (${pct(u.eeprom.used, u.eeprom.total)})`);
    if (u.flash && u.flash.total) parts.push(`Flash ${_fmtHuman(u.flash.used)}/${_fmtHuman(u.flash.total)} (${pct(u.flash.used, u.flash.total)})`);
    return parts.join(' · ');
}

// ─── Symbols via nm ──────────────────────────────────────────────────────────
function symbolSizes(toolchain, nmPath, elfPath, limit = 40) {
    return new Promise((resolve) => {
        try {
            if (!nmPath) { resolve([]); return; }
            const r = cp.spawnSync(nmPath, ['--size-sort', '--radix=d', '-S', elfPath], {
                timeout: 10000, encoding: 'utf8', windowHide: true,
            });
            const out = [];
            for (const line of String(r.stdout || '').split('\n')) {
                const m = /^\s*(\d+)\s+(\d+)\s+([A-Za-z?])\s+(\S+)$/.exec(line);
                if (!m) continue;
                out.push({ size: parseInt(m[1], 10), name: m[4], type: m[3] });
            }
            out.sort((a, b) => b.size - a.size);
            resolve(out.slice(0, limit));
        } catch { resolve([]); }
    });
}

// ─── Report persistence ──────────────────────────────────────────────────────
let _last = null;
const _collectCbs = [];
function onCollect(cb) { if (typeof cb === 'function') _collectCbs.push(cb); }
function _notify() {
    for (const cb of _collectCbs.slice()) { try { cb(); } catch {} }
}

function histPath(root, outDirAbs) {
    const outDir = outDirAbs || path.join(root, 'build');
    return path.join(outDir, HIST_FILE);
}
function readHistory(root, outDirAbs) {
    try {
        const p = histPath(root, outDirAbs);
        if (!fs.existsSync(p)) return [];
        return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch { return []; }
}
function writeHistory(root, list, outDirAbs, cap = 200) {
    try {
        const p = histPath(root, outDirAbs);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(list.slice(-Math.max(200, cap)), null, 2));
    } catch {}
}

async function generate(root, proj, board, opts) {
    opts = opts || {};
    const usage = computeUsage(opts.sections, board);
    const symbols = opts.elfPath ? await symbolSizes(opts.toolchain, opts.nmPath, opts.elfPath) : [];
    const entry = {
        ts: new Date().toISOString(),
        board: proj.board,
        usage: { flash: usage.flash, ram: usage.ram, eeprom: usage.eeprom },
    };
    // pic.memory.historyLimit (previously declared but never read).
    const limitRaw = Number(opts.historyLimit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 50;
    const hist = readHistory(root, opts.outDir);
    hist.push(entry);
    writeHistory(root, hist, opts.outDir, limit);

    _last = {
        root, board, elfPath: opts.elfPath, hexPath: opts.hexPath, mapPath: opts.mapPath, usage, symbols,
        history: hist.slice(-limit), ts: entry.ts, toolchain: require('./helpers').resolveToolchain(proj),
    };
    _notify();
    return _last;
}

function lastReport() { return _last; }
function lastUsageText() { return _last ? usageText(_last.usage) : ''; }
function lastUsageHuman() { return _last ? usageHuman(_last.usage) : ''; }
function reset() { _last = null; _notify(); }

module.exports = {
    computeUsage, usageText, usageHuman,
    parseObjdumpSections, symbolSizes,
    generate, lastReport, lastUsageText, lastUsageHuman, reset, onCollect,
};
