'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// extension.js — PIC-MDF activation: tree views, webview views, status bar,
// all commands, the project create/select wizards, port picking, the project
// editor / board manager / config editor, and teardown.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const _promptedPacksThisSession = new Set();
const Toolchain = require('./toolchain');
const Boards = require('./boards');
const Tree   = require('./treeProvider');
const StatusBar = require('./statusBar');
const Build  = require('./build');
const Flash  = require('./flash');
const Device = require('./device');
const Monitor = require('./monitor');
const MemoryView = require('./memoryView');
const Ports  = require('./ports');
const Validator = require('./validator');
const IntelliSense = require('./intellisense');
const Tasks  = require('./tasks');
const LaunchJson = require('./launchJson');
const ProjEdit = require('./projectEditor');
const Components = require('./components');
const BoardManager = require('./boardManager');
const ImportProject = require('./importProject');
const DebugProvider = require('./debugProvider');
const PackManager = require('./packManager');

function _isRootAcceptable(rootPath) {
    if (!rootPath) return false;
    try { if (!fs.existsSync(rootPath)) return false; } catch { return false; }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return true;
    return folders.some(f => {
        const rel = path.relative(f.uri.fsPath, rootPath);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
}

function _collectCandidateProjects() {
    const out = [];
    const seen = new Set();
    const folders = vscode.workspace.workspaceFolders || [];
    const probe = (fsPath, isSubfolder) => {
        if (seen.has(fsPath)) return;
        seen.add(fsPath);
        const { status, proj, parseError } = Validator.readProjectConfig(fsPath);
        let projectType, hint;
        if (status === 'missing') { projectType = 'none'; hint = 'No pic-project.json — not a PIC project'; }
        else if (status === 'broken') { projectType = 'broken'; hint = `pic-project.json: broken JSON (${parseError})`; }
        else {
            const report = Validator.validateProjectConfig(proj, fsPath, { countSources: false });
            if (report.errors.length) { projectType = 'errors'; hint = `pic-project.json: ${report.errors.length} error(s)`; }
            else if (report.warnings.length) { projectType = 'warnings'; hint = `valid with ${report.warnings.length} warning(s)`; }
            else { projectType = 'valid'; hint = 'PIC project (config valid)'; }
        }
        out.push({ fsPath, projectType, hint, isSubfolder });
    };
    for (const f of folders) {
        probe(f.uri.fsPath, false);
        try {
            for (const entry of fs.readdirSync(f.uri.fsPath, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
                const sub = path.join(f.uri.fsPath, entry.name);
                if (fs.existsSync(path.join(sub, 'pic-project.json'))) probe(sub, true);
            }
        } catch {}
    }
    return out;
}

function activate(ctx) {
    // Defence in depth; VS Code also disables this extension in Restricted Mode.
    if (!vscode.workspace.isTrusted) return;

    H.setCtx(ctx);
    const oc = H.getOutputChannel();
    ctx.subscriptions.push(oc);
    oc.appendLine('[PIC-MDF] Extension activated');

    const savedRoot = ctx.workspaceState.get('picActiveRoot');
    if (_isRootAcceptable(savedRoot)) H.setActiveRoot(savedRoot);

    // ─── Tree views ───────────────────────────────────────────────────────
    const expandedIds = new Set(ctx.workspaceState.get('picTreeExpanded') || []);
    const saveExpandedIds = () => ctx.workspaceState.update('picTreeExpanded', [...expandedIds]);
    const isExpanded = (id) => expandedIds.has(id);
    const provider = new Tree.PicProvider({ isExpanded });
    H.setProvider(provider);
    const treeView = vscode.window.createTreeView('pic.projectView', { treeDataProvider: provider });
    ctx.subscriptions.push(treeView);
    ctx.subscriptions.push(
        treeView.onDidExpandElement(e => { if (e.element && e.element.id) { expandedIds.add(e.element.id); saveExpandedIds(); } }),
        treeView.onDidCollapseElement(e => { if (e.element && e.element.id) { expandedIds.delete(e.element.id); saveExpandedIds(); } }),
        treeView.onDidChangeVisibility(e => { if (e.visible) StatusBar.markUiVisible(); }),
    );
    // the checkbox of a component (Project Folder → Components) enables / disables it
    if (typeof treeView.onDidChangeCheckboxState === 'function') ctx.subscriptions.push(treeView.onDidChangeCheckboxState(Components.onCheckbox));
    if (treeView.visible) StatusBar.markUiVisible();

    const devtoolsProvider = new Tree.PicDevtoolsProvider({ isExpanded });
    H.setDevtoolsProvider(devtoolsProvider);
    const devtoolsView = vscode.window.createTreeView('pic.devtoolsView', { treeDataProvider: devtoolsProvider });
    ctx.subscriptions.push(devtoolsView);
    ctx.subscriptions.push(
        devtoolsView.onDidExpandElement(e => { if (e.element && e.element.id) { expandedIds.add(e.element.id); saveExpandedIds(); } }),
        devtoolsView.onDidCollapseElement(e => { if (e.element && e.element.id) { expandedIds.delete(e.element.id); saveExpandedIds(); } }),
        devtoolsView.onDidChangeVisibility(e => { if (e.visible) StatusBar.markUiVisible(); }),
    );
    if (devtoolsView.visible) StatusBar.markUiVisible();

    const refProvider = new Tree.PicRefProvider();
    H.setRefProvider(refProvider);
    const refView = vscode.window.createTreeView('pic.referenceView', { treeDataProvider: refProvider });
    ctx.subscriptions.push(refView);
    ctx.subscriptions.push(refView.onDidChangeVisibility(e => { if (e.visible) StatusBar.markUiVisible(); }));
    if (refView.visible) StatusBar.markUiVisible();

    // ─── Webview views ────────────────────────────────────────────────────
    MemoryView.registerProvider(ctx);
    Monitor.registerProvider(ctx);

    // ─── Status bar / debug / tasks ───────────────────────────────────────
    StatusBar.createStatusBar(ctx);
    DebugProvider.register(ctx);
    ctx.subscriptions.push(vscode.tasks.registerTaskProvider('pic', {
        provideTasks: () => Tasks.provideTasks(),
        resolveTask: (task) => Tasks.resolveTask(task),
    }));

    // ─── Commands ─────────────────────────────────────────────────────────
    const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
    reg('pic.build', () => Build.build());
    reg('pic.flash', () => Flash.flash());
    reg('pic.clean', () => Build.clean());
    reg('pic.openMonitor', () => Monitor.cmdOpen());
    reg('pic.monitor.start', () => Monitor.cmdStart());
    reg('pic.monitor.stop', () => Monitor.cmdStop());
    reg('pic.monitor.clear', () => Monitor.clearOutput());
    reg('pic.monitor.refreshPorts', () => Monitor.cmdRefreshPorts());
    reg('pic.createProject', cmdCreateProject);
    reg('pic.importProject', ImportProject.cmdImportProject);
    reg('pic.selectProject', cmdSelectProject);
    reg('pic.clearProject', cmdClearProject);
    reg('pic.editProject', ProjEdit.openProjectEditor);
    Components.registerCommands(reg);
    reg('pic.syncLaunchConfigs', LaunchJson.cmdSyncLaunchConfigs);
    reg('pic.generateTasks', Tasks.cmdGenerateTasks);
    reg('pic.showProblems', cmdShowProblems);
    reg('pic.selectBoard', cmdSelectBoard);
    reg('pic.manageBoards', BoardManager.openBoardManager);
    reg('pic.exportBoards', BoardManager.cmdExport);
    reg('pic.importBoards', BoardManager.cmdImport);
    reg('pic.selectToolchain', Toolchain.cmdSelectToolchain);
    reg('pic.pack.installForProject', PackManager.cmdInstallPackForProject);
    reg('pic.pack.installByName', PackManager.cmdInstallPackByName);
    reg('pic.pack.list', PackManager.cmdListPacks);
    reg('pic.pack.updateCatalog', PackManager.cmdUpdateCatalog);
    reg('pic.pack.openStore', PackManager.cmdOpenStore);
    reg('pic.selectProgrammer', Flash.selectProgrammer);
    reg('pic.selectPort', cmdSelectPort);
    reg('pic.configureIntelliSense', IntelliSense.cmdConfigureIntelliSense);
    reg('pic.toggleBuildMode', StatusBar.cmdToggleBuildMode);
    reg('pic.refreshMemory', () => MemoryView.refresh());
    reg('pic.config.open', Device.openConfigEditor);
    reg('pic.eeprom.upload', Flash.eepromUpload);
    reg('pic.eeprom.download', Flash.eepromDownload);
    reg('pic.erase', Flash.chipErase);
    reg('pic.showDisassembly', Device.showDisassembly);
    reg('pic.reference.insert', cmdRefInsert);
    reg('pic.reference.doc', cmdRefDoc);
    reg('pic.refresh', () => {
        Toolchain.invalidate();
        Boards.invalidate();
        if (H.getProvider()) H.getProvider().refresh();
        if (H.getDevtoolsProvider()) H.getDevtoolsProvider().refresh();
        if (H.getRefProvider()) H.getRefProvider().refresh();
        MemoryView.refresh();
    });
    reg('pic.collapseAll', () => { try { vscode.commands.executeCommand('workbench.actions.treeView.pic.projectView.collapseAll'); } catch {} });
    reg('pic.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:pic-mdf'));
    reg('pic.returnViews', () => {
        for (const view of ['pic.projectView', 'pic.memoryView', 'pic.monitorView', 'pic.devtoolsView', 'pic.referenceView']) {
            try { vscode.commands.executeCommand(`${view}.resetViewLocation`); } catch {}
        }
    });

    // ─── Config-change hooks ──────────────────────────────────────────────
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('pic')) {
            Toolchain.invalidate();
            Boards.invalidate();
            StatusBar.refreshStatusBar();
            if (H.getProvider()) H.getProvider().refresh();
            if (H.getDevtoolsProvider()) H.getDevtoolsProvider().refresh();
            if (e.affectsConfiguration('pic.buildMode')) { try { ProjEdit.notifyBuildModeChanged(); } catch {} }
            if (e.affectsConfiguration('pic.comPort')) { try { Monitor.onComPortChanged(); } catch {} }
        }
    }));

    // ─── Startup ──────────────────────────────────────────────────────────
    try {
        Toolchain.detect();
        if (H.getDevtoolsProvider()) H.getDevtoolsProvider().refresh();
    } catch (e) { H.log(`[toolchain] startup detection failed: ${e.message}`); }
    if (H.getActiveRoot()) {
        Tasks.syncAfterProjectChange();
        LaunchJson.syncAfterProjectChange();
        IntelliSense.syncAfterProjectChange();
    }
}

