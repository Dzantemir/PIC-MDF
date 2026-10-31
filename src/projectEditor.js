'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// projectEditor.js — the visual pic-project.json editor (webview panel).
// A centered column of cards: General, Defines, Build,
// Upload, Hooks — with a searchable MCU dropdown and a sticky save bar.
// Merge-on-save: managed keys are overlaid on
// the fresh disk config, unmanaged keys survive.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Boards = require('./boards');
const Validator = require('./validator');
const Sources = require('./sources');

let _panel = null;
let _panelRoot = null;

function openProjectEditor() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const cfgPath = path.join(root, 'pic-project.json');
    const rc = Validator.readProjectConfig(root);
    if (rc.status === 'missing') { H.warnNoProject(); return; }
    if (rc.status === 'broken') {
        vscode.window.showErrorMessage(`PIC: pic-project.json is not valid JSON: ${rc.parseError || 'parse error'}`, 'Open File')
            .then(a => { if (a === 'Open File') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(cfgPath)); });
        return;
    }
    if (_panel) {
        if (_panelRoot === root) { _panel.reveal(vscode.ViewColumn.One); return; }
        try { _panel.dispose(); } catch {}
    }
    _panelRoot = root;
    _panel = vscode.window.createWebviewPanel(
        'pic.projectEditor', `PIC-MDF — Project Editor (${path.basename(root)})`, vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    _panel.webview.html = _render();
    _panel.webview.onDidReceiveMessage(onMessage);
    // The sdcc-mdf/avr-mdf reveal-refresh: re-push the MCU summaries every
    // time the panel becomes visible — a board saved/deleted in the Board
    // Manager (or dropped into .pic/boards / pic.boardsDir) while the editor
    // was open now reaches the open picker. ONLY the boards ride this push:
    // the form is not re-initialised, so unsaved edits survive (unlike a
    // full 'state' push — the reveal-only lesson still holds).
    _panel.onDidChangeViewState(() => {
        if (!_panel || !_panel.visible) return;
        try {
            _panel.webview.postMessage({ type: 'boardsChanged', boards: Boards.listBoardsDetailed() });
        } catch { /* disposed mid-send */ }
    });
    _panel.onDidDispose(() => { _panel = null; _panelRoot = null; });
}

function onMessage(m) {
    if (!m || !m.type) return;
    switch (m.type) {
        case 'ready': _sendAll(); break;
        case 'save': _save(m.proj); break;
        case 'pickSdkFolder': _pickSdkFolder(); break;
        case 'pickDfpFolder': _pickDfpFolder(); break;
        case 'openComponent': try { require('./components').host().openEditor(m.name || 'main'); } catch (e) { H.log('[projectEditor] ' + e.message); } break;
        case 'newComponent': try { require('./components').host().newComponent(); } catch (e) { H.log('[projectEditor] ' + e.message); } break;
        case 'setBuildMode': _setBuildMode(m.mode); break;
    }
}

async function _pickSdkFolder() {
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        title: 'PIC-MDF › Select External SDK Folder',
    });
    if (picked && picked.length) {
        const rel = Sources.normalizeExtSdk(_panelRoot, picked[0].fsPath);
        try { _panel?.webview.postMessage({ type: 'sdkFolderPicked', path: rel }); } catch {}
    }
}

async function _pickDfpFolder() {
    try {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: 'PIC-MDF › Select the toolchain-specific DFP folder',
        });
        if (picked && picked.length) _panel?.webview.postMessage({ type: 'dfpFolderPicked', path: picked[0].fsPath });
    } catch (e) {
        vscode.window.showErrorMessage(`PIC: could not select the DFP folder — ${e.message}`);
    }
}

async function _setBuildMode(mode) {
    const next = (mode === 'debug') ? 'debug' : 'release';
    try { await H.setCfg('buildMode', next); } catch (e) { H.log(`[projectEditor] build mode write failed: ${e.message}`); }
    const live = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug' ? 'debug' : 'release';
    try { _panel?.webview.postMessage({ type: 'buildModeSet', mode: live }); } catch {}
}
function notifyBuildModeChanged() {
    if (!_panel) return;
    const live = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug' ? 'debug' : 'release';
    try { _panel.webview.postMessage({ type: 'buildModeSet', mode: live }); } catch {}
}

function _sendAll() {
    if (!_panel) return;
    const root = _panelRoot;
    const rc = Validator.readProjectConfig(root);
    const proj = rc.status === 'ok' ? rc.proj : null;
    try {
        _panel.webview.postMessage({
            type: 'state', proj,
            boards: Boards.listBoardsDetailed(),
            file: path.join(root || '', 'pic-project.json'),
            comPort: String(H.cfg('comPort') || ''),
            extSdk: String(H.cfg('externalSdkPath') || ''),
            dfpPath: String(H.cfg('dfpPath') || ''),
            buildMode: String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug' ? 'debug' : 'release',
        });
    } catch {}
}

