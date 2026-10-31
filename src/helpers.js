'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// helpers.js — shared infrastructure for PIC-MDF (the AVR-MDF/SDCC-MDF
// pattern): module state, configuration access, the PIC terminal with a
// PINNED shell, exit-code marker files (build/flash/clean run in the
// terminal, their exit code comes back through a marker file the shell
// writes), the busy gate, variable expansion and small fs utilities.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const cp     = require('child_process');
const { checkOutputDir } = require('./pathSafety');

const IS_WIN = os.platform() === 'win32';
const IS_MAC = os.platform() === 'darwin';

// ─── Module state ────────────────────────────────────────────────────────────
let _ctx              = null;
let _provider        = null;
let _devtoolsProvider = null;
let _refProvider      = null;
let _outputChannel   = null;
let _activeRoot      = null;
let _globalBusy      = false;
let _globalBusyName  = '';
let _lastCmdStart    = 0;
let _busyTimer       = null;
let _terms           = {};
let _termCloseHook   = null;
const _activeWaits   = new Map();
let _statusBar       = {};
let _toolchain       = null;
let _boardCache      = null;

// ─── Getters / Setters ───────────────────────────────────────────────────────
const getCtx              = () => _ctx;
const setCtx              = (v) => { _ctx = v; };
const getProvider         = () => _provider;
const setProvider         = (v) => { _provider = v; };
const getDevtoolsProvider = () => _devtoolsProvider;
const setDevtoolsProvider = (v) => { _devtoolsProvider = v; };
const getRefProvider      = () => _refProvider;
const setRefProvider      = (v) => { _refProvider = v; };
const getOutputChannel    = () => {
    if (!_outputChannel) _outputChannel = vscode.window.createOutputChannel('PIC-MDF');
    return _outputChannel;
};
const getActiveRoot   = () => _activeRoot;
const setActiveRoot   = (v) => { _activeRoot = v; };
const getGlobalBusyName = () => _globalBusyName;
const getTerms        = () => _terms;
const setTerms        = (v) => { _terms = v; };
const getToolchainCache = () => _toolchain;
const setToolchainCache = (v) => {
    _toolchain = v;
    try {
        const anyFound = !!(v && (v.xc8 || v.xc16 || v.xc32 || v.xcdsc));
        vscode.commands.executeCommand('setContext', 'pic.toolchainFound', anyFound);
    } catch {}
};
const getBoardCache   = () => _boardCache;
const setBoardCache   = (v) => { _boardCache = v; };
const getStatusBarItem = (k) => _statusBar[k];
const setStatusBarItem = (k, v) => { _statusBar[k] = v; };

// ─── Busy gate (one build/flash/clean at a time) ─────────────────────────────
function _busyTimeStr() { return ((Date.now() - _lastCmdStart) / 1000).toFixed(0) + 's'; }
function _startBusyTimer() {
    _stopBusyTimer();
    const bar = getStatusBarItem('busy');
    _busyTimer = setInterval(() => {
        const b = getStatusBarItem('busy');
        if (b) b.text = `$(sync~spin) PIC: ${_globalBusyName} (${_busyTimeStr()})`;
    }, 1000);
    if (bar) bar.text = `$(sync~spin) PIC: ${_globalBusyName}`;
}
function _stopBusyTimer() {
    if (_busyTimer) { clearInterval(_busyTimer); _busyTimer = null; }
}
function setBusy(name) {
    _globalBusy = true;
    _globalBusyName = name;
    _lastCmdStart = Date.now();
    try { vscode.commands.executeCommand('setContext', 'pic.busy', true); } catch {}
    const bar = getStatusBarItem('busy');
    if (bar) {
        bar.text = `$(sync~spin) PIC: ${name}`;
        bar.tooltip = `PIC ${name} is running — commands are locked.\nClick to focus the terminal.`;
        bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        bar.show();
    }
    _startBusyTimer();
    log(`▶ ${name} started`);
}
function clearBusy() {
    _globalBusy = false;
    _globalBusyName = '';
    _stopBusyTimer();
    try { vscode.commands.executeCommand('setContext', 'pic.busy', false); } catch {}
    const bar = getStatusBarItem('busy');
    if (bar) { bar.hide(); bar.backgroundColor = undefined; }
}
function checkBusy() {
    if (!_globalBusy) return false;
    vscode.window.showWarningMessage(
        `PIC: ${_globalBusyName} is still running (${_busyTimeStr()}) — wait for it to finish.`,
        'Focus terminal'
    ).then(a => { if (a === 'Focus terminal') vscode.commands.executeCommand('workbench.action.terminal.focus'); });
    return true;
}

