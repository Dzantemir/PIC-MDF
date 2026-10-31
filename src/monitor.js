'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// monitor.js — the Serial Monitor webview (port/baud, send line, rx/tx
// counters). One reader process per platform:
//   Windows: a single PowerShell process — a background runspace pumps
//            SerialPort RX to stdout while the main thread copies our stdin
//            bytes into the port, so the monitor is fully bidirectional.
//   POSIX:   `stty` sets the line discipline (baud, raw, no echo), `cat` reads
//            the device and a write fd on the tty carries TX.
// The port name and baud rate are validated BEFORE anything reaches a shell
// string (audit 0.3.0 items 4 and 8).
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const fs     = require('fs');
const H      = require('./helpers');
const Ports  = require('./ports');

let _view = null;
let _connected = false;
const _lines = [];

function registerProvider(ctx) {
    ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('pic.monitorView', new PicMonitorViewProvider(), {
        webviewOptions: { retainContextWhenHidden: true },
    }));
}

class PicMonitorViewProvider {
    constructor() { this._view = null; }
    resolveWebviewView(view) {
        _view = view;
        this._view = view;
        view.webview.options = { enableScripts: true };
        try { require('./statusBar').markUiVisible(); } catch {}
        view.webview.html = _html();
        view.webview.onDidReceiveMessage(msg => onMessage(msg));
        view.onDidDispose(() => { _view = null; this._view = null; });
        view.onDidChangeVisibility(() => { try { require('./statusBar').markUiVisible(); } catch {} if (view.visible) postState(); });
        postState();
    }
}

function reveal() { try { vscode.commands.executeCommand('pic.monitorView.focus'); } catch {} }
function isConnected() { return _connected; }
function clearOutput() { _lines.length = 0; _post({ type: 'clear' }); }
function cmdRefreshPorts() { _post({ type: 'ports', ports: Ports.detectPorts() }); }
function onComPortChanged() { postState(); }
function cmdOpen() { reveal(); }

function onMessage(m) {
    if (!m || !m.type) return;
    switch (m.type) {
        case 'ready': postState(); break;
        case 'connect': _connect(m.port, m.baud); break;
        case 'disconnect': _disconnect(); break;
        case 'send': _send(m.text, m.eol); break;
        case 'clear': clearOutput(); break;
        case 'refreshPorts': cmdRefreshPorts(); break;
    }
}

function _post(msg) { try { _view && _view.webview.postMessage(msg); } catch {} }

function postState() {
    _post({
        type: 'state',
        connected: _connected,
        ports: Ports.detectPorts(),
        port: String(H.cfg('comPort') || ''),
        baud: validBaud(H.cfg('monitorBaud')) || 115200,
        eol: _eolFromSettings(),
        timestamps: !!H.cfg('monitorTimestamps'),
        lines: _lines.slice(-500),
    });
}

// pic.monitorEol (previously declared but never read): the default send-line
// terminator until the user picks another one in the toolbar.
function _eolFromSettings() {
    const v = String(H.cfg('monitorEol') || 'lf').toLowerCase();
    return ['lf', 'cr', 'crlf', 'none'].includes(v) ? v : 'lf';
}

// ─── Serial I/O ──────────────────────────────────────────────────────────────
// Whitelist first: a port/baud that does not match NEVER reaches a command
// line, in any shell (audit 0.3.0 item 4 — the old code interpolated the raw
// port into a PowerShell string and used `baud || 115200` unchecked).
let _proc = null;
let _wfd = -1; // POSIX write fd on the tty

const _PORT_RE_WIN = /^(?:COM\d{1,3}|\\\\.\\COM\d{1,3})$/i;
// Any path under /dev built from safe components (ttyUSB0, cu.usbmodem…,
// serial/by-id/usb-…). No quotes/metachars can appear; '..' is rejected
// twice (lookahead here + explicit check in validPort).
const _PORT_RE_POSIX = /^(?!.*\.\.)\/dev\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const _PORT_RE = H.IS_WIN ? _PORT_RE_WIN : _PORT_RE_POSIX;

function validPort(p) {
    const s = String(p || '').trim();
    if (!s || s.includes('..')) return null;
    return _PORT_RE.test(s) ? s : null;
}

function validBaud(b) {
    const n = Number(b);
    return Number.isInteger(n) && n >= 110 && n <= 4000000 ? n : null;
}

