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
    assert.equal(again.ok, false);
    assert.match(again.error, /已汉化/);

    const rv = await revert(opts);
    assert.equal(rv.ok, true, rv.error);
    assert.equal(await read(path.join(root, REL)), js);
    assert.equal(await read(path.join(root, 'resources/app/product.json')), productBefore);
    assert.equal(await readLocale(opts.argvPath), null);
    assert.deepEqual(await fs.readdir(opts.extensionsDir), []);
    assert.deepEqual(JSON.parse(await read(path.join(opts.userDataDir, 'languagepacks.json'))), {});
    assert.equal((await readState(opts.dataDir)).localized, false);
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
});