// ─── Configuration ───────────────────────────────────────────────────────────
function cfg(key) { return vscode.workspace.getConfiguration('pic').get(key); }
async function setCfg(key, val) {
    const config = vscode.workspace.getConfiguration('pic');
    if (cfg('saveSettingsToWorkspace') && vscode.workspace.workspaceFolders?.length) {
        await config.update(key, val, vscode.ConfigurationTarget.Workspace);
    } else {
        await config.update(key, val, vscode.ConfigurationTarget.Global);
    }
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toISOString().slice(11, 23);
    getOutputChannel().appendLine(`[${ts}] ${msg}`);
}

// ─── Shell detection / classification ────────────────────────────────────────
const SHELL_POWERSHELL = 'powershell';
const SHELL_CMD        = 'cmd';
const SHELL_POSIX      = 'posix';
const SHELL_FISH       = 'fish';

function _classifyShell(p) {
    const s = String(p || '').toLowerCase();
    const base = path.posix.basename(s.replace(/\\/g, '/'));
    if (base.includes('powershell') || base.includes('pwsh')) return SHELL_POWERSHELL;
    if (base === 'cmd.exe' || base === 'cmd') return SHELL_CMD;
    if (base === 'fish') return SHELL_FISH;
    if (['bash', 'sh', 'zsh', 'ksh', 'dash', 'csh', 'tcsh', 'ash', 'busybox'].some(n => base.startsWith(n))) return SHELL_POSIX;
    if (s.includes('powershell') || s.includes('pwsh')) return SHELL_POWERSHELL;
    if (s.includes('cmd')) return SHELL_CMD;
    return null;
}
function _posixProfileShell() {
    try {
        const platformKey = os.platform() === 'darwin' ? 'osx' : 'linux';
        const defName = String(vscode.workspace.getConfiguration('terminal.integrated.defaultProfile').get(platformKey) || '').trim();
        if (defName) {
            const profiles = vscode.workspace.getConfiguration('terminal.integrated.profiles').get(platformKey) || {};
            const def = profiles[defName];
            if (def && typeof def === 'object' && def.path) {
                return { path: String(def.path), args: Array.isArray(def.args) ? def.args.map(String) : [] };
            }
            return { path: defName, args: [] };
        }
    } catch {}
    return { path: String(process.env.SHELL || ''), args: [] };
}
const _KNOWN_SHELL_MARKERS = ['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'wsl'];
const _BARE_SH_REGEX = /(^|[\\/.])sh(\\.exe)?($|[\\/.])/i;
function _isRecognizedShell(shellPath) {
    const s = String(shellPath || '').toLowerCase();
    if (!s) return false;
    if (_KNOWN_SHELL_MARKERS.some(m => s.includes(m))) return true;
    return _BARE_SH_REGEX.test(s);
}
let _unknownShellWarned = false;
function _maybeWarnUnknownShell(resolvedShell) {
    if (_unknownShellWarned) return;
    if (_isRecognizedShell(resolvedShell)) return;
    _unknownShellWarned = true;
    const name = path.basename(String(resolvedShell || '')) || String(resolvedShell || '');
    log(`[SHELL] unrecognized shell "${resolvedShell}" — quoting/markers may not work. Set "pic.shellPath" to override.`);
    vscode.window.showInformationMessage(
        `PIC: Detected shell "${name}" is not officially supported. Build/flash commands may fail with quoting or exit-code markers. Set "pic.shellPath" to override.`,
        'Configure shell', 'Ignore'
    ).then(choice => {
        if (choice === 'Configure shell') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'pic.shellPath');
        }
    });
}
function _resolveAutoShell() {
    if (!IS_WIN) {
        const p = _posixProfileShell().path || '/bin/sh';
        _maybeWarnUnknownShell(p);
        return p;
    }
    const termCfg = vscode.workspace.getConfiguration('terminal').get('integrated.defaultProfile.windows');
    if (termCfg) {
        const profiles = vscode.workspace.getConfiguration('terminal').get('integrated.profiles.windows') || {};
        const p = profiles[termCfg];
        if (p && p.path) return p.path;
        if (typeof p === 'string') return p;
        return termCfg;
    }
    const comspec = process.env.COMSPEC;
    if (comspec) return comspec;
    return 'powershell.exe';
}
function getUserShell() {
    return String(cfg('shellPath') || _resolveAutoShell());
}
function shellKind() {
    const kind = _classifyShell(getUserShell());
    if (kind) return kind;
    return IS_WIN ? SHELL_POWERSHELL : SHELL_POSIX;
}
function _which(bareName) {
    try {
        const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
        for (const d of dirs) for (const e of exts) {
            const c = path.join(d, bareName + e);
            try { if (fs.statSync(c).isFile()) return c; } catch {}
        }
    } catch {}
    return null;
}
function _pinnableShellPath(shell) {
    const s = String(shell || '').trim();
    if (!s) return null;
    if (s.includes('\\') || s.includes('/')) {
        try { return fs.existsSync(s) ? s : null; } catch { return null; }
    }
    return _which(s);
}

