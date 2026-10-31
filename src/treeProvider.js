'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// treeProvider.js — three tree providers:
//   PicProvider         — the Project & Commands view
//   PicDevtoolsProvider — the Development Tools view (per-toolchain catalogue)
//   PicRefProvider      — the XC Reference view
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const H      = require('./helpers');
const Validator = require('./validator');
const Boards = require('./boards');
const Components = require('./components');

class PicItem extends vscode.TreeItem {
    constructor(label, opts) {
        super(label, vscode.TreeItemCollapsibleState.None);
        opts = opts || {};
        this.command = opts.command
            ? (typeof opts.command === 'string' ? { command: opts.command, title: label } : { title: label, ...opts.command })
            : undefined;
        this.iconPath = opts.icon
            ? new vscode.ThemeIcon(opts.icon, opts.iconColor ? new vscode.ThemeColor(opts.iconColor) : undefined)
            : undefined;
        this.description = opts.desc || '';
        this.tooltip = opts.tooltip || label;
        if (opts.contextValue) this.contextValue = opts.contextValue;
    }
}
class PicGroup extends vscode.TreeItem {
    constructor(id, label, children, expanded, opts) {
        super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        this.id = id;
        this._children = children;
        opts = opts || {};
        if (opts.desc) this.description = opts.desc;
        if (opts.tooltip) this.tooltip = opts.tooltip;
    }
    getChildren() { return this._children; }
}
function _base(opts) {
    return { isExpanded: (opts && typeof opts.isExpanded === 'function') ? opts.isExpanded : () => false };
}

