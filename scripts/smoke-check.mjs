// 真机冒烟检查（CI 的 platform-smoke.yml 和手工测试都用）。只读，不改任何文件。
// 用法：
//   node scripts/smoke-check.mjs pristine  <安装根> <platform>   三个补丁文件与官方原版 sha256 一致（未汉化 / 已完整还原）
//   node scripts/smoke-check.mjs checksums <安装根> <platform>   product.json 里所有 checksums 与磁盘文件一致（Cursor 不会报“安装已损坏”）
//   node scripts/smoke-check.mjs patched   <安装根> <platform>   补丁文件已不是原版，且含中文
//   node scripts/smoke-check.mjs ui <调试端口> [超时秒=90]         等工作台窗口出现，检查界面里有中文、没有“损坏”提示
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { loadAnchors } from '../packages/engine/src/anchors.js';
import { fileURLToPath } from 'node:url';
import { appPrefix } from '../packages/engine/src/index.js';

const anchorsDir = fileURLToPath(new URL('../anchors', import.meta.url));

const [mode, a1, a2] = process.argv.slice(2);
const fail = (m) => { console.error(`✖ ${m}`); process.exit(1); };
const ok = (m) => console.log(`✔ ${m}`);
const sha = async (p) => crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');

async function product(root, platform) {
  return JSON.parse(await fs.readFile(path.join(root, appPrefix(platform), 'product.json'), 'utf8'));
}

if (mode === 'pristine' || mode === 'patched') {
  const p = await product(a1, a2);
  const anchors = await loadAnchors({ version: p.version, platform: a2, anchorsDir });
  if (!anchors.pristine) fail(`锚点 ${p.version} 没有 pristine`);
  for (const [rel, want] of Object.entries(anchors.pristine)) {
    const got = await sha(path.join(a1, rel));
    if (mode === 'pristine' && got !== want) fail(`${rel} 不是官方原版：${got}`);
    if (mode === 'patched' && got === want) fail(`${rel} 仍是原版，没有汉化`);
    ok(`${rel} ${mode === 'pristine' ? '= 原版' : '已改动'}`);
  }
  if (mode === 'patched') {
    const js = await fs.readFile(path.join(a1, appPrefix(a2), 'out/vs/workbench/workbench.desktop.main.js'), 'utf8');
    if (!/[\u4e00-\u9fff]{2}/.test(js)) fail('workbench.desktop.main.js 里没有中文');
    ok('workbench.desktop.main.js 含中文');
  }
} else if (mode === 'checksums') {
  const p = await product(a1, a2);
  const out = path.join(a1, appPrefix(a2), 'out');
  for (const [k, v] of Object.entries(p.checksums ?? {})) {
    const got = crypto.createHash('sha256').update(await fs.readFile(path.join(out, k))).digest('base64').replace(/=+$/, '');
    if (got !== v) fail(`checksum 不符：${k}`);
    ok(`checksum ${k}`);
  }
} else if (mode === 'ui') {
  const port = Number(a1);
  const deadline = Date.now() + Number(a2 ?? 90) * 1000;
  let text = '';
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && /workbench/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
        text = await new Promise((r) => {
          ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result?.result?.value ?? ''); });
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.body ? document.body.innerText : ""', returnByValue: true } }));
        });
        ws.close();
        if (/[\u4e00-\u9fff]{2}/.test(text)) break;
      }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (/corrupt|已损坏/i.test(text)) fail('界面出现“安装已损坏”提示');
  if (!/[\u4e00-\u9fff]{2}/.test(text)) fail(`超时：界面里没有中文。前 300 字：${text.slice(0, 300)}`);
  ok(`界面已是中文：${text.replace(/\s+/g, ' ').slice(0, 120)}`);
} else {
  fail('用法见文件头注释');
}
