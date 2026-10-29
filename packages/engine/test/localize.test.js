import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localize, revert, readState } from '../src/localize.js';
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
  const product = { version, vscodeVersion: '1.128.0', checksums: { [KEY]: vscodeChecksum(Buffer.from(js)) } };
  await fs.writeFile(path.join(root, 'resources/app/product.json'), JSON.stringify(product, null, '\t') + '\n');
  const home = await tmp('home-');
  const cliDir = await tmp('cli-');
  const cliPath = path.join(cliDir, 'cursor');
  await fs.writeFile(cliPath, `#!/bin/sh
ext=""; while [ $# -gt 0 ]; do case "$1" in --extensions-dir) ext="$2"; shift;; --install-extension) mode=i;; --uninstall-extension) mode=u;; esac; shift; done
[ "$mode" = i ] && mkdir -p "$ext/ms-ceintl.vscode-language-pack-zh-hans-1.128.0"
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

    const again = await localize(opts);
    assert.equal(again.ok, false);
    assert.match(again.error, /已汉化/);

    const rv = await revert(opts);
    assert.equal(rv.ok, true, rv.error);
    assert.equal(await read(path.join(root, REL)), js);
    assert.equal(await read(path.join(root, 'resources/app/product.json')), productBefore);
    assert.equal(await readLocale(opts.argvPath), null);
    assert.deepEqual(await fs.readdir(opts.extensionsDir), []);
    assert.equal((await readState(opts.dataDir)).localized, false);
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
    assert.deepEqual(await fs.readdir(opts.extensionsDir), []);
  });

  it('refuses while Cursor is running', async () => {
    const { opts } = await setup();
    const r = await localize({ ...opts, isCursorRunning: async () => true });
    assert.equal(r.ok, false);
    assert.match(r.error, /退出 Cursor/);
  });
});