// ─── Select / clear project ──────────────────────────────────────────────────
async function cmdSelectProject() {
    if (H.checkBusy()) return;
    const candidates = _collectCandidateProjects();
    const items = candidates.map(c => ({
        label: path.basename(c.fsPath) + (c.isSubfolder ? '  (subfolder)' : ''),
        description: c.fsPath,
        detail: c.hint,
        kind: vscode.QuickPickItemKind.Default,
        pick: c,
    }));
    items.push({ label: '$(file-directory) Browse for a folder…', browse: true });
    const pick = await vscode.window.showQuickPick(items, {
        matchOnDescription: true, matchOnDetail: true,
        placeHolder: 'Select the PIC project folder (the one with pic-project.json)',
    });
    if (!pick) return;
    let root = null;
    if (pick.browse) {
        const sel = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: 'PIC › Select the project folder',
        });
        if (!sel || !sel.length) return;
        root = sel[0].fsPath;
    } else {
        root = pick.pick.fsPath;
        if (pick.pick.projectType === 'none') {
            const fix = await vscode.window.showErrorMessage(
                `PIC: "${path.basename(root)}" is not a PIC project (no pic-project.json).`,
                'Create project here', 'Pick another folder'
            );
            if (fix === 'Create project here') {
                const boardId = await Boards.selectBoard(null, { placeHolder: 'Board for the new project' });
                if (!boardId) return;
                await _createProjectIn(root, path.basename(root), boardId);
                return;
            }
            if (fix === 'Pick another folder') { cmdSelectProject(); return; }
            return;
        }
        if (pick.pick.projectType === 'broken') {
            vscode.window.showErrorMessage(`PIC: pic-project.json in "${path.basename(root)}" is broken JSON — fix it first.`);
            return;
        }
    }
    _setActiveProject(root);
}

