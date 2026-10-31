'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// boardManager.js — the MCU Definitions manager (webview panel): the sdcc-mdf / avr-mdf
// Board Manager design with PIC fields (0.4.1 — 0.3.8 had replaced it with a plainer page).
//
// Storage model (boards describe HARDWARE, not a project):
//   • BUILTIN  — boards/ shipped with the extension (read-only);
//   • GLOBAL (default) — ~/.pic-mdf/boards: available in EVERY project and
//     with no project open at all; lives OUTSIDE VS Code's extension storage,
//     so definitions survive extension updates/reinstalls;
//   • DIR     — the pic.boardsDir setting (an extra folder of board JSONs);
//   • PROJECT — <activeRoot>/.pic/boards/: project-specific override with the
//     highest priority (same-id shadowing).
// Priority: project → folder → global → built-in.
//
// Layout: page header + two columns — left the tree-grouped MCU list card
// (filter, collapse/expand, source switcher, + New / Import / Export), right
// the editor form cards (Identity / Target / Memory / Upload / Destination),
// plus a fixed save bar (Open JSON · Duplicate · Delete · Save).
//
// postMessage protocol (webview ⇄ host):
//   → {type:'ready'|'refresh'|'edit'|'new'|'save'|'delete'|'duplicate'|
//      'openFile'|'export'|'import'|'uiState'}
//   ← {type:'boards', boards:[{id,name,vendor,cpu,source,file,def}], hasProject}
//   ← {type:'board', id, board}          (edit / new / duplicate)
//   ← {type:'saveResult', ok, errors, warnings, file, id}
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const H      = require('./helpers');
const Boards = require('./boards');

let _panel = null;

// ─── Destinations ────────────────────────────────────────────────────────────
function _globalBoardsDir() { return path.join(os.homedir(), '.pic-mdf', 'boards'); }
function _projectBoardsDir(root) { return path.join(root, '.pic', 'boards'); }

// Resolve the save destination: 'project' only when a project is active,
// 'global' otherwise (and as the default). The panel works WITHOUT an active
// project — global definitions are always manageable.
function _resolveDestDir(dest) {
    const root = H.getActiveRoot();
    if (dest === 'project' && root) {
        return { dir: _projectBoardsDir(root), name: 'project', label: '.pic/boards/ (this project only)' };
    }
    return { dir: _globalBoardsDir(), name: 'global', label: '~/.pic-mdf/boards (all projects, survives updates)' };
}

// Board objects from Boards.loadBoards() carry three injected/private fields
// (id from the file name, _path, _origin) — strip them before sending a
// definition to the webview or writing it back to disk.
function _stripInternal(def) {
    const { id, _path, _origin, ...rest } = def || {};
    return rest;
}

// ─── Tree state persistence (host memento) ───────────────────────────────────
// The webview's vscode.setState survives only while the panel INSTANCE lives;
// closing the tab disposes the webview and its state with it. The fold map +
// the active source slice are mirrored to the host's globalState on every
// change ('uiState' message), and a fresh panel is seeded from the HOST_STATE
// snapshot embedded into its HTML at creation.
const UI_STATE_KEY = 'picBoardTreeState';
function _sanitizeUiState(st) {
    if (!st || typeof st !== 'object' || Array.isArray(st)) return null;
    const src = typeof st.src === 'string' ? st.src : 'all';
    const collapsed = (st.collapsed && typeof st.collapsed === 'object' && !Array.isArray(st.collapsed))
        ? st.collapsed : {};
    return { src, collapsed };
}
function loadUiState() {
    let raw = null;
    try { raw = H.getCtx()?.globalState.get(UI_STATE_KEY); } catch (e) { /* no ctx in harnesses */ }
    return _sanitizeUiState(raw) || { src: 'all', collapsed: {}, fresh: true };   // fresh = nothing stored yet
}
function saveUiState(st) {
    const clean = _sanitizeUiState(st) || { src: 'all', collapsed: {} };
    try { H.getCtx()?.globalState.update(UI_STATE_KEY, clean); } catch (e) { /* memento optional */ }
    return clean;
}

// ─── Validation ──────────────────────────────────────────────────────────────
// Returns { valid, errors, warnings }. The board id and build.device are separate
// fields in PIC-MDF (the id is the file name + the proj.board value; build.device
// is what the XC compiler receives as -mcpu= / -mprocessor=).
function validateBoardDef(id, board) {
    const errors = [], warnings = [];
    if (!board || typeof board !== 'object') return { valid: false, errors: ['definition must be an object'], warnings };
    if (!id || typeof id !== 'string') errors.push('board id is required');
    else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) errors.push(`board id "${id}" contains invalid characters (allowed: a-z 0-9 . _ -, must start with a letter or digit)`);
    if (!board.name || typeof board.name !== 'string') errors.push('name is required');
    const device = board.build?.device;
    if (!device || typeof device !== 'string') errors.push('build.device is required (the device name the compiler receives)');
    const mem = board.build?.memory || {};
    for (const k of ['flash', 'ram', 'eeprom']) {
        if (mem[k] !== undefined && (!Number.isInteger(Number(mem[k])) || Number(mem[k]) < 0)) {
            errors.push(`memory.${k} must be a non-negative integer (bytes)`);
        }
    }
    if (board.build?.f_cpu_hz !== undefined && (!Number.isSafeInteger(Number(board.build.f_cpu_hz)) || Number(board.build.f_cpu_hz) <= 0)) {
        errors.push('build.f_cpu_hz must be a positive integer (Hz)');
    }
    // The UI edits Hz once; f_cpu is a C-literal mirror (used for F_CPU / _XTAL_FREQ).
    const lit = Number(String(board.build?.f_cpu || '').replace(/[uUlL]+$/, ''));
    if (Number.isFinite(lit) && lit > 0 && Number.isFinite(Number(board.build?.f_cpu_hz)) && lit !== Number(board.build.f_cpu_hz)) {
        warnings.push(`build.f_cpu "${board.build.f_cpu}" and build.f_cpu_hz ${board.build.f_cpu_hz} disagree — keep them in sync`);
    }
    return { valid: errors.length === 0, errors, warnings };
}

