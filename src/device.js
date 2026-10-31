'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// device.js — Configuration Bits editor + disassembly (per architecture).
//
// Config bits are the PIC analogue of the AVR fuses: device-specific named
// fields with a fixed set of values. The editor reads the fields from the
// board JSON (build.config_bits, where each entry is name → value) or, when
// the board carries none, offers a raw 16/32-bit hex editor. Writing the
// config is done through the compiler: a small generated source file with
// #pragma config statements that is rebuilt into the .hex.
//
// Disassembly uses the toolchain's own objdump (<xc-objdump> -d -S).
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const cp     = require('child_process');
const H      = require('./helpers');
const Toolchain = require('./toolchain');
const Boards = require('./boards');
const Validator = require('./validator');

// ─── Config Bits editor (webview) ────────────────────────────────────────────
let _panel = null;
let _panelRoot = null;

function openConfigEditor() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const board = Boards.getBoard(proj.board);
    if (!board) { vscode.window.showErrorMessage(`PIC: board "${proj.board}" not found.`); return; }

    if (_panel && _panelRoot === root) { _panel.reveal(vscode.ViewColumn.One); return; }
    if (_panel) { try { _panel.dispose(); } catch {} }
    _panelRoot = root;
    _panel = vscode.window.createWebviewPanel(
        'pic.configEditor', `PIC — Config Bits (${path.basename(root)})`, vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    _panel.webview.html = _renderConfig(board, proj);
    _panel.webview.onDidReceiveMessage(async (m) => {
        if (!m) return;
        if (m.type === 'saveConfig') { _saveConfig(root, proj, board, m.bits); return; }
        if (m.type === 'loadFromDfp') {
            try {
                const PM = require('./packManager');
                const cb = PM.getConfigBits(board.build.device, board.toolchain || H.resolveToolchain(proj));
                if (cb && cb.fields && Object.keys(cb.fields).length) {
                    _panel.webview.html = _renderConfig(board, proj, cb);
                } else {
                    // try install
                    const res = await PM.ensureFor(board.build.device, board.toolchain || H.resolveToolchain(proj));
                    if (res && res.ok) {
                        const cb2 = PM.getConfigBits(board.build.device, board.toolchain || H.resolveToolchain(proj));
                        if (cb2 && cb2.fields && Object.keys(cb2.fields).length) {
                            _panel.webview.html = _renderConfig(board, proj, cb2);
                            return;
                        }
                    }
                    vscode.window.showWarningMessage('PIC: no configuration-bit data found for ' + board.build.device + '.');
                }
            } catch (e) { vscode.window.showErrorMessage('PIC: ' + e.message); }
            return;
        }
    });
    _panel.onDidDispose(() => { _panel = null; _panelRoot = null; });
}

function _saveConfig(root, proj, board, bits) {
    // bits: { fieldName: value } — written into the board's config_bits via the
    // PROJECT (.pic/boards/<id>.json if project-local, else the project file's
    // own build.config_bits). We store on the PROJECT so it travels with the
    // code and never mutates the shared board database.
    try {
        const file = path.join(root, 'pic-project.json');
        const { ok, data } = H.readJsonFile(file);
        if (!ok) { vscode.window.showErrorMessage('PIC: pic-project.json is not valid JSON.'); return; }
        data.build = data.build || {};
        data.build.config_bits = bits;
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
        vscode.window.showInformationMessage('PIC: configuration bits saved to pic-project.json. Rebuild to apply.');
        H.log(`[config] saved ${Object.keys(bits).length} config bit(s)`);
    } catch (e) {
        vscode.window.showErrorMessage(`PIC: could not save config bits — ${e.message}`);
    }
}

