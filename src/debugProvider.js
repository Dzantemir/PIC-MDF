'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// debugProvider.js — the PIC debug configuration provider.
// Full MDB (Microchip Debugger) integration is a large surface; this provider
// gives VS Code a working launch type that:
//   • resolves the program path from the active project (default build output)
//   • locates an MDB / simulator when one is configured
//   • reports honestly when no debugger is available (the PIC families have no
//     avr-gdb/simavr equivalent in the box — MDB is a separate install).
// It never pretends a session started when it could not.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Validator = require('./validator');

function register(ctx) {
    ctx.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('pic', new PicConfigurationProvider()));
}

class PicConfigurationProvider {
    resolveDebugConfiguration(folder, config) {
        // Fill defaults from the active project.
        const root = H.getActiveRoot();
        if (root) {
            const { status, proj } = Validator.readProjectConfig(root);
            if (status === 'ok') {
                if (!config.program) {
                    const out = H.expandOutPaths(root, proj);
                    config.program = path.join(out.outDirAbs, out.outName + '.elf');
                }
                if (!config.cwd) config.cwd = root;
                if (!config.mdbPath) config.mdbPath = String(H.cfg('debug.mdbPath') || '');
                if (!config.simPath) config.simPath = String(H.cfg('debug.simPath') || '');
            }
        }
        if (config.stopOnEntry === undefined) config.stopOnEntry = true;
        return config;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
        // Verify the program exists — do not open a dead session.
        if (config.program && !fs.existsSync(config.program)) {
            const build = await vscode.window.showErrorMessage(
                `PIC: firmware not found — ${config.program}`, 'Build now');
            if (build === 'Build now') {
                await vscode.commands.executeCommand('pic.build');
            }
            return undefined;
        }
        if (!config.mdbPath) {
            const found = _findMdb();
            if (!found) {
                vscode.window.showWarningMessage(
                    'PIC: no Microchip MDB debugger was found. Install MPLAB X (which ships mdb) or set pic.debug.mdbPath. ' +
                    'The PIC families do not have a bundled avr-gdb-style debugger — MDB is a separate installation.');
                return undefined;
            }
            config.mdbPath = found;
        }
        return config;
    }
}

function _findMdb() {
    const candidates = ['mdb', 'mdb.bat'];
    const exts = H.IS_WIN ? ['.exe', '.bat', ''] : ['' ]; 
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const d of dirs) for (const c of candidates) for (const e of exts) {
        const p = path.join(d, c + e);
        try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
    return null;
}

module.exports = { register };