// Normalize before writing: defaults for f_cpu/f_cpu_hz, integer memory sizes,
// and upload.maximum_* derived from memory (the flasher caps mirror the chip).
function _normalizeBoardDef(board) {
    const b = JSON.parse(JSON.stringify(board || {}));
    b.build = b.build || {};
    // Prefer the literal only when one is actually present; a hand-authored
    // definition containing just f_cpu_hz must not be overwritten by the
    // default literal before we get a chance to read its numeric value.
    const literal = String(b.build.f_cpu ?? '').trim();
    let hz = literal ? Number(literal.replace(/[uUlL]+$/, '')) : NaN;
    if (!Number.isSafeInteger(hz) || hz <= 0) hz = Number(String(b.build.f_cpu_hz ?? ''));
    b.build.f_cpu_hz = Number.isSafeInteger(hz) && hz > 0 ? hz : 1000000;
    b.build.f_cpu = String(b.build.f_cpu_hz) + 'UL';
    b.build.memory = b.build.memory || {};
    for (const k of ['flash', 'ram', 'eeprom']) {
        const n = parseInt(b.build.memory[k], 10);
        b.build.memory[k] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
    b.upload = b.upload || {};
    // an explicit positive maximum_size (e.g. flash minus a bootloader) is kept;
    // otherwise it mirrors the flash size.
    const maxSz = parseInt(b.upload.maximum_size, 10);
    b.upload.maximum_size = Number.isFinite(maxSz) && maxSz > 0 ? maxSz : b.build.memory.flash;
    b.upload.maximum_ram_size = b.build.memory.ram;
    b.upload.maximum_eeprom_size = b.build.memory.eeprom;
    return b;
}

// ─── List ordering + tree shape + source census (pure, injected into the view)
// User-facing rules (the sdcc-mdf "weakest MCU first" ordering): vendors
// ALPHABETICALLY (case-insensitive, empty last), and inside a vendor the MCUs
// sorted by power — Flash ascending, RAM as tie-break, name last — so the
// small workhorses (ATtiny13, ATmega8…) top the group instead of drowning
// between 128K monsters. Both helpers below run on the PRE-SORTED entry list
// the webview already receives, so grouping is a single run-length pass — and
// the webview gets these EXACT functions via Function.toString() injection.
function sortBoardsForList(list) {
    const vendorOf = b => String(b.vendor || '').trim().toLowerCase() || '~';   // '~' sorts last
    const flashOf = b => Number(b.def?.build?.memory?.flash ?? 0) || 0;
    const ramOf = b => Number(b.def?.build?.memory?.ram ?? 0) || 0;
    return [...(list || [])].sort((a, b) => {
        const v = vendorOf(a).localeCompare(vendorOf(b));
        if (v !== 0) return v;
        const fa = flashOf(a), fb = flashOf(b);
        if (fa !== fb) return fa - fb;
        const ra = ramOf(a), rb = ramOf(b);
        if (ra !== rb) return ra - rb;
        return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
}
function treeGroups(list) {
    const groups = [];
    let cur = null, curKey = null;
    for (const b of (list || [])) {
        const v = String(b.vendor || '').trim() || '(no vendor)';
        // vendors differing only in CASE form ONE group — the sort above already
        // orders them adjacently; the branch label keeps the first-seen spelling.
        const key = v.toLowerCase();
        if (!cur || curKey !== key) { cur = { vendor: v, boards: [] }; groups.push(cur); curKey = key; }
        cur.boards.push(b);
    }
    return groups;
}
// Labels for the source switcher, in display order: builtin (shipped,
// read-only) → global (~/.pic-mdf/boards) → dir (pic.boardsDir setting) →
// project (.pic/boards). Segments appear ONLY for sources that actually have
// boards — the common case stays a tidy "All | Built-in | Global".
const SRC_LABELS = {
    builtin: 'Built-in',
    global:  'Global',
    dir:     'Folder',
    project: 'Project',
};
function sourcesCensus(list) {
    const order = ['builtin', 'global', 'dir', 'project'];
    const counts = {};
    for (const b of (list || [])) {
        const s = order.includes(b.source) ? b.source : 'dir';
        counts[s] = (counts[s] || 0) + 1;
    }
    return order.filter(k => counts[k])
        .map(k => ({ key: k, label: SRC_LABELS[k], count: counts[k] }));
}

// ─── CRUD (pure, testable) ───────────────────────────────────────────────────
function saveBoardDef(destDir, id, board) {
    const check = validateBoardDef(id, board);
    if (!check.valid) return { valid: false, errors: check.errors, warnings: check.warnings };
    const def = _stripInternal(_normalizeBoardDef(board));
    try {
        fs.mkdirSync(destDir, { recursive: true });
        const file = path.join(destDir, `${id}.json`);
        fs.writeFileSync(file, JSON.stringify(def, null, 2) + '\n', 'utf8');
        return { valid: true, errors: [], warnings: check.warnings, file };
    } catch (e) {
        // fs errors (read-only file, antivirus lock, unreachable dir) used to
        // escape as an unhandled rejection and the Save button silently "did
        // nothing" — the error is reported to the user instead.
        return { valid: false, errors: [`failed to write ${path.join(destDir, `${id}.json`)}: ${e.message}`], warnings: check.warnings };
    }
}

// Delete EVERY user-writable copy of the id: the same id can exist in several
// locations (project .pic/boards/, pic.boardsDir, ~/.pic-mdf/boards) and
// deleting only the highest-priority copy would let the board RESURRECT on the
// next scan. A built-in definition with the same id (if any) stays protected.
function deleteBoardDef(id) {
    const removed = [];
    for (let i = 0; i < 8; i++) {                       // locations are few — guard anyway
        Boards.invalidate();                            // the cache must not resurrect removed files
        const b = Boards.getBoard(id);
        if (!b) break;                                  // fully gone
        if (b._origin === 'builtin') break;             // protected (user copies already removed)
        try { fs.rmSync(b._path, { force: true }); removed.push(b._path); }
        catch (e) { return { ok: false, reason: `failed to delete ${b._path}: ${e.message}` }; }
    }
    Boards.invalidate();
    if (!removed.length) {
        const b = Boards.getBoard(id);
        if (b && b._origin === 'builtin') {
            return { ok: false, reason: `"${id}" is a built-in MCU definition and cannot be deleted (duplicate & edit it instead)` };
        }
        return { ok: false, reason: `MCU definition "${id}" not found` };
    }
    return { ok: true, files: removed };
}

// ─── Panel / message handling ────────────────────────────────────────────────
// NOTE: works WITHOUT an active project — global definitions are always
// manageable.
function _refreshPanel() {
    Boards.invalidate();
    const list = sortBoardsForList([...Boards.loadBoards().values()].map(b => ({
        id: b.id,
        name: b.name || b.id,
        vendor: b.vendor || '',
        cpu: b.build?.device || '',                 // the device shown in the meta line
        device: b.build?.device || '',
        toolchain: b.toolchain || '',
        source: b._origin || 'builtin',
        file: b._path || '',
        def: _stripInternal(b),                  // full definition minus private fields
    })));
    _panel?.webview.postMessage({ type: 'boards', boards: list, hasProject: !!H.getActiveRoot() });
}

function openBoardManager() {
    if (_panel) {
        // reveal refreshes too — a palette import/export or an external file
        // change is reflected on the next reveal instead of surviving until a
        // manual refresh.
        Boards.invalidate();
        _refreshPanel();
        _panel.reveal(vscode.ViewColumn.One);
        return;
    }
    // Embed the persisted tree snapshot so a freshly created panel (whose own
    // webview state starts empty) restores the fold map instead of resetting
    // to fully expanded.
    const uiState = loadUiState();
    _panel = vscode.window.createWebviewPanel(
        'pic.boardManager', 'PIC — MCU Definitions (Board Manager)', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    _panel.webview.html = _getHtml(uiState);
    _panel.webview.onDidReceiveMessage(onMessage);
    _panel.onDidDispose(() => { _panel = null; });
    _refreshPanel();
}

async function onMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
        case 'ready':
        case 'refresh':
            _refreshPanel();
            return;
        case 'edit': {
            // Fresh scan: the file may have changed since the list was built.
            Boards.invalidate();
            const b = msg.id ? Boards.getBoard(String(msg.id)) : null;
            if (b) _panel?.webview.postMessage({ type: 'board', id: b.id, board: _stripInternal(b) });
            return;
        }
        case 'new': {
            // Blank draft: XC8, 8 MHz, empty memory sizes, ipecmd.
            const draft = {
                name: '', vendor: 'Microchip', toolchain: 'xc8',
                build: { device: '', family: '', f_cpu: '8000000UL', f_cpu_hz: 8000000, memory: {}, extra_flags: [] },
                upload: { protocol: 'ipecmd' },
            };
            _panel?.webview.postMessage({ type: 'board', id: null, board: draft });
            return;
        }
        case 'save':
            _saveBoard(msg.data);
            return;
        case 'delete':
            _deleteBoard(msg.id);
            return;
        case 'duplicate':
            await _duplicateBoard(msg.id);
            return;
        case 'openFile': {
            const b = msg.id ? Boards.getBoard(String(msg.id)) : null;
            if (b?._path) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(b._path));
            return;
        }
        case 'export':
            await cmdExport();
            return;
        case 'import':
            await cmdImport();   // cmdImport refreshes the open panel itself
            return;
        case 'uiState':
            saveUiState(msg.state);
            return;
    }
}

function _saveBoard(data) {
    const board = data?.board;
    // a new MCU without an id gets one from its device name; ids are stored lower-case (the loader reads them so)
    let id = String(data?.id || '').trim();
    if (!id) id = String(board?.build?.device || '').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^[^a-z0-9]+/i, '');
    id = id.toLowerCase();
    const dest = _resolveDestDir(data?.dest === 'project' ? 'project' : 'global');
    const originalId = data?.originalId ? String(data.originalId) : '';
    const originalFile = data?.originalFile ? String(data.originalFile) : '';

    // Refuse to overwrite a DIFFERENT board when the id was changed (or the
    // destination switched) — unless the target file IS the file of the board
    // being edited (normal re-save).
    if (id) {
        const clashFile = path.join(dest.dir, `${id}.json`);
        const sameFile = originalFile && path.resolve(originalFile) === path.resolve(clashFile);
        let exists = fs.existsSync(clashFile);
        if (!exists) {
            // the loader lower-cases ids — compare case-insensitively against every file of the folder
            try { exists = fs.readdirSync(dest.dir).some(n => n.toLowerCase() === `${id}.json` && path.resolve(dest.dir, n) !== path.resolve(originalFile || '')); } catch { /* folder missing yet */ }
        }
        if (exists && !sameFile) {
            const why = (originalId && originalId !== id)
                ? `Board id was changed from "${originalId}" to "${id}", but a board named "${id}" already exists in ${dest.label} — choose another id.`
                : `A board named "${id}" already exists in ${dest.label} (${clashFile}) — choose another id.`;
            vscode.window.showErrorMessage(`PIC Board Manager: ${why}`);
            _panel?.webview.postMessage({ type: 'saveResult', ok: false, errors: [why], warnings: [] });
            return;
        }
    }

    const res = saveBoardDef(dest.dir, id, board);
    if (!res.valid) {
        vscode.window.showErrorMessage(`PIC Board Manager: ${res.errors.join('; ')}`);
        _panel?.webview.postMessage({ type: 'saveResult', ok: false, errors: res.errors, warnings: res.warnings });
        return;
    }
    if (res.warnings?.length) vscode.window.showWarningMessage(`MCU saved with warnings: ${res.warnings.join('; ')}`);
    else vscode.window.showInformationMessage(`✅ MCU "${id}" saved → ${dest.label}`);
    // On an id CHANGE the old definition file is intentionally kept (renaming
    // would lose it on write failure) — but the user must KNOW.
    if (originalId && originalId !== id) {
        vscode.window.showInformationMessage(`ℹ️ The old definition "${originalId}" was kept — delete it from the list if you no longer need it.`);
    }
    H.log(`[boards] saved ${id} → ${res.file}`);
    Boards.invalidate();
    if (H.getProvider()) H.getProvider().refresh();
    _refreshPanel();
    _panel?.webview.postMessage({ type: 'saveResult', ok: true, warnings: res.warnings || [], file: res.file, id });
}

function _deleteBoard(id) {
    const boardId = String(id || '');
    // Built-in definitions are protected — refuse up front with the canonical
    // hint (the webview disables the button anyway; this is the backstop).
    Boards.invalidate();
    const cur = Boards.getBoard(boardId);
    if (cur && cur._origin === 'builtin') {
        vscode.window.showErrorMessage(`PIC Board Manager: "${boardId}" is a built-in MCU definition and cannot be deleted (duplicate & edit it instead)`);
        return;
    }
    vscode.window.showWarningMessage(
        `Delete the MCU definition "${boardId}"?`, { modal: true }, 'Delete'
    ).then(pick => {
        if (pick !== 'Delete') return;
        const res = deleteBoardDef(boardId);
        if (!res.ok) { vscode.window.showErrorMessage(`PIC Board Manager: ${res.reason}`); return; }
        const n = res.files?.length || 0;
        vscode.window.showInformationMessage(`MCU "${boardId}" deleted${n > 1 ? ` — ${n} copies removed` : ''}.`);
        H.log(`[boards] MCU "${boardId}" deleted:\n  ${res.files.join('\n  ')}`);
        Boards.invalidate();
        if (Boards.getBoard(boardId)?._origin === 'builtin') {
            vscode.window.showInformationMessage(`ℹ️ A built-in definition "${boardId}" is still active — the deleted copy used to shadow it.`);
        }
        if (H.getProvider()) H.getProvider().refresh();
        _refreshPanel();
    });
}

async function _duplicateBoard(id) {
    const srcId = String(id || '');
    Boards.invalidate();
    const b = Boards.getBoard(srcId);
    if (!b) { vscode.window.showErrorMessage(`PIC Board Manager: MCU "${srcId}" not found`); return; }
    const newId = await vscode.window.showInputBox({
        prompt: `New board id (copy of "${srcId}")`,
        value: `${srcId}-copy`,
        validateInput: v => /^[a-z0-9][a-z0-9._-]*$/i.test(v) ? null : 'Only letters, digits, . _ - are allowed (must start with a letter or digit)',
    });
    if (!newId) return;   // cancelled
    // Refuse an id whose destination file already exists — the copy is sent to
    // the webview for editing and would collide at save time.
    Boards.invalidate();
    if (Boards.loadBoards().has(newId.toLowerCase())) {
        vscode.window.showErrorMessage(`PIC Board Manager: a board named "${newId}" already exists — choose another id.`);
        return;
    }
    // The copy keeps every field of the source (memory, f_cpu, extra_flags,
    // upload…); build.device stays the REAL chip name (the compiler receives it as -mcpu= /
    // -mprocessor=), only the definition id and the display name change — then it goes to
    // the webview as an UNSAVED draft for editing, exactly like + New.
    const copy = _stripInternal(b);
    copy.name = `${b.name || srcId} (copy)`;
    _panel?.webview.postMessage({ type: 'board', id: newId.toLowerCase(), board: copy });
}