function _setActiveProject(root) {
    H.setActiveRoot(root);
    H.getCtx()?.workspaceState.update('picActiveRoot', root);
    Boards.invalidate();
    if (H.getProvider()) H.getProvider().refresh();
    if (H.getRefProvider()) H.getRefProvider().refresh();
    try { require('./statusBar').refreshStatusBar(); } catch {}
    Tasks.syncAfterProjectChange();
    LaunchJson.syncAfterProjectChange();
    IntelliSense.syncAfterProjectChange();
    H.log(`Active project → ${root}`);
    // offer to install the device's DFP if missing (once per device per session)
    try {
        const V = require('./validator');
        const { status, proj } = V.readProjectConfig(root);
        if (status === 'ok' && proj && proj.board) {
            const b = Boards.getBoard(proj.board);
            const dev = b && b.build && b.build.device;
            const tc = H.resolveToolchain(proj);
            if (dev && !_promptedPacksThisSession.has(dev)) {
                _promptedPacksThisSession.add(dev);
                require('./packManager').ensureFor(dev, tc);
            }
        }
    } catch {}
}

function cmdClearProject() {
    if (H.checkBusy()) return;
    H.setActiveRoot(null);
    H.getCtx()?.workspaceState.update('picActiveRoot', null);
    Boards.invalidate();
    if (H.getProvider()) H.getProvider().refresh();
}

