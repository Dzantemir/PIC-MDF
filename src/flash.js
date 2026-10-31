'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// flash.js — programming the PIC with the Microchip command-line tools:
//   ipecmd  (MPLAB IPE — the modern universal CLI, all families)
//   pk3cmd  (PICkit 3)
//   pk2cmd  (PICkit 2)
//   nw_prog (the older PICkit 2 standalone)
// plus a fully custom upload.tool + args with ${…} expansion.
// The command is assembled from the project upload{} + board upload{} +
// pic.programmer / pic.comPort settings.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Toolchain = require('./toolchain');
const Boards = require('./boards');
const Validator = require('./validator');
const Hooks  = require('./hooks');
const { buildVars, extendVars } = require('./build');

const TERM = 'PIC';

// ─── Programmer recipes ──────────────────────────────────────────────────────
// toolFlag — the flag that names the executable in upload.tool when the user
// picked a recipe (kept in upload.programmer).
const RECIPES = [
    {
        id: 'ipecmd', label: 'MPLAB IPE (ipecmd) — all families',
        desc: 'The MPLAB Integrated Programming Environment CLI. Drives PICkit 4/5, SNAP, ICD 4/5, Real ICE, PM3 and most third-party programmers. Pass -P<tool> and -TPPK4/-TPICD4/-TSNAP…',
        needsDevice: true, needsFile: true, tool: 'ipecmd',
    },
    {
        id: 'pk3cmd', label: 'PICkit 3 (pk3cmd)',
        desc: 'The classic PICkit 3 command-line programmer.',
        needsDevice: true, needsFile: true, tool: 'pk3cmd',
    },
    {
        id: 'pk2cmd', label: 'PICkit 2 (pk2cmd)',
        desc: 'The PICkit 2 command-line programmer (legacy devices).',
        needsDevice: true, needsFile: true, tool: 'pk2cmd',
    },
    {
        id: 'nw_prog', label: 'PICkit 2 standalone (nw_prog)',
        desc: 'The older PICkit 2 standalone programmer.',
        needsDevice: true, needsFile: true, tool: 'nw_prog',
    },
    {
        id: 'custom', label: 'Custom (edit in the project)',
        desc: 'Set upload.tool / upload.args in pic-project.json — full ${…} variable expansion. Use this for ICD, PM3, or a bootloader script.',
        custom: true,
    },
];
function recipeFor(id) { return RECIPES.find(r => r.id === id) || null; }

// ─── The flash argv (ipecmd-style) ───────────────────────────────────────────
// ipecmd:  ipecmd -P<tool> -TP<device> -F<file.hex> -M -OL
//   -P<programmer>   e.g. PK4 / PK5 / SNAP / ICD4 / ICD5 / RICE / PM3
//   -TP<device>      the device (PIC18F4550 …)
//   -F<hex>          the file to program
//   -M               program the whole device (erase + program + verify)
//   -OL              power the target from the programmer
//   -W               (pk3cmd) erase before programming
function _programmerFlags(prog, device, hex) {
    switch (prog.tool) {
        case 'ipecmd':
            return [`-P${prog.hw || 'PK4'}`, `-TP${device}`, `-F${hex}`, '-M', '-OL'];
        case 'pk3cmd':
            return [`-P${device}`, `-F${hex}`, '-M', '-Y'];
        case 'pk2cmd':
            return [`-P${device}`, `-F${hex}`, '-M'];
        case 'nw_prog':
            return [`-P${device}`, `-F${hex}`, '-M'];
        default:
            return [];
    }
}