// The Windows reader/writer. `port` and `baud` are already validated, so the
// interpolated values can only be a COM name and an integer. The background
// runspace turns RX into stdout; the main thread blocks on stdin and forwards
// our bytes to the port (this is what makes Send actually work).
function _buildPsScript(port, baud) {
    return [
        "$ErrorActionPreference='Stop'",
        'try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}',
        `$p=New-Object System.IO.Ports.SerialPort('${port}',${baud},[System.IO.Ports.Parity]::None,8,[System.IO.Ports.StopBits]::One)`,
        'try{$p.Encoding=[System.Text.Encoding]::UTF8}catch{}',
        '$p.Open()',
        '$rs=[System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()',
        '$rs.Open()',
        "$rs.SessionStateProxy.SetVariable('p',$p)",
        '$bg=[System.Management.Automation.PowerShell]::Create()',
        '$bg.Runspace=$rs',
        "$null=$bg.AddScript('while($p.IsOpen){$d=$p.ReadExisting();if($d){[Console]::Out.Write($d)};Start-Sleep -Milliseconds 10}')",
        '$h=$bg.BeginInvoke()',
        '$stdin=[Console]::OpenStandardInput()',
        '$buf=New-Object byte[] 4096',
        'try{while(($n=$stdin.Read($buf,0,$buf.Length)) -gt 0){$p.Write($buf,0,$n)}}',
        'finally{try{$bg.Stop()}catch{};try{$p.Close()}catch{}}',
    ].join(';');
}

function _closeWriteFd() {
    if (_wfd >= 0) { try { fs.closeSync(_wfd); } catch {} _wfd = -1; }
}

function _connect(port, baud) {
    if (_connected) _disconnect();
    const rawPort = String(port || H.cfg('comPort') || '').trim();
    const usePort = validPort(rawPort);
    if (!usePort) {
        _post({ type: 'error', message: `Invalid serial port "${rawPort}" — expected a COM port (Windows) or a /dev/tty… / /dev/cu… device (POSIX).` });
        return;
    }
    let useBaud = validBaud(baud);
    if (useBaud == null) {
        if (baud !== undefined && baud !== null && String(baud).trim() !== '') {
            _post({ type: 'error', message: `Invalid baud rate "${baud}".` });
            return;
        }
        useBaud = validBaud(H.cfg('monitorBaud')) || 115200;
    }
    const cp = require('child_process');
    try {
        if (H.IS_WIN) {
            _proc = cp.spawn('powershell.exe', ['-NoProfile', '-Command', _buildPsScript(usePort, useBaud)], { windowsHide: true });
        } else {
            // Configure the line discipline BEFORE the reader starts — the old
            // code never set the speed, so the port kept whatever the driver
            // had (garbage at mismatched rates; audit item 8).
            const sttyFlag = H.IS_MAC ? '-f' : '-F';
            const stty = cp.spawnSync('stty', [sttyFlag, usePort, String(useBaud), 'raw', '-echo'], { timeout: 5000 });
            if (stty.error || stty.status !== 0) {
                pushLine('[warn] could not configure ' + usePort + ' (' + (stty.error ? stty.error.message : 'stty exit ' + stty.status) + ') — continuing with current line settings');
            }
            _wfd = fs.openSync(usePort, 'r+'); // TX: our bytes go straight to the tty
            _proc = cp.spawn('cat', [usePort]);   // RX: device → stdout
        }
        _proc.stdout.on('data', (buf) => pushChunk(buf.toString()));
        _proc.stderr.on('data', (buf) => pushLine('[err] ' + buf.toString().trim()));
        _proc.on('error', (e) => {
            _closeWriteFd();
            pushLine('[err] ' + e.message);
            _connected = false; postState();
            try { require('./statusBar').refreshMonitorButton(); } catch {}
        });
        _proc.on('close', () => {
            _closeWriteFd();
            _connected = false; postState();
            try { require('./statusBar').refreshMonitorButton(); } catch {}
        });
        _connected = true;
        _post({ type: 'connected', port: usePort });
        try { require('./statusBar').refreshMonitorButton(); } catch {}
        if (usePort !== H.cfg('comPort')) H.setCfg('comPort', usePort);
    } catch (e) {
        _closeWriteFd();
        if (_proc) { try { _proc.kill(); } catch {} _proc = null; }
        _post({ type: 'error', message: `Could not open ${usePort}: ${e.message}` });
    }
}

function _disconnect() {
    _closeWriteFd();
    if (_proc) {
        // Graceful first (lets the PowerShell finally{} close the port), then kill.
        try { if (_proc.stdin && !_proc.stdin.destroyed) _proc.stdin.end(); } catch {}
        try { _proc.kill(); } catch {}
        _proc = null;
    }
    _connected = false;
    _post({ type: 'disconnected' });
    try { require('./statusBar').refreshMonitorButton(); } catch {}
}

function _send(text, eol) {
    if (!_proc || !_connected) { _post({ type: 'error', message: 'Not connected.' }); return; }
    // EOL: the webview selector wins; pic.monitorEol is the default.
    const mode = String(eol || _eolFromSettings()).toLowerCase();
    const term = mode === 'crlf' ? '\r\n' : mode === 'cr' ? '\r' : mode === 'none' ? '' : '\n';
    const payload = Buffer.from(String(text || '') + term, 'utf8');
    try {
        if (H.IS_WIN) {
            _proc.stdin.write(payload);
        } else if (_wfd >= 0) {
            fs.writeSync(_wfd, payload);
        } else {
            _post({ type: 'error', message: 'Port is not open for writing.' });
            return;
        }
    } catch (e) {
        _post({ type: 'error', message: 'Send failed: ' + e.message });
        return;
    }
    pushLine('> ' + text);
}

