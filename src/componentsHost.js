'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// componentsHost.js — the VS Code side of the components infrastructure
// (shared by pic-mdf, avr-mdf and sdcc-mdf; every extension passes its own
// ADAPTER, see below). Owns:
//   • the Component Editor webview (one panel per component),
//   • "New component", "Add existing component", "Delete / Remove component",
//   • "Prebuilt libraries…" (add .a/.lib files to a component, copy or reference),
//   • enabling / disabling a component (the sidebar checkbox),
//   • resolve()/describe() for the build and the sidebar.
//
// adapter = {
//   id: 'pic', prefix: 'PIC', title: 'PIC-MDF',        // texts
//   projectFile: 'pic-project.json',
//   mediaFile: absolute path of component-editor.html,
//   libExts: ['.a'], libFilter: { 'Static libraries': ['a'] },
//   sourceFilter: { 'Source files': ['c', …] },
//   labels: { sourceHint, sourceRuleHint, libHint, archLabel(root, proj) },
//   getRoot() → string|null,   warnNoProject(),
//   readProject(root) → { status:'ok'|'broken'|'missing', proj },
//   writeProject(root, proj),                           // 2-space JSON + newline
//   validateProject(proj, root) → { errors:[…] } | null // optional
//   collectSources(dir, { sources }) → { sources:[…], errors:[…] } | [...]
//   extSdk(root) → string,
//   legacyIncludesBase: 'project' (default) | 'component'  — what the "includes" of an old {path,…} entry of "components" are relative to
//   expect(root, proj) → { machines?, label?, sdccPorts? },
//   afterChange(root),                                  // refresh tree / IntelliSense / tasks …
//   log(msg),
// }
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const CM     = require('./componentModel');
const LI     = require('./libInspect');

