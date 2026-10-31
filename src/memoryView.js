'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// memoryView.js — the Memory webview: usage bars, top symbols, history chart.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const H      = require('./helpers');
const Memory = require('./memory');

let _provider = null;

function registerProvider(ctx) {
    _provider = new PicMemoryViewProvider();
    ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('pic.memoryView', _provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    Memory.onCollect(() => _provider && _provider.push());
}

class PicMemoryViewProvider {
    constructor() { this._view = null; }
    resolveWebviewView(view) {
        this._view = view;
        view.webview.options = { enableScripts: true };
        try { require('./statusBar').markUiVisible(); } catch {}
        view.webview.html = _html();
        view.webview.onDidReceiveMessage(msg => { if (msg && msg.type === 'ready') this.push(); });
        view.onDidDispose(() => { this._view = null; });
        view.onDidChangeVisibility(() => { try { require('./statusBar').markUiVisible(); } catch {} if (view.visible) this.push(); });
        this.push();
    }
    push() { try { this._view && this._view.webview.postMessage(_payload()); } catch {} }
}

function refresh() { if (_provider) _provider.push(); }

function _payload() {
    const r = Memory.lastReport();
    if (!r) return { empty: true };
    const threshold = Number(H.cfg('memory.thresholdWarning') || 85);
    const area = (key, label, color) => {
        const a = r.usage[key];
        if (!a || !a.total) return null;
        const pct = Math.round(a.used / a.total * 100);
        return { label, used: a.used, total: a.total, pct, color: pct >= 100 ? 'red' : pct >= threshold ? 'yellow' : color };
    };
    return {
        ts: r.ts, board: r.board, toolchain: r.toolchain,
        areas: [area('flash', 'Flash', 'green'), area('ram', 'RAM', 'blue'), area('eeprom', 'EEPROM', 'purple')].filter(Boolean),
        symbols: (r.symbols || []).slice(0, 25),
        history: (r.history || []).map(h => ({ ts: h.ts, flash: h.usage.flash.used, ram: h.usage.ram.used })),
    };
}

function _html() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 12px 14px; }
.empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 18px 6px; line-height: 1.6; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .6px; color: var(--vscode-descriptionForeground); margin: 16px 0 8px; }
.area { margin-bottom: 12px; }
.area .top { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 3px; }
.area .name { font-weight: 600; }
.bar { height: 10px; border-radius: 5px; background: var(--vscode-input-background, rgba(128,128,128,.2)); overflow: hidden; }
.bar > span { display: block; height: 100%; border-radius: 5px; }
.green { background: #4ecf8b; } .blue { background: #4daafc; } .purple { background: #a374e8; } .yellow { background: #d1b02a; } .red { background: #f14c4c; }
svg { width: 100%; height: 90px; }
table { width: 100%; border-collapse: collapse; font-size: 11px; font-family: var(--vscode-editor-font-family); }
td { padding: 2px 4px; border-bottom: 1px solid var(--vscode-panel-border, #3e3e42); }
td.r { text-align: right; color: var(--vscode-descriptionForeground); }
</style></head><body>
<div id="root"><div class="empty">No build report yet — build the project to populate the memory view.</div></div>
<script>
const vscode = acquireVsCodeApi();
window.addEventListener('message', e => render(e.data));
function fmt(n){ if(n>=1048576){const r=Math.round(n/1048576*10)/10;return (r%1?r.toFixed(1):r)+'M';} if(n>=1024){const r=Math.round(n/1024*10)/10;return (r%1?r.toFixed(1):r)+'K';} return n+'B'; }
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function render(d){
  const root=document.getElementById('root');
  if(!d||d.empty){root.innerHTML='<div class="empty">No build report yet — build the project.</div>';return;}
  let h='';
  for(const a of (d.areas||[])){
    h+='<div class="area"><div class="top"><span class="name">'+esc(a.label)+'</span><span>'+fmt(a.used)+' / '+fmt(a.total)+' ('+a.pct+'%)</span></div>'
      +'<div class="bar"><span class="'+a.color+'" style="width:'+Math.min(100,a.pct)+'%"></span></div></div>';
  }
  if((d.history||[]).length>1){ h+='<h3>History (flash / RAM)</h3>'+chart(d.history); }
  if((d.symbols||[]).length){ h+='<h3>Top symbols</h3><table>'+d.symbols.map(s=>'<tr><td>'+esc(s.name)+'</td><td class="r">'+fmt(s.size)+'</td></tr>').join('')+'</table>'; }
  root.innerHTML=h;
}
function chart(hist){
  const w=300,h=80,pad=4;
  const max=Math.max(...hist.map(x=>Math.max(x.flash,x.ram)),1);
  const step=(w-pad*2)/Math.max(1,hist.length-1);
  const line=(key)=>hist.map((x,i)=>{const v=x[key]/max;return (i?'L':'M')+(pad+i*step).toFixed(1)+','+(h-pad-v*(h-pad*2)).toFixed(1);}).join(' ');
  return '<svg viewBox="0 0 '+w+' '+h+'"><path d="'+line('flash')+'" fill="none" stroke="#4ecf8b" stroke-width="1.5"/>'
    +'<path d="'+line('ram')+'" fill="none" stroke="#4daafc" stroke-width="1.5"/></svg>';
}
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

module.exports = { registerProvider, refresh, PicMemoryViewProvider, _payload };