function _renderConfig(board, proj, cb) {
    const saved = (proj.build && proj.build.config_bits) || board.build.config_bits || {};
    // try DFP if not passed
    if (!cb) {
        try {
            const PM = require('./packManager');
            cb = PM.getConfigBits(board.build.device, board.toolchain || H.resolveToolchain(proj));
        } catch (e) { cb = null; }
    }
    const hasFields = !!(cb && cb.fields && Object.keys(cb.fields).length);
    let rows = '';
    if (hasFields) {
        rows = Object.entries(cb.fields).map(([k, info]) => {
            const val = (saved && saved[k] != null) ? saved[k] : (info.default || (info.values[0] && info.values[0].value) || '');
            const opts = (info.values || []).map(v =>
                `<option value="${esc(v.value)}"${v.value === val ? ' selected' : ''}>${esc(v.value)} — ${esc(v.desc || '')}</option>`
            ).join('');
            return `<tr><td><code>${esc(k)}</code><div class="muted" style="font-size:11px">${esc(info.desc || '')}</div></td><td><select data-field="${esc(k)}">${opts}</select></td></tr>`;
        }).join('');
    } else if (Object.keys(saved).length) {
        rows = Object.entries(saved).map(([k, v]) => `
            <tr><td><code>${esc(k)}</code></td><td><input data-field="${esc(k)}" value="${esc(String(v))}"></td></tr>`).join('');
    } else {
        rows = '<tr><td colspan="2" class="muted">No configuration-bit fields found for this device. Install its Device Family Pack (DFP) to load them, or enter raw <code>#pragma config</code> statements.</td></tr>';
    }
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 18px 22px; }
h1 { font-size: 18px; margin: 0 0 4px; }
.sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 16px; }
table { border-collapse: collapse; width: 100%; max-width: 720px; }
td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border, #3e3e42); vertical-align: middle; }
code { background: var(--vscode-textCodeBlock-background, rgba(110,118,129,0.12)); padding: 1px 5px; border-radius: 3px; }
input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #3e3e42); padding: 4px 8px; border-radius: 4px; width: 100%; font-family: var(--vscode-editor-font-family); }
select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #3e3e42); padding: 4px 8px; border-radius: 4px; width: 100%; font-family: var(--vscode-editor-font-family); }
.muted { color: var(--vscode-descriptionForeground); }
.bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 22px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border-top: 1px solid var(--vscode-panel-border, #3e3e42); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 7px 18px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.note { max-width: 720px; margin-top: 14px; padding: 10px 12px; background: var(--vscode-textCodeBlock-background, rgba(110,118,129,0.10)); border-radius: 6px; font-size: 12px; line-height: 1.5; }
</style></head><body>
<h1>🔧 Configuration Bits — ${esc(board.name || board.build.device)}</h1>
<div class="sub">Device: <code>${esc(board.build.device)}</code> · toolchain: <code>${esc(board.toolchain || H.resolveToolchain(proj))}</code> · family: ${esc(board.build.family || '')}</div>
<table>${rows}</table>
<div class="note">
    Values are written as <code>#pragma config &lt;field&gt; = &lt;value&gt;</code> and applied on the next Build.
    Field names and legal values are device-specific — see the device datasheet or the MPLAB X Configuration Bits window.
    On the 16/32-bit families a config change normally requires the whole device to be reprogrammed (the config lives in a dedicated region of the .hex).
</div>
<div class="bar">
    <button id="save">Save configuration</button>
    <button id="loadDfp" style="margin-left:8px;background:var(--vscode-button-secondaryBackground, #3a3d41);color:var(--vscode-button-secondaryForeground, #fff);">Load from DFP</button>
</div>
<script>
const vscode = acquireVsCodeApi();
document.getElementById('save').addEventListener('click', () => {
    const bits = {};
    document.querySelectorAll('select[data-field], input[data-field]').forEach(i => { const v = i.value.trim(); if (v) bits[i.getAttribute('data-field')] = v; });
    vscode.postMessage({ type: 'saveConfig', bits });
});
document.getElementById('loadDfp').addEventListener('click', () => {
    vscode.postMessage({ type: 'loadFromDfp' });
});
</script>
</body></html>`;
}
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── Disassembly ─────────────────────────────────────────────────────────────
function _objdumpName(id) {
    return id === 'xc8' ? 'pic-objdump' : id === 'xc16' ? 'xc16-objdump' : id === 'xc32' ? 'xc32-objdump' : 'xc-dsc-objdump';
}

async function showDisassembly() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const toolchainId = H.resolveToolchain(proj);
    const tc = Toolchain.requireToolchain(toolchainId);
    if (!tc) return;
    const out = H.expandOutPaths(root, proj);
    const elf = path.join(out.outDirAbs, out.outName + '.elf');
    if (!fs.existsSync(elf)) {
        const pick = await vscode.window.showWarningMessage(`PIC: ${out.outName}.elf not found — build first.`, 'Build');
        if (pick === 'Build') vscode.commands.executeCommand('pic.build');
        return;
    }
    const objdump = tc.modules[_objdumpName(toolchainId)];
    if (!objdump) {
        vscode.window.showErrorMessage(`PIC: no ${_objdumpName(toolchainId)} found in the ${toolchainId} toolchain.`);
        return;
    }
    const lss = path.join(out.outDirAbs, out.outName + '.lss');
    let stale = true;
    try { stale = fs.statSync(lss).mtimeMs < fs.statSync(elf).mtimeMs; } catch {}
    if (stale) {
        try {
            const r = cp.spawnSync(objdump, ['-d', '-S', elf], { timeout: 30000, encoding: 'utf8', windowHide: true, cwd: root });
            const text = String(r.stdout || '');
            if (!text) throw new Error(String(r.stderr || 'no output'));
            fs.writeFileSync(lss, text);
        } catch (e) {
            vscode.window.showErrorMessage(`PIC: objdump failed — ${e.message}`);
            return;
        }
    }
    try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(lss));
        await vscode.window.showTextDocument(doc, { preview: true });
    } catch (e) {
        vscode.window.showErrorMessage(`PIC: cannot open ${path.relative(root, lss)} — ${e.message}`);
    }
}

module.exports = { openConfigEditor, showDisassembly };