function create(adapter) {
    const A = adapter;
    const panels = new Map();            // key → { panel, name, root }
    const inspectCache = new Map();      // file → { sig, expectKey, info }

    const fail = (msg) => vscode.window.showErrorMessage(`${A.prefix}: ${msg}`);
    const info = (msg) => vscode.window.showInformationMessage(`${A.prefix}: ${msg}`);
    const keyOf = (root, name) => `${root}::${String(name).toLowerCase()}`;

    function _ctx() {
        const root = A.getRoot();
        if (!root) { A.warnNoProject(); return null; }
        const rc = A.readProject(root);
        if (rc.status !== 'ok') {
            fail(rc.status === 'broken' ? `${A.projectFile} is not valid JSON — fix it first.` : `no ${A.projectFile} in this folder.`);
            return null;
        }
        return { root, proj: rc.proj };
    }
    const _opts = (root) => ({ collectSources: A.collectSources, libExts: A.libExts, extSdk: A.extSdk(root) || '', legacyIncludesBase: A.legacyIncludesBase });
    function resolve(root, proj) { return CM.resolve(root, proj, _opts(root)); }
    function describe(root, proj) { return CM.describe(resolve(root, proj)); }
    function _find(res, name) { return res.components.find(c => c.name.toLowerCase() === String(name).toLowerCase()); }

    // ── inspection (cached) ──
    function _inspect(file, expect) {
        let sig = '';
        try { const st = fs.statSync(file); sig = `${st.size}:${st.mtimeMs}`; } catch { /* handled by inspectFile */ }
        const ek = JSON.stringify(expect || {});
        const c = inspectCache.get(file);
        if (c && c.sig === sig && c.ek === ek) return c.info;
        const res = LI.inspectFile(file, expect);
        inspectCache.set(file, { sig, ek, info: res });
        if (inspectCache.size > 400) inspectCache.delete(inspectCache.keys().next().value);
        return res;
    }

    // ── preview of an (unsaved) manifest ──
    function _preview(root, proj, comp, manifest) {
        const one = CM.resolveOne(comp, manifest, _opts(root));
        const exp = A.expect ? A.expect(root, proj) : {};
        const incs = manifest.includes !== undefined ? manifest.includes : [];
        const libs = CM.libEntries(comp.dir, manifest.libraries || [], A.libExts).map(e => ({
            entry: e.entry,
            missing: e.state === 'missing' || e.state === 'badext',
            reason: e.state === 'badext' ? `not a ${A.libExts.join(' / ')} file` : (e.state === 'missing' ? 'the file or folder does not exist' : ''),
            files: e.files.map(f => ({ rel: CM.portable(comp.dir, f), info: _inspect(f, exp) })),
        }));
        return {
            sources: { count: one.sources.length, files: one.sources.map(s => CM.portable(comp.dir, s.file)), errors: one.missing.sources },
            includes: incs.map(entry => ({ entry, ok: !one.missing.includes.includes(entry) })),
            libs,
        };
    }

    function _stateFor(root, proj, name, focus) {
        const res = resolve(root, proj);
        const comp = _find(res, name);
        if (!comp) return null;
        const eff = CM.effectiveManifest(comp);
        const labels = Object.assign({}, A.labels || {}, {
            libExts: A.libExts.join(' / '),
            archLabel: A.labels && typeof A.labels.archLabel === 'function' ? A.labels.archLabel(root, proj) : (A.labels && A.labels.archLabel) || '',
        });
        return {
            comp,
            state: {
                name: comp.name, kind: comp.kind, dir: comp.dir, rel: comp.rel, excluded: comp.excluded,
                hasManifest: comp.hasManifest, manifestBroken: comp.manifestStatus === 'broken' ? (CM.readManifest(comp.dir).error || 'parse error') : '',
                projFile: A.projectFile,
                manifest: eff,
                others: res.components.filter(c => c.kind !== 'main' && c.name !== comp.name).map(c => ({ name: c.name, disabled: c.excluded })),
                labels, focus: focus || null,
                preview: _preview(root, proj, comp, eff),
            },
        };
    }

    function _push(p) {
        const ctx = _ctx0(p.root);
        if (!ctx) return;
        const r = _stateFor(p.root, ctx.proj, p.name, null);
        if (!r) { try { p.panel.dispose(); } catch { /* gone */ } return; }
        try { p.panel.webview.postMessage({ type: 'state', state: r.state }); } catch { /* disposed */ }
    }
    function _ctx0(root) {
        const rc = A.readProject(root);
        return rc.status === 'ok' ? { root, proj: rc.proj } : null;
    }
    function refreshPanels() { for (const p of panels.values()) _push(p); }

    // ── writing ──
    function _writeComponent(root, comp, manifest) {
        if (comp.kind === 'main') {
            const rc = A.readProject(root);
            if (rc.status !== 'ok') throw new Error(`${A.projectFile} cannot be read`);
            const proj = rc.proj;
            CM.applyManifestToProj(proj, manifest);
            const v = A.validateProject ? A.validateProject(proj, root) : null;
            if (v && v.errors && v.errors.length) throw new Error(`refused to save — ${v.errors[0]}`);
            A.writeProject(root, proj);
        } else if (comp.kind === 'sdk') {
            throw new Error('components of the external SDK are read-only');
        } else {
            // the editor has no "defines" field (SDCC only): carry over what the component already has
            if (manifest.defines === undefined && comp.manifest && Array.isArray(comp.manifest.defines)) manifest = Object.assign({}, manifest, { defines: comp.manifest.defines });
            CM.writeManifest(comp.dir, manifest);
        }
    }
    function _changed(root) {
        try { A.afterChange(root); } catch (e) { A.log(`[components] afterChange failed: ${e.message}`); }
        refreshPanels();
    }

    // ── Component Editor ──
    function openEditor(name, opts) {
        opts = opts || {};
        const ctx = _ctx();
        if (!ctx) return;
        const r = _stateFor(ctx.root, ctx.proj, name || CM.MAIN, opts.focus);
        if (!r) { fail(`component "${name}" was not found.`); return; }
        const key = keyOf(ctx.root, r.state.name);
        const existing = panels.get(key);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.One);
            try { existing.panel.webview.postMessage({ type: 'state', state: r.state }); } catch { /* disposed */ }
            return;
        }
        const title = r.state.kind === 'main' ? `${A.title} — Application (main)` : `${A.title} — ${r.state.name}`;
        const panel = vscode.window.createWebviewPanel(`${A.id}.componentEditor`, title, vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true });
        const rec = { panel, name: r.state.name, root: ctx.root };
        panels.set(key, rec);
        panel.webview.html = fs.readFileSync(A.mediaFile, 'utf8').replace('<title>Component Editor</title>', `<title>${A.title} — Component Editor</title>`);
        panel.webview.onDidReceiveMessage((m) => _onMessage(rec, m, opts.focus));
        panel.onDidDispose(() => { panels.delete(key); });
        panel.onDidChangeViewState(() => { if (panel.visible) { /* keep unsaved edits: no re-push */ } });
    }

    async function _onMessage(rec, m, focus) {
        if (!m || !m.type) return;
        const ctx = _ctx0(rec.root);
        if (!ctx) { try { rec.panel.webview.postMessage({ type: 'error', message: `${A.projectFile} cannot be read` }); } catch { /* gone */ } return; }
        const res = resolve(rec.root, ctx.proj);
        const comp = _find(res, rec.name);
        const post = (x) => { try { rec.panel.webview.postMessage(x); } catch { /* disposed */ } };
        if (!comp) { post({ type: 'error', message: `component "${rec.name}" no longer exists` }); return; }
        switch (m.type) {
            case 'ready': {
                const r = _stateFor(rec.root, ctx.proj, rec.name, focus);
                if (r) post({ type: 'state', state: r.state });
                break;
            }
            case 'preview': {
                try { post({ type: 'preview', preview: _preview(rec.root, ctx.proj, comp, CM.normalizeManifest(m.manifest)) }); }
                catch (e) { A.log(`[components] preview failed: ${e.message}`); }
                break;
            }
            case 'pick': await _pick(rec, comp, m, post); break;
            case 'save': {
                try {
                    _writeComponent(rec.root, comp, CM.normalizeManifest(m.manifest));
                } catch (e) { post({ type: 'error', message: e.message }); fail(`could not save "${comp.name}" — ${e.message}`); break; }
                info(`✅ ${comp.kind === 'main' ? 'application' : 'component "' + comp.name + '"'} saved.`);
                post({ type: 'saved' });
                _changed(rec.root);
                break;
            }
            case 'delete': await deleteComponent(comp.name); break;
            case 'openFolder': try { vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(comp.dir)); } catch { /* ignore */ } break;
        }
    }

    async function _pick(rec, comp, m, post) {
        const field = String(m.field || '');
        const mode = String(m.mode || 'any');
        const cfg = {
            sources:   { title: `${A.title} › Add source files or folders`, filters: A.sourceFilter },
            includes:  { title: `${A.title} › Add include folders` },
            libraries: { title: `${A.title} › Add prebuilt libraries`, filters: A.libFilter },
        }[field];
        if (!cfg) return;
        const o = { title: cfg.title, canSelectMany: true, defaultUri: vscode.Uri.file(comp.dir) };
        if (mode === 'folder') { o.canSelectFiles = false; o.canSelectFolders = true; }
        else if (mode === 'file') { o.canSelectFiles = true; o.canSelectFolders = false; if (cfg.filters) o.filters = cfg.filters; }
        else { o.canSelectFiles = true; o.canSelectFolders = true; if (cfg.filters) o.filters = cfg.filters; }
        try {
            const picked = await vscode.window.showOpenDialog(o);
            if (!picked || !picked.length) return;
            post({ type: 'picked', field, paths: [...new Set(picked.map(u => CM.portable(comp.dir, u.fsPath)))] });
        } catch (e) { fail(`could not select paths — ${e.message}`); }
    }

    // ── New component ──
    async function newComponent() {
        const ctx = _ctx();
        if (!ctx) return;
        const libLabel = A.libExts.join(' / ');
        const kind = await vscode.window.showQuickPick([
            { label: '$(file-code) Source component', description: 'C code + headers (src/, include/)', detail: 'A folder with your own sources that are compiled into the firmware.', value: 'source' },
            { label: '$(library) Prebuilt library', description: `a ready-made ${libLabel} + its headers`, detail: 'A folder that links an already compiled static library into the firmware.', value: 'prebuilt' },
        ], { title: `${A.title} › New component`, placeHolder: 'What kind of component?' });
        if (!kind) return;
        const res = resolve(ctx.root, ctx.proj);
        const name = await vscode.window.showInputBox({
            title: `${A.title} › New component`,
            prompt: 'Component name (a folder in components/)',
            placeHolder: kind.value === 'prebuilt' ? 'vendor_lib' : 'my_driver',
            validateInput: (v) => {
                const bad = CM.validateName(v);
                if (bad) return bad;
                if (_find(res, v.trim())) return `A component called "${v.trim()}" already exists.`;
                if (fs.existsSync(path.join(ctx.root, 'components', v.trim()))) return `components/${v.trim()} already exists.`;
                return null;
            },
        });
        if (!name) return;
        try {
            const out = CM.createComponent(ctx.root, name.trim(), kind.value);
            A.log(`[components] created ${out.dir}`);
        } catch (e) { fail(`could not create the component — ${e.message}`); return; }
        _changed(ctx.root);
        if (kind.value === 'prebuilt') {
            const added = await addLibraries(name.trim(), { fresh: true });
            if (!added) openEditor(name.trim(), { focus: 'libraries' });
        } else {
            openEditor(name.trim());
        }
    }

    // ── Prebuilt libraries: add files to a component ──
    async function addLibraries(name, opts) {
        opts = opts || {};
        const ctx = _ctx();
        if (!ctx) return false;
        const res = resolve(ctx.root, ctx.proj);
        const comp = _find(res, name || CM.MAIN);
        if (!comp) { fail(`component "${name}" was not found.`); return false; }
        if (comp.kind === 'sdk') { fail('components of the external SDK are read-only.'); return false; }
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true, canSelectFiles: true, canSelectFolders: false, filters: A.libFilter,
            title: `${A.title} › Prebuilt libraries for "${comp.name}" (${A.libExts.join(' / ')})`,
        });
        if (!picked || !picked.length) return false;
        const files = picked.map(u => u.fsPath);
        const outside = files.filter(f => { const rel = path.relative(comp.dir, f); return rel.startsWith('..') || path.isAbsolute(rel); });
        let copy = false;
        if (outside.length) {
            const how = await vscode.window.showQuickPick([
                { label: '$(file-add) Copy into the component', description: `${comp.rel === '.' ? '' : comp.rel + '/'}lib/`, detail: 'Recommended — the project stays self-contained and portable.', value: 'copy' },
                { label: '$(link) Reference in place', description: 'keep the absolute path', detail: 'The library stays where it is; the path is stored as is (not portable).', value: 'ref' },
            ], { title: `${A.title} › ${outside.length} file(s) are outside the component`, placeHolder: 'How should they be added?' });
            if (!how) return false;
            copy = how.value === 'copy';
        }
        const eff = CM.effectiveManifest(comp);
        const libs = (eff.libraries || []).slice();
        const have = new Set(libs.map(s => s.toLowerCase()));
        // files already reached through a folder entry ("lib") need no extra line
        const covered = new Set(CM.libEntries(comp.dir, libs, A.libExts).flatMap(e => e.files).map(f => path.resolve(f).toLowerCase()));
        for (const f of files) {
            let entry;
            const isOutside = outside.includes(f);
            if (isOutside && copy) {
                const dest = path.join(comp.dir, 'lib', path.basename(f));
                try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(f, dest); }
                catch (e) { fail(`could not copy ${path.basename(f)} — ${e.message}`); continue; }
                entry = CM.portable(comp.dir, dest);
            } else entry = CM.portable(comp.dir, f);
            const absNew = path.resolve(comp.dir, entry).toLowerCase();
            if (!have.has(entry.toLowerCase()) && !covered.has(absNew)) { libs.push(entry); have.add(entry.toLowerCase()); covered.add(absNew); }
        }
        const man = Object.assign({}, eff, { libraries: libs });
        try { _writeComponent(ctx.root, comp, man); }
        catch (e) { fail(`could not update "${comp.name}" — ${e.message}`); return false; }
        _changed(ctx.root);
        openEditor(comp.name, { focus: 'libraries' });
        return true;
    }

    // ── Add an existing folder as a component ──
    async function addExisting() {
        const ctx = _ctx();
        if (!ctx) return;
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false, canSelectFiles: false, canSelectFolders: true,
            title: `${A.title} › Add an existing component folder`, openLabel: 'Add as component',
        });
        if (!picked || !picked.length) return;
        const dir = picked[0].fsPath;
        const res = resolve(ctx.root, ctx.proj);
        if (res.components.some(c => path.resolve(c.dir) === path.resolve(dir))) { info(`"${path.basename(dir)}" is already a component of this project.`); return; }
        const nm = path.basename(dir);
        const bad = CM.validateName(nm);
        if (bad) { fail(`the folder name "${nm}" cannot be a component name — ${bad}`); return; }
        if (_find(res, nm)) { fail(`a component called "${nm}" already exists.`); return; }
        const rc = A.readProject(ctx.root);
        if (rc.status !== 'ok') return;
        const proj = rc.proj;
        if (!Array.isArray(proj.components)) proj.components = [];
        proj.components.push({ path: CM.portable(ctx.root, dir) });
        try { A.writeProject(ctx.root, proj); } catch (e) { fail(`could not update ${A.projectFile} — ${e.message}`); return; }
        _changed(ctx.root);
        openEditor(nm);
    }

    // ── Delete / remove ──
    async function deleteComponent(name) {
        const ctx = _ctx();
        if (!ctx) return;
        const res = resolve(ctx.root, ctx.proj);
        const comp = _find(res, name);
        if (!comp || comp.kind === 'main' || comp.kind === 'sdk') return;
        const rc = A.readProject(ctx.root);
        const proj = rc.proj;
        const listedIdx = Array.isArray(proj.components)
            ? proj.components.findIndex(e => e && typeof e === 'object' && typeof e.path === 'string' && path.resolve(ctx.root, e.path) === path.resolve(comp.dir))
            : -1;
        let removeFromDisk = true;
        if (listedIdx >= 0) {
            const pick = await vscode.window.showWarningMessage(
                `Remove component "${comp.name}" from the project?\n${comp.dir}`, { modal: true, detail: 'The folder is outside the project tree and stays on disk.' }, 'Remove from project');
            if (pick !== 'Remove from project') return;
            removeFromDisk = false;
        } else {
            const pick = await vscode.window.showWarningMessage(
                `Delete component "${comp.name}" and ALL of its files?\n${comp.dir}`, { modal: true, detail: 'The folder is removed from disk. This cannot be undone.' }, 'Delete');
            if (pick !== 'Delete') return;
        }
        try {
            if (listedIdx >= 0) proj.components.splice(listedIdx, 1);
            let dirty = listedIdx >= 0;
            if (Array.isArray(proj.disabled_components)) {
                const keep = proj.disabled_components.filter(n => String(n).toLowerCase() !== comp.name.toLowerCase());
                if (keep.length !== proj.disabled_components.length) {
                    dirty = true;
                    if (keep.length) proj.disabled_components = keep; else delete proj.disabled_components;
                }
            }
            if (dirty) A.writeProject(ctx.root, proj);
            if (removeFromDisk) {
                // never delete anything that is not a plain, non-empty-named folder below an existing parent
                if (!comp.dir || path.resolve(comp.dir) === path.resolve(ctx.root) || path.parse(comp.dir).root === comp.dir) throw new Error('refusing to delete this folder');
                fs.rmSync(comp.dir, { recursive: true, force: true });
            }
        } catch (e) { fail(`could not delete "${comp.name}" — ${e.message}`); }
        const p = panels.get(keyOf(ctx.root, comp.name));
        if (p) { try { p.panel.dispose(); } catch { /* gone */ } }
        _changed(ctx.root);
    }

    // ── Enable / disable ──
    function setEnabled(name, enabled) {
        const ctx = _ctx();
        if (!ctx) return;
        const proj = ctx.proj;
        const cur = (Array.isArray(proj.disabled_components) ? proj.disabled_components : []).map(String);
        const low = String(name).toLowerCase();
        const next = cur.filter(n => n.toLowerCase() !== low);
        if (!enabled) next.push(name);
        if (next.length) proj.disabled_components = next; else delete proj.disabled_components;
        try { A.writeProject(ctx.root, proj); } catch (e) { fail(`could not update ${A.projectFile} — ${e.message}`); return; }
        _changed(ctx.root);
    }

    return { openEditor, newComponent, addExisting, deleteComponent, addLibraries, setEnabled, resolve, describe, refreshPanels };
}

module.exports = { create };