async function _save(proj) {
    const root = _panelRoot;
    if (!root) return;
    if (!proj || typeof proj !== 'object' || Array.isArray(proj)) {
        vscode.window.showErrorMessage('PIC: invalid project structure.'); return;
    }
    const sdkPath = String(proj.externalSdkPath || '').trim();
    delete proj.externalSdkPath;

    // fresh-disk merge — unmanaged keys survive
    const diskRc = Validator.readProjectConfig(root);
    const disk = diskRc.status === 'ok' ? diskRc.proj : {};
    const merged = { ...disk };
    for (const k of ['name', 'board', 'defines']) {
        merged[k] = proj[k];
    }
    const db = (disk.build && typeof disk.build === 'object' && !Array.isArray(disk.build)) ? disk.build : {};
    const pb = (proj.build && typeof proj.build === 'object' && !Array.isArray(proj.build)) ? proj.build : {};
    const mb = { ...db };
    for (const k of ['output_name', 'output_dir', 'optimization', 'f_cpu_hz', 'gc_sections', 'lto', 'dfp', 'c_flags', 'cxx_flags', 'asm_flags', 'link_flags', 'extra_flags']) {
        if (pb[k] !== undefined) mb[k] = pb[k]; else delete mb[k];
    }
    const ph = (pb.hooks && typeof pb.hooks === 'object' && !Array.isArray(pb.hooks)) ? pb.hooks : {};
    const dh = (db.hooks && typeof db.hooks === 'object' && !Array.isArray(db.hooks)) ? db.hooks : {};
    const mh = { ...dh };
    for (const stage of ['pre_build', 'post_link', 'post_build', 'pre_upload', 'post_upload']) {
        if (ph[stage] !== undefined) mh[stage] = ph[stage]; else delete mh[stage];
    }
    if (Object.keys(mh).length) mb.hooks = mh; else delete mb.hooks;
    delete merged.toolchain;   // legacy key — the compiler follows the MCU now
    merged.build = mb;
    const pu = (proj.upload && typeof proj.upload === 'object' && !Array.isArray(proj.upload)) ? proj.upload : {};
    const du = (disk.upload && typeof disk.upload === 'object' && !Array.isArray(disk.upload)) ? disk.upload : {};
    const mu = { ...du };
    for (const k of ['programmer', 'hardware', 'port', 'tool', 'args', 'eeprom']) {
        if (pu[k] !== undefined) mu[k] = pu[k]; else delete mu[k];
    }
    merged.upload = mu;

    const report = Validator.validateProjectConfig(merged, root, { countSources: false });
    if (report.errors.length) {
        vscode.window.showErrorMessage(`PIC: refused to save — ${report.errors[0]}${report.errors.length > 1 ? ` (+${report.errors.length - 1} more)` : ''}`);
        return;
    }
    try {
        fs.writeFileSync(path.join(root, 'pic-project.json'), JSON.stringify(merged, null, 2) + '\n');
        H.log(`[projectEditor] saved pic-project.json`);
        if (H.getProvider()) H.getProvider().refresh();
        // the toolchain (architecture) may have changed here — the Reference view and the
        // status-bar chip follow it (the old quick-pick refreshed them itself)
        if (H.getRefProvider()) H.getRefProvider().refresh();
        try { require('./statusBar').refreshStatusBar(); } catch {}
        vscode.window.showInformationMessage('✅ pic-project.json saved.');
        try { require('./intellisense').syncAfterProjectChange(); } catch {}
        try { require('./tasks').syncAfterProjectChange(); } catch {}
        try { require('./launchJson').syncAfterProjectChange(); } catch {}
    } catch (e) {
        vscode.window.showErrorMessage(`PIC: could not save — ${e.message}`);
        return;
    }
    const sdkNorm = Sources.normalizeExtSdk(root, sdkPath);
    const curSdk = String(H.cfg('externalSdkPath') || '').trim();
    if (sdkNorm !== curSdk) {
        try { await H.setCfg('externalSdkPath', sdkNorm); } catch (e) {
            vscode.window.showErrorMessage(`PIC: could not save the SDK folder setting — ${e.message}`);
        }
    }
    _sendAll();
}

function _render() {
    return fs.readFileSync(path.join(__dirname, '..', 'media', 'projectEditor.html'), 'utf8');
}

module.exports = { openProjectEditor, notifyBuildModeChanged };
