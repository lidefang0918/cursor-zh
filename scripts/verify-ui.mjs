// 用系统 Chrome + Playwright 渲染正式 apps/desktop/index.html。
// mock window.engine 仅在本脚本注入，不进入产品代码。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE || 'playwright';
let chromium;
try {
  ({ chromium } = await import(playwrightPath.startsWith('/') || playwrightPath.startsWith('file:')
    ? pathToFileURL(playwrightPath).href
    : playwrightPath));
} catch (e) {
  console.error('需要 Playwright。设置 PLAYWRIGHT_MODULE 为可导入路径，或安装 playwright。', e.message);
  process.exit(2);
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageUrl = 'file://' + path.join(repo, 'apps/desktop/index.html');
const outDir = path.join(repo, 'docs/images/ui-progressive');
const imgDir = path.join(repo, 'docs/images');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const pass = (name, d = '') => results.push({ name, ok: true, d });
const fail = (name, d) => results.push({ name, ok: false, d });
const assert = (name, cond, d) => { if (cond) pass(name, d); else fail(name, d || 'failed'); };

const errors = [];
const pageErrors = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--disable-font-subpixel-positioning', '--no-sandbox'],
});

const statusOf = {
  fresh: {
    cursor: { root: '/Applications/Cursor.app', version: '3.29.9', vscodeVersion: '1.105.1' },
    supported: true, exact: true, localized: false, stale: false, upToDate: null,
    platform: 'darwin', kind: 'mac-applications', writable: true, readOnlyFs: false,
    needsElevation: false, running: 0, installs: [{ root: '/Applications/Cursor.app', version: '3.29.9' }],
    appImages: [], extracted: [], otherInstall: null, pending: null, state: {},
    supportedVersions: ['3.27.22', '3.28.7', '3.29.9'], mac: { translocated: false, appManagement: false, signMode: 'adhoc' },
  },
  running: null, // filled below
  linux: {
    cursor: { root: '/usr/share/cursor', version: '3.29.9', vscodeVersion: '1.105.1' },
    supported: true, exact: true, localized: false, stale: false, upToDate: null,
    platform: 'linux', kind: 'deb', writable: false, readOnlyFs: false,
    needsElevation: true, running: 0, installs: [{ root: '/usr/share/cursor', version: '3.29.9' }],
    appImages: [], extracted: [], otherInstall: null, pending: null, state: {},
    supportedVersions: ['3.27.22', '3.28.7', '3.29.9'],
    elevation: { pkexec: true, graphical: true },
  },
  localized: {
    cursor: { root: '/Applications/Cursor.app', version: '3.29.9', vscodeVersion: '1.105.1' },
    supported: true, exact: true, localized: true, stale: false, upToDate: true,
    platform: 'darwin', kind: 'mac-applications', writable: true, readOnlyFs: false,
    needsElevation: false, running: 0, installs: [{ root: '/Applications/Cursor.app', version: '3.29.9' }],
    appImages: [], extracted: [], otherInstall: null, pending: null,
    state: { localized: true, at: '2026-11-16T01:20:00.000Z' },
    supportedVersions: ['3.27.22', '3.28.7', '3.29.9'], mac: { translocated: false, appManagement: false, signMode: 'adhoc' },
  },
  error: null,
  compat: {
    cursor: { root: '/Applications/Cursor.app', version: '3.30.0', vscodeVersion: '1.105.1' },
    supported: true, exact: false, compatBase: '3.29.9', localized: false, stale: false, upToDate: null,
    platform: 'darwin', kind: 'mac-applications', writable: true, readOnlyFs: false,
    needsElevation: false, running: 0, installs: [{ root: '/Applications/Cursor.app', version: '3.30.0' }],
    appImages: [], extracted: [], otherInstall: null, pending: null, state: {},
    supportedVersions: ['3.27.22', '3.28.7', '3.29.9'], mac: { translocated: false, appManagement: false, signMode: 'adhoc' },
  },
};
statusOf.running = { ...statusOf.fresh, running: 1 };
statusOf.error = { ...statusOf.linux, needsElevation: false, writable: true, kind: 'manual', cursor: { root: '/opt/cursor', version: '3.29.9', vscodeVersion: '1.105.1' }, installs: [{ root: '/opt/cursor', version: '3.29.9' }] };

