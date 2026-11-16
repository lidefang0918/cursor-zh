import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repo } from './helpers/ui-dom-harness.mjs';

const desktopDir = path.join(repo, 'apps/desktop');
const probePy = path.join(repo, 'packages/engine/test/helpers/ui-layout-probe.py');

const missingStatus = {
  ok: true,
  cursor: null,
  supported: false,
  exact: false,
  compatBase: null,
  supportedVersions: ['3.27.22', '3.28.7', '3.29.9'],
  state: { localized: true, at: '2026-10-30T02:45:40.824Z', version: '3.27.22', installRoot: '/usr/share/cursor' },
  patched: false,
  stale: false,
  localized: false,
  upToDate: null,
  platform: 'linux',
  kind: null,
  writable: false,
  readOnlyFs: false,
  needsElevation: false,
  elevation: { pkexec: false, graphical: false },
  running: 0,
  installs: [],
  appImages: [],
  extracted: [],
  otherInstall: null,
  pending: null,
};

const foundStatus = {
  ...missingStatus,
  cursor: { root: '/opt/cursor', version: '3.29.9', vscodeVersion: '1.128.0' },
  supported: true,
  exact: true,
  state: {},
  kind: 'manual',
  writable: true,
  installs: [{ root: '/opt/cursor', version: '3.29.9' }],
};

function fixtureFor(status, platform = 'linux') {
  const html = fs.readFileSync(path.join(desktopDir, 'index.html'), 'utf8');
  // 正式页有 CSP default-src 'self'，内联 mock 会被挡住；外置同源脚本即可。
  const mockJs = `window.engine = {
  platform: ${JSON.stringify(platform)},
  getStatus: async () => (${JSON.stringify(status)}),
  localize: async () => ({ ok: true }),
  revert: async () => ({ ok: true }),
  extractAppImage: async () => ({ ok: false, error: '不可用' }),
  copy: async () => true,
  showLog: async () => '/tmp/cursor-zh-localizer/gui.log',
  pickRoot: async () => null,
  onLog: () => {},
};`;
  const out = html.replace('<script src="renderer.js"></script>', '<script src="engine-mock.js"></script>\n  <script src="renderer.js"></script>');
  if (out === html) throw new Error('未能在 index.html 中插入布局探测脚本');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czl-ui-layout-'));
  fs.copyFileSync(path.join(desktopDir, 'renderer.js'), path.join(dir, 'renderer.js'));
  fs.writeFileSync(path.join(dir, 'engine-mock.js'), mockJs);
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, out);
  return { dir, file };
}

function pathToFileUrl(p) {
  return 'file://' + path.resolve(p);
}

function measureWebKit(htmlFile) {
  const r = spawnSync('python3', [probePy, '--html', htmlFile, '--wait-ms', '500'], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 15000,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || r.error?.message || '').trim();
    return { ok: false, error: err || `webkit probe exit ${r.status}` };
  }
  try { return { ok: true, data: JSON.parse(r.stdout) }; }
  catch (e) { return { ok: false, error: `bad json: ${r.stdout}\n${e.message}` }; }
}