// ─── Create project (wizard) ─────────────────────────────────────────────────
async function cmdCreateProject() {
    if (H.checkBusy()) return;
    const name = await vscode.window.showInputBox({
        prompt: 'Project name (used in pic-project.json; keep it ASCII)',
        value: 'my-pic-project',
        validateInput: validateProjectNameValue,
    });
    if (!name) return;
    const boardId = await Boards.selectBoard(null, { placeHolder: 'Target board / MCU' });
    if (!boardId) return;
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: 'Create Project Here',
        title: 'PIC-MDF › Create Project Folder (new or empty)',
    });
    if (!picked || picked.length === 0) return;
    await _createProjectIn(picked[0].fsPath, name, boardId);
}

async function _createProjectIn(projectDir, name, boardId) {
    if (fs.existsSync(path.join(projectDir, 'pic-project.json'))) {
        vscode.window.showErrorMessage(`PIC: "${path.basename(projectDir)}" already contains a pic-project.json — refusing to overwrite.`);
        return;
    }
    const board = Boards.getBoard(boardId);
    let mainPath = null;
    try {
        for (const d of ['src', 'include', 'lib', 'components', '.vscode']) {
            fs.mkdirSync(path.join(projectDir, d), { recursive: true });
        }
        mainPath = path.join(projectDir, 'src', 'main.c');
        fs.writeFileSync(mainPath, Boards.mainTemplate(board, H.resolveToolchain({ board: boardId })));
        fs.writeFileSync(path.join(projectDir, 'pic-project.json'), JSON.stringify({
            name,
            board: boardId,
            sources: ['src'],
            includes: ['include'],
            defines: [],
            libraries: ['lib'],
            components: ['components'],
            build: { output_dir: 'build', output_name: 'firmware', hooks: {} },
            upload: { programmer: 'ipecmd' },
        }, null, 2) + '\n');
        fs.writeFileSync(path.join(projectDir, '.vscode', 'settings.json'), JSON.stringify({}, null, 2) + '\n');
    } catch (e) {
        vscode.window.showErrorMessage(`PIC: failed to create the project in "${projectDir}": ${e.message}`);
        return;
    }
    const startIdx = vscode.workspace.workspaceFolders?.length || 0;
    try {
        vscode.workspace.updateWorkspaceFolders(startIdx, 0, { uri: vscode.Uri.file(projectDir), name: path.basename(projectDir) });
    } catch {}
    _setActiveProject(projectDir);
    try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mainPath)); } catch {}
    vscode.window.showInformationMessage(`✅ Project "${name}" created (device: ${board ? board.build.device : boardId}, compiler: ${H.resolveToolchain({ board: boardId })}).`);
    try { if (board && board.build && board.build.device) require('./packManager').ensureFor(board.build.device, H.resolveToolchain({ board: boardId })); } catch {}
}