function engineInit({ scene, theme, platform, hang } = {}) {
  return `(function () {
    const scene = ${JSON.stringify(scene || 'fresh')};
    const theme = ${JSON.stringify(theme || '')};
    if (theme) localStorage.setItem('czl-theme', theme);
    const table = ${JSON.stringify(statusOf)};
    const status = table[scene] || table.fresh;
    const hang = ${hang ? 'true' : 'false'};
    let hanging;
    window.engine = {
      platform: ${JSON.stringify(platform || status.platform || 'darwin')},
      getStatus: async () => status,
      localize: async (o) => {
        if (hang) { await new Promise(() => {}); }
        if (scene === 'error') return { ok: false, code: 'PATCH_FAILED', error: '写入失败', next: '安装文件没有被改动。请把日志文件发给开发者。', restored: true };
        return { ok: true };
      },
      revert: async () => ({ ok: true }),
      extractAppImage: async () => ({ ok: false, error: '不可用' }),
      copy: async () => true,
      showLog: async () => '/tmp/cursor-zh-localizer/gui.log',
      onLog: (cb) => { window.__czlOnLog = cb; },
    };
  })();`;
}

async function openPage({ width = 820, height = 720, scene = 'fresh', theme = 'light', platform, hang = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(engineInit({ scene, theme, platform, hang }));
  await page.goto(pageUrl + `?scene=${scene}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(150);
  return { context, page };
}

async function shot(page, name, sel = 'body') {
  const dest = path.join(outDir, name);
  const el = sel ? page.locator(sel).first() : null;
  if (sel && el) await el.screenshot({ path: dest });
  else await page.screenshot({ path: dest, fullPage: true });
  return dest;
}

async function noOverflow(page, name) {
  const data = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  assert(name + ' 无横向溢出', data.sw <= data.cw + 1 && data.bw <= data.cw + 1, JSON.stringify(data));
}

function toWebp(png, webp) {
  const r = spawnSync('ffmpeg', ['-y', '-i', png, '-quality', '80', webp], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'ffmpeg webp failed');
}

// light default
{
  const { context, page } = await openPage({ scene: 'fresh', theme: 'light', platform: 'darwin' });
  await shot(page, 'light-default.png', 'body');
  const body = await page.locator('body').innerText();
  assert('浅色默认还未汉化', body.includes('还未汉化'));
  assert('浅色默认 3.29.9 已适配', body.includes('3.29.9') && body.includes('已适配'));
  assert('浅色默认无堆叠说明书', !body.includes('需要管理员权限') && !body.includes('与 Cursor 官方无关'));
  await noOverflow(page, '浅色默认');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    const s = getComputedStyle(el);
    return { id: el?.id, outline: s.outlineStyle, w: s.outlineWidth };
  });
  assert('Tab 焦点可见', outline.outline !== 'none' && parseFloat(outline.w) >= 2, JSON.stringify(outline));
  await context.close();
}

// dark default
{
  const { context, page } = await openPage({ scene: 'fresh', theme: 'dark', platform: 'darwin' });
  await shot(page, 'dark-default.png', 'body');
  assert('深色主题已应用', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark');
  await noOverflow(page, '深色默认');
  await context.close();
}

// mac confirm
{
  const { context, page } = await openPage({ scene: 'fresh', theme: 'light', platform: 'darwin' });
  await page.click('#localize');
  await page.waitForSelector('#overlay:not([hidden])');
  const t = await page.locator('#dialog').innerText();
  assert('授权确认含钥匙串与 ad-hoc 说明', t.includes('系统钥匙串') && t.includes('ad-hoc'));
  assert('授权确认含尚未完全修复', t.includes('尚未完全修复'));
  await shot(page, 'auth-confirm.png', null);
  await page.keyboard.press('Escape');
  assert('Escape 关闭授权确认', await page.locator('#overlay').evaluate((e) => e.hidden));
  await context.close();
}

// running + quit
{
  const { context, page } = await openPage({ scene: 'running', theme: 'light', platform: 'darwin' });
  assert('运行中一行状态', (await page.locator('#running-line').innerText()).includes('Cursor 正在运行'));
  await shot(page, 'running.png', 'body');
  await page.click('#localize');
  const t = await page.locator('#dialog').innerText();
  assert('退出确认含保存与 ⌘Q', t.includes('保存') && t.includes('⌘Q'));
  await shot(page, 'quit-confirm.png', null);
  await context.close();
}

// error retry
{
  const { context, page } = await openPage({ scene: 'error', theme: 'light', platform: 'linux' });
  await page.click('#localize');
  await page.waitForFunction(() => document.getElementById('localize')?.textContent.includes('重试'));
  const body = await page.locator('body').innerText();
  assert('失败主操作是重试', body.includes('重试') && body.includes('下一步'));
  await shot(page, 'error.png', 'body');
  await context.close();
}

// details + localized + compat
{
  const { context, page } = await openPage({ scene: 'fresh', theme: 'light', platform: 'darwin' });
  await page.click('#toggle-details');
  assert('详情含路径', (await page.locator('#details').innerText()).includes('/Applications/Cursor.app'));
  await shot(page, 'details.png', 'body');
  await context.close();
}
{
  const { context, page } = await openPage({ scene: 'localized', theme: 'light', platform: 'darwin' });
  await page.evaluate(() => { const n = document.getElementById('success-note'); if (n) n.hidden = false; });
  await shot(page, 'localized.png', 'body');
  const revertOn = await page.locator('#revert').isVisible();
  const locHidden = await page.locator('#localize').evaluate((e) => e.hidden);
  assert('已汉化显示还原', revertOn && locHidden, `revert=${revertOn} localizeHidden=${locHidden}`);
  await context.close();
}
{
  const { context, page } = await openPage({ scene: 'compat', theme: 'light', platform: 'darwin' });
  await shot(page, 'compat.png', 'body');
  assert('兼容模式可见', (await page.locator('body').innerText()).includes('还没有专门适配') || (await page.locator('body').innerText()).includes('兼容模式'));
  await context.close();
}

// busy lock
{
  const { context, page } = await openPage({ scene: 'error', theme: 'light', platform: 'linux', hang: true });
  await page.click('#localize');
  await page.waitForFunction(() => document.getElementById('localize')?.disabled);
  assert('忙碌锁定主按钮', await page.locator('#localize').isDisabled());
  assert('忙碌锁定刷新', await page.locator('#refresh').isDisabled());
  await shot(page, 'busy.png', 'body');
  await context.close();
}

// narrow
{
  const { context, page } = await openPage({ width: 640, height: 900, scene: 'fresh', theme: 'light', platform: 'darwin' });
  await shot(page, 'narrow.png', 'body');
  await noOverflow(page, '窄窗');
  await context.close();
}

await browser.close();
assert('console error 为 0', errors.length === 0, errors.join('\n') || '0');
assert('pageerror 为 0', pageErrors.length === 0, pageErrors.join('\n') || '0');

// README webps from formal UI (no usernames)
toWebp(path.join(outDir, 'localized.png'), path.join(imgDir, 'app-localized.webp'));
toWebp(path.join(outDir, 'light-default.png'), path.join(imgDir, 'app-reverted.webp'));
toWebp(path.join(outDir, 'quit-confirm.png'), path.join(imgDir, 'app-confirm-close.webp'));

const failed = results.filter((r) => !r.ok);
const lines = [
  '# UI Playwright 验证',
  '',
  '时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '（Asia/Shanghai）',
  '对象：正式 `apps/desktop/index.html`（mock `window.engine` 仅由本脚本注入）。',
  '',
  `通过 ${results.filter((r) => r.ok).length} / ${results.length}，失败 ${failed.length}。`,
  '',
  ...results.map((r) => `- [${r.ok ? 'x' : ' '}] ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.d ? ' — ' + r.d : ''}`),
  '',
  '截图目录：`docs/images/ui-progressive/`',
];
if (failed.length) lines.push('', '失败：', ...failed.map((f) => `- ${f.name}: ${f.d}`));
fs.writeFileSync(path.join(outDir, 'VERIFY.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(failed.length ? 1 : 0);
