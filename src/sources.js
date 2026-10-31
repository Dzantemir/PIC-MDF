'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// sources.js — pure-node source collection (no vscode dependency):
//   collectSources():  one component's source rules ("src" folder (recursive),
//                      explicit .c/.cpp/.s/.S files, JSON {path,pattern,flags} rules)
//   resolveProject():  main + components/* → sources, include dirs, libraries
//                      (componentModel.js); the pic.externalSdkPath folder
//                      contributes components/<name>/ and lib/*.a
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');

const C_EXTS   = new Set(['.c', '.cc', '.cpp', '.cxx']);
const ASM_EXTS = new Set(['.s', '.S', '.asm']);

function _walk(dir, out, filter) {
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) _walk(full, out, filter);
            else if (entry.isFile() && filter(entry.name)) out.push(full);
        }
    } catch {}
    return out;
}

function _entryPath(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof entry.path === 'string') return entry.path;
    return null;
}
function _entryFlags(entry) {
    return (entry && typeof entry === 'object' && Array.isArray(entry.flags)) ? entry.flags : null;
}

function _matchesPattern(relPath, pattern) {
    const rel = String(relPath || '').split(path.sep).join('/').replace(/^\.\//, '');
    const pat = String(pattern || '').split('\\').join('/').replace(/^\.\//, '');
    let rx = '^';
    for (let i = 0; i < pat.length; i++) {
        const ch = pat[i];
        if (ch === '*') {
            if (pat[i + 1] === '*') {
                i++;
                if (pat[i + 1] === '/') { i++; rx += '(?:.*/)?'; }
                else rx += '.*';
            } else rx += '[^/]*';
        } else if (ch === '?') rx += '[^/]';
        else rx += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
    rx += '$';
    try { return new RegExp(rx, 'i').test(rel); } catch { return rel === pat; }
}

function _entryPattern(entry) {
    return entry && typeof entry === 'object' && typeof entry.pattern === 'string' && entry.pattern.trim()
        ? entry.pattern.trim() : null;
}

function collectSources(root, proj) {
    const result = { sources: [], errors: [] };
    const seen = new Set();
    const add = (file, flags) => {
        const norm = path.normalize(file);
        if (seen.has(norm)) return;
        seen.add(norm);
        const extRaw = path.extname(file);
        const ext = extRaw.toLowerCase();
        const kind = C_EXTS.has(ext) ? 'c' : ASM_EXTS.has(ext) ? 'asm' : null;
        if (!kind) return;
        result.sources.push({ file, kind, flags, ext, extRaw });
    };
    for (const entry of (proj.sources || [])) {
        const rel = _entryPath(entry);
        if (!rel) { result.errors.push(`sources: invalid entry ${JSON.stringify(entry)}`); continue; }
        const flags = _entryFlags(entry);
        const pattern = _entryPattern(entry);
        const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
        let st = null;
        try { st = fs.statSync(abs); } catch {}
        if (!st) { result.errors.push(`sources: not found: ${rel}`); continue; }
        if (st.isDirectory()) {
            for (const f of _walk(abs, [], n => C_EXTS.has(path.extname(n).toLowerCase()) || ASM_EXTS.has(path.extname(n).toLowerCase()))) {
                if (!pattern || _matchesPattern(path.relative(abs, f), pattern)) add(f, flags);
            }
        } else if (st.isFile()) {
            if (!pattern || _matchesPattern(path.basename(abs), pattern)) add(abs, flags);
        }
    }
    result.sources.sort((a, b) => a.file.localeCompare(b.file));
    return result;
}

function resolveExtSdk(root, extSdk) {
    const raw = String(extSdk || '').trim();
    if (!raw) return '';
    if (path.isAbsolute(raw)) return raw;
    if (!root) return '';
    return path.resolve(root, raw);
}
function normalizeExtSdk(root, raw) {
    const val = String(raw || '').trim();
    if (!val) return '';
    if (!root) return path.isAbsolute(val) ? val : '';
    const abs = path.isAbsolute(val) ? val : path.resolve(root, val);
    const rel = path.relative(root, abs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return abs;
    }
    return rel;
}

// ─── components (main + components/*) ───────────────────────────────────────
// v0.4.0: sources / includes / libraries are per COMPONENT now — see
// componentModel.js. resolveProject() is what the build, the validator,
// IntelliSense and the sidebar share.
const CM = require('./componentModel');
function resolveProject(root, proj, extSdkRaw) {
    return CM.resolve(root, proj, {
        collectSources,
        libExts: ['.a'],
        extSdk: resolveExtSdk(root, extSdkRaw),
    });
}

module.exports = { collectSources, resolveProject, resolveExtSdk, normalizeExtSdk, C_EXTS, ASM_EXTS };