// ─── Flash ───────────────────────────────────────────────────────────────────
async function flash() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const board = Boards.getBoard(proj.board);
    if (!board) { vscode.window.showErrorMessage(`PIC: board "${proj.board}" not found.`); return; }

    const _out = H.expandOutPaths(root, proj);
    const hexPath = path.join(_out.outDirAbs, _out.outName + '.hex');
    if (!fs.existsSync(hexPath)) {
        const pick = await vscode.window.showErrorMessage(
            `PIC: ${_out.outName}.hex not found — build the project first (${_out.outDirRel}/).`,
            'Build now'
        );
        if (pick === 'Build now') await require('./build').build();
        return;
    }

    const up = proj.upload || {};
    const vars = buildVars(root, proj, board, { toolchain: H.getProjectToolchain(root) });

    // custom tool path
    if (up.tool && Array.isArray(up.args) && up.tool !== 'ipecmd' && up.tool !== 'pk3cmd' && up.tool !== 'pk2cmd') {
        return await _flashCustom(root, proj, vars, up, hexPath);
    }

    const progId = String(up.programmer || H.cfg('programmer') || 'ipecmd');
    const recipe = recipeFor(progId) || recipeFor('ipecmd');
    const toolName = recipe.tool || 'ipecmd';
    const toolPath = H._which ? H._which(toolName) : null;
    const exe = toolPath || toolName;

    const hw = String(up.hardware || H.cfg('programmerHardware') || 'PK4');
    const argv = _programmerFlags({ tool: toolName, hw }, board.build.device, hexPath);

    H.setBusy('Flash');
    try {
        const preEc = await Hooks.runHook(proj, 'pre_upload', vars, TERM);
        if (preEc !== 0) { vscode.window.showErrorMessage(`PIC: pre_upload hook failed (exit ${preEc}) — flash aborted.`); return; }
        H.log(`[flash] ${exe} ${argv.join(' ')}`);
        const line = [H.exe(exe), ...argv.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
        const ec = await H.runInTerminal(TERM, [line]);
        if (ec === 0) {
            H.flashBarFeedback('flash', '$(check) Flashed', '$(zap) Flash');
            const postEc = await Hooks.runHook(proj, 'post_upload', vars, TERM);
            if (postEc !== 0) H.log(`[flash] post_upload hook exit ${postEc} (ignored)`);
            vscode.window.showInformationMessage(`PIC: ${board.build.device} programmed.`);
            H.log('✔ Flash OK');
            if (H.cfg('monitorAutoOpen')) {
                const Monitor = require('./monitor');
                Monitor.reveal();
            }
            return true;
        } else if (ec === -1) {
            vscode.window.showErrorMessage('PIC: flash interrupted (no exit code seen).');
            return false;
        } else {
            vscode.window.showErrorMessage(`PIC: programmer failed (exit ${ec}) — see the PIC terminal output.`);
            return false;
        }
    } finally {
        H.clearBusy();
    }
}

async function _flashCustom(root, proj, vars, up, hexPath) {
    // extendVars keeps git:hash / git:branch lazy (no git rev-parse unless used).
    const merged = extendVars(vars, { hex: hexPath, outputHex: hexPath });
    const resolved = up.args.map(a => H.configVarResolver()(H.envVarResolver()(H.expandVars(String(a), merged))));
    const line = [H.exe(up.tool), ...resolved.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
    H.setBusy('Flash');
    try {
        H.log(`[flash] custom tool: ${line}`);
        const ec = await H.runInTerminal(TERM, [line]);
        if (ec === 0) {
            H.flashBarFeedback('flash', '$(check) Flashed', '$(zap) Flash');
            return true;
        }
        vscode.window.showErrorMessage(`PIC: custom upload tool failed (exit ${ec}).`);
        return false;
    } finally {
        H.clearBusy();
    }
}

// ─── Chip erase ──────────────────────────────────────────────────────────────
async function chipErase() {
    if (H.checkBusy()) return;
    const pick = await vscode.window.showWarningMessage(
        'PIC: erase the whole device? Program memory, data EEPROM and config bits are returned to their erased state.',
        { modal: true }, 'Erase device'
    );
    if (pick !== 'Erase device') return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const board = Boards.getBoard(proj.board);
    if (!board) { vscode.window.showErrorMessage(`PIC: board "${proj.board}" not found.`); return; }
    const up = proj.upload || {};
    const progId = String(up.programmer || H.cfg('programmer') || 'ipecmd');
    const recipe = recipeFor(progId) || recipeFor('ipecmd');
    const toolName = recipe.tool || 'ipecmd';
    const exe = (H._which ? H._which(toolName) : null) || toolName;
    const device = board.build.device;
    let argv;
    if (toolName === 'ipecmd') argv = [`-P${up.hardware || 'PK4'}`, `-TP${device}`, '-E'];
    else if (toolName === 'pk3cmd') argv = [`-P${device}`, '-E'];
    else if (toolName === 'pk2cmd') argv = [`-P${device}`, '-E'];
    else argv = [`-P${device}`, '-E'];
    H.setBusy('Chip Erase');
    try {
        const line = [H.exe(exe), ...argv.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
        const ec = await H.runInTerminal(TERM, [line]);
        if (ec === 0) vscode.window.showInformationMessage('PIC: device erased.');
        else vscode.window.showErrorMessage(`PIC: erase failed (exit ${ec}).`);
    } finally { H.clearBusy(); }
}

// ─── EEPROM / data-memory up + download ──────────────────────────────────────
// ipecmd can read/write the data-EEPROM range with -G/-F on a hex image, but
// the exact flags are family-dependent. For families where the compiler
// produces no .eep artifact, we drive the config/EEPROM editor instead and
// stay honest about what the programmer supports.
async function eepromUpload() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false, openLabel: 'Write data image',
        title: 'PIC: EEPROM / data image to write (.hex)',
        defaultUri: vscode.Uri.file(root),
        filters: { 'Hex images': ['hex'], 'All files': ['*'] },
    });
    if (!picked || !picked.length) return;
    const file = picked[0].fsPath;
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const board = Boards.getBoard(proj.board);
    if (!board) { vscode.window.showErrorMessage(`PIC: board "${proj.board}" not found.`); return; }
    const device = board.build.device;
    const up = proj.upload || {};
    const toolName = (recipeFor(String(up.programmer || H.cfg('programmer') || 'ipecmd')) || {}).tool || 'ipecmd';
    const exe = (H._which ? H._which(toolName) : null) || toolName;
    const argv = toolName === 'ipecmd'
        ? [`-P${up.hardware || 'PK4'}`, `-TP${device}`, `-F${file}`, '-M', '-OL']
        : [`-P${device}`, `-F${file}`, '-M'];
    H.setBusy('EEPROM upload');
    try {
        const line = [H.exe(exe), ...argv.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
        const ec = await H.runInTerminal(TERM, [line]);
        if (ec === 0) vscode.window.showInformationMessage(`PIC: ${path.basename(file)} written.`);
        else vscode.window.showErrorMessage(`PIC: EEPROM upload failed (exit ${ec}).`);
    } finally { H.clearBusy(); }
}