// ─── Terminal management ─────────────────────────────────────────────────────
function _resolveTermCwd() {
    if (_activeRoot && fs.existsSync(_activeRoot)) return vscode.Uri.file(_activeRoot);
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const f of folders) {
            try { if (fs.existsSync(f.uri.fsPath)) return f.uri; } catch {}
        }
    }
    return vscode.Uri.file(os.homedir());
}
function getTerm(name) {
    if (cfg('reuseTerminal') && _terms[name] && _terms[name].exitStatus === undefined) {
        return _terms[name];
    }
    if (_terms[name]) {
        try { _terms[name].dispose(); } catch {}
        delete _terms[name];
    }
    const opts = { name, cwd: _resolveTermCwd() };
    if (IS_WIN) {
        const shell = _pinnableShellPath(getUserShell());
        if (shell) opts.shellPath = shell;
    } else {
        const prof = _posixProfileShell();
        const shell = _pinnableShellPath(prof.path || process.env.SHELL || '/bin/sh');
        if (shell) opts.shellPath = shell;
        if (prof.args && prof.args.length) opts.shellArgs = prof.args;
    }
    const t = vscode.window.createTerminal(opts);
    _terms[name] = t;
    return t;
}

// ─── Killed-terminal watch ───────────────────────────────────────────────────
function _readMarker(marker) {
    try { return parseInt(fs.readFileSync(marker, 'utf8').trim(), 10); } catch { return NaN; }
}
function _finishWait(term, reason) {
    const w = _activeWaits.get(term);
    if (!w) return;
    _activeWaits.delete(term);
    clearInterval(w.timer);
    const ec = _readMarker(w.marker);
    try { fs.unlinkSync(w.marker); } catch {}
    if (!isNaN(ec)) { w.resolve(ec); return; }
    log(`[term] ${w.termName} ${reason} — no exit code seen, treating as interrupted`);
    w.resolve(-1);
}
function _ensureTermCloseHook() {
    if (_termCloseHook) return;
    try {
        _termCloseHook = vscode.window.onDidCloseTerminal((closed) => {
            for (const k of Object.keys(_terms)) {
                if (_terms[k] === closed) delete _terms[k];
            }
            if (_activeWaits.has(closed)) _finishWait(closed, 'was closed/killed');
        });
        const ctx = getCtx();
        if (ctx && ctx.subscriptions) ctx.subscriptions.push(_termCloseHook);
    } catch { _termCloseHook = null; }
}