function _stamp() {
    if (!H.cfg('monitorTimestamps')) return '';
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}] `;
}
function pushChunk(s) {
    const parts = String(s).split(/\r?\n/);
    for (let i = 0; i < parts.length - 1; i++) pushLine(parts[i]);
    if (parts[parts.length - 1]) pushLine(parts[parts.length - 1], true);
}
let _pending = '';
function pushLine(line, partial) {
    if (partial) { _pending += line; return; }
    const full = _pending + line; _pending = '';
    const stamped = _stamp() + full;
    _lines.push(stamped);
    if (_lines.length > 1000) _lines.shift();
    _post({ type: 'line', text: stamped });
}

function cmdStart() { reveal(); }
function cmdStop() { _disconnect(); }
function connectDefault() {
    const port = String(H.cfg('comPort') || '');
    if (port) _connect(port, H.cfg('monitorBaud'));
}

function _html() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; }
.toolbar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #3e3e42); flex-wrap: wrap; }
select, input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #3e3e42); border-radius: 4px; padding: 3px 6px; font-size: 12px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
button.sec { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
#out { flex: 1; overflow-y: auto; padding: 6px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
#out div { line-height: 1.4; }
#out .err { color: var(--vscode-charts-red, #f14c4c); }
#input { display: flex; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--vscode-panel-border, #3e3e42); }
#input input { flex: 1; }
.status { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: auto; }
</style></head><body>
<div class="toolbar">
  <select id="port"></select>
  <select id="baud">
    <option>9600</option><option>19200</option><option>38400</option><option>57600</option>
    <option>115200</option><option>230400</option><option>460800</option><option>921600</option>
  </select>
  <button id="connect">Connect</button>
  <button id="refresh" class="sec">↻</button>
  <button id="clear" class="sec">Clear</button>
  <span class="status" id="status">disconnected</span>
</div>
<div id="out"></div>
<div id="input">
  <select id="eol"><option value="lf">LF</option><option value="crlf">CRLF</option><option value="cr">CR</option><option value="none">none</option></select>
  <input id="line" placeholder="Type a line and press Enter">
</div>
<script>
const vscode = acquireVsCodeApi();
let connected = false;
const $ = (id) => document.getElementById(id);
function addLine(text, cls){ const d=document.createElement('div'); if(cls)d.className=cls; d.textContent=text; $('out').appendChild(d); $('out').scrollTop=$('out').scrollHeight; }
$('connect').onclick = () => { if(connected){ vscode.postMessage({type:'disconnect'}); } else { vscode.postMessage({type:'connect', port:$('port').value, baud:Number($('baud').value)}); } };
$('refresh').onclick = () => vscode.postMessage({type:'refreshPorts'});
$('clear').onclick = () => { $('out').innerHTML=''; vscode.postMessage({type:'clear'}); };
$('line').addEventListener('keydown', e => { if(e.key==='Enter'){ vscode.postMessage({type:'send', text:$('line').value, eol:$('eol').value}); $('line').value=''; } });
window.addEventListener('message', e => {
  const m = e.data;
  if(m.type==='state'){ connected=m.connected; setPorts(m.ports, m.port); $('baud').value=String(m.baud); if(m.eol){ $('eol').value=m.eol; } if(m.lines){ $('out').innerHTML=''; m.lines.forEach(l=>addLine(l)); } setStatus(); }
  else if(m.type==='ports'){ setPorts(m.ports, $('port').value); }
  else if(m.type==='connected'){ connected=true; setStatus('connected: '+m.port); }
  else if(m.type==='disconnected'){ connected=false; setStatus(); }
  else if(m.type==='line'){ addLine(m.text); }
  else if(m.type==='clear'){ $('out').innerHTML=''; }
  else if(m.type==='error'){ addLine(m.message, 'err'); }
});
function setPorts(ports, sel){ const p=$('port'); const cur=sel||p.value; p.innerHTML=''; (ports||[]).forEach(x=>{ const o=document.createElement('option'); o.value=x; o.textContent=x; p.appendChild(o); }); if(cur && !(ports||[]).includes(cur)){ const o=document.createElement('option'); o.value=cur; o.textContent=cur; p.appendChild(o);} if(cur) p.value=cur; }
function setStatus(t){ $('status').textContent = t || (connected ? 'connected' : 'disconnected'); $('connect').textContent = connected ? 'Disconnect' : 'Connect'; }
vscode.postMessage({type:'ready'});
</script></body></html>`;
}

module.exports = {
    registerProvider, reveal, isConnected, clearOutput, cmdRefreshPorts, onComPortChanged,
    cmdOpen, cmdStart, cmdStop, connectDefault, postState,
};

// Test hooks (plain-node unit/integration tests; not used by the extension).
module.exports._internal = { validPort, validBaud, _buildPsScript, _connect, _disconnect, _send, _lines, _PORT_RE_WIN, _PORT_RE_POSIX };
