'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// intellisense.js — .vscode/c_cpp_properties.json generator (cpptools).
// The real compiler is the source of truth: compilerPath = the active
// toolchain driver, compilerArgs = the device flag. cpptools then derives the
// built-in macros and the system include paths from the compiler itself.
// Add-if-missing: an existing "PIC" configuration is only patched when fields
// are absent.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Toolchain = require('./toolchain');
const Boards = require('./boards');
const Validator = require('./validator');
const { resolveProject } = require('./sources');

const CONFIG_NAME = 'PIC';

function _cppFileFor(root) {
    const vsDir = path.join(root, '.vscode');
    return { vsDir, file: path.join(vsDir, 'c_cpp_properties.json') };
}
function _writeAtomic(file, text) {
    const tmp = file + '.pic-tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

async function cmdConfigureIntelliSense() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const id = H.resolveToolchain(proj);
    const tc = Toolchain.requireToolchain(id);
    if (!tc) return;
    const done = mergeConfig(root, proj, tc);
    if (done) vscode.window.showInformationMessage('PIC: IntelliSense configuration written (.vscode/c_cpp_properties.json).');
}

async function syncAfterProjectChange() {
    const root = H.getActiveRoot();
    if (!root) return;
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') return;
    if (!H.cfg('intellisense.autoConfig')) return;
    const id = H.resolveToolchain(proj);
    const tc = Toolchain.detect()[id];
    if (!tc) return;
    try { mergeConfig(root, proj, tc); } catch (e) { H.log(`[intellisense] sync failed: ${e.message}`); }
}

function mergeConfig(root, proj, tc) {
    const { vsDir, file } = _cppFileFor(root);
    try { fs.mkdirSync(vsDir, { recursive: true }); } catch {}

    let doc = null;
    if (fs.existsSync(file)) {
        for (const d of vscode.window.visibleTextEditors) {
            if (d.document.uri.fsPath === file && d.document.isDirty) { H.log('[intellisense] c_cpp_properties.json has unsaved edits — skipped'); return false; }
        }
        const { ok, data, error } = H.readJsonFile(file);
        if (!ok) { H.log(`[intellisense] ${path.basename(file)} is not valid JSON (${error}) — left alone`); return false; }
        doc = data;
    }
    if (!doc || typeof doc !== 'object') doc = {};
    if (!Array.isArray(doc.configurations)) doc.configurations = [];

    const board = Boards.getBoard(proj.board);
    const device = board ? board.build.device : String(proj.board || '').toUpperCase();
    const hz = board && board.build ? (board.build.f_cpu_hz || 0) : 0;
    const defines = [];
    if (hz) { defines.push(`F_CPU=${hz}UL`, `FCY=${hz}UL`); if (tc.id === 'xc8') defines.push(`_XTAL_FREQ=${hz}UL`); }
    for (const d of (proj.defines || [])) {
        defines.push(String(typeof d === 'string' ? d : (d && d.name) || ''));
    }

    const includePath = [];
    try {
        for (const inc of resolveProject(root, proj, String(H.cfg('externalSdkPath') || '').trim()).includeDirs) {
            const fwd = _fwd(inc);
            if (!includePath.some(x => x.toLowerCase() === fwd.toLowerCase())) includePath.push(fwd);
        }
    } catch (e) { H.log(`[intellisense] components could not be resolved: ${e.message}`); }
    for (const inc of (tc.includeDirs || [])) includePath.push(_fwd(inc));
    includePath.push('${workspaceFolder}/**');

    const entry = {
        name: CONFIG_NAME,
        compilerPath: _fwd(tc.driver),
        compilerArgs: Toolchain.deviceFlags(tc.id, device),
        defines: defines.filter(Boolean),
        includePath,
        cStandard: 'c11',
        cppStandard: 'c++17',
        intelliSenseMode: 'gcc-x86',
    };

    const existing = doc.configurations.find(c => c && c.name === CONFIG_NAME);
    if (existing) {
        let touched = false;
        for (const k of ['compilerPath', 'compilerArgs', 'defines', 'includePath', 'cStandard', 'cppStandard', 'intelliSenseMode']) {
            if (existing[k] === undefined) { existing[k] = entry[k]; touched = true; }
        }
        if (!touched) { H.log('[intellisense] PIC configuration already present'); return false; }
    } else {
        doc.configurations.push(entry);
    }
    doc.version = 4;
    _writeAtomic(file, JSON.stringify(doc, null, 2) + '\n');
    H.log(`[intellisense] written (compilerPath: ${entry.compilerPath}, device flag: ${entry.compilerArgs.join(' ')})`);
    return true;
}
function _fwd(p) { return String(p).replace(/\\/g, '/'); }

module.exports = { cmdConfigureIntelliSense, syncAfterProjectChange };
