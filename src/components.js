'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// components.js — PIC-MDF's glue for the shared components infrastructure
// (componentModel.js / componentsHost.js, the same files ship in avr-mdf and
// sdcc-mdf): the adapter, the commands and the sidebar description.
//
//   main + components/<name>/ — each component has its own sources, include
//   folders, prebuilt libraries (.a) and "requires"; edited in the Component
//   Editor (sidebar → Project Folder → Components), exactly like esp8266-idf.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const H      = require('./helpers');
const Validator = require('./validator');
const Sources = require('./sources');
const Host   = require('./componentsHost');

let _host = null;

// ELF e_machine of the objects each compiler produces (libInspect.js)
const EXPECT = {
    xc8:   { machines: [204],   label: 'XC8 (8-bit PIC)' },
    xc16:  { machines: [118],   label: 'XC16 (PIC24 / dsPIC)' },
    xcdsc: { machines: [118],   label: 'XC-DSC (dsPIC)' },
    xc32:  { machines: [8, 40], label: 'XC32 (PIC32)' },
};

function host() {
    if (_host) return _host;
    _host = Host.create({
        id: 'pic', prefix: 'PIC', title: 'PIC-MDF',
        projectFile: Validator.PROJECT_FILE,
        mediaFile: path.join(__dirname, '..', 'media', 'component-editor.html'),
        libExts: ['.a'],
        libFilter: { 'Static libraries': ['a'] },
        sourceFilter: { 'Source files': ['c', 'cc', 'cpp', 'cxx', 's', 'S', 'asm'] },
        labels: {
            sourceHint: 'C/C++ (.c .cc .cpp .cxx) and assembly (.s .S .asm) files are compiled.',
            sourceRuleHint: 'Per-source "flags" in a rule are supported by XC16 / XC32 / XC-DSC; the XC8 one-step driver shares one set of flags.',
            libHint: 'The libraries are handed to the linker after the objects (several libraries: in an --start-group on XC16 / XC32 / XC-DSC).',
            archLabel: (root, proj) => (EXPECT[H.resolveToolchain(proj)] || EXPECT.xc8).label,
        },
        getRoot: () => H.getActiveRoot(),
        warnNoProject: () => H.warnNoProject(),
        readProject: (root) => Validator.readProjectConfig(root),
        writeProject: (root, proj) => fs.writeFileSync(path.join(root, Validator.PROJECT_FILE), JSON.stringify(proj, null, 2) + '\n'),
        validateProject: (proj, root) => Validator.validateProjectConfig(proj, root, { countSources: false }),
        collectSources: (dir, projLike) => Sources.collectSources(dir, projLike),
        extSdk: (root) => Sources.resolveExtSdk(root, H.cfg('externalSdkPath')),
        expect: (root, proj) => EXPECT[H.resolveToolchain(proj)] || EXPECT.xc8,
        afterChange: (root) => {
            if (H.getProvider()) H.getProvider().refresh();
            try { require('./intellisense').syncAfterProjectChange(); } catch { /* optional */ }
        },
        log: (m) => H.log(m),
    });
    return _host;
}

// A command may arrive with a component name, a tree item (inline button) or nothing.
async function _pickName(arg, { includeMain = true, placeHolder } = {}) {
    if (typeof arg === 'string' && arg) return arg;
    if (arg && typeof arg === 'object' && arg._comp) return arg._comp;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return null; }
    const rc = Validator.readProjectConfig(root);
    if (rc.status !== 'ok') { H.warnNoProject(); return null; }
    const list = host().describe(root, rc.proj).filter(c => includeMain || c.kind !== 'main');
    if (!list.length) { vscode.window.showInformationMessage('PIC: there are no components yet — use "New Component…".'); return null; }
    const pick = await vscode.window.showQuickPick(list.map(c => ({
        label: (c.kind === 'main' ? '$(home) ' : c.excluded ? '$(circle-slash) ' : '$(package) ') + (c.kind === 'main' ? 'main (application)' : c.name),
        description: c.excluded ? 'disabled' : `${c.srcCount} src · ${c.libCount} lib`,
        value: c.name,
    })), { placeHolder: placeHolder || 'Component' });
    return pick ? pick.value : null;
}

function registerCommands(reg) {
    reg('pic.component.new',    () => host().newComponent());
    reg('pic.component.add',    () => host().addExisting());
    reg('pic.component.edit',   async (arg) => { const n = await _pickName(arg, { placeHolder: 'Edit which component?' }); if (n) host().openEditor(n); });
    reg('pic.component.libs',   async (arg) => { const n = await _pickName(arg, { placeHolder: 'Add prebuilt libraries to which component?' }); if (n) host().addLibraries(n); });
    reg('pic.component.delete', async (arg) => { const n = await _pickName(arg, { includeMain: false, placeHolder: 'Delete which component?' }); if (n) host().deleteComponent(n); });
}

// Sidebar: the checkbox of a non-main component enables / disables it.
function onCheckbox(e) {
    try {
        for (const [item, state] of e.items) {
            if (item && item._comp && item._compToggle) host().setEnabled(item._comp, state === vscode.TreeItemCheckboxState.Checked);
        }
    } catch (err) { H.log(`[components] checkbox handler failed: ${err.message}`); }
}

module.exports = { host, registerCommands, onCheckbox, EXPECT };