async function eepromDownload() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const board = Boards.getBoard(proj.board);
    if (!board) { vscode.window.showErrorMessage(`PIC: board "${proj.board}" not found.`); return; }
    const _out = H.expandOutPaths(root, proj);
    let outDir = _out.outDirAbs;
    try { if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true }); } catch { outDir = root; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(outDir, `eeprom-dump-${stamp}.hex`);
    const device = board.build.device;
    const up = proj.upload || {};
    const toolName = (recipeFor(String(up.programmer || H.cfg('programmer') || 'ipecmd')) || {}).tool || 'ipecmd';
    const exe = (H._which ? H._which(toolName) : null) || toolName;
    const argv = toolName === 'ipecmd'
        ? [`-P${up.hardware || 'PK4'}`, `-TP${device}`, `-GF${target}`]
        : [`-P${device}`, `-GF${target}`];
    H.setBusy('EEPROM download');
    try {
        const line = [H.exe(exe), ...argv.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
        const ec = await H.runInTerminal(TERM, [line]);
        if (ec === 0 && fs.existsSync(target)) {
            vscode.window.showInformationMessage(`PIC: data read → ${path.relative(root, target)}`, 'Open')
                .then(a => { if (a === 'Open') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target)); });
        } else if (ec === 0) {
            vscode.window.showWarningMessage('PIC: programmer exited 0 but no dump file was created (this family may not expose a readable data region via this tool).');
        } else {
            vscode.window.showErrorMessage(`PIC: EEPROM download failed (exit ${ec}).`);
        }
    } finally { H.clearBusy(); }
}

// ─── Programmer picker ───────────────────────────────────────────────────────
async function selectProgrammer() {
    const root = H.getActiveRoot();
    let proj = null;
    if (root) {
        const r = Validator.readProjectConfig(root);
        if (r.status === 'ok') proj = r.proj;
    }
    const current = String((proj && proj.upload && proj.upload.programmer) || H.cfg('programmer') || '');
    const items = RECIPES.map(r => ({
        label: (r.id === current ? '$(check) ' : '') + r.label,
        description: r.id,
        detail: r.desc,
        recipe: r,
    }));
    const pick = await vscode.window.showQuickPick(items, {
        matchOnDescription: true, matchOnDetail: true,
        placeHolder: 'Select the programmer',
    });
    if (!pick) return;
    if (pick.recipe.custom) {
        vscode.commands.executeCommand('pic.editProject');
        return;
    }
    if (proj && root) {
        proj.upload = proj.upload || {};
        proj.upload.programmer = pick.recipe.id;
        try {
            fs.writeFileSync(path.join(root, 'pic-project.json'), JSON.stringify(proj, null, 2) + '\n');
        } catch (e) {
            vscode.window.showErrorMessage(`PIC: could not update pic-project.json — ${e.message}`);
            return;
        }
    } else {
        await H.setCfg('programmer', pick.recipe.id);
    }
    if (H.getProvider()) H.getProvider().refresh();
    vscode.window.showInformationMessage(`PIC: programmer set to ${pick.recipe.id}.`);
}

module.exports = {
    flash, chipErase, eepromUpload, eepromDownload,
    selectProgrammer, RECIPES,
};
