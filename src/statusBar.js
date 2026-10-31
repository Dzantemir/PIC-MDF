'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// statusBar.js — the bar follows the panel (the AVR-MDF/sdcc-mdf pattern).
// Build / Flash / Clean / Monitor / port / toolchain are persistent COMMAND
// entry points, shown once a view of the container has been opened. The busy
// indicator is never gated.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const H      = require('./helpers');

let _uiVisible = false;

function markUiVisible() {
    if (_uiVisible) return;
    _uiVisible = true;
    applyUiVisibility();
}
function applyUiVisibility() {
    for (const n of ['build', 'flash', 'clean', 'monitor']) {
        const bar = H.getStatusBarItem(n);
        if (bar) { if (_uiVisible) bar.show(); else bar.hide(); }
    }
    refreshStatusBar();
}

function createStatusBar(ctx) {
    const busy = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 106);
    busy.command = 'workbench.action.terminal.focus';
    ctx.subscriptions.push(busy);
    H.setStatusBarItem('busy', busy);

    const build = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 105);
    build.text = '$(tools) Build'; build.tooltip = 'PIC: Build (Ctrl+Alt+B)'; build.command = 'pic.build';
    ctx.subscriptions.push(build); H.setStatusBarItem('build', build);

    const flash = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 104);
    flash.text = '$(zap) Flash'; flash.tooltip = 'PIC: Flash (Ctrl+Alt+F)'; flash.command = 'pic.flash';
    ctx.subscriptions.push(flash); H.setStatusBarItem('flash', flash);

    const clean = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
    clean.text = '$(trash) Clean'; clean.tooltip = 'PIC: Clean (Ctrl+Alt+C)'; clean.command = 'pic.clean';
    ctx.subscriptions.push(clean); H.setStatusBarItem('clean', clean);

    const monitor = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    ctx.subscriptions.push(monitor); H.setStatusBarItem('monitor', monitor);
    refreshMonitorButton();

    const port = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    port.command = 'pic.selectPort';
    ctx.subscriptions.push(port); H.setStatusBarItem('port', port);

    const mode = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    mode.command = 'pic.toggleBuildMode';
    ctx.subscriptions.push(mode); H.setStatusBarItem('mode', mode);

    const tchain = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    tchain.command = 'pic.selectToolchain';
    ctx.subscriptions.push(tchain); H.setStatusBarItem('toolchain', tchain);

    applyUiVisibility();
}

async function cmdToggleBuildMode() {
    if (H.checkBusy()) return;
    const cur = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug' ? 'debug' : 'release';
    const next = cur === 'debug' ? 'release' : 'debug';
    await H.setCfg('buildMode', next);
    refreshStatusBar();
    vscode.window.showInformationMessage(
        `PIC: build mode → ${next}${next === 'debug' ? ' (-O0 -g + DEBUG)' : ' (optimized)'}`);
    if (H.getProvider()) H.getProvider().refresh();
}

function refreshStatusBar() {
    if (!_uiVisible) return;
    const portBar = H.getStatusBarItem('port');
    if (portBar) {
        const port = H.cfg('comPort');
        portBar.text = port ? `$(plug) ${port}` : '$(plug) No port';
        portBar.tooltip = port ? `PIC port: ${port}\nClick to change` : 'PIC: no port selected';
        portBar.show();
    }
    const tcBar = H.getStatusBarItem('toolchain');
    if (tcBar) {
        const root = H.getActiveRoot();
        if (root) {
            const id = H.getProjectToolchain(root);
            let found = false, detail = '';
            try {
                const tc = require('./toolchain').detect();
                const t = tc[id];
                if (t) { found = true; detail = t.driver + (t.version ? ' v' + t.version : ''); }
                else detail = 'compiler not found';
            } catch {}
            const short = id === 'xcdsc' ? 'XC-DSC' : id.toUpperCase();
            tcBar.text = `${found ? '$(chip)' : '$(warning)'} ${short}`;
            tcBar.tooltip = `PIC compiler (chosen automatically from the MCU): ${short}\n${detail}\nClick to check the detected compilers / set a compiler folder`;
            tcBar.show();
        } else {
            tcBar.hide();
        }
    }
    const modeBar = H.getStatusBarItem('mode');
    if (modeBar) {
        const isDebug = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug';
        modeBar.text = isDebug ? '$(bug) Debug' : '$(circuit-board) Release';
        modeBar.tooltip = isDebug ? 'PIC build mode: debug\nClick to switch to release' : 'PIC build mode: release\nClick to switch to debug';
        modeBar.show();
    }
}

function refreshMonitorButton() {
    const bar = H.getStatusBarItem('monitor');
    if (!bar) return;
    const M = require('./monitor');
    const running = !!(M && M.isConnected && M.isConnected());
    if (running) {
        bar.text = '$(debug-stop) Monitor';
        bar.tooltip = 'Stop Monitor';
        bar.command = 'pic.monitor.stop';
        bar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        bar.text = '$(terminal) Monitor';
        bar.tooltip = 'Start Monitor';
        bar.command = 'pic.monitor.start';
        bar.backgroundColor = undefined;
    }
    if (_uiVisible) bar.show();
    try { vscode.commands.executeCommand('setContext', 'pic.monitorConnected', running); } catch {}
}

module.exports = { createStatusBar, refreshStatusBar, refreshMonitorButton, cmdToggleBuildMode, markUiVisible };