// ─── Exit-code markers ───────────────────────────────────────────────────────
function markerDir() {
    const dir = path.join(os.tmpdir(), 'pic-mdf');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
}
function q(p) {
    if (!p) return '""';
    const s = String(p);
    const kind = shellKind();
    if (kind === SHELL_POWERSHELL) return `'${s.replace(/'/g, "''")}'`;
    if (kind === SHELL_CMD) return `"${s.replace(/"/g, '""')}"`;
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
// An executable is a command, not a quoted string expression in PowerShell.
function exe(p) { return (shellKind() === SHELL_POWERSHELL ? '& ' : '') + q(p); }
function anchorCmd(dir, command) {
    if (!dir) return command;
    const kind = shellKind();
    if (kind === SHELL_POWERSHELL) return `if ($(try { Set-Location -LiteralPath ${q(dir)} -ErrorAction Stop; $true } catch { $false })) { ${command} } else { Write-Error 'Cannot set command working directory' }`;
    return `${kind === SHELL_CMD ? 'cd /d' : 'cd'} ${q(dir)} && ${command}`;
}
function buildMarkerCmd(markerFile) {
    const kind = shellKind();
    if (kind === SHELL_CMD) {
        return `(if errorlevel 1 (echo 1) else (if errorlevel 0 (echo 0) else (echo 1))) >${q(markerFile)}`;
    }
    if (kind === SHELL_POWERSHELL) {
        return `$ec = if ($?) { 0 } elseif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }; [string]$ec | Out-File -NoNewline -Encoding ASCII ${q(markerFile)}`;
    }
    if (kind === SHELL_FISH) {
        return `begin; set ec $status; echo -n $ec > ${q(markerFile)}; end`;
    }
    return `printf '%s\\n' "$?" > ${q(markerFile)}`;
}

// ─── Long-command splitter ───────────────────────────────────────────────────
const TERM_LINE_LIMIT = 7000;
function tokenizeCommandLine(s) {
    const toks = [];
    let cur = '';
    let quote = null;
    for (const ch of String(s)) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
        } else if (ch === ' ' || ch === '\t') {
            if (cur) { toks.push(cur); cur = ''; }
        } else {
            cur += ch;
        }
    }
    if (cur) toks.push(cur);
    return toks;
}
function _sendTerminalLine(term, full, kind) {
    if (full.length <= TERM_LINE_LIMIT) { term.sendText(full, true); return; }
    const cont = (kind === SHELL_CMD) ? ' ^' : (kind === SHELL_POWERSHELL ? ' `' : ' \\');
    const toks = tokenizeCommandLine(full);
    const lines = [];
    let cur = '';
    for (const tok of toks) {
        if (cur && cur.length + 1 + tok.length > TERM_LINE_LIMIT) { lines.push(cur); cur = tok; }
        else cur = cur ? cur + ' ' + tok : tok;
    }
    if (cur) lines.push(cur);
    for (let i = 0; i < lines.length - 1; i++) term.sendText(lines[i] + cont, true);
    term.sendText(lines[lines.length - 1], true);
    if (lines.length > 1) {
        log(`[term] command exceeds ${TERM_LINE_LIMIT} chars — split into ${lines.length} lines (shell line limit)`);
    } else {
        log(`[term] command exceeds ${TERM_LINE_LIMIT} chars but has no safe split point — sending as-is`);
    }
}
function runInTerminal(termName, cmds, { reveal = true, cwd = getActiveRoot() } = {}) {
    return new Promise((resolve) => {
        const marker = path.join(markerDir(), `pic_${Date.now()}_${Math.floor(Math.random() * 1e6)}.tmp`);
        const term = getTerm(termName);
        if (reveal) term.show();
        _ensureTermCloseHook();
        const kind = shellKind();
        const sep = (kind === SHELL_CMD) ? ' & ' : ' ; ';
        const full = `${cmds.map(cmd => anchorCmd(cwd, cmd)).join(sep)}${sep}${buildMarkerCmd(marker)}`;
        _sendTerminalLine(term, full, kind);
        const w = { resolve, marker, timer: null, termName };
        _activeWaits.set(term, w);
        const started = Date.now();
        const MAX_WAIT = 30 * 60 * 1000;
        w.timer = setInterval(() => {
            let ec = _readMarker(marker);
            if (!isNaN(ec)) {
                _activeWaits.delete(term);
                clearInterval(w.timer);
                try { fs.unlinkSync(marker); } catch {}
                resolve(ec);
            } else if (term.exitStatus !== undefined) {
                _finishWait(term, 'shell exited');
            } else if (Date.now() - started > MAX_WAIT) {
                _activeWaits.delete(term);
                clearInterval(w.timer);
                try { fs.unlinkSync(marker); } catch {}
                resolve(-1);
            }
        }, 250);
    });
}
function sendTerminalLines(termName, lines, { reveal = true } = {}) {
    if (!lines || !lines.length) return;
    const term = getTerm(termName);
    if (reveal) term.show();
    const kind = shellKind();
    for (const line of lines) _sendTerminalLine(term, anchorCmd(getActiveRoot(), line), kind);
}

