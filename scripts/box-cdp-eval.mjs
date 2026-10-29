// box 专用调试：Cursor 需以 --remote-debugging-port=9333 启动（只在 box 上临时用，验证完用普通方式重启）
// node cdp-eval.mjs <title-substring> <js-expression>   （只连 box 上本地 Cursor 的调试端口）
const [title, expr] = process.argv.slice(2);
const list = await (await fetch('http://localhost:9333/json/list')).json();
const t = list.find((x) => x.type === 'page' && x.title.includes(title));
if (!t) { console.error('no page', list.map((x) => x.title)); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) { const r = d.result; console.log(typeof r.result?.value === 'string' ? r.result.value : JSON.stringify(r.result?.value ?? r, null, 1)); ws.close(); } });
