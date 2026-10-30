// 把 Electron 版界面（apps/desktop/index.html + renderer.js）同步到 Tauri 版（apps/tauri/ui/）：
//   - 去掉 index.html 里的 CSP meta（Tauri 版的 CSP 在 tauri.conf.json 里，由 Tauri 注入，并放行它自己的 IPC）
//   - 在 renderer.js 之前插入 tauri-bridge.js（用 Tauri invoke/事件实现和 preload.cjs 一样的 window.engine）
// 用法：node scripts/sync-tauri-ui.mjs [--check]   --check：只检查是否已同步（测试用），不写文件
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(repo, 'apps/desktop');
const dst = path.join(repo, 'apps/tauri/ui');

export function tauriHtml(html) {
  const out = html
    .replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<script src="renderer.js"></script>', '<script src="tauri-bridge.js"></script>\n  <script src="renderer.js"></script>');
  if (out.includes('Content-Security-Policy') || !out.includes('tauri-bridge.js')) throw new Error('index.html 结构变了，sync-tauri-ui 需要更新');
  return out;
}

export function expected() {
  return {
    'index.html': tauriHtml(fs.readFileSync(path.join(src, 'index.html'), 'utf8')),
    'renderer.js': fs.readFileSync(path.join(src, 'renderer.js'), 'utf8'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = [];
  for (const [name, text] of Object.entries(expected())) {
    const p = path.join(dst, name);
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (cur === text) continue;
    stale.push(name);
    if (!check) { fs.mkdirSync(dst, { recursive: true }); fs.writeFileSync(p, text); }
  }
  if (check && stale.length) { console.error(`apps/tauri/ui 未同步：${stale.join(', ')}（运行 node scripts/sync-tauri-ui.mjs）`); process.exit(1); }
  console.log(stale.length ? `${check ? '未同步' : '已同步'}：${stale.join(', ')}` : 'apps/tauri/ui 已是最新');
}