function measureChromeFixture(status, platform = 'linux') {
  const chrome = process.env.CHROME_PATH || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
  if (!chrome) return { ok: false, error: 'no chrome' };
  const { file, dir } = fixtureFor(status, platform);
  const probeJs = `window.addEventListener('load', () => {
    const collect = () => {
      const ids = ['toggle-details', 'toggle-log', 'details', 'revert', 'localize'];
      const out = { ids: {} };
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) { out.ids[id] = null; continue; }
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        out.ids[id] = {
          hiddenAttr: el.hasAttribute('hidden'),
          hiddenProp: !!el.hidden,
          display: cs.display,
          visibility: cs.visibility,
          offsetHeight: el.offsetHeight,
          offsetWidth: el.offsetWidth,
          rectH: r.height,
          rectW: r.width,
        };
      }
      out.statusTitle = (document.getElementById('status-title') || {}).textContent || '';
      return out;
    };
    const start = Date.now();
    const tick = () => {
      const out = collect();
      if ((out.statusTitle && out.statusTitle !== '检测中…') || Date.now() - start > 3000) {
        const pre = document.createElement('pre');
        pre.id = 'layout-probe-json';
        pre.textContent = JSON.stringify(out);
        document.body.appendChild(pre);
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });`;
  fs.writeFileSync(path.join(dir, 'layout-probe.js'), probeJs);
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace('</body>', '<script src="layout-probe.js"></script></body>');
  fs.writeFileSync(file, html);
  const r = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=3000', '--dump-dom', pathToFileUrl(file),
  ], { encoding: 'utf8', timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').slice(-800) };
  const m = (r.stdout || '').match(/<pre id="layout-probe-json">([^<]*)<\/pre>/);
  if (!m) return { ok: false, error: 'chrome dump missing probe json' };
  try { return { ok: true, data: JSON.parse(m[1].replace(/&quot;/g, '"')) }; }
  catch (e) { return { ok: false, error: e.message + ' ' + m[1] }; }
}

function measure(status, platform = 'linux') {
  const { file, dir } = fixtureFor(status, platform);
  const webkit = measureWebKit(file);
  fs.rmSync(dir, { recursive: true, force: true });
  const chrome = measureChromeFixture(status, platform);
  const engines = [];
  if (webkit.ok) engines.push({ name: 'webkitgtk', data: webkit.data });
  if (chrome.ok) engines.push({ name: 'chrome', data: chrome.data });
  if (!engines.length) {
    throw new Error(`布局探测失败 webkit=${webkit.error} chrome=${chrome.error}`);
  }
  return engines;
}

describe('未找到 Cursor 时详细信息的真实布局', () => {
  it('即使 hidden 属性已设，「详细信息」折叠在 WebKitGTK/Chrome 布局中也不应占位', () => {
    const engines = measure(missingStatus);
    assert.ok(engines.length >= 1);
    for (const { name, data } of engines) {
      assert.match(data.statusTitle, /未找到 Cursor/, `${name} 应为未找到状态`);
      const detailsToggle = data.ids['toggle-details'];
      assert.ok(detailsToggle, `${name} 应仍有 #toggle-details 节点`);
      // 布局级：不能只看 hidden 属性。真实 Tauri/WebKit 里 .fold-toggle{display:flex} 会盖掉 hidden。
      assert.equal(detailsToggle.display, 'none', `${name} 计算样式应为 display:none，实际 ${detailsToggle.display}（hiddenAttr=${detailsToggle.hiddenAttr} height=${detailsToggle.rectH}）`);
      assert.equal(detailsToggle.offsetHeight, 0, `${name} offsetHeight 应为 0，实际 ${detailsToggle.offsetHeight}`);
      assert.equal(detailsToggle.rectH, 0, `${name} 布局高度应为 0，实际 ${detailsToggle.rectH}`);
      const revert = data.ids.revert;
      if (revert) {
        assert.equal(revert.offsetHeight, 0, `${name} 还原英文也不应占位`);
      }
    }
  });

  it('已找到安装时「详细信息」折叠在布局中可见（不误伤其它情境）', () => {
    const engines = measure(foundStatus);
    for (const { name, data } of engines) {
      assert.match(data.statusTitle, /还未汉化/, `${name} 应为还未汉化，实际 ${data.statusTitle}`);
      const detailsToggle = data.ids['toggle-details'];
      assert.ok(detailsToggle, `${name} 应有 #toggle-details`);
      assert.notEqual(detailsToggle.display, 'none', `${name} 找到安装后详细信息应参与布局`);
      assert.ok(detailsToggle.offsetHeight > 0, `${name} 详细信息折叠应有高度，实际 ${detailsToggle.offsetHeight}`);
      const logToggle = data.ids['toggle-log'];
      assert.ok(logToggle && logToggle.offsetHeight > 0, `${name} 日志折叠应保持可见`);
    }
  });
});