// ─── Project & Commands ──────────────────────────────────────────────────────
class PicProvider {
    // 📦 Components — main + components/<name>/ (the esp8266-idf layout): click = Component Editor,
    // checkbox = enable / disable, inline buttons = prebuilt libraries / edit / delete.
    _componentsGroup(root, proj) {
        let list = [];
        try { list = Components.host().describe(root, proj); }
        catch (e) { H.log(`[tree] components could not be resolved: ${e.message}`); }
        const items = list.map(c => {
            const isMain = c.kind === 'main';
            const warn = c.issues.some(i => i.level === 'error') ? 'error' : (c.issues.length ? 'warning' : '');
            const it = new PicItem(isMain ? 'main' : c.name, {
                command: { command: 'pic.component.edit', arguments: [c.name] },
                icon: isMain ? 'home' : (c.excluded ? 'circle-slash' : (warn ? warn : 'package')),
                iconColor: warn === 'error' ? 'charts.red' : warn === 'warning' ? 'charts.yellow' : undefined,
                desc: c.excluded ? 'disabled' : [
                    c.srcCount ? `${c.srcCount} src` : '', c.libCount ? `${c.libCount} lib` : '',
                ].filter(Boolean).join(' · ') || (isMain ? 'application' : 'empty'),
                tooltip: [
                    isMain ? 'main — the application (sources, includes and libraries of pic-project.json)' : `Component: ${c.name}${c.kind === 'listed' ? ' (external folder)' : c.kind === 'sdk' ? ' (external SDK)' : ''}`,
                    c.rel === '.' ? root : (path.isAbsolute(c.rel) ? c.rel : path.join(root, c.rel)),
                    '', `${c.srcCount} source file(s) · ${c.includeCount} include folder(s) · ${c.libCount} prebuilt librar${c.libCount === 1 ? 'y' : 'ies'}`,
                    ...(c.libs.length ? ['Libraries: ' + c.libs.join(', ')] : []),
                    ...(c.requires.length ? ['Requires: ' + c.requires.join(', ')] : []),
                    ...(c.legacy && !isMain ? ['(no component.json — folder defaults; open the editor and Save to create it)'] : []),
                    ...c.issues.map(i => (i.level === 'error' ? '✖ ' : '⚠ ') + i.text),
                    '', 'Click to open the Component Editor.',
                ].join('\n'),
            });
            it.contextValue = isMain ? 'componentMain' : (c.kind === 'sdk' ? 'componentSdk' : 'componentItem');
            it._comp = c.name;
            if (!isMain && c.kind !== 'sdk') {
                it._compToggle = true;
                it.checkboxState = c.excluded ? vscode.TreeItemCheckboxState.Unchecked : vscode.TreeItemCheckboxState.Checked;
            }
            return it;
        });
        const g = new PicGroup('componentsGroup', '📦  Components', items, true, { desc: `${Math.max(0, items.length - 1)}` });
        g.contextValue = 'componentsGroup';
        return g;
    }
    constructor(opts) {
        this._isExpanded = _base(opts).isExpanded;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
    }
    refresh() { this._emitter.fire(undefined); }
    getTreeItem(el) { return el; }
    getChildren(el) {
        if (el instanceof PicGroup) return el._children;
        if (el) return [];
        return this._getRoot();
    }
    _getRoot() {
        const root = H.getActiveRoot();
        let proj = null, cfgStatus = 'missing', report = null;
        if (root) {
            const loaded = Validator.readProjectConfig(root);
            cfgStatus = loaded.status;
            if (loaded.status === 'ok') {
                proj = loaded.proj;
                try { report = Validator.validateProjectConfig(proj, root, { countSources: true }); }
                catch (e) { report = { valid: false, errors: [`validation crashed: ${e && e.message}`], warnings: [], infos: [], counts: {} }; }
            }
        }
        const items = [];
        items.push(new PicItem('Create New Project', {
            command: 'pic.createProject', icon: 'new-folder', iconColor: 'charts.green',
            tooltip: 'Create a new PIC project from a template (device-aware main.c)',
        }));
        items.push(new PicItem('PIC-MDF: Import Project…', {
            command: 'pic.importProject', icon: 'desktop-download', iconColor: 'charts.cyan',
            tooltip: 'Import an MPLAB X project or a Makefile',
        }));
        items.push(new PicItem('PIC-MDF: MCU Definitions…', {
            command: 'pic.manageBoards', icon: 'circuit-board', iconColor: 'charts.purple',
            tooltip: 'Board Manager: add, edit, duplicate or delete MCU definitions',
        }));

        const projChildren = [];
        if (root && proj) {
            projChildren.push(new PicItem(path.basename(root), {
                command: 'pic.selectProject', icon: 'folder-active', iconColor: 'charts.yellow',
                tooltip: root + '\nClick to select a different project folder.', contextValue: 'projectItem', desc: 'click to change',
            }));
            const errN = report.errors.length, warnN = report.warnings.length;
            if (errN > 0) {
                projChildren.push(new PicItem(`config: ${errN} error${errN > 1 ? 's' : ''}`, {
                    command: 'pic.showProblems', icon: 'error', iconColor: 'charts.red',
                    tooltip: 'pic-project.json has errors — click for details (build is blocked)', desc: warnN ? `+${warnN} warn` : '',
                }));
            } else if (warnN > 0) {
                projChildren.push(new PicItem(`config: ${warnN} warning${warnN > 1 ? 's' : ''}`, {
                    command: 'pic.showProblems', icon: 'warning', iconColor: 'charts.yellow',
                    tooltip: 'pic-project.json has warnings — click for details',
                }));
            } else {
                projChildren.push(new PicItem('config: valid', {
                    command: 'pic.showProblems', icon: 'check', iconColor: 'charts.green', tooltip: 'pic-project.json is valid',
                }));
            }
            let mcuLine = '';
            try { mcuLine = Boards.boardInfoLine(proj.board); } catch {}
            projChildren.push(new PicItem(`MCU: ${proj.board || 'unknown'}`, {
                command: 'pic.editProject', icon: 'circuit-board', iconColor: 'charts.purple',
                tooltip: `Board (MCU): ${proj.board || 'unknown'}` + (mcuLine ? `\n${mcuLine}` : '')
                    + `\nCompiler (automatic, from the MCU): ${H.resolveToolchain(proj)}` + '\nChange it in the Project Editor',
            }));
            projChildren.push(this._componentsGroup(root, proj));
            const hookNames = Object.keys((proj.build && proj.build.hooks) || {});
            if (hookNames.length) projChildren.push(new PicItem(`Hooks: ${hookNames.join(', ')}`, { icon: 'list-unordered', iconColor: 'charts.orange' }));
        } else if (root && cfgStatus === 'broken') {
            projChildren.push(new PicItem(path.basename(root), {
                command: 'pic.selectProject', icon: 'folder', iconColor: 'charts.yellow', contextValue: 'projectItem', desc: 'click to change',
                tooltip: root + '\n(pic-project.json has a JSON syntax error!)',
            }));
            projChildren.push(new PicItem('config: broken JSON', { command: 'pic.showProblems', icon: 'error', iconColor: 'charts.red' }));
        } else if (root) {
            projChildren.push(new PicItem(path.basename(root), {
                command: 'pic.selectProject', icon: 'folder', iconColor: 'charts.yellow', contextValue: 'projectItem', desc: 'click to change',
                tooltip: root + '\n(no pic-project.json found)',
            }));
            projChildren.push(new PicItem('pic-project.json: not found', {
                command: 'pic.createProject', icon: 'warning', iconColor: 'charts.yellow', tooltip: 'Click to create a project here…',
            }));
        } else {
            projChildren.push(new PicItem('folder not found', {
                command: 'pic.selectProject', icon: 'error', iconColor: 'charts.red', desc: 'click to select',
            }));
        }
        items.push(new PicGroup('projectGroup', '📁  Project Folder', projChildren, this._isExpanded('projectGroup')));

        items.push(new PicGroup('actionsGroup', '⚙️  Actions', [
            new PicItem('Build', { command: 'pic.build', icon: 'tools', iconColor: 'charts.green', tooltip: 'Build (Ctrl+Alt+B)' }),
            new PicItem('Flash', { command: 'pic.flash', icon: 'zap', iconColor: 'charts.blue', tooltip: 'Program the device (Ctrl+Alt+F)' }),
            new PicItem('Clean', { command: 'pic.clean', icon: 'trash', iconColor: 'charts.red', tooltip: 'Remove build output (Ctrl+Alt+C)' }),
            new PicItem('Disassembly', { command: 'pic.showDisassembly', icon: 'file-code', iconColor: 'charts.orange', tooltip: 'Disassemble the built ELF (objdump -d -S)' }),
        ], this._isExpanded('actionsGroup')));

        items.push(new PicGroup('deviceGroup', '🔧  Device', [
            new PicItem('Configuration Bits…', { command: 'pic.config.open', icon: 'settings-gear', iconColor: 'charts.orange', tooltip: 'Edit configuration bits (the PIC analogue of the AVR fuses)' }),
            new PicItem('Chip Erase', { command: 'pic.erase', icon: 'zap', iconColor: 'charts.red', tooltip: 'Erase the whole device' }),
            new PicItem('EEPROM: upload…', { command: 'pic.eeprom.upload', icon: 'cloud-upload', iconColor: 'charts.green', tooltip: 'Write an EEPROM/data image to the device' }),
            new PicItem('EEPROM: download…', { command: 'pic.eeprom.download', icon: 'cloud-download', iconColor: 'charts.blue', tooltip: 'Read the device EEPROM/data into build/' }),
        ], this._isExpanded('deviceGroup')));

        const port = H.cfg('comPort') || '—';
        items.push(new PicGroup('portGroup', '🔌  Port Settings', [
            new PicItem(`Port: ${port}`, { command: 'pic.selectPort', icon: 'plug', iconColor: 'charts.blue', tooltip: 'Click to select port', desc: port === '—' ? 'not selected' : '' }),
        ], this._isExpanded('portGroup')));

        return items;
    }
}