// ─── Select port ─────────────────────────────────────────────────────────────
async function cmdSelectPort() {
    if (H.checkBusy()) return null;
    const current = H.cfg('comPort') || '';
    const detected = Ports.detectPorts();
    const items = detected.map(p => ({
        label: `$(plug) ${p}`,
        description: p === current ? 'current' : '',
        picked: p === current,
        port: p,
    }));
    items.push({ label: '$(edit) Enter port manually…', port: null });
    const picked = await vscode.window.showQuickPick(items, {
        title: 'PIC: Select Serial Port',
        placeHolder: detected.length ? 'Detected ports' : 'No ports detected — enter manually',
    });
    if (!picked) return null;
    let input = picked.port;
    if (!input) {
        input = await vscode.window.showInputBox({
            prompt: 'Enter port manually',
            placeHolder: H.IS_WIN ? 'COM3' : '/dev/ttyUSB0',
            value: current,
            validateInput: text => {
                if (!text) return 'Port cannot be empty';
                if (!/^[a-zA-Z0-9./\\_-]+$/.test(text)) return 'Invalid characters in port name';
                return null;
            },
        });
        if (!input) return null;
    }
    await H.setCfg('comPort', input);
    vscode.window.showInformationMessage(`PIC: Port → ${input}`);
    StatusBar.refreshStatusBar();
    Monitor.postState();
    if (H.getProvider()) H.getProvider().refresh();
    return input;
}

// ─── Select board ────────────────────────────────────────────────────────────
async function cmdSelectBoard() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const id = await Boards.selectBoard(proj.board);
    if (!id) return;
    proj.board = id;
    const board = Boards.getBoard(id);
    delete proj.toolchain;   // legacy key — the compiler follows the MCU now
    try {
        fs.writeFileSync(path.join(root, 'pic-project.json'), JSON.stringify(proj, null, 2) + '\n');
        Boards.invalidate();
        if (H.getProvider()) H.getProvider().refresh();
        vscode.window.showInformationMessage(`PIC: board → ${id} (rebuild to apply).`);
        IntelliSense.syncAfterProjectChange();
        // offer to install the device's DFP if missing
        try { if (board && board.build && board.build.device) require('./packManager').ensureFor(board.build.device, H.resolveToolchain(proj)); } catch {}
    } catch (e) {
        vscode.window.showErrorMessage(`PIC: could not update the project — ${e.message}`);
    }
}

