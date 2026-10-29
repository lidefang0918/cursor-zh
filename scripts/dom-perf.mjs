#!/usr/bin/env node
// DOM 补漏运行时的性能测量（box 调试用）：对已用 --remote-debugging-port 启动的 Cursor 的各窗口开 CPU 采样，
// 期间跑一遍 coverage-scan.mjs（设置各页、命令面板、菜单、右键菜单），结束后统计落在注入块
// （/*CURSOR_ZH_DOM_BEGIN*/ 之后）里的采样时间占比。用法：node scripts/dom-perf.mjs [--port 9333] [--palette-pages 40]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PORT = opt('port', '9333');
const here = dirname(fileURLToPath(import.meta.url));
const pages = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).filter((x) => x.type === 'page' && x.title);
const conns = [];
for (const t of pages) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 200 });
  await send('Profiler.start');
  conns.push({ title: t.title, ws, send });
}
const t0 = Date.now();
try {
  execFileSync(process.execPath, [join(here, 'coverage-scan.mjs'), '--port', PORT, '--palette-pages', opt('palette-pages', '40')], { stdio: ['ignore', 'ignore', 'inherit'] });
} catch (e) { console.error('coverage-scan 失败', e.message); }
const wall = Date.now() - t0;
// 注入块起始行（0 基）：按文件找 BEGIN 标记
const beginLine = {};
const lineOf = (url) => {
  if (url in beginLine) return beginLine[url];
  let n = -1;
  try { const src = readFileSync(fileURLToPath(url.replace(/^vscode-file:\/\/vscode-app/, 'file://')), 'utf8'); const i = src.indexOf('/*CURSOR_ZH_DOM_BEGIN*/'); if (i >= 0) n = src.slice(0, i).split('\n').length - 1; } catch {}
  return (beginLine[url] = n);
};
const out = [];
for (const c of conns) {
  const { result } = await c.send('Profiler.stop');
  const p = result.profile;
  const dt = (p.endTime - p.startTime) / 1000 / p.samples.length; // ms/样本
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const counts = new Map(); for (const s of p.samples) counts.set(s, (counts.get(s) || 0) + 1);
  let total = 0, idle = 0, czl = 0;
  const fn = {};
  for (const [id, k] of counts) {
    const n = byId.get(id); total += k;
    const cf = n.callFrame;
    if (cf.functionName === '(idle)' || cf.functionName === '(program)') { idle += k; continue; }
    const b = cf.url ? lineOf(cf.url) : -1;
    if (b >= 0 && cf.lineNumber >= b) { czl += k; fn[cf.functionName || '(anon)'] = (fn[cf.functionName || '(anon)'] || 0) + k; }
  }
  const busy = total - idle;
  out.push({ window: c.title, sampledMs: +(total * dt).toFixed(0), busyMs: +(busy * dt).toFixed(0), domRuntimeMs: +(czl * dt).toFixed(1), shareOfBusy: busy ? +(100 * czl / busy).toFixed(2) : 0,
    top: Object.entries(fn).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, k]) => `${f}:${(k * dt).toFixed(1)}ms`) });
  c.ws.close();
}
console.log(JSON.stringify({ wallMs: wall, windows: out }, null, 2));