// ─── Export / import (single-JSON backup commands) ───────────────────────────
async function cmdExport() {
    const dir = _globalBoardsDir();
    if (!fs.existsSync(dir)) {
        vscode.window.showInformationMessage('PIC: no user MCU definitions to export (~/.pic-mdf/boards is empty).');
        return;
    }
    const target = await vscode.window.showSaveDialog({
        title: 'PIC-MDF: export user MCU definitions (single JSON backup)',
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pic-mdf-boards.json')),
        filters: { 'JSON backup': ['json'] },
    });
    if (!target) return;   // cancelled — nothing to report
    const out = {};
    for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.json')) continue;
        const { ok, data } = H.readJsonFile(path.join(dir, f));
        if (ok && data && typeof data === 'object') out[f.replace(/\.json$/i, '')] = data;
    }
    try {
        fs.writeFileSync(target.fsPath, JSON.stringify(out, null, 2) + '\n');
        vscode.window.showInformationMessage(`PIC: ${Object.keys(out).length} user MCU definition(s) exported.`);
        H.log(`[boards] exported ${Object.keys(out).length} definition(s) → ${target.fsPath}`);
    } catch (e) {
        vscode.window.showErrorMessage(`PIC: export failed — ${e.message}`);
    }
}

async function cmdImport() {
    const pick = await vscode.window.showOpenDialog({
        title: 'PIC-MDF: import MCU definitions from a JSON backup',
        canSelectFiles: true, canSelectMany: false,
        filters: { 'JSON backup': ['json'] },
    });
    if (!pick || !pick.length) return;
    const { ok, data, error } = H.readJsonFile(pick[0].fsPath);
    if (!ok || !data || typeof data !== 'object' || Array.isArray(data)) {
        vscode.window.showErrorMessage(`PIC: not a valid backup file — ${error || 'wrong structure'}`);
        return;
    }
    const dir = _globalBoardsDir();
    let n = 0;
    for (const [id, board] of Object.entries(data)) {
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || !board || typeof board !== 'object' || !board.build || !board.build.device) continue;
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(board, null, 2) + '\n');
            n++;
        } catch (e) { H.log(`[boards] import of "${id}" failed: ${e.message}`); }
    }
    Boards.invalidate();
    _refreshPanel();                    // newly merged boards appear without a manual reopen
    if (H.getProvider()) H.getProvider().refresh();
    vscode.window.showInformationMessage(`PIC: ${n} MCU definition(s) imported.`);
}

// ─── The webview ─────────────────────────────────────────────────────────────
// One big template literal, sectioned:
//   [CSS]   theme variables → page header → layout → cards → fields/buttons →
//           list tree → source switcher → empty state → tooltips → save bar
//   [HTML]  page header → left list card → right editor cards → save bar
//   [JS]    state/seed → tree render → filter/switcher → form render/collect →
//           message loop → tooltip clamping → ready
// Every injected JSON is escaped (< → \u003C) so user-editable strings (vendor,
// name…) can never break out of the script element.
function escJson(s) { return String(s).replace(/</g, '\\u003C'); }

function _getHtml(uiState) {
    let builtinCount = 0;
    try { builtinCount = [...Boards.loadBoards().values()].filter(b => b._origin === 'builtin').length; } catch { /* the header just says 0 */ }
    const hostStateJson = JSON.stringify({ ...(_sanitizeUiState(uiState) || { src: 'all', collapsed: {} }), fresh: !!(uiState && uiState.fresh) });
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>PIC — MCU Definitions (Board Manager)</title>
<style>
/* ─── Theme variables (with hardcoded fallbacks) ─── */
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --fg2: var(--vscode-descriptionForeground);
    --fg3: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, var(--vscode-panel-border, #3e3e42));
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn2-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn2-fg: var(--vscode-button-secondaryForeground, #ffffff);
    --border: var(--vscode-widget-border, var(--vscode-panel-border, #3e3e42));
    --border2: var(--vscode-panel-border, #3e3e42);
    --section-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --card-bg: var(--vscode-editorWidget-background, rgba(128,128,128,0.04));
    --code-bg: var(--vscode-textCodeBlock-background, rgba(110,118,129,0.12));
    --accent: var(--vscode-textLink-foreground, #4daafc);
    --focus-bd: var(--vscode-focusBorder, #007fd4);
    --tip-bg: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526));
    --tip-fg: var(--vscode-editorHoverWidget-foreground, var(--vscode-editorWidget-foreground, #cccccc));
    --tip-bd: var(--vscode-editorHoverWidget-border, var(--border));
    --list-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12));
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--fg); }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    padding: 18px 20px 80px;
    max-width: 1180px;
    margin: 0 auto;
}

/* ─── Page header ─── */
.page-hd { margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border2); }
.page-hd h1 {
    font-size: 18px; font-weight: 600; margin: 0 0 4px;
    display: flex; align-items: center; gap: 8px;
}
.page-hd .page-sub { font-size: 12px; color: var(--fg2); line-height: 1.5; }
.page-hd .page-sub code { background: var(--code-bg); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); }
.page-hd .page-actions { margin-top: 8px; font-size: 11px; color: var(--fg3); }

/* ─── Two-column layout ─── */
.layout { display: flex; gap: 14px; align-items: flex-start; }
.col-list { width: 320px; flex: 0 0 320px; }
.col-editor { flex: 1; min-width: 0; }
@media (max-width: 760px) {
    .layout { flex-direction: column; }
    .col-list { width: 100%; flex: 1 1 auto; }
}

/* ─── Cards (sections) ─── */
.card {
    border: 1px solid var(--border); border-radius: 8px;
    margin-bottom: 14px; background: var(--card-bg);
    overflow: visible;
}
.card-hd {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; border-bottom: 1px solid var(--border2);
    background: var(--section-bg);
    border-radius: 8px 8px 0 0;
    flex-wrap: wrap;   /* the list-card toolbar takes its own line under the title */
}
.card-hd .c-icon {
    width: 22px; height: 22px; border-radius: 5px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px; flex: 0 0 auto;
    background: var(--code-bg);
}
.card-hd h3 { font-size: 13px; font-weight: 600; color: var(--fg); flex: 0 1 auto; }
.card-hd h3#edTitle { margin-right: 6px; }
.card-hd .c-sub { font-size: 11px; color: var(--fg2); margin-left: 4px; }
.card-hd .c-tip { margin-left: auto; }
/* The MCU-list toolbar gets its OWN header row, full width: the list card is a
   fixed 320px, but "MCUs (311) + New + Import + Export + ⓘ" needs more than
   that on one line. */
.card-hd .c-actions {
    flex-basis: 100%; margin-left: 0; justify-content: flex-start;
    display: flex; gap: 6px; align-items: center;
}
.card-bd { padding: 12px 14px; }

/* ─── Field rows ─── */
.row {
    display: flex; gap: 8px; margin-bottom: 10px;
    align-items: center; flex-wrap: wrap;
}
.row:last-child { margin-bottom: 0; }
label {
    min-width: 130px; font-size: 12px; flex: 0 0 auto;
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--fg);
}
input, select {
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border);
    padding: 5px 8px; border-radius: 4px;
    font-size: 12px; width: 100%;
    font-family: var(--vscode-editor-font-family);
    transition: border-color .12s, box-shadow .12s;
}
input:focus, select:focus {
    outline: none; border-color: var(--focus-bd);
    box-shadow: 0 0 0 1px var(--focus-bd);
}
input[disabled], select[disabled] { opacity: .5; cursor: default; }
.row > input, .row > select, .row > .fld { flex: 1; min-width: 120px; width: auto; }
.fld input { width: 100%; }

button {
    background: var(--btn-bg); color: var(--btn-fg); border: none;
    padding: 6px 14px; border-radius: 4px; cursor: pointer;
    font-size: 12px; font-family: inherit;
    transition: opacity .12s, background .12s;
}
button:hover { opacity: .9; }
button:active { transform: translateY(1px); }
button.sec { background: var(--btn2-bg); color: var(--btn2-fg); white-space: nowrap; }
button.danger { background: #a1260d; color: #fff; }
button:disabled { opacity: 0.5; cursor: default; }

/* Card-header toolbar: every action button shares ONE height (24px), while the
   primary + New action stands 28px tall — big green primary, smaller grey
   secondaries. */
.card-hd .c-actions button {
    height: 24px; box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center;
    gap: 5px; padding: 0 10px; font-size: 11px;
}
.card-hd .c-actions button svg { flex: 0 0 auto; display: block; }
.card-hd .c-actions button.create {
    height: 28px; padding: 0 14px; font-size: 12px;
}
/* Soft group separator between + New and the Import/Export backup pair. */
.card-hd .c-actions .tb-sep {
    flex: 0 0 auto; width: 1px; height: 16px;
    margin: 0 3px; border-radius: 1px;
    background: linear-gradient(180deg, transparent,
        var(--border) 20%, var(--border) 80%, transparent);
}

/* ─── Accent "+ New" action — green pill, reads as a positive "add" ─── */
button.create {
    display: inline-flex; align-items: center; justify-content: center;
    background: linear-gradient(180deg, #3fb950 0%, #2ea043 100%);
    color: #fff; font-weight: 600; font-size: 11px; letter-spacing: .2px;
    padding: 0 12px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,.16);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 1px 3px rgba(0,0,0,.28);
    white-space: nowrap;
}
button.create .plus {
    display: inline-block; font-size: 15px; font-weight: 700;
    line-height: 1; margin-right: 4px; transform: translateY(.5px);
}
button.create:hover { opacity: 1; filter: brightness(1.12); }
button.create:active { transform: translateY(1px); filter: brightness(.94); }
button.create:focus-visible { outline: 1px solid var(--focus-bd); outline-offset: 1px; }

/* ─── Hints ─── */
.hint { font-size: 11px; color: var(--fg2); margin-top: 4px; line-height: 1.5; }
.hint code, .tip-pop code {
    background: var(--code-bg); padding: 1px 4px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
}

/* ─── Memory row ─── */
.memrow { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 0; }
.memrow .cell { flex: 1; min-width: 110px; }
.memrow .cell label { min-width: 0; display: block; margin-bottom: 3px; }

/* ─── MCU list — a TREE: vendor series = branch, MCUs = leaves ─── */
/* The vendor row is a real branch header: click it (or focus + Enter/Space) to
   fold/unfold its MCUs. It stays sticky while the (70vh) list scrolls, so the
   series you are browsing stays visible. Uppercase + letterspacing reads as a
   branch label, not an MCU. */
.board-list .vend {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; gap: 4px;
    padding: 6px 10px 5px; font-size: 10px; font-weight: 700;
    color: var(--fg2); text-transform: uppercase; letter-spacing: .8px;
    background: var(--section-bg);
    border-bottom: 1px solid var(--border);
    cursor: pointer; user-select: none; -webkit-user-select: none;
}
.board-list .vend:hover { color: var(--fg); }
.board-list .vend:focus-visible { outline: 1px solid var(--focus-bd); outline-offset: -1px; }
.board-list .vend .tw-caret { flex: 0 0 auto; opacity: .75; transition: transform .12s ease; }
.board-list .vend.open .tw-caret { transform: rotate(90deg); }
.board-list .vend .v-nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-list .vend .v-count { margin-left: auto; font-weight: 600; opacity: .75; flex: 0 0 auto; }
.board-list {
    max-height: 70vh; overflow-y: auto; padding: 4px 0;
}
/* Search row: the prefix filter plus collapse/expand-all for the vendor
   branches (tree affordances, one click each). */
.list-tools { display: flex; gap: 6px; margin-bottom: 8px; }
.list-tools input { flex: 1; min-width: 0; }
.ico-btn {
    flex: 0 0 auto; width: 28px; height: 28px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--btn2-bg); color: var(--btn2-fg);
    border: 1px solid var(--input-border); border-radius: 4px;
    cursor: pointer;
}
.ico-btn svg { display: block; }
.ico-btn:hover { filter: brightness(1.15); }
.ico-btn:active { transform: translateY(1px); }
/* The segmented source switcher: one click slices the tree to one storage
   location; "All" shows everything mixed. Segments render only for sources
   that HAVE boards, and the active slice is remembered across reopens. */