// ─── Development Tools ───────────────────────────────────────────────────────
class PicDevtoolsProvider {
    constructor(opts) {
        this._isExpanded = _base(opts).isExpanded;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
    }
    refresh() { this._emitter.fire(undefined); }
    getTreeItem(el) { return el; }
    getChildren(el) {
        if (el instanceof PicGroup) return el._children;
        if (el) return [];
        return this._getRoot();
    }
    _getRoot() {
        const tc = H.getToolchainCache() || require('./toolchain').detect();
        const Toolchain = require('./toolchain');
        const groups = [];
        for (const id of Toolchain.TOOLCHAIN_IDS) {
            const spec = Toolchain.TOOLCHAINS[id];
            const t = tc[id];
            const kids = [];
            if (t) {
                kids.push(new PicItem(`${t.driver}${t.version ? ' v' + t.version : ''}`, { icon: 'check', iconColor: 'charts.green', tooltip: t.driver }));
                const foundN = Object.keys(t.modules || {}).length;
                kids.push(new PicItem(`Binutils`, {
                    icon: foundN ? 'package' : 'warning', iconColor: foundN ? 'charts.cyan' : 'charts.yellow',
                    desc: `${foundN}/${spec.binutils.length} found`,
                    tooltip: spec.binutils.map(n => `${t.modules[n] ? '✔' : '✖'} ${n}`).join('\n'),
                }));
                kids.push(new PicItem(`Devices`, { icon: 'circuit-board', iconColor: 'charts.purple', desc: `${t.devices.all.length}`, tooltip: `${t.devices.all.length} device(s) known from the distribution` }));
                if (t.simulator) kids.push(new PicItem('Simulator', { icon: 'check', iconColor: 'charts.green', desc: path.basename(t.simulator), tooltip: t.simulator }));
                kids.push(new PicItem('Select compiler folder…', { command: 'pic.selectToolchain', icon: 'folder-opened', iconColor: 'charts.orange' }));
            } else {
                kids.push(new PicItem('not found', { command: 'pic.selectToolchain', icon: 'warning', iconColor: 'charts.yellow', tooltip: `Click to select the ${spec.label} folder` }));
            }
            groups.push(new PicGroup('tc_' + id, spec.label, kids, this._isExpanded('tc_' + id), {
                desc: t ? (t.version ? 'v' + t.version : 'found') : 'not found',
                tooltip: t ? t.driver : `Install ${spec.label} or point PIC-MDF at its folder.`,
            }));
        }
        return groups;
    }
}

