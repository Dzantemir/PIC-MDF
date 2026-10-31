'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// validator.js — read & validate pic-project.json (the tree's config status,
// the Project Problems command and the build gate all live off this).
// ─────────────────────────────────────────────────────────────────────────────
const path     = require('path');
const fs       = require('fs');
const H        = require('./helpers');
const Boards   = require('./boards');
const { resolveProject } = require('./sources');
const CM = require('./componentModel');

const PROJECT_FILE = 'pic-project.json';

function projectFilePath(root) { return path.join(root, PROJECT_FILE); }

function readProjectConfig(root) {
    if (!root) return { status: 'missing' };
    const file = projectFilePath(root);
    if (!fs.existsSync(file)) return { status: 'missing' };
    const { ok, data, error } = H.readJsonFile(file);
    if (!ok) return { status: 'broken', parseError: error, cfgPath: file };
    return { status: 'ok', proj: data, cfgPath: file };
}

function validateProjectConfig(proj, root, { countSources = true } = {}) {
    const errors = [], warnings = [], infos = [];
    const counts = { sources: 0, components: 0, libraries: 0 };

    if (!proj || typeof proj !== 'object') {
        return { valid: false, errors: ['project config is not a JSON object'], warnings, infos, counts };
    }
    if (typeof proj.name !== 'string' || !proj.name.trim()) errors.push('name: missing (string required)');
    else if (!H.isAscii(proj.name)) warnings.push('name: non-ASCII characters (build paths want ASCII)');

    // v0.4.0: "toolchain" is no longer a project setting — the compiler follows the
    // MCU (helpers.resolveToolchain). A legacy key in an old file is simply ignored.

    if (typeof proj.board !== 'string' || !proj.board) {
        errors.push('board: missing — pick the target MCU (e.g. "pic18f4550")');
    } else {
        const b = Boards.getBoard(proj.board);
        if (!b) {
            warnings.push(`board: "${proj.board}" is not in the MCU database — the raw device flag will be used`);
        }
    }

    if (!Array.isArray(proj.sources)) errors.push('sources: must be an array');

    for (const key of ['includes', 'libraries', 'components', 'defines', 'requires', 'disabled_components']) {
        if (proj[key] !== undefined && !Array.isArray(proj[key])) {
            errors.push(`${key}: must be an array`);
        }
    }

    const build = proj.build || {};
    if (proj.build !== undefined && typeof proj.build !== 'object') errors.push('build: must be an object');
    if (build.output_dir !== undefined && typeof build.output_dir !== 'string') errors.push('build.output_dir: must be a string');
    if (root && typeof build.output_dir === 'string' && build.output_dir.trim() && !/\$\{/.test(build.output_dir)) {
        const safety = H.checkOutputDir(root, build.output_dir);
        if (!safety.ok) errors.push('build.output_dir: ' + safety.reason);
    }
    if (build.output_name !== undefined && /[/\\]/.test(String(build.output_name))) errors.push('build.output_name: must be a file name, not a path');
    if (build.f_cpu_hz !== undefined && build.f_cpu_hz !== null) {
        const hz = Number(build.f_cpu_hz);
        if (!Number.isSafeInteger(hz) || hz <= 0) errors.push('build.f_cpu_hz: must be a positive integer in Hz or null');
    }
    if (build.optimization !== undefined && build.optimization !== null && !['', 'default', '0', '1', '2', '3', 's'].includes(String(build.optimization).toLowerCase())) {
        errors.push('build.optimization: expected default, 0, 1, 2, 3 or s');
    }
    if (build.dfp !== undefined && typeof build.dfp !== 'string') errors.push('build.dfp: must be a string');
    for (const flagKey of ['c_flags', 'cxx_flags', 'asm_flags', 'link_flags', 'extra_flags']) {
        if (build[flagKey] !== undefined && !Array.isArray(build[flagKey])) errors.push(`build.${flagKey}: must be an array`);
    }
    if (build.lto !== undefined && typeof build.lto !== 'boolean') errors.push('build.lto: must be boolean');
    if (build.gc_sections !== undefined && typeof build.gc_sections !== 'boolean') errors.push('build.gc_sections: must be boolean');
    if (build.hooks !== undefined) {
        if (!build.hooks || typeof build.hooks !== 'object' || Array.isArray(build.hooks)) errors.push('build.hooks: must be an object');
        else {
            for (const k of Object.keys(build.hooks)) {
                const v = build.hooks[k];
                const ok = (typeof v === 'string') ||
                    (Array.isArray(v) && v.every(c => typeof c === 'string'));
                if (!ok) errors.push(`build.hooks.${k}: must be a command string or an array of command strings`);
            }
        }
    }

    const upload = proj.upload || {};
    if (proj.upload !== undefined && typeof proj.upload !== 'object') errors.push('upload: must be an object');
    if (upload.tool !== undefined && typeof upload.tool !== 'string') errors.push('upload.tool: must be a string');
    if (upload.args !== undefined && !Array.isArray(upload.args)) errors.push('upload.args: must be an array');
    if (upload.programmer !== undefined && typeof upload.programmer !== 'string') errors.push('upload.programmer: must be a string');
    if (upload.port !== undefined && typeof upload.port !== 'string') errors.push('upload.port: must be a string');

    // main + components → sources / libraries (the same resolution the build uses)
    if (countSources && root && Array.isArray(proj.sources)) {
        try {
            const res = resolveProject(root, proj, String(H.cfg('externalSdkPath') || '').trim());
            counts.sources = res.sources.length;
            counts.components = res.components.length - 1;     // without main
            counts.libraries = res.libraries.length;
            const v = CM.validateAll(res);
            errors.push(...v.errors);
            warnings.push(...v.warnings);
            if (res.sources.length === 0) {
                warnings.push('sources: no .c/.cpp/.s/.S files found — check the application (main) and the components');
            }
        } catch (e) { warnings.push(`components: could not be resolved — ${e.message}`); }
    }

    if (!errors.length && !warnings.length) infos.push('Configuration is valid.');
    return { valid: errors.length === 0, errors, warnings, infos, counts };
}

function reportText(proj, root) {
    const r = validateProjectConfig(proj, root, { countSources: true });
    const lines = [];
    lines.push(`pic-project.json — ${r.valid ? (r.warnings.length ? 'valid with warnings' : 'valid') : 'INVALID'}`);
    lines.push('');
    for (const e of r.errors)   lines.push(`✖ ${e}`);
    for (const w of r.warnings) lines.push(`⚠ ${w}`);
    for (const i of r.infos)    lines.push(`✔ ${i}`);
    lines.push('');
    lines.push(`sources: ${r.counts.sources}, components: ${r.counts.components}, libraries: ${r.counts.libraries}`);
    return lines.join('\n');
}

module.exports = { PROJECT_FILE, readProjectConfig, validateProjectConfig, reportText };
