'use strict';
const fs = require('fs');
const path = require('path');

// Directories that are never a legitimate build output. A Clean of any of
// these would destroy sources or repository metadata (audit 0.3.0 item 1). The
// components model (main + components/<name>/) puts sources under src/,
// include/, lib/ and components/ — those are protected too, now that the
// Output folder can be typed in the Project Editor again.
const STOP_DIRS = new Set(['.git', '.hg', '.svn', '.bzr', '.vscode', 'src', 'node_modules', 'include', 'lib', 'components']);
// A build output must be a strict child of the project. Refuse symlinks and
// Windows junctions in its components: lexical containment alone is unsafe.
// The project root itself may be a symlink (e.g. a workspace alias).
function checkOutputDir(root, outputDir) {
    try {
        if (!root || !outputDir) return { ok: false, reason: 'missing project/output path' };
        const base = path.resolve(root);
        const target = path.resolve(base, outputDir);
        const rel = path.relative(base, target);
        if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
            return { ok: false, reason: 'output directory must be strictly inside the project root' };
        }
        if (STOP_DIRS.has(rel.split(path.sep)[0])) {
            return { ok: false, reason: `refusing to use "${rel.split(path.sep)[0]}" as the build output directory` };
        }
        const realBase = fs.realpathSync(base);
        let cursor = base;
        for (const part of rel.split(path.sep)) {
            cursor = path.join(cursor, part);
            let stat;
            try { stat = fs.lstatSync(cursor); }
            catch (e) { if (e.code === 'ENOENT') break; throw e; }
            if (stat.isSymbolicLink()) return { ok: false, reason: 'output path contains a symbolic link or junction: ' + cursor };
            if (!stat.isDirectory()) return { ok: false, reason: 'output path contains a non-directory: ' + cursor };
            const realRel = path.relative(realBase, fs.realpathSync(cursor));
            if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) {
                return { ok: false, reason: 'output directory resolves outside the project root' };
            }
        }
        // The target itself may be a nested repository root or hold the project
        // file — deleting it in Clean would take the sources with it.
        for (const marker of ['.git', '.hg', '.svn', 'pic-project.json']) {
            try { if (fs.existsSync(path.join(target, marker))) { return { ok: false, reason: 'output directory contains ' + marker }; } } catch {}
        }
        return { ok: true, resolved: target };
    } catch (e) { return { ok: false, reason: 'cannot verify output directory: ' + e.message }; }
}
module.exports = { checkOutputDir };