// ─── Status bar feedback helpers ─────────────────────────────────────────────
function flashBarFeedback(itemKey, feedbackText, idleText, ms = 3500) {
    const bar = getStatusBarItem(itemKey);
    if (!bar) return;
    const oldText = bar.text;
    bar.text = feedbackText;
    setTimeout(() => { bar.text = idleText || oldText; }, ms);
}

// ─── Diagnostics helpers (Problems panel) ────────────────────────────────────
let _diagCollection = null;
function getDiagCollection() {
    if (!_diagCollection) _diagCollection = vscode.languages.createDiagnosticCollection('pic');
    return _diagCollection;
}
function clearDiagnostics() { getDiagCollection().clear(); }

function parseGccDiagLine(line, rootDir) {
    // main.c:12:5: error: unknown type name 'Foo'
    // main.c:12:5: warning: unused variable
    // main.c:12: fatal error: foo.h: No such file
    // ./src/main.c:34:2: error: …
    const m = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning)\s*:\s*(.*)$/.exec(line);
    if (!m) return null;
    let file = m[1].replace(/\\ /g, ' ');
    if (/^[A-Za-z]:[\\\/]/.test(file) || file.startsWith('/')) {
        // absolute
    } else {
        file = path.join(rootDir, file);
    }
    const lineNo = parseInt(m[2], 10);
    const colNo = m[3] ? parseInt(m[3], 10) : 1;
    const sev = m[4] === 'error' || m[4] === 'fatal error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
    return {
        file, line: lineNo, col: colNo, severity: sev, message: m[5],
    };
}
// ld diagnostic: path/file.o: in function `main': file.c:(.text+0x0): undefined reference to `foo'
function parseLdDiagLines(stdout, stderr, rootDir) {
    const out = [];
    const lines = String(stderr || '') + '\n' + String(stdout || '');
    let currentFile = null, currentLine = null;
    for (const raw of lines.split('\n')) {
        const line = raw.trim();
        let m = /^In function\s+`(.+)':\s*$/.exec(line);
        if (m) continue;
        m = /^(.+?):(\d+):\s*(?:undefined reference|relocation truncated|cannot find|multiple definition|first defined here)/.exec(line) ||
            /^(.+?:(?:\.[^:]+)?):\s*(undefined reference|relocation truncated|multiple definition)/.exec(line);
        if (m) {
            const file = path.isAbsolute(m[1]) || path.win32.isAbsolute(m[1]) ? m[1] : path.resolve(rootDir, m[1]);
            currentFile = file; currentLine = /^\d+$/.test(m[2] || '') ? parseInt(m[2], 10) : 1;
            out.push({
                file: currentFile.replace(/\((\.[^)]+)\)$/, ''), line: currentLine, col: 1,
                severity: vscode.DiagnosticSeverity.Error, message: line,
            });
            continue;
        }
        m = /^(.+?\.(?:o|a|elf)):\s+in function\s+`(.+)':/.exec(line);
        if (m) { currentFile = m[1]; continue; }
        m = /^(.*?\.(?:c|cpp|cc|cxx|S|s)):\((\.[^)]+)\):\s*(.*)$/.exec(line);
        if (m && currentFile) {
            out.push({
                file: path.isAbsolute(m[1]) || path.win32.isAbsolute(m[1]) ? m[1] : path.resolve(rootDir, m[1]),
                line: 1, col: 1, severity: vscode.DiagnosticSeverity.Error, message: m[3] || line,
            });
            continue;
        }
    }
    return out;
}
function reportDiagnostics(items, rootDir) {
    const coll = getDiagCollection();
    const byFile = new Map();
    for (const it of items) {
        const uri = vscode.Uri.file(it.file);
        if (!byFile.has(it.file)) byFile.set(it.file, { uri, diags: [] });
        const diag = new vscode.Diagnostic(
            new vscode.Range(Math.max(0, (it.line || 1) - 1), Math.max(0, (it.col || 1) - 1),
                             Math.max(0, (it.line || 1) - 1), Math.max(0, (it.col || 1) - 1) + 200),
            it.message, it.severity);
        diag.source = 'pic';
        byFile.get(it.file).diags.push(diag);
    }
    coll.clear();
    for (const { uri, diags } of byFile.values()) coll.set(uri, diags);
    return byFile.size;
}

