import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localize, revert, readState, status } from '../src/localize.js';
import { vscodeChecksum } from '../src/patch.js';
import { readLocale } from '../src/langpack.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REL = 'resources/app/out/vs/workbench/workbench.desktop.main.js';
const KEY = 'vs/workbench/workbench.desktop.main.js';
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));

async function setup({ js = 'a="Cursor Settings";b="New Agent";', version = 'test-fixture' } = {}) {
  const root = await tmp('inst-');
  await fs.mkdir(path.dirname(path.join(root, REL)), { recursive: true });
  await fs.writeFile(path.join(root, REL), js);
  const product = { version, commit: 'c0ffee', vscodeVersion: '1.128.0', checksums: { [KEY]: vscodeChecksum(Buffer.from(js)) } };
  await fs.writeFile(path.join(root, 'resources/app/product.json'), JSON.stringify(product, null, '\t') + '\n');
  const home = await tmp('home-');
  const cliDir = await tmp('cli-');
  const cliPath = path.join(cliDir, 'cursor');
  await fs.writeFile(cliPath, `#!/bin/sh
ext=""; while [ $# -gt 0 ]; do case "$1" in --extensions-dir) ext="$2"; shift;; --install-extension) mode=i;; --uninstall-extension) mode=u;; esac; shift; done
[ "$mode" = i ] && mkdir -p "$ext/ms-ceintl.vscode-language-pack-zh-hans-1.128.0" && printf '%s' '{"name":"vscode-language-pack-zh-hans","publisher":"MS-CEINTL","version":"1.128.0","contributes":{"localizations":[{"languageId":"zh-cn","localizedLanguageName":"中文(简体)","translations":[{"id":"vscode","path":"./translations/main.i18n.json"}]}]}}' > "$ext/ms-ceintl.vscode-language-pack-zh-hans-1.128.0/package.json"
[ "$mode" = u ] && rm -rf "$ext"/ms-ceintl.vscode-language-pack-zh-hans-*
exit 0
`, { mode: 0o755 });
  const opts = {
    installRoot: root, platform: 'linux', cliPath, vsixPath: '/fake.vsix',
    userDataDir: path.join(home, '.config/Cursor'), extensionsDir: path.join(home, '.cursor/extensions'),
    argvPath: path.join(home, '.cursor/argv.json'), dataDir: path.join(home, '.config/cursor-zh-localizer'),
    anchorsDir: path.join(repo, 'packages/engine/test/fixtures/anchors'), dictPath: path.join(repo, 'packages/engine/test/fixtures/dict.json'),
    isCursorRunning: async () => false,
  };
  return { root, js, opts };
}
const read = (p) => fs.readFile(p, 'utf8');