// ─── Show problems ───────────────────────────────────────────────────────────
function cmdShowProblems() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj, parseError } = Validator.readProjectConfig(root);
    const text = status === 'missing'
        ? 'No pic-project.json in the active folder.'
        : status === 'broken'
            ? `pic-project.json is broken JSON:\n${parseError}`
            : Validator.reportText(proj, root);
    const doc = vscode.window.createOutputChannel('PIC — Project Report');
    doc.clear();
    doc.appendLine(text);
    doc.show(true);
}

// ─── Reference helpers ───────────────────────────────────────────────────────
// The inline buttons pass the TREE ITEM (item.entry = the data row); the tree
// click passes the row itself; the palette passes nothing → a quick-pick.
function _refEntryOf(item) {
    return (item && item.entry) ? item.entry : (item && typeof item === 'object' ? item : null);
}
function _refAllEntries(filter) {
    const out = [];
    for (const m of require('./referenceData').MODULES) {
        for (const e of (m.entries || [])) if (!filter || filter(e)) out.push({ label: e.name, description: m.title, detail: e.desc || '', entry: e });
    }
    return out;
}
async function cmdRefInsert(item) {
    let e = _refEntryOf(item);
    let name = e && e.name ? String(e.name) : (typeof item === 'string' ? item : '');
    if (!name) {
        const pick = await vscode.window.showQuickPick(_refAllEntries(x => /^#\s*include\b/.test(x.name)),
            { title: 'PIC: insert an #include', placeHolder: 'Choose a header', matchOnDetail: true });
        if (!pick) return;
        name = pick.label;
    }
    if (!/^#\s*include\b/.test(name)) {
        vscode.window.showInformationMessage(`PIC: "${name}" is not an #include line — use Reference Details for its usage.`);
        return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage(`PIC: ${name} — open a C file to insert it.`); return; }
    if (editor.document.getText().includes(name)) { vscode.window.setStatusBarMessage(`PIC: ${name} already present`, 2500); return; }
    const ok = await editor.edit(eb => {
        let insertLine = 0;
        for (let i = 0; i < editor.document.lineCount; i++) {
            if (/^\s*#\s*include/.test(editor.document.lineAt(i).text)) insertLine = i + 1;
        }
        eb.insert(new vscode.Position(insertLine, 0), name + '\n');
    });
    if (ok) vscode.window.setStatusBarMessage(`PIC: inserted ${name}`, 2500);
}
async function cmdRefDoc(item) {
    let e = _refEntryOf(item);
    if (!e || !e.name) {
        const pick = await vscode.window.showQuickPick(_refAllEntries(), { title: 'PIC: XC reference', placeHolder: 'Choose an entry', matchOnDescription: true, matchOnDetail: true });
        if (!pick) return;
        e = pick.entry;
    }
    const a = await vscode.window.showInformationMessage(`${e.name}: ${e.desc || ''}`, 'Copy signature');
    if (a === 'Copy signature') vscode.env.clipboard.writeText(e.signature || e.name || '');
}

// ─── Name validation ─────────────────────────────────────────────────────────
const WINDOWS_RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);
function validateProjectNameValue(v) {
    const s = String(v || '').trim();
    if (!s) return 'Project name is required.';
    if (!H.isAscii(s)) return 'Only ASCII characters (Latin letters, digits, "-" and "_").';
    if (!/^[A-Za-z]/.test(s)) return 'The name must start with a Latin letter.';
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return 'Only Latin letters, digits, "-" and "_" are allowed.';
    if (WINDOWS_RESERVED_NAMES.has(s.toUpperCase())) return `"${s}" is a reserved Windows device name.`;
    if (/[. ]$/.test(s)) return 'The name must not end with a dot or a space.';
    if (s.length > 64) return 'Keep the name under 64 characters.';
    return null;
}

function deactivate() {
    H.clearBusy();
    try { require('./monitor').cmdStop(); } catch {}
    const terms = H.getTerms();
    for (const t of Object.values(terms)) { try { t.dispose(); } catch {} }
    H.setTerms({});
}

module.exports = { activate, deactivate };
