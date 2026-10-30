// Tauri 版界面（apps/tauri/ui）必须与 Electron 版（apps/desktop）同步，且 window.engine 接口一致
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expected, tauriHtml } from '../../../scripts/sync-tauri-ui.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

describe('tauri ui', () => {
  it('apps/tauri/ui 与 apps/desktop 同步（不同步请运行 node scripts/sync-tauri-ui.mjs）', () => {
    for (const [name, text] of Object.entries(expected())) assert.equal(read(`apps/tauri/ui/${name}`), text, name);
  });
  it('去掉 HTML 里的 CSP（交给 tauri.conf.json），并在 renderer.js 前加载桥接脚本', () => {
    const h = tauriHtml(read('apps/desktop/index.html'));
    assert.doesNotMatch(h, /Content-Security-Policy/);
    assert.ok(h.indexOf('tauri-bridge.js') < h.indexOf('renderer.js'));
    const conf = JSON.parse(read('apps/tauri/src-tauri/tauri.conf.json'));
    assert.match(conf.app.security.csp, /default-src 'self'/);
    assert.match(conf.app.security.csp, /ipc:/);
  });
  it('桥接脚本提供与 preload.cjs 相同的 window.engine 方法', () => {
    const names = (src) => [...src.matchAll(/^\s+(\w+)[:,]/gm)].map((m) => m[1]);
    const pre = names(read('apps/desktop/preload.cjs'));
    const bridge = new Set(names(read('apps/tauri/ui/tauri-bridge.js')));
    for (const n of pre) assert.ok(bridge.has(n), `tauri-bridge.js 缺少 ${n}`);
  });
  it('Rust 外壳里的引擎操作名与 engine-ipc.mjs 一致', () => {
    const ops = [...read('scripts/engine-ipc.mjs').matchAll(/^  (\w+): /gm)].map((m) => m[1]).sort();
    const rs = read('apps/tauri/src-tauri/src/main.rs').match(/matches!\(op\.as_str\(\), ([^)]*)\)/)[1];
    assert.deepEqual([...rs.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(), ops);
  });
  it('构建时嵌入的文件都存在', () => {
    const rs = read('apps/tauri/src-tauri/build.rs');
    const list = rs.match(/for rel in \[([^\]]*)\]/)[1];
    for (const [, rel] of list.matchAll(/"([^"]+)"/g)) assert.ok(fs.existsSync(path.join(repo, rel)), rel);
  });
});