.srcbar {
    display: flex; margin-bottom: 8px;
    border: 1px solid var(--input-border); border-radius: 5px;
    overflow: hidden;
}
.srcbar button {
    flex: 1 1 0; min-width: 0; padding: 4px 5px;
    font-size: 11px; font-family: inherit;
    background: transparent; color: var(--fg2);
    border: none; border-right: 1px solid var(--input-border);
    border-radius: 0; cursor: pointer; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
}
.srcbar button:last-child { border-right: none; }
.srcbar button:hover:not(.on) { background: var(--hover); color: var(--fg); opacity: 1; }
.srcbar button.on { background: var(--btn-bg); color: var(--btn-fg); }
/* MCUs hang on the branch: indented under their vendor series, with a faint
   vertical guide that stops mid-row on the last MCU (the classic tree elbow)
   so each group reads as a branch, not a flat table. */
.board-list .item {
    position: relative;
    padding: 7px 12px 7px 30px; border-bottom: 1px solid var(--border);
    cursor: pointer; display: flex; justify-content: space-between;
    gap: 8px; align-items: center; transition: background .1s;
}
.board-list .item::before {
    content: ''; position: absolute; left: 16px; top: 0; bottom: 0;
    width: 1px; background: var(--border);
}
.board-list .item:last-child::before { bottom: 50%; }
.board-list .item:last-child { border-bottom: none; }
.board-list .item:hover { background: var(--hover); }
.board-list .item:focus-visible { outline: 1px solid var(--focus-bd); outline-offset: -1px; }
.board-list .item.sel { background: var(--hover); outline: 1px solid var(--input-border); outline-offset: -1px; }
.board-list .item .nm { font-size: 12px; font-weight: 600; color: var(--fg); }
.board-list .item .meta { font-size: 10px; color: var(--fg2); margin-top: 2px; }
.tag {
    font-size: 9px; padding: 1px 6px; border-radius: 8px;
    border: 1px solid var(--input-border); color: var(--fg2);
    white-space: nowrap; text-transform: uppercase; letter-spacing: .3px;
}
.tag.project { border-color: #4e9a51; color: #6fce73; }
.tag.global   { border-color: #3a7ea5; color: #5aa7d6; }
.tag.dir      { border-color: #b08542; color: #d9a856; }
.tag.builtin  { border-color: #6b6b6b; color: #9b9b9b; }

/* ─── Empty states ─── */
.empty-state {
    padding: 36px 20px; text-align: center;
    color: var(--fg2); font-size: 12px; line-height: 1.7;
}
.empty-state .empty-icon { font-size: 28px; margin-bottom: 10px; opacity: .7; }
.empty-state code {
    background: var(--code-bg); padding: 1px 4px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
}

/* ─── Form feedback ─── */
.err { color: #f14c4c; font-size: 11px; margin-top: 8px; white-space: pre-line; line-height: 1.5; }
.warn { color: #cca700; font-size: 11px; margin-top: 6px; white-space: pre-line; line-height: 1.5; }

/* ─── Info tooltips (ⓘ) — pure CSS hover/focus popovers ─── */
.tip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 13px; height: 13px; margin-left: 3px;
    border-radius: 50%;
    background: var(--vscode-badge-background, rgba(128,128,128,.35));
    color: var(--vscode-badge-foreground, var(--fg2));
    font-size: 9px; font-weight: bold; font-family: sans-serif;
    cursor: help; vertical-align: middle;
    position: relative; border: none; padding: 0;
    flex: 0 0 auto;
}
/* The "i" is a real text letter; line-height:1 pins the glyph to its own em
   box and a tiny translateY compensates the empty descender space. */
.tip::before {
    content: 'i';
    display: block; line-height: 1;
    transform: translateY(0.02em);
}
.tip-pop {
    display: none; position: absolute;
    left: 20px; top: -10px;
    width: 320px; max-width: 60vw;
    padding: 9px 11px; text-align: left;
    background: var(--tip-bg); color: var(--tip-fg);
    border: 1px solid var(--tip-bd); border-radius: 5px;
    box-shadow: 0 4px 14px rgba(0,0,0,.4);
    font-size: 11px; font-weight: normal; line-height: 1.5;
    z-index: 500; white-space: normal;
    overflow-wrap: break-word;   /* long code tokens must not overflow the box */
}
.tip-pop .tp-t { display: block; color: var(--fg); font-weight: 600; margin-bottom: 3px; font-size: 11px; }
.tip-pop .tp-x { display: block; color: var(--fg2); font-size: 11px; }
.tip-pop b { color: var(--fg); font-weight: 600; }
.tip:hover .tip-pop, .tip:focus .tip-pop { display: block; }
.tip.tip-end .tip-pop { left: auto; right: 20px; }

/* ─── Save bar (fixed) ─── */
.save-bar {
    position: fixed; left: 0; right: 0; bottom: 0;
    padding: 10px 20px;
    background: var(--vscode-editorWidget-background, var(--bg));
    border-top: 1px solid var(--border2);
    display: flex; align-items: center; gap: 12px;
    z-index: 100;
}
.save-bar .save-hint { font-size: 11px; color: var(--fg2); }
.save-bar .save-hint code { background: var(--code-bg); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); }
.save-bar button { padding: 7px 18px; font-size: 13px; }
.save-bar .save-spacer { flex: 1; }
.save-actions { display: flex; gap: 8px; align-items: center; }

/* ─── Section accent colors (left border) ─── */
.card.accent-list     { border-left: 3px solid var(--vscode-charts-blue, #4daafc); }
.card.accent-identity { border-left: 3px solid var(--accent); }
.card.accent-target   { border-left: 3px solid var(--vscode-charts-orange, #d28f1c); }
.card.accent-memory   { border-left: 3px solid var(--vscode-charts-yellow, #d1b02a); }
.card.accent-upload   { border-left: 3px solid var(--vscode-charts-purple, #a374e8); }
.card.accent-dest     { border-left: 3px solid var(--vscode-charts-green, #4ecf8b); }
</style>
</head>
<body>

<!-- ─── Page header ─── -->
<div class="page-hd">
    <h1>🧰 MCU Definitions (Board Manager)</h1>
    <div class="page-sub">
        Manage <b>MCU definitions</b> — the device profiles a project's <code>board</code> field points at.
        ${builtinCount} MCUs ship built-in (PIC10/12/16/18, PIC24, dsPIC30/33, PIC32), plus your own: each definition fixes the device name the
        XC compiler receives (<code>-mcpu=PIC18F4550</code>), <b>the compiler itself</b> (XC8 / XC16 / XC32 / XC-DSC), the clock,
        Flash/RAM/EEPROM sizes and the default programmer.
        Priority: <b>project → folder → global → built-in</b> — your edits land in
        <code>~/.pic-mdf/boards</code> (global) or <code>.pic/boards</code> (this project).
        Hover any <b>ⓘ</b> for an explanation of the field.
    </div>
    <div class="page-actions">
        Built-in definitions are <b>read-only</b> — duplicate one to customize it. Definitions are <b>hardware</b>, not project settings: one MCU can be reused by many projects.
    </div>
</div>

<div class="layout">
    <!-- ─── Left: the MCU list card ─── -->
    <div class="col-list">
        <section class="card accent-list">
            <header class="card-hd">
                <span class="c-icon">📋</span>
                <h3>MCUs</h3>
                <span class="c-sub">(<span id="count">0</span>)</span>
                <!-- ⓘ closes the title row (right edge); tip-end → popover opens leftwards. -->
                <span class="tip c-tip tip-end" tabindex="0" title="MCU list">
                    <span class="tip-pop"><span class="tp-t">MCU list</span>
                        <span class="tp-x">Every definition pic-mdf knows — <b>built-in</b> (read-only), <b>global</b> (saved in <code>~/.pic-mdf/boards</code> — outside VS Code's extension storage, so definitions <b>survive extension updates</b> and are available in <b>all projects</b>), <b>folder</b> (the <code>pic.boardsDir</code> setting) or <b>project</b> (saved in <code>&lt;root&gt;/.pic/boards/</code>, shadows the same id from other sources for that project only). The list is a <b>tree</b> — vendor series are the branches (click one to fold/unfold it, or use the collapse/expand-all buttons), their MCUs are the leaves — and the segmented switcher above the list instantly slices it to one source, or everything together. Click an MCU to edit it on the right; click <b>+ New</b> for a blank form. <b>Export / Import</b> copy your <b>global</b> definitions to/from a single JSON backup file (project and built-in definitions are not part of the backup).</span>
                    </span>
                </span>
                <!-- Toolbar: + New is THE primary action (green pill, 28px); the
                     Import/Export backup pair are grey secondaries, split by a
                     soft divider. Inline SVG icons — Unicode arrows render as
                     tofu on some Windows fonts. -->
                <div class="c-actions">
                    <button class="create" id="btnNew" title="Create a new blank MCU definition"><span class="plus" aria-hidden="true">+</span>New</button>
                    <span class="tb-sep" aria-hidden="true"></span>
                    <button class="sec" id="btnImport" title="Merge MCU definitions from a single backup JSON into ~/.pic-mdf/boards — never deletes anything"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.3M4.8 6.6 8 9.8l3.2-3.2M3 13.3h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Import</button>
                    <button class="sec" id="btnExport" title="Copy all your global MCU definitions (~/.pic-mdf/boards) into a single JSON backup file"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 9.8V2.5M4.8 5.7 8 2.5l3.2 3.2M3 13.3h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Export</button>
                </div>
            </header>
            <div class="card-bd">
                <!-- Tree controls: the prefix filter plus collapse/expand-all
                     for the vendor branches, and the segmented SOURCE switcher
                     below it re-slices the list instantly. -->
                <div class="list-tools">
                    <input id="listSearch" placeholder="Filter MCUs…  (matches anywhere in name / id / vendor / CPU / MCU / target)" autocomplete="off" spellcheck="false">
                    <button type="button" class="ico-btn" id="btnCollapseAll" title="Collapse all vendor branches" aria-label="Collapse all vendor branches"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8 8 4l4 4M4 13l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                    <button type="button" class="ico-btn" id="btnExpandAll" title="Expand all vendor branches" aria-label="Expand all vendor branches"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3l4 4 4-4M4 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                </div>
                <div id="srcbar" class="srcbar" role="group" aria-label="Filter MCUs by storage source"></div>
                <div id="list" class="board-list" role="tree" aria-label="MCU definitions by vendor series"></div>
            </div>
        </section>
    </div>

    <!-- ─── Right: editor / empty state ─── -->
    <div class="col-editor">
        <div id="empty" class="empty-state">
            <div class="empty-icon">👈</div>
            Select an MCU on the left to edit it, or click <b>+ New</b> to create one.<br>
            Built-in MCUs are read-only — <b>Duplicate</b> one to customize it.<br>
            Global definitions live in <code>~/.pic-mdf/boards</code> (every project, <b>survive extension updates</b>); project definitions (in <code>.pic/boards/</code>) shadow them for this project only.
        </div>

        <div id="form" style="display:none">

            <!-- ─── Identity ─── -->
            <section class="card accent-identity">
                <header class="card-hd">
                    <span class="c-icon">🪪</span>
                    <h3 id="edTitle">No MCU selected</h3>
                    <span class="tip c-tip" tabindex="0" title="MCU identity">
                        <span class="tip-pop"><span class="tp-t">Identity — name &amp; id</span>
                            <span class="tp-x"><b>Name</b> is a free-form display label (shown in the MCU picker and build messages). <b>Board id</b> is the file name on disk (<code>&lt;id&gt;.json</code>) AND the value projects put in their <code>board</code> field — must be unique, only <code>a-z 0-9 . _ -</code>; left empty it is derived from the device name. <b>Vendor</b> is the series label the MCU is grouped under (<code>PIC18 (8-bit)</code>, <code>PIC24F</code>, <code>dsPIC33CK</code>, <code>PIC32MX</code>…).</span>
                        </span>
                    </span>
                </header>
                <div class="card-bd">
                    <div class="row">
                        <label>Name <span class="tip" tabindex="0" title="Name">
                            <span class="tip-pop"><span class="tp-t">Name</span><span class="tp-x">Free-form display label, shown in the MCU picker and in build messages. <b>Example:</b> <code>PIC18F4550 (my board)</code>.</span></span>
                        </span></label>
                        <input id="f_name" placeholder="My custom MCU">
                    </div>
                    <div class="row">
                        <label>Board id <span class="tip" tabindex="0" title="Board id">
                            <span class="tip-pop"><span class="tp-t">Board id</span><span class="tp-x">Unique identifier — used as the JSON file name AND as the value projects reference via <code>"board"</code>. Lower-case, only <code>a-z 0-9 . _ -</code>, must start with a letter or digit. <b>Example:</b> <code>pic18f4550-usb</code>. Renaming an existing id creates a new file — the old one is not deleted automatically.</span></span>
                        </span></label>
                        <div class="fld">
                            <input id="f_id" placeholder="my-mcu" spellcheck="false">
                            <div class="hint">file name <code>&lt;id&gt;.json</code> + the value of <code>proj.board</code></div>
                        </div>
                    </div>
                    <div class="row">
                        <label>Vendor <span class="tip" tabindex="0" title="Vendor">
                            <span class="tip-pop"><span class="tp-t">Vendor</span><span class="tp-x">The series / family label the MCU is grouped under in this tree and in the pickers. Does not affect compilation. <b>Examples:</b> <code>PIC18 (8-bit)</code>, <code>PIC16F (8-bit)</code>, <code>PIC24F</code>, <code>dsPIC33CK (DSC)</code>, <code>PIC32MZ</code>.</span></span>
                        </span></label>
                        <input id="f_vendor" placeholder="PIC18 (8-bit)">
                    </div>
                </div>
            </section>

            <!-- ─── Target ─── -->
            <section class="card accent-target">
                <header class="card-hd">
                    <span class="c-icon">🎯</span>
                    <h3>Target</h3>
                    <span class="c-sub">device · compiler · family · clock</span>
                    <span class="tip c-tip" tabindex="0" title="Target">
                        <span class="tip-pop"><span class="tp-t">Target — device / compiler / family / clock</span>
                            <span class="tp-x"><b>Device</b> is the single most important field: the name the XC compiler receives (<code>-mcpu=</code> for XC8 / XC16 / XC-DSC, <code>-mprocessor=</code> for XC32) and the key of the device-pack lookup. <b>Compiler</b> is the Microchip toolchain every project that uses this MCU is built with — there is no per-project compiler setting, the compiler follows the MCU. <b>Family</b> is only a label. The <b>clock</b> feeds the automatic <code>_XTAL_FREQ</code> / <code>FCY</code> / <code>F_CPU</code> define.</span>
                        </span>
                    </span>
                </header>
                <div class="card-bd">
                    <div class="row">
                        <label>Device (MCU) <span class="tip" tabindex="0" title="Device">
                            <span class="tip-pop"><span class="tp-t">Device — -mcpu= / -mprocessor=</span><span class="tp-x">The device name the compiler receives, exactly as Microchip spells it. It fixes the instruction set, the <code>&lt;xc.h&gt;</code> register definitions and the linker script, and selects the Device Family Pack. <b>Examples:</b> <code>PIC18F4550</code>, <code>16F877A</code>, <code>24FJ128GA010</code>, <code>33CK256MP508</code>, <code>32MX795F512L</code>.</span></span>
                        </span></label>
                        <input id="f_device" placeholder="PIC18F4550" spellcheck="false">
                    </div>
                    <div class="row">
                        <label>Compiler <span class="tip" tabindex="0" title="Compiler">
                            <span class="tip-pop"><span class="tp-t">Compiler (toolchain)</span><span class="tp-x">The Microchip compiler for this device: <b>xc8</b> (8-bit PIC10/12/16/18), <b>xc16</b> (16-bit PIC24 / dsPIC30 / dsPIC33F/E), <b>xc32</b> (32-bit PIC32), <b>xcdsc</b> (dsPIC33A/C/E/F). It decides the compiler, the binutils and the kind of device pack used — <b>every project that picks this MCU is built with it</b>.</span></span>
                        </span></label>
                        <select id="f_toolchain">
                            <option value="xc8">xc8 — 8-bit PIC10 / 12 / 16 / 18</option>
                            <option value="xc16">xc16 — 16-bit PIC24 / dsPIC</option>
                            <option value="xc32">xc32 — 32-bit PIC32</option>
                            <option value="xcdsc">xcdsc — dsPIC33A / C / E / F</option>
                        </select>
                    </div>
                    <div class="row">
                        <label>Family <span class="tip" tabindex="0" title="Family">
                            <span class="tip-pop"><span class="tp-t">Family</span><span class="tp-x">A free-form core / family label shown in the MCU pickers and the project summary — <code>PIC18 (16-bit core)</code>, <code>mid-range (14-bit)</code>, <code>PIC24F</code>, <code>dsPIC33CK</code>. It does not change how the project is built.</span></span>
                        </span></label>
                        <input id="f_family" placeholder="e.g. mid-range (14-bit)" spellcheck="false">
                    </div>
                    <div class="row">
                        <label>Clock frequency (Hz) <span class="tip" tabindex="0" title="Clock frequency">
                            <span class="tip-pop"><span class="tp-t">Clock — one source of truth</span><span class="tp-x">Set the MCU clock in Hz once. The extension derives both the C literal (<code>8000000UL</code>) and the numeric value used for the automatic <code>_XTAL_FREQ</code> (XC8) / <code>FCY</code> (XC16, XC-DSC) / <code>F_CPU</code> definition, so they cannot drift apart. A project-specific override can be set in Project Editor → General.</span></span>
                        </span></label>
                        <input id="f_fcpu_hz" type="number" min="1" step="1" placeholder="8000000">
                    </div>
                </div>
            </section>

            <!-- ─── Memory ─── -->
            <section class="card accent-memory">
                <header class="card-hd">
                    <span class="c-icon">💾</span>
                    <h3>Memory</h3>
                    <span class="c-sub">Flash · RAM · EEPROM</span>
                    <span class="tip c-tip" tabindex="0" title="Memory sizes">
                        <span class="tip-pop"><span class="tp-t">Memory — Flash · RAM · EEPROM</span>
                            <span class="tp-x">Hardware limits for this MCU, in <b>bytes</b>, non-negative integers. <b>Flash</b> is the program memory the build summary measures the image against. <b>RAM</b> feeds the data-usage figures of the memory report. <b>EEPROM</b> is the data EEPROM (leave <code>0</code> for devices without one). <b>Example:</b> PIC18F4550 = 32768 / 2048 / 256.</span>
                        </span>
                    </span>
                </header>
                <div class="card-bd">
                    <div class="memrow">
                        <div class="cell">
                            <label>Flash (bytes) <span class="tip" tabindex="0" title="Flash">
                                <span class="tip-pop"><span class="tp-t">Flash (bytes)</span><span class="tp-x">Total program memory. The build summary compares the image size against it. For 12/14-bit PICs (PIC10/12/16) a program word is stored as two bytes in the HEX file, so a PIC16F877A with 8K words is <code>16384</code> (the datasheet figure &laquo;14 KB&raquo; counts 14 bits per word). For PIC24/dsPIC/PIC32 use the nominal flash from the part name. <b>Example:</b> 32768 for a PIC18F4550.</span></span>
                            </span></label>
                            <input id="f_flash" type="number" min="0" placeholder="32768">
                        </div>
                        <div class="cell">
                            <label>RAM (bytes) <span class="tip" tabindex="0" title="RAM">
                                <span class="tip-pop"><span class="tp-t">RAM (bytes)</span><span class="tp-x">Data RAM for globals, the stack and the heap. The memory report shows how much of it the firmware uses. <code>0</code> = unknown (no percentage is shown). <b>Example:</b> 2048 for a PIC18F4550.</span></span>
                            </span></label>
                            <input id="f_ram" type="number" min="0" placeholder="2048">
                        </div>
                        <div class="cell">
                            <label>EEPROM (bytes) <span class="tip tip-end" tabindex="0" title="EEPROM">
                                <span class="tip-pop"><span class="tp-t">EEPROM (bytes)</span><span class="tp-x">Data EEPROM size, <code>0</code> when the device has none. <b>Example:</b> 256 for a PIC18F4550.</span></span>
                            </span></label>
                            <input id="f_eeprom" type="number" min="0" placeholder="256">
                        </div>
                    </div>
                </div>
            </section>

            <!-- ─── Programming ─── -->
            <section class="card accent-upload">
                <header class="card-hd">
                    <span class="c-icon">⚙️</span>
                    <h3>Programming</h3>
                    <span class="c-sub">programmer · image size</span>
                    <span class="tip c-tip" tabindex="0" title="Programming">
                        <span class="tip-pop"><span class="tp-t">Programming — defaults of the MCU</span>
                            <span class="tp-x"><b>Programmer</b> is the default flashing tool recorded for this MCU and shown in the MCU pickers: <code>ipecmd</code> (MPLAB IPE — PICkit 4/5, SNAP, ICD 4/5, Real ICE, all families), <code>pk3cmd</code> (PICkit 3) or <code>pk2cmd</code> (PICkit 2). The tool a project really uses is chosen in its Project Editor (Upload). <b>Maximum image size</b> is optional — empty means "the Flash size", set it lower when a bootloader reserves part of the flash.</span>
                        </span>
                    </span>
                </header>
                <div class="card-bd">
                    <div class="row">
                        <label>Programmer <span class="tip" tabindex="0" title="Programmer">
                            <span class="tip-pop"><span class="tp-t">Programmer (protocol)</span><span class="tp-x">The default flashing tool of this MCU. <b>ipecmd</b> drives every Microchip programmer / debugger through MPLAB IPE; <b>pk3cmd</b> and <b>pk2cmd</b> are the legacy PICkit 3 / PICkit 2 command-line tools. A project overrides it in the Project Editor.</span></span>
                        </span></label>
                        <select id="f_protocol">
                            <option value="ipecmd">ipecmd — MPLAB IPE (all families)</option>
                            <option value="pk3cmd">pk3cmd — PICkit 3</option>
                            <option value="pk2cmd">pk2cmd — PICkit 2</option>
                        </select>
                    </div>
                    <div class="row">
                        <label>Maximum image size <span class="tip" tabindex="0" title="Maximum image size">
                            <span class="tip-pop"><span class="tp-t">Maximum image size (bytes)</span><span class="tp-x">Optional upper limit for the firmware image. Empty = the Flash size above. <b>Example:</b> 30720 when a 2 KB bootloader owns the top of a 32 KB flash.</span></span>
                        </span></label>
                        <input id="f_maxsize" type="number" min="0" placeholder="empty = Flash size">
                    </div>
                    <div class="row">
                        <label>Note <span class="tip" tabindex="0" title="Note">
                            <span class="tip-pop"><span class="tp-t">Note</span><span class="tp-x">Free-form reminder kept with the definition — e.g. <code>48 MHz from the PLL, 20 MHz crystal</code>.</span></span>
                        </span></label>
                        <input id="f_note" placeholder="e.g. 20 MHz crystal, PLL ×4">
                    </div>
                    <div class="row">
                        <label>Docs URL <span class="tip" tabindex="0" title="Docs URL">
                            <span class="tip-pop"><span class="tp-t">Docs URL</span><span class="tp-x">Datasheet or product page for this MCU. <b>Example:</b> <code>https://www.microchip.com/en-us/product/PIC18F4550</code>.</span></span>
                        </span></label>
                        <input id="f_url" placeholder="https://…">
                    </div>
                </div>
            </section>

            <!-- ─── Save destination ─── -->
            <section class="card accent-dest">
                <header class="card-hd">
                    <span class="c-icon">📍</span>
                    <h3>Save destination</h3>
                    <span class="c-sub">global vs project</span>
                    <span class="tip c-tip" tabindex="0" title="Save destination">
                        <span class="tip-pop"><span class="tp-t">Save destination — global vs project</span>
                            <span class="tp-x"><b>Global</b> definitions live in <code>~/.pic-mdf/boards</code> — in your home directory, <b>outside VS Code's extension storage</b>, so they survive extension updates and are visible in <b>every</b> project, with or without a project open. <b>Project</b> definitions are written into <code>&lt;root&gt;/.pic/boards/&lt;id&gt;.json</code> and shadow a same-id definition from any other source <b>for that project only</b>. The project option is unavailable when no folder is open.</span>
                        </span>
                    </span>
                </header>
                <div class="card-bd">
                    <div class="row">
                        <label>Save to <span class="tip" tabindex="0" title="Save to">
                            <span class="tip-pop"><span class="tp-t">Save to</span><span class="tp-x">Where the MCU JSON is written when you click <b>Save</b>. <b>Global</b> = available in every project. <b>Project</b> = <code>&lt;root&gt;/.pic/boards/</code>, shadows a same-id definition for the open project only.</span></span>
                        </span></label>
                        <select id="f_dest">
                            <option value="global">Global — ~/.pic-mdf/boards (all projects)</option>
                            <option value="project">Project — .pic/boards/ (this project only)</option>
                        </select>
                    </div>
                    <div class="hint" id="destHint"></div>
                </div>
            </section>

            <div class="err" id="err"></div>
            <div class="warn" id="warn"></div>
        </div>
    </div>
</div>

<!-- ─── Fixed save bar ─── -->
<div class="save-bar">
    <span class="save-hint" id="hintEmpty">select an MCU on the left, or click <b>+ New</b> to create one — actions appear here once a board is open</span>
    <span class="save-hint" id="hintEdit" style="display:none">writes <code>&lt;id&gt;.json</code> to the chosen destination — global definitions go to <code>~/.pic-mdf/boards</code> and are visible in <b>all</b> projects</span>
    <span class="save-hint" id="hintNew" style="display:none">new MCU — fill in the fields and click <b>Save</b>; <b>Open JSON</b>, <b>Duplicate</b> and <b>Delete</b> activate after the definition is saved</span>
    <span class="save-spacer"></span>
    <div class="save-actions" id="saveActions" style="display:none">
        <button class="sec" id="btnOpen" title="Open the MCU's JSON file in the editor">📂 Open JSON</button>
        <button class="sec" id="btnDup" title="Make a copy with a new id">⧉ Duplicate</button>
        <button class="danger" id="btnDel" title="Delete this MCU definition (every user-writable copy)">🗑 Delete</button>
        <button id="btnSave" title="Write the MCU JSON to the chosen destination">💾 Save</button>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
// HOST_STATE: the tree snapshot persisted by the HOST (see the 'uiState'
// message / persist() below). Injected at panel creation as the seed for a
// fresh webview whose own getState() is empty.
const HOST_STATE = ${escJson(hostStateJson)};
// The tree/census helpers below are the EXACT host functions from
// boardManager.js, injected via Function.toString(): the webview can never
// drift from the host implementation.
const treeGroups = ${treeGroups.toString()};
const sourcesCensus = ${sourcesCensus.toString()};
const SRC_LABELS = ${escJson(JSON.stringify(SRC_LABELS))};
const TAG_TEXT = { builtin: 'builtin', global: 'global', dir: 'folder', project: 'project' };
// The branch caret: a right-pointing chevron that rotates 90deg when the
// branch is open (CSS .vend.open .tw-caret). Inline SVG, no Unicode arrows —
// those render as tofu on some Windows fonts.
const CARET = '<svg class="tw-caret" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let boards = [], sel = null, ro = false, hasProject = false, isNew = false;
// The board id the Save button is currently writing (set in btnSave.onclick,
// consumed by the saveResult handler) — lets a successful save re-select the
// SAVED id, covering an id change, while a refused save leaves the form
// untouched for fixing.
let pendingSaveId = '';

// ─── Tree + switcher state ───
// srcFilter is the active slice of the segmented switcher ('all' | 'builtin' |
// 'global' | 'dir' | 'project'); collapsed remembers which vendor branches are
// folded. Init order: the panel's OWN vscode.getState first (that one survives
// hide/show of the same panel instance), and when a freshly created panel has
// none, the HOST_STATE snapshot embedded at creation. persist() mirrors every
// change back to the host, so the memento is always current.
let srcFilter = 'all';
let collapsed = {};
let autoFold = false;   // the first view of a long list (nothing stored yet) starts with every vendor branch folded
(function () {
    let st = null;
    try { st = vscode.getState && vscode.getState(); } catch (e) { /* shim environments */ }
    if (!st || typeof st !== 'object') { st = HOST_STATE; autoFold = !!(HOST_STATE && HOST_STATE.fresh); }
    if (st && typeof st === 'object') {
        if (typeof st.src === 'string') srcFilter = st.src;
        if (st.collapsed && typeof st.collapsed === 'object') collapsed = st.collapsed;
    }
})();
function persist() {
    try { vscode.setState({ src: srcFilter, collapsed }); } catch (e) {}
    try { vscode.postMessage({ type: 'uiState', state: { src: srcFilter, collapsed } }); } catch (e) {}
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function val(id) { return document.getElementById(id).value.trim(); }
function set(id, v) { document.getElementById(id).value = (v === undefined || v === null) ? '' : String(v); }
function fmtSize(n) { n = Number(n) || 0; return n >= 1024 && n % 1024 === 0 ? (n / 1024) + 'K' : String(n) + 'B'; }

// ─── The segmented source switcher ───
function renderSrcbar() {
    const bar = document.getElementById('srcbar');
    const census = sourcesCensus(boards);
    // The active slice may have vanished (e.g. the last global MCU was
    // deleted) — snap back to the full list instead of showing nothing. The
    // snap-back is PERSISTED too, so the next panel does not boot into a dead
    // slice just to snap again.
    if (srcFilter !== 'all' && !census.some(c => c.key === srcFilter)) { srcFilter = 'all'; persist(); }
    const tips = {
        all: 'Every MCU definition from every source, mixed together',
        builtin: 'Shipped with the extension (read-only) — duplicate one to customize it',
        global: 'Your definitions: ~/.pic-mdf/boards — every project, survives updates',
        dir: 'Extra folder from the pic.boardsDir setting',
        project: '<project>/.pic/boards — this project only, shadows other sources',
    };
    let html = '<button type="button" data-src="all" class="' + (srcFilter === 'all' ? 'on' : '') + '" aria-pressed="' + (srcFilter === 'all') + '" title="' + esc(tips.all) + '">All ' + boards.length + '</button>';
    for (const c of census) {
        html += '<button type="button" data-src="' + c.key + '" class="' + (srcFilter === c.key ? 'on' : '') + '" aria-pressed="' + (srcFilter === c.key) + '" title="' + esc(tips[c.key] || '') + '">' + esc(c.label) + ' ' + c.count + '</button>';
    }
    bar.innerHTML = html;
    bar.querySelectorAll('button').forEach(b => b.onclick = () => {
        srcFilter = b.dataset.src;
        persist();
        renderList();
    });
}

function toggleVendor(v) {
    if (collapsed[v]) delete collapsed[v]; else collapsed[v] = true;
    persist();
    renderList();
}

// Per-slice empty states: a filter that hides everything gets an honest
// explanation of WHERE those definitions would live, not a bare "no match".
function emptyFor(q) {
    if (q) return '<div class="empty-state" style="padding:22px 16px">No MCUs match "' + esc(q) + '"<br><span style="font-size:11px">the filter matches any part of the name / id / vendor / MCU</span></div>';
    const msgs = {
        builtin: 'No built-in MCU definitions found — the extension install looks broken.',
        global: 'No global MCUs yet.<br><span style="font-size:11px">Global definitions live in ~/.pic-mdf/boards — every project, survive updates. <b>+ New</b> creates one; <b>Import</b> restores a backup.</span>',
        dir: 'No MCUs in the extra folder.<br><span style="font-size:11px">Point the pic.boardsDir setting at a folder of board JSON files to have it show up here.</span>',
        project: 'No project MCUs.<br><span style="font-size:11px">Project definitions live in &lt;project&gt;/.pic/boards/ and shadow the same id from other sources for this project only.</span>',
    };
    return '<div class="empty-state" style="padding:22px 16px">' + (msgs[srcFilter] || 'No MCU definitions.') + '</div>';
}

// ─── The tree list ───
// Two instant layers, both host-free: (1) the source switcher slices the
// storage locations; (2) the substring filter narrows name/id/vendor/MCU. The host
// list arrives PRE-SORTED (vendors alphabetical, weakest MCU first inside a
// vendor) and both filters preserve that order, so the tree re-forms on the
// fly. While the filter field is non-empty every matching branch is forced
// open so results never hide inside a folded vendor; the per-branch fold
// state returns as soon as the field is cleared.
function renderList() {
    const el = document.getElementById('list');
    const q = (document.getElementById('listSearch').value || '').trim().toLowerCase();
    renderSrcbar();
    const bySrc = srcFilter === 'all' ? boards : boards.filter(b => (b.source || 'builtin') === srcFilter);
    const shown = q
        ? bySrc.filter(b =>
            (b.name || '').toLowerCase().includes(q) ||
            (b.id || '').toLowerCase().includes(q) ||
            (b.vendor || '').toLowerCase().includes(q) ||
            String(b.cpu || '').toLowerCase().includes(q) ||
            String(b.device || '').toLowerCase().includes(q) ||
            String(b.toolchain || '').toLowerCase().includes(q))
        : bySrc;
    document.getElementById('count').textContent = shown.length === boards.length
        ? String(boards.length) : shown.length + ' / ' + boards.length;
    let html = '';
    for (const g of treeGroups(shown)) {
        const fold = !q && collapsed[g.vendor] === true;
        html += '<div class="vend' + (fold ? '' : ' open') + '" data-v="' + esc(g.vendor) + '" role="button" tabindex="0" aria-expanded="' + (!fold) + '">' +
            CARET + '<span class="v-nm">' + esc(g.vendor) + '</span>' +
            '<span class="v-count">' + g.boards.length + '</span></div>';
        if (!fold) {
            html += '<div class="v-kids" role="group">';
            for (const b of g.boards) {
                const mem = (b.def && b.def.build && b.def.build.memory) || {};
                const cpuTxt = (b.cpu && String(b.cpu).toLowerCase() !== String(b.id).toLowerCase()) ? ' · ' + esc(b.cpu) : '';
                const memTxt = (mem.flash ? ' · ' + fmtSize(mem.flash) + ' flash' : '') + (mem.ram ? ' · ' + fmtSize(mem.ram) + ' RAM' : '');
                const meta = esc(b.id) + cpuTxt + ' · ' + esc(b.toolchain || '') + memTxt;
                html += '<div class="item' + (sel && !isNew && sel.id === b.id ? ' sel' : '') + '" data-id="' + esc(b.id) + '" role="treeitem" tabindex="0">' +
                    '<div><div class="nm">' + esc(b.name) + '</div>' +
                    '<div class="meta">' + meta + '</div></div>' +
                    '<span class="tag ' + esc(b.source || 'builtin') + '">' + esc(TAG_TEXT[b.source || 'builtin'] || (b.source || 'builtin')) + '</span></div>';
            }
            html += '</div>';
        }
    }
    el.innerHTML = html || emptyFor(q);
    el.querySelectorAll('.vend').forEach(v => {
        const t = () => toggleVendor(v.dataset.v);
        v.onclick = t;
        v.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t(); } };
    });
    el.querySelectorAll('.item').forEach(i => {
        const t = () => selectBoard(i.dataset.id);
        i.onclick = t;
        i.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t(); } };
    });
}
document.getElementById('listSearch').oninput = renderList;
// Tree affordances: fold every vendor branch / open them all again. One click,
// instant (the fold map is webview-local state).
document.getElementById('btnCollapseAll').onclick = () => {
    collapsed = {};
    for (const g of treeGroups(boards)) collapsed[g.vendor] = true;
    persist(); renderList();
};
document.getElementById('btnExpandAll').onclick = () => {
    collapsed = {};
    persist(); renderList();
};

// Selecting an MCU is a host round-trip ({type:'edit', id} → {type:'board'}):
// the form always shows the CURRENT file content, never a stale copy.
function selectBoard(id) { vscode.postMessage({ type: 'edit', id: id }); }

// ─── The editor form ───
function renderForm() {
    const form = document.getElementById('form');
    const title = document.getElementById('edTitle');
    document.getElementById('empty').style.display = sel ? 'none' : 'block';
    form.style.display = sel ? 'block' : 'none';
    document.getElementById('saveActions').style.display = sel ? 'flex' : 'none';
    document.getElementById('hintEmpty').style.display = sel ? 'none' : 'inline';
    document.getElementById('hintNew').style.display = (sel && isNew) ? 'inline' : 'none';
    document.getElementById('hintEdit').style.display = (sel && !isNew) ? 'inline' : 'none';
    renderDest();
    if (!sel) { title.textContent = 'No MCU selected'; return; }
    ro = (sel.source || '') === 'builtin';
    const def = sel.def || {};
    const base = def.name || (isNew ? 'New MCU' : sel.id);
    title.textContent = base + (ro ? '  (built-in — read only)' : (isNew ? '  (unsaved)' : ''));
    set('f_id', sel.id || '');
    set('f_name', def.name || '');
    set('f_vendor', def.vendor || '');
    set('f_device', (def.build && def.build.device) || '');
    set('f_toolchain', def.toolchain || 'xc8');
    set('f_family', (def.build && def.build.family) || '');
    // (family is a free-text field for PIC — no select handling needed)
    const fcpuLiteral = String((def.build && def.build.f_cpu) || '');
    const fcpuParsed = Number(fcpuLiteral.replace(/[uUlL]+$/, ''));
    const fcpuHz = Number.isFinite(fcpuParsed) && fcpuParsed > 0 ? fcpuParsed : Number((def.build && def.build.f_cpu_hz) || 1000000);
    set('f_fcpu_hz', Number.isFinite(fcpuHz) && fcpuHz > 0 ? fcpuHz : 1000000);
    const mem = (def.build && def.build.memory) || {};
    set('f_flash', mem.flash); set('f_ram', mem.ram); set('f_eeprom', mem.eeprom);
    const up = def.upload || {};
    setProtocol(up.protocol || 'ipecmd');
    set('f_maxsize', up.maximum_size); set('f_note', up.note);
    set('f_url', def.url);
    // Built-in MCUs: EVERYTHING is read-only (duplicate & edit to customize).
    for (const id of ['f_id', 'f_name', 'f_vendor', 'f_device', 'f_toolchain', 'f_family', 'f_fcpu_hz',
                      'f_flash', 'f_ram', 'f_eeprom', 'f_protocol', 'f_maxsize',
                      'f_note', 'f_url', 'f_dest']) {
        document.getElementById(id).disabled = ro;
    }
    document.getElementById('btnSave').disabled = ro;
    // A brand-new (unsaved) MCU has no JSON file on disk yet — nothing to
    // open, duplicate or delete, so those actions stay disabled until the
    // definition is saved.
    document.getElementById('btnDel').disabled  = ro || isNew;
    document.getElementById('btnOpen').disabled = isNew;
    document.getElementById('btnDup').disabled  = isNew;
    document.getElementById('err').textContent = '';
    document.getElementById('warn').textContent = '';
    // Default destination: keep editing where the MCU lives.
    document.getElementById('f_dest').value = sel.source === 'project' ? 'project' : 'global';
}

// the programmer select holds the known tools; a hand-written value stays selectable (nothing is lost on save)
function setProtocol(v) {
    const selEl = document.getElementById('f_protocol');
    const want = String(v || 'ipecmd');
    if (![...selEl.options].some(o => o.value === want)) {
        const o = document.createElement('option');
        o.value = want; o.textContent = want + ' (custom)';
        selEl.appendChild(o);
    }
    selEl.value = want;
}

// a new MCU without an id gets one from its device name (the host derives the same)
function deriveId(dev) {
    return String(dev || '').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^[^a-z0-9]+/i, '');
}

function renderDest() {
    const destSel = document.getElementById('f_dest');
    const wsOpt = destSel.querySelector('option[value="project"]');
    if (wsOpt) wsOpt.disabled = !hasProject;
    if (!hasProject) destSel.value = 'global';
    document.getElementById('destHint').textContent = hasProject
        ? 'Global definitions (~/.pic-mdf/boards) are available in every project and survive extension updates; project definitions (.pic/boards/) shadow them for this project only.'
        : 'No project open — definitions are saved to ~/.pic-mdf/boards (all projects, survives updates).';
}

// collect() builds the definition to save. The loaded definition is the BASE
// and only the form-managed fields are overwritten on top of it — every
// unknown/extra field (extra_flags, optimization, custom keys…) survives an
// edit instead of being destroyed.
function collect() {
    const num = id => { const v = document.getElementById(id).value.trim(); return v === '' ? undefined : parseInt(v, 10); };
    const def = (sel && sel.def) ? JSON.parse(JSON.stringify(sel.def)) : {};
    def.name = val('f_name');
    const vendor = val('f_vendor');
    if (vendor) def.vendor = vendor; else delete def.vendor;
    def.build = def.build || {};
    def.build.device = val('f_device');
    def.toolchain = val('f_toolchain');
    const _fam = val('f_family'); if (_fam) def.build.family = _fam; else delete def.build.family;
    const hzRaw = val('f_fcpu_hz');
    const hz = hzRaw === '' ? 1000000 : Number(hzRaw);
    def.build.f_cpu_hz = Number.isFinite(hz) ? hz : 0;
    def.build.f_cpu = (Number.isFinite(hz) && hz > 0) ? String(hz) + 'UL' : '0UL';
    def.build.memory = def.build.memory || {};
    def.build.memory.flash   = num('f_flash')   ?? 0;
    def.build.memory.ram     = num('f_ram')     ?? 0;
    def.build.memory.eeprom  = num('f_eeprom')  ?? 0;
    def.upload = def.upload || {};
    def.upload.protocol = val('f_protocol') || 'ipecmd';
    const _mx = val('f_maxsize');
    if (_mx !== '') def.upload.maximum_size = parseInt(_mx, 10); else delete def.upload.maximum_size;
    const _note = val('f_note');
    if (_note) def.upload.note = _note; else delete def.upload.note;
    const url = val('f_url');
    if (url) def.url = url; else delete def.url;
    return def;
}

// ─── Buttons ───
document.getElementById('btnNew').onclick = () => vscode.postMessage({ type: 'new' });
document.getElementById('btnExport').onclick = () => vscode.postMessage({ type: 'export' });
document.getElementById('btnImport').onclick = () => vscode.postMessage({ type: 'import' });
document.getElementById('btnSave').onclick = () => {
    document.getElementById('err').textContent = '';
    document.getElementById('warn').textContent = '';
    const sid = (val('f_id') || deriveId(val('f_device'))).toLowerCase();
    set('f_id', sid);
    pendingSaveId = sid;
    // Send the id/file of the MCU being EDITED so the host can refuse to
    // overwrite a DIFFERENT board when the id was changed (a normal re-save
    // writes the same file and must stay allowed).
    vscode.postMessage({
        type: 'save',
        data: {
            id: sid,
            board: collect(),
            dest: document.getElementById('f_dest').value,
            originalId: (sel && !isNew && sel.id) ? sel.id : '',
            originalFile: (sel && !isNew && sel.file) ? sel.file : '',
        },
    });
};
document.getElementById('btnDel').onclick = () => {
    if (!sel || ro || isNew) return;
    vscode.postMessage({ type: 'delete', id: sel.id });
};
document.getElementById('btnDup').onclick = () => {
    if (!sel || isNew) return;
    vscode.postMessage({ type: 'duplicate', id: sel.id });
};
document.getElementById('btnOpen').onclick = () => {
    if (sel && !isNew && sel.file) vscode.postMessage({ type: 'openFile', id: sel.id });
};

// ─── Host messages ───
window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m || !m.type) return;
    if (m.type === 'boards') {
        boards = m.boards || [];
        hasProject = !!m.hasProject;
        if (autoFold) {
            autoFold = false;
            if (boards.length > 400) {
                collapsed = {};
                for (const g of treeGroups(boards)) collapsed[g.vendor] = true;
                persist();
            }
        }
        if (isNew) {
            // A brand-new MCU was just saved → the refreshed list contains it;
            // re-select by the id typed in the form so the editor flips to
            // "saved" mode (buttons activate) instead of collapsing.
            const typed = val('f_id');
            const again = typed && boards.find(b => b.id === typed);
            if (again) { sel = again; isNew = false; }
            else {
                // An UNSAVED draft — renderForm() would re-read every field
                // from the (empty) draft and wipe the typed input. Refresh the
                // LIST only (Import merge and reveal-refresh land here).
                renderList(); renderDest(); return;
            }
        } else if (sel) {
            const again = boards.find(b => b.id === sel.id);
            if (again) {
                // Same MCU re-selected — the form may hold UNSAVED edits that a
                // refresh must not wipe; only a vanished MCU (delete) falls
                // through to renderForm() (empty state).
                sel = again; renderList(); renderDest(); return;
            }
            sel = null;   // deleted while the form was open
        }
        renderList(); renderForm();
        return;
    }
    if (m.type === 'board') {
        // edit / new / duplicate. The entry is looked up in the local list:
        // found → editing an existing MCU (source/file drive read-only + Open
        // JSON); not found → an unsaved draft (+ New, or a Duplicate copy).
        pendingSaveId = '';
        const entry = m.id ? boards.find(b => b.id === m.id) : null;
        sel = {
            id: m.id || '',
            def: m.board || {},
            source: entry ? entry.source : '',
            file: entry ? entry.file : '',
        };
        isNew = !entry;
        renderList(); renderForm();
        return;
    }
    if (m.type === 'saveResult') {
        // A successful save re-selects the SAVED id — the 'boards' refresh that
        // arrived just before this message deliberately left the form
        // untouched, so an id CHANGE now lands the editor on the NEW MCU
        // instead of pointing at the kept old definition.
        if (m.ok && pendingSaveId) {
            const again = boards.find(b => b.id === pendingSaveId);
            if (again) { sel = again; isNew = false; renderList(); renderForm(); }
        }
        pendingSaveId = '';
        if (!m.ok) document.getElementById('err').textContent = (m.errors || []).join('\\n');
        else if (m.warnings && m.warnings.length) document.getElementById('warn').textContent = m.warnings.join('\\n');
        return;
    }
});

// ─── Badge-aware tooltip placement ───
// Pick the horizontal side FIRST — flip to the other side of the ⓘ badge when
// this one has no room — and only then clamp whatever still sticks out (the
// bottom edge, mostly). Pure math, no dependencies.
function placeTipPop(b, r, vw, vh, M, GAP) {
    const w = r.width, h = r.height;
    const onRight = r.left >= b.left;               // which side did CSS pick?
    const roomR = vw - M - (b.right + GAP);         // space right of the badge
    const roomL = b.left - GAP - M;                 // …and left of it
    let left;
    if (onRight) {
        if (w <= roomR) left = b.right + GAP;           // fits right — as laid out
        else if (w <= roomL) left = b.left - GAP - w;   // no room → flip to the left
        else left = roomR >= roomL ? vw - M - w : M;    // neither fits → roomier side
    } else {
        if (w <= roomL) left = b.left - GAP - w;        // fits left — as laid out
        else if (w <= roomR) left = b.right + GAP;      // no room → flip to the right
        else left = roomL >= roomR ? M : vw - M - w;
    }
    let top = r.top;                                // CSS keeps it 10px above the badge
    if (top + h > vh - M) top = vh - M - h;         // crosses the bottom → lift
    if (top < M) top = M;                           // …but never above the top edge
    return { left, top };
}
(function () {
    const M = 8, GAP = 7;   // GAP matches CSS left:20px on the 13px badge (20-13)
    const clamp = tip => {
        const pop = tip.querySelector('.tip-pop');
        if (!pop) return;
        // Reset overrides → measure the rect exactly as CSS laid it out
        pop.style.left = ''; pop.style.right = ''; pop.style.top = '';
        const b = tip.getBoundingClientRect();
        const r = pop.getBoundingClientRect();
        const t = placeTipPop(b, r,
            document.documentElement.clientWidth, document.documentElement.clientHeight, M, GAP);
        // Inline left/top override BOTH CSS anchors.
        pop.style.right = 'auto';
        pop.style.left = Math.round(t.left - b.left) + 'px';
        pop.style.top = Math.round(t.top - b.top) + 'px';
    };
    const release = tip => {
        const pop = tip.querySelector('.tip-pop');
        if (pop) { pop.style.left = ''; pop.style.right = ''; pop.style.top = ''; }
    };
    document.querySelectorAll('.tip').forEach(tip => {
        tip.addEventListener('mouseenter', () => clamp(tip));
        tip.addEventListener('focus', () => clamp(tip));
        tip.addEventListener('mouseleave', () => release(tip));
        tip.addEventListener('blur', () => release(tip));
    });
    window.addEventListener('resize', () => {
        document.querySelectorAll('.tip').forEach(tip => {
            const pop = tip.querySelector('.tip-pop');
            if (pop && getComputedStyle(pop).display !== 'none') clamp(tip);
        });
    });
})();

vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}

module.exports = { openBoardManager, cmdExport, cmdImport, validateBoardDef, saveBoardDef, deleteBoardDef, sortBoardsForList, treeGroups, sourcesCensus, _normalizeBoardDef, _getHtml };