describe('localize/revert', () => {
  it('localizes end-to-end and reverts byte-for-byte', async () => {
    const { root, js, opts } = await setup();
    const productBefore = await read(path.join(root, 'resources/app/product.json'));
    const logs = [];
    const r = await localize({ ...opts, onLog: (m) => logs.push(m) });
    assert.equal(r.ok, true, r.error);
    const out = await read(path.join(root, REL));
    assert.match(out, /"Cursor 设置"/);
    assert.match(out, /CURSOR_ZH_DOM_BEGIN/);
    const product = JSON.parse(await read(path.join(root, 'resources/app/product.json')));
    assert.equal(product.checksums[KEY], vscodeChecksum(Buffer.from(out)));
    assert.equal(await readLocale(opts.argvPath), 'zh-cn');
    assert.equal((await readState(opts.dataDir)).localized, true);
    assert.ok(logs.length > 3);
    // 语言包当场登记进 languagepacks.json：第一次重启就能生成中文 NLS 缓存（原生菜单变中文）
    const lpFile = path.join(opts.userDataDir, 'languagepacks.json');
    const packs = JSON.parse(await read(lpFile));
    assert.equal(packs['zh-cn'].hash, 'e847c90f9aa805971f169edf104a4233');
    assert.match(packs['zh-cn'].translations.vscode, /ms-ceintl\.vscode-language-pack-zh-hans-1\.128\.0\/translations\/main\.i18n\.json$/);

    const again = await localize(opts);
    assert.equal(again.ok, true, 'localizing twice is a no-op success');
    assert.equal(again.already, true);
    assert.equal(await read(path.join(root, REL)), out, 'second localize changes nothing');

    const rv = await revert(opts);
    assert.equal(rv.ok, true, rv.error);
    assert.equal(await read(path.join(root, REL)), js);
    assert.equal(await read(path.join(root, 'resources/app/product.json')), productBefore);
    assert.equal(await readLocale(opts.argvPath), null);
    assert.deepEqual(await fs.readdir(opts.extensionsDir), []);
    assert.deepEqual(JSON.parse(await read(path.join(opts.userDataDir, 'languagepacks.json'))), {});
    assert.equal((await readState(opts.dataDir)).localized, false);
  });

  it('re-patches from the pristine backup when the dictionary changes (tool upgrade), without reverting first', async () => {
    const { root, js, opts } = await setup();
    const dir = await tmp('dict-');
    const dictPath = path.join(dir, 'dict.json');
    const base = JSON.parse(await read(opts.dictPath));
    await fs.writeFile(dictPath, JSON.stringify(base));
    const o = { ...opts, dictPath };
    assert.equal((await localize(o)).ok, true);
    const first = await read(path.join(root, REL));
    const prevLocaleState = (await readState(opts.dataDir)).prevLocale;
    assert.equal((await status({ ...o, light: true })).upToDate, true);
    await fs.writeFile(dictPath, JSON.stringify({ ...base, 'New Agent': '新建智能体X' }));
    assert.equal((await status({ ...o, light: true })).upToDate, false, 'status tells the GUI an update is available');
    const logs = [];
    const r = await localize({ ...o, onLog: (m) => logs.push(m) });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.refreshed, true);
    const second = await read(path.join(root, REL));
    assert.notEqual(second, first);
    assert.match(second, /新建智能体X/);
    assert.equal(second.split('CURSOR_ZH_DOM_BEGIN').length - 1, 1, 'patched once, from the pristine copy');
    const product = JSON.parse(await read(path.join(root, 'resources/app/product.json')));
    assert.equal(product.checksums[KEY], vscodeChecksum(Buffer.from(second)));
    const st = await readState(opts.dataDir);
    assert.equal(st.localized, true);
    assert.equal(st.prevLocale, prevLocaleState, 'original locale still remembered for revert');
    assert.equal((await localize(o)).already, true, 'then idempotent again');
    assert.equal((await revert(o)).ok, true);
    assert.equal(await read(path.join(root, REL)), js, 'revert still restores the original bytes');
    assert.equal(await readLocale(opts.argvPath), null);
  });

  it('patches untranslated NLS messages, clears the translation cache, and restores both on revert', async () => {
    const { root, opts } = await setup({ version: 'test-nls' });
    const nls = path.join(root, 'resources/app/out/nls.messages.json');
    const nlsBefore = JSON.stringify(['OK', '&&Edit']);
    await fs.writeFile(nls, nlsBefore);
    const cache = path.join(opts.userDataDir, 'clp/abc.zh-cn/c0ffee');
    await fs.mkdir(cache, { recursive: true });
    const r = await localize(opts);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(JSON.parse(await read(nls)), ['OK', '编辑(&&E)']);
    await assert.rejects(fs.access(cache));
    await fs.mkdir(cache, { recursive: true });
    assert.equal((await revert(opts)).ok, true);
    assert.equal(await read(nls), nlsBefore);
    await assert.rejects(fs.access(cache));
  });

  it('refuses unknown versions without touching anything', async () => {
    const { root, js, opts } = await setup({ version: '0.0.1' });
    const r = await localize(opts);
    assert.equal(r.ok, false);
    assert.match(r.error, /暂未适配/);
    assert.equal(await read(path.join(root, REL)), js);
    assert.equal(await readLocale(opts.argvPath), null);
  });

  it('rolls back everything when a required anchor is missing', async () => {
    const { root, js, opts } = await setup({ js: 'b="New Agent";' });
    const r = await localize(opts);
    assert.equal(r.ok, false);
    assert.equal(r.restored, true);
    assert.match(r.error, /必需锚点缺失/);
    assert.equal(await read(path.join(root, REL)), js);
    assert.equal(await readLocale(opts.argvPath), null);
    // 补丁在暂存区算失败，语言包根本没装
    assert.deepEqual(await fs.readdir(opts.extensionsDir).catch(() => []), []);
  });

  it('refuses while Cursor is running', async () => {
    const { opts } = await setup();
    const r = await localize({ ...opts, isCursorRunning: async () => true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CURSOR_RUNNING');
    assert.match(r.error, /Cursor 正在运行/);
  });

  it('treats a "localized" state whose install was wiped/reinstalled as stale and re-localizes', async () => {
    const { root, js, opts } = await setup();
    const productBefore = await read(path.join(root, 'resources/app/product.json'));
    assert.equal((await localize(opts)).ok, true);
    // 模拟重装：安装文件回到原版，state/备份/语言包/locale 都还在
    await fs.writeFile(path.join(root, REL), js);
    await fs.writeFile(path.join(root, 'resources/app/product.json'), productBefore);
    const st = await status(opts);
    assert.equal(st.stale, true);
    assert.equal(st.localized, false);
    assert.equal(st.patched, false);

    const r = await localize(opts);
    assert.equal(r.ok, true, r.error);
    assert.match(await read(path.join(root, REL)), /"Cursor 设置"/);
    const backups = await fs.readdir(path.join(opts.dataDir, 'backups'));
    assert.ok(backups.some((b) => b.includes('.stale-')), backups.join());
    const s2 = await readState(opts.dataDir);
    assert.equal(s2.prevLocale, null); // 记住的是最初的 locale，不是过期记录留下的 zh-cn
    assert.equal(s2.installedLangpack, true);

    assert.equal((await revert(opts)).ok, true);
    assert.equal(await read(path.join(root, REL)), js);
    assert.equal(await read(path.join(root, 'resources/app/product.json')), productBefore);
    assert.equal(await readLocale(opts.argvPath), null);
    // 补丁在暂存区算失败，语言包根本没装
    assert.deepEqual(await fs.readdir(opts.extensionsDir).catch(() => []), []);
  });

  it('revert with stale state never overwrites the new install with old backups', async () => {
    const { root, opts } = await setup();
    assert.equal((await localize(opts)).ok, true);
    const fresh = 'a="Cursor Settings";/*new build*/';
    await fs.writeFile(path.join(root, REL), fresh);
    const rv = await revert(opts);
    assert.equal(rv.ok, true, rv.error);
    assert.equal(await read(path.join(root, REL)), fresh);
    assert.equal(await readLocale(opts.argvPath), null);
    assert.deepEqual(await fs.readdir(opts.extensionsDir), []);
    assert.equal((await readState(opts.dataDir)).localized, false);
  });

  it('refuses to back up files that already carry the patch without a state record', async () => {
    const { root, opts } = await setup();
    assert.equal((await localize(opts)).ok, true);
    await fs.rm(path.join(opts.dataDir, 'state.json'));
    const patched = await read(path.join(root, REL));
    const r = await localize(opts);
    assert.equal(r.ok, false);
    assert.match(r.error, /已带汉化补丁/);
    assert.equal(await read(path.join(root, REL)), patched);
  });
  // macOS 上关闭 Cursor 时自动更新刚好装上：记录的版本号和 product.json 对不上，但文件仍是我们的补丁
  it('a patched install whose version no longer matches the record is NOT stale; revert restores the backup', async () => {
    const { root, js, opts } = await setup();
    const pj = path.join(root, 'resources/app/product.json');
    const productBefore = await read(pj);
    assert.equal((await localize(opts)).ok, true);
    const p = JSON.parse(await read(pj)); p.version = 'test-nls';
    await fs.writeFile(pj, JSON.stringify(p));
    const st = await status(opts);
    assert.equal(st.stale, false);
    assert.equal(st.localized, true);
    const rv = await revert(opts);
    assert.equal(rv.ok, true, rv.error);
    assert.equal(rv.stale, false);
    assert.equal(await read(path.join(root, REL)), js);
    assert.equal(await read(pj), productBefore);
    assert.equal(await readLocale(opts.argvPath), null);
    assert.deepEqual(await fs.readdir(opts.extensionsDir), []);
  });

  it('recovers from a .stale-* backup when an old version retired the record but left patched files', async () => {
    const { root, js, opts } = await setup();
    const pj = path.join(root, 'resources/app/product.json');
    const productBefore = await read(pj);
    assert.equal((await localize(opts)).ok, true);
    // 旧版 revert 的误判：备份挪成 .stale-*，语言包/locale 清掉，state 写成未汉化，安装文件没动
    const b = path.join(opts.dataDir, 'backups');
    const [dir] = await fs.readdir(b);
    await fs.rename(path.join(b, dir), path.join(b, `${dir}.stale-2026-10-29T00-00-00-000Z`));
    await fs.writeFile(path.join(opts.dataDir, 'state.json'), JSON.stringify({ localized: false, revertedAt: 'x' }));
    const patched = await read(path.join(root, REL));

    // 备份被篡改 → 拒绝，安装文件不动
    const bad = await tmp('bad-');
    await fs.cp(path.join(b, `${dir}.stale-2026-10-29T00-00-00-000Z`), bad, { recursive: true });
    await fs.appendFile(path.join(bad, 'files', REL), 'x');
    const r0 = await revert({ ...opts, fromBackup: bad });
    assert.equal(r0.code, 'BACKUP_INVALID');
    assert.equal(await read(path.join(root, REL)), patched);

    const rv = await revert(opts);
    assert.equal(rv.ok, true, rv.error);
    assert.match(rv.recovered, /\.stale-/);
    assert.equal(await read(path.join(root, REL)), js);
    assert.equal(await read(pj), productBefore);
    assert.equal((await revert(opts)).code, 'NOT_LOCALIZED');
    // 恢复后能正常重新汉化
    assert.equal((await localize(opts)).ok, true);
  });

  it('aborts localize when the install changes while Cursor is being closed (auto-update race)', async () => {
    const { root, js, opts } = await setup();
    const pj = path.join(root, 'resources/app/product.json');
    const r = await localize({
      ...opts, closeRunning: true, isCursorRunning: undefined, listRunning: async () => [{ pid: 1, main: true }],
      closeCursor: async () => { const p = JSON.parse(await read(pj)); p.version = '9.9.9'; await fs.writeFile(pj, JSON.stringify(p)); return { ok: true, relaunch: null }; },
    });
    assert.equal(r.code, 'INSTALL_CHANGED', r.error);
    assert.equal(await read(path.join(root, REL)), js);
    assert.deepEqual(await fs.readdir(path.join(opts.dataDir, 'backups')).catch(() => []), []);
    assert.equal((await readState(opts.dataDir)).localized, false);
  });
});