// ─── Small fs utilities ──────────────────────────────────────────────────────
function readJsonFile(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const json = raw.replace(/^\uFEFF/, '');
        return { ok: true, data: JSON.parse(json) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}
function isAscii(str) { return /^[\x00-\x7F]*$/.test(str); }
function warnNoProject() {
    vscode.window.showInformationMessage(
        'PIC: no active project. Select or create one first.',
        'Select Project', 'Create Project'
    ).then(a => {
        if (a === 'Select Project') vscode.commands.executeCommand('pic.selectProject');
        if (a === 'Create Project') vscode.commands.executeCommand('pic.createProject');
    });
}

// ─── Variable expansion (${workspaceFolder}, ${board.mcu}, …) ────────────────
function expandVars(str, vars) {
    if (typeof str !== 'string') return str;
    return str.replace(/\$\{([^}]+)\}/g, (whole, name) => {
        if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
        return whole;
    });
}
function configVarResolver() {
    return (str) => str.replace(/\$\{config:([^}]+)\}/g, (whole, key) => {
        try {
            const conf = vscode.workspace.getConfiguration();
            const tryKeys = key.includes('.') ? [key] : ['pic.' + key, key];
            for (const k of tryKeys) {
                const v = conf.get(k);
                if (v !== undefined && v !== null) return String(v);
            }
        } catch {}
        return whole;
    });
}
function envVarResolver() {
    return (str) => str.replace(/\$\{env:([^}]+)\}/g, (whole, key) => {
        const v = process.env[key];
        return v === undefined ? whole : v;
    });
}