// ─── XC Reference ────────────────────────────────────────────────────────────
class PicRefProvider {
    constructor(opts) {
        this._isExpanded = _base(opts).isExpanded;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
        this._data = require('./referenceData');
    }
    refresh() { this._emitter.fire(undefined); }
    getTreeItem(el) { return el; }
    getChildren(el) {
        if (el instanceof PicGroup) return el._children;
        if (el) return [];
        const data = this._data;
        const kids = [];
        kids.push(new PicItem(`${data.MODULES.length} modules · ${data.MODULES.reduce((n, m) => n + (m.entries || []).length, 0)} entries`, {
            icon: 'book', iconColor: 'charts.cyan',
            tooltip: 'The XC compiler reference: <xc.h>, config bits, delays, interrupts, the device headers and the driver options. Verified against the MPLAB XC compiler guides.',
        }));
        for (const m of data.MODULES) {
            const entries = (m.entries || []).map(e => {
                const it = new PicItem(e.name, {
                    icon: 'symbol-function', iconColor: 'charts.blue',
                    tooltip: `${e.name}\n${e.desc || ''}${e.signature ? '\n\n' + e.signature : ''}`,
                    // '#include …' entries also get the inline "insert" button
                    contextValue: /^#\s*include\b/.test(e.name) ? 'picRefInclude' : 'picRefEntry',
                    command: { command: 'pic.reference.doc', title: 'Details', arguments: [e] },
                });
                it.entry = e;          // the inline buttons receive the TREE ITEM, not the data row
                return it;
            });
            kids.push(new PicGroup('ref_' + m.id, m.title, entries, this._isExpanded('ref_' + m.id), {
                desc: `${(m.entries || []).length}`, tooltip: m.summary || m.title,
            }));
        }
        return kids;
    }
}

module.exports = { PicProvider, PicDevtoolsProvider, PicRefProvider };
