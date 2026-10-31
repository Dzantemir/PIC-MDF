'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// tasks.js — the three PIC tasks (Build / Flash / Clean) merged into the
// workspace folder's .vscode/tasks.json, running the EXTENSION'S OWN commands.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');

const PIC_TASKS = [
    { type: 'pic', label: 'PIC: Build', action: 'build', isDefaultBuild: true },
    { type: 'pic', label: 'PIC: Flash', action: 'flash' },
    { type: 'pic', label: 'PIC: Clean', action: 'clean' },
];

function _tasksFileFor(root) {
    const vsDir = path.join(root, '.vscode');
    return { vsDir, file: path.join(vsDir, 'tasks.json') };
}
const _sameEntry = (a, b) => !!(a && b && a.type === 'pic' && b.type === 'pic' && a.label === b.label);

function _detectIndent(raw) {
    const m = /^([ \t]+)\S/m.exec(raw);
    return m ? m[1] : '\t';
}
function _writeAtomic(file, text) {
    const tmp = file + '.pic-tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

function syncAfterProjectChange() {
    try {
        if (!H.cfg('autoGenerateTasks')) return;
        const root = _owningFolder();
        if (!root) return;
        const changed = mergeInto(root);
        if (changed) H.log(`[tasks] merged PIC tasks into tasks.json`);
    } catch (e) { H.log(`[tasks] sync failed: ${e.message}`); }
}
function _owningFolder() {
    const root = H.getActiveRoot();
    if (root) {
        const folders = vscode.workspace.workspaceFolders || [];
        const f = folders.find(f => {
            const rel = path.relative(f.uri.fsPath, root);
            return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        });
        return f ? f.uri.fsPath : root;
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : null;
}

function mergeInto(root) {
    const { vsDir, file } = _tasksFileFor(root);
    try { fs.mkdirSync(vsDir, { recursive: true }); } catch {}
    let doc = { version: '2.0.0', tasks: [] };
    let indent = '\t';
    if (fs.existsSync(file)) {
        for (const d of vscode.window.visibleTextEditors) {
            if (d.document.uri.fsPath === file && d.document.isDirty) { H.log('[tasks] tasks.json has unsaved edits — skipped'); return false; }
        }
        const raw = fs.readFileSync(file, 'utf8');
        const { ok, data, error } = H.readJsonFile(file);
        if (!ok) { H.log(`[tasks] tasks.json is not valid JSON (${error}) — left alone`); return false; }
        indent = _detectIndent(raw);
        doc = data && typeof data === 'object' ? data : doc;
        if (!Array.isArray(doc.tasks)) doc.tasks = [];
    }
    let changed = false;
    for (const t of PIC_TASKS) {
        if (doc.tasks.some(e => _sameEntry(e, t))) continue;
        const entry = { type: t.type, action: t.action, label: t.label, problemMatcher: ['$pic'] };
        if (t.isDefaultBuild) entry.group = { kind: 'build', isDefault: true };
        doc.tasks.push(entry);
        changed = true;
    }
    if (!changed) return false;
    _writeAtomic(file, JSON.stringify(doc, null, indent === '\t' ? '\t' : 2) + '\n');
    return true;
}

async function cmdGenerateTasks() {
    const root = _owningFolder();
    if (!root) { H.warnNoProject(); return; }
    const changed = mergeInto(root);
    vscode.window.showInformationMessage(
        changed ? 'PIC: tasks.json updated — PIC: Build (default, Ctrl+Shift+B) / Flash / Clean are available via Tasks: Run Task.'
                : 'PIC: tasks.json already carries the three PIC tasks — nothing to do.');
}

function provideTasks() {
    return PIC_TASKS.map(t => {
        const task = new vscode.Task(
            { type: 'pic', action: t.action },
            vscode.TaskScope.Workspace,
            t.label, 'PIC-MDF',
            new vscode.CustomExecution(async () => new PicTaskTerminal(t))
        );
        if (t.isDefaultBuild) task.group = { kind: 'build', isDefault: true };
        task.problemMatchers = ['$pic'];
        return task;
    });
}
function resolveTask(task) {
    const action = (task.definition && task.definition.action) || 'build';
    const t = new vscode.Task(
        { type: 'pic', action }, task.scope || vscode.TaskScope.Workspace, task.name, 'PIC-MDF',
        new vscode.CustomExecution(async () => new PicTaskTerminal({ action, label: task.name }))
    );
    t.problemMatchers = ['$pic'];
    return t;
}

const ACTION_TO_CMD = { build: 'pic.build', flash: 'pic.flash', clean: 'pic.clean' };

class PicTaskTerminal {
    constructor(task) { this._task = task; }
    open() {
        const cmd = ACTION_TO_CMD[this._task.action] || 'pic.build';
        this._write(`▶ ${this._task.label} — running…\r\n`);
        vscode.commands.executeCommand(cmd).then((ok) => {
            if (ok) { this._write(`✔ done\r\n`); this._close(); }
            else { this._write(`✖ finished with errors — see the PIC output / terminal\r\n`); this._close(1); }
        }, (err) => {
            this._write(`✖ failed: ${err && err.message}\r\n`); this._close(1);
        });
    }
    _write(s) { try { this._emitter?.fire(s); } catch {} }
    get onDidWrite() { if (!this._emitter) this._emitter = new vscode.EventEmitter(); return this._emitter.event; }
    get onDidClose() { if (!this._closeEmitter) this._closeEmitter = new vscode.EventEmitter(); return this._closeEmitter.event; }
    _close(code) { try { this._closeEmitter?.fire(code ?? 0); } catch {} }
    close() {}
    handleInput() {}
}

module.exports = { syncAfterProjectChange, cmdGenerateTasks, provideTasks, resolveTask };
