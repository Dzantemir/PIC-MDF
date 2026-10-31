'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// hooks.js — pre_build / post_link / post_build / pre_upload / post_upload
// shell hooks from pic-project.json build.hooks, in the PIC terminal.
// Every stage is a LIST of commands. A non-zero exit stops the stage.
// ${...} variables are expanded (unresolved ones stay literal).
// ─────────────────────────────────────────────────────────────────────────────
const H = require('./helpers');

function getHook(proj, name) {
    const cmd = proj && proj.build && proj.build.hooks ? proj.build.hooks[name] : null;
    if (typeof cmd === 'string' && cmd.trim()) return [cmd.trim()];
    if (Array.isArray(cmd)) return cmd.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim());
    return [];
}

async function runHook(proj, name, vars, termName = 'PIC') {
    const cmds = getHook(proj, name);
    if (!cmds.length) return 0;
    let last = 0;
    for (let i = 0; i < cmds.length; i++) {
        // Values substituted into a hook line are escaped for the active shell
        // (context-aware), so branch names / env values cannot inject commands.
        const expanded = H.expandHookCommand(cmds[i], vars);
        H.log(`[hook] ${name} [${i + 1}/${cmds.length}]: ${expanded}`);
        last = await H.runInTerminal(termName, [expanded], { cwd: vars.workspaceFolder || H.getActiveRoot() });
        if (last !== 0) {
            H.log(`[hook] ${name} FAILED (exit ${last})`);
            return last;
        }
    }
    return last;
}

module.exports = { runHook };