// ─── Hook command expansion with context-aware shell escaping ───────────────
// Hook commands are shell lines authored by the project; the ${…} VALUES come
// from git branch names, environment variables and settings, none of which is
// guaranteed free of shell metacharacters (audit 0.3.0 item 3). Every value is
// escaped according to the quoting context it lands in, so a crafted value can
// never leave the command the author intended. Defence in depth on top of
// Workspace Trust.
const _SAFE_UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]+$/;
function _quoteCtxAt(subject, idx) {
    // Scan the template up to the placeholder: which quoting region is it in?
    let inS = false, inD = false;
    for (let i = 0; i < idx && i < subject.length; i++) {
        const ch = subject[i];
        if (ch === '\\') { i++; continue; }
        if (!inD && ch === "'") inS = !inS;
        else if (!inS && ch === '"') inD = !inD;
    }
    return inS ? 'single' : (inD ? 'double' : null);
}
function _escapeHookValue(v, ctx) {
    const kind = shellKind();
    const s = String(v).replace(/[\r\n]+/g, ' ');
    if (kind === SHELL_CMD) {
        // cmd.exe: only double quotes are syntactic inside "…"; %VAR% expansion
        // cannot be escaped portably but can never execute a command.
        if (ctx === 'double') return s.replace(/"/g, '""');
        if (_SAFE_UNQUOTED.test(s) && !/[&|<>^%]/.test(s)) return s;
        return '"' + s.replace(/"/g, '""') + '"';
    }
    if (ctx === 'double') {
        if (kind === SHELL_POWERSHELL) return s.replace(/["`$]/g, (m) => '`' + m);
        return s.replace(/["`$\\]/g, (m) => '\\' + m);
    }
    if (ctx === 'single') {
        return kind === SHELL_POWERSHELL ? s.replace(/'/g, "''") : s.replace(/'/g, "'\\''");
    }
    if (_SAFE_UNQUOTED.test(s)) return s;
    // Unquoted context: wrap in single quotes (both PowerShell and POSIX). For
    // fish the '\'' idiom still yields a literal quote, so it stays safe there.
    return kind === SHELL_POWERSHELL ? "'" + s.replace(/'/g, "''") + "'"
        : "'" + s.replace(/'/g, "'\\''") + "'";
}
function expandHookCommand(tpl, vars) {
    // ONE pass: substituted values are never re-scanned for ${…}, so a value
    // that itself looks like "${env:X}" cannot smuggle a second substitution.
    return String(tpl).replace(/\$\{(env:|config:)?([^}]+)\}/g, (whole, prefix, name, offset, subject) => {
        let v;
        if (prefix === 'env:') v = process.env[name];
        else if (prefix === 'config:') {
            try {
                const conf = vscode.workspace.getConfiguration();
                const tryKeys = name.includes('.') ? [name] : ['pic.' + name, name];
                for (const k of tryKeys) {
                    const val = conf.get(k);
                    if (val !== undefined && val !== null) { v = val; break; }
                }
            } catch {}
        } else if (Object.prototype.hasOwnProperty.call(vars, name)) v = vars[name];
        if (v === undefined || v === null) return whole;
        return _escapeHookValue(v, _quoteCtxAt(subject, offset));
    });
}
function gitInfo(root) {
    const info = { hash: '', branch: '' };
    try {
        const out = cp.execSync('git rev-parse HEAD --abbrev-ref HEAD', {
            cwd: root || process.cwd(),
            timeout: 2000,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = String(out || '').split('\n').map(s => s.trim()).filter(Boolean);
        if (lines.length >= 2) { info.hash = lines[0].slice(0, 7); info.branch = lines[1]; }
        else if (lines.length === 1) info.hash = lines[0].slice(0, 7);
    } catch {}
    return info;
}

// ─── The compiler follows the MCU ────────────────────────────────────────────
// v0.4.0: there is no "toolchain" setting any more — the architecture is a
// property of the chip. Resolution order:
//   1. the MCU definition (board.toolchain — built-in database / Board Manager)
//   2. the device NAME (PIC16… → xc8, PIC24/dsPIC → xc16, PIC32/SAM → xc32)
//   3. a legacy "toolchain" key of an old pic-project.json (only when the MCU
//      is unknown to the database)
//   4. xc8
const TOOLCHAIN_IDS = ['xc8', 'xc16', 'xc32', 'xcdsc'];
function toolchainFromDevice(dev) {
    const d = String(dev || '').toUpperCase();
    if (/^(?:E?PIC)?(?:10|12|16|18)[A-Z]/.test(d) || /^PIC1[0268][A-Z]/.test(d)) return 'xc8';
    if (/^(?:DSPIC|PIC24)/.test(d) || /^(?:24|30|33)[A-Z]/.test(d)) return 'xc16';
    if (/^(?:PIC32|32M|32C|ATSAM|SAM|PIC32C)/.test(d)) return 'xc32';
    return '';
}
function resolveToolchain(proj) {
    if (!proj || typeof proj !== 'object') return 'xc8';
    try {
        const Boards = require('./boards');
        const b = Boards.getBoard(proj.board);
        if (b && TOOLCHAIN_IDS.includes(b.toolchain)) return b.toolchain;
        const dev = (b && b.build && b.build.device) || proj.board;
        const byName = toolchainFromDevice(dev);
        if (byName) return byName;
    } catch {}
    if (TOOLCHAIN_IDS.includes(proj.toolchain)) return proj.toolchain;
    return 'xc8';
}
// The ACTIVE project's compiler: 'xc8' | 'xc16' | 'xc32' | 'xcdsc'.
function getProjectToolchain(root) {
    const r = root || _activeRoot;
    if (!r) return 'xc8';
    try {
        const Validator = require('./validator');
        const { status, proj } = Validator.readProjectConfig(r);
        if (status === 'ok' && proj) return resolveToolchain(proj);
    } catch {}
    return 'xc8';
}

// v0.3.20 pattern: expand ${…} in build.output_dir / build.output_name.
function expandOutPaths(root, proj) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const rawDir = (proj && proj.build && typeof proj.build.output_dir === 'string' && proj.build.output_dir.trim())
        ? proj.build.output_dir.trim() : 'build';
    const rawName = (proj && proj.build && typeof proj.build.output_name === 'string' && proj.build.output_name.trim())
        ? proj.build.output_name.trim() : 'firmware';
    const git = /\$\{git:/.test(rawDir + rawName) ? gitInfo(root) : { hash: '', branch: '' };
    const base = {
        'workspaceFolder': root || '',
        'workspaceFolderBasename': root ? path.basename(root) : '',
        'project.name': (proj && proj.name) || (root ? path.basename(root) : ''),
        'buildMode': String(cfg('buildMode') || 'release').toLowerCase(),
        'toolchain': getProjectToolchain(root),
        'git:hash': git.hash,
        'git:branch': git.branch,
        'date': date,
        'time': time,
        'datetime': `${date}_${time}`,
        'unixtime': Math.floor(now.getTime() / 1000),
        'pathSeparator': path.sep,
        'userHome': os.homedir(),
    };
    const expand = (s) => envVarResolver()(configVarResolver()(expandVars(String(s || ''), base)));
    let outDirRel = expand(rawDir).trim();
    if (!outDirRel || outDirRel === '.') outDirRel = 'build';
    let outName = expand(rawName).trim().replace(/[/\\]+/g, '');
    if (!outName) outName = 'firmware';
    const outDirAbs = path.isAbsolute(outDirRel) ? outDirRel : path.join(root || '', outDirRel);
    const safety = checkOutputDir(root, outDirAbs);
    if (!safety.ok) throw new Error('Unsafe build.output_dir: ' + safety.reason);
    return { outDirRel, outName, outDirAbs };
}

module.exports = {
    IS_WIN, IS_MAC, TOOLCHAIN_IDS, toolchainFromDevice, resolveToolchain,
    SHELL_POWERSHELL, SHELL_CMD, SHELL_POSIX, SHELL_FISH,
    getCtx, setCtx,
    getProvider, setProvider,
    getDevtoolsProvider, setDevtoolsProvider,
    getRefProvider, setRefProvider,
    getOutputChannel, getActiveRoot, setActiveRoot,
    getGlobalBusyName, getTerms, setTerms,
    getToolchainCache, setToolchainCache,
    getBoardCache, setBoardCache,
    getStatusBarItem, setStatusBarItem,
    setBusy, clearBusy, checkBusy,
    cfg, setCfg, log,
    shellKind, getUserShell, q, exe, anchorCmd, checkOutputDir, buildMarkerCmd, runInTerminal, sendTerminalLines, getTerm,
    flashBarFeedback,
    getDiagCollection, clearDiagnostics, parseGccDiagLine, parseLdDiagLines, reportDiagnostics,
    readJsonFile, isAscii, warnNoProject, _which, tokenizeCommandLine,
    getProjectToolchain,
    expandVars, configVarResolver, envVarResolver,
    expandHookCommand,
    expandOutPaths,
    gitInfo,
    markerDir,
};
