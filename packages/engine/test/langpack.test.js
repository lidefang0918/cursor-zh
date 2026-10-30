import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  langpackVersionFor, langpackUrl, ensureLanguagePack, uninstallLanguagePack,
  findInstalledLangpack, findConflicts, setLocale, readLocale, registerLanguagePack, unregisterLanguagePack,
} from '../src/langpack.js';

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));

// 假 CLI：模拟 `cursor --install-extension x.vsix --extensions-dir D` / `--uninstall-extension id`
async function fakeCli() {
  const dir = await tmp('cli-');
  const cli = path.join(dir, 'cursor');
  await fs.writeFile(cli, `#!/bin/sh
echo "$@" >> "${dir}/calls.log"
ext=""; while [ $# -gt 0 ]; do case "$1" in --extensions-dir) ext="$2"; shift;; --install-extension) mode=i;; --uninstall-extension) mode=u;; esac; shift; done
if [ "$mode" = i ]; then mkdir -p "$ext/ms-ceintl.vscode-language-pack-zh-hans-1.128.0"; fi
if [ "$mode" = u ]; then rm -rf "$ext"/ms-ceintl.vscode-language-pack-zh-hans-*; fi
`, { mode: 0o755 });
  return { cli, log: path.join(dir, 'calls.log') };
}

describe('langpack', () => {
  it('picks the langpack version matching Cursor vscodeVersion', () => {
    assert.equal(langpackVersionFor('1.128.0'), '1.128.0');
    assert.equal(langpackVersionFor('1.99.3'), '1.99.0');
    assert.match(langpackUrl('1.128.0'), /open-vsx\.org\/api\/MS-CEINTL\/vscode-language-pack-zh-hans\/1\.128\.0\/file\/.*1\.128\.0\.vsix$/);
  });

  it('installs via Cursor CLI when missing, skips when present', async () => {
    const { cli, log } = await fakeCli();
    const extensionsDir = await tmp('ext-');
    const r1 = await ensureLanguagePack({ cliPath: cli, extensionsDir, userDataDir: '/tmp/ud', vsixPath: '/x.vsix' });
    assert.equal(r1.installed, true);
    assert.ok(r1.extensionPath.endsWith('ms-ceintl.vscode-language-pack-zh-hans-1.128.0'));
    assert.match(await fs.readFile(log, 'utf8'), /--install-extension \/x\.vsix --extensions-dir .* --user-data-dir \/tmp\/ud/);
    const r2 = await ensureLanguagePack({ cliPath: cli, extensionsDir, userDataDir: '/tmp/ud', vsixPath: '/x.vsix' });
    assert.equal(r2.installed, false);
    await uninstallLanguagePack({ cliPath: cli, extensionsDir, userDataDir: '/tmp/ud' });
    assert.equal(await findInstalledLangpack(extensionsDir), null);
  });

  it('ignores a leftover langpack folder not registered in extensions.json', async () => {
    const extensionsDir = await tmp('ext-');
    const dir = path.join(extensionsDir, 'ms-ceintl.vscode-language-pack-zh-hans-1.128.0');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(extensionsDir, 'extensions.json'), '[]');
    assert.equal(await findInstalledLangpack(extensionsDir), null);
    await fs.writeFile(path.join(extensionsDir, 'extensions.json'),
      JSON.stringify([{ identifier: { id: 'MS-CEINTL.vscode-language-pack-zh-hans' }, relativeLocation: 'ms-ceintl.vscode-language-pack-zh-hans-1.128.0' }]));
    assert.equal(await findInstalledLangpack(extensionsDir), dir);
  });

  it('detects conflicting community language packs', async () => {
    const extensionsDir = await tmp('ext-');
    await fs.mkdir(path.join(extensionsDir, 'polang233.cursor-language-pack-0.1.0'));
    await fs.mkdir(path.join(extensionsDir, 'ms-python.python-1.0.0'));
    assert.deepEqual(await findConflicts(extensionsDir), ['polang233.cursor-language-pack-0.1.0']);
  });

  it('sets locale in argv.json (JSONC, keeps comments) and returns previous', async () => {
    const dir = await tmp('argv-');
    const argvPath = path.join(dir, 'argv.json');
    await fs.writeFile(argvPath, '// comment\n{\n\t"enable-crash-reporter": true\n}\n');
    assert.equal(await setLocale({ argvPath, locale: 'zh-cn' }), null);
    const txt = await fs.readFile(argvPath, 'utf8');
    assert.match(txt, /\/\/ comment/);
    assert.equal(await readLocale(argvPath), 'zh-cn');
    assert.equal(await setLocale({ argvPath, locale: 'en' }), 'zh-cn');
    assert.equal(await readLocale(argvPath), 'en');
    await setLocale({ argvPath, locale: null });
    assert.equal(await readLocale(argvPath), null);
    assert.match(await fs.readFile(argvPath, 'utf8'), /"enable-crash-reporter": true\n\}/);
  });

  it('creates argv.json when missing', async () => {
    const argvPath = path.join(await tmp('argv-'), 'sub', 'argv.json');
    await setLocale({ argvPath, locale: 'zh-cn' });
    assert.equal(await readLocale(argvPath), 'zh-cn');
    // Cursor 首次启动会接着追加自己的键，逗号单独占一行；还原后不能留下孤立的逗号
    await fs.writeFile(argvPath, (await fs.readFile(argvPath, 'utf8')).replace(/\n\}\n$/, '\n,\n\n\t// c\n\t"enable-crash-reporter": true\n}\n'));
    await setLocale({ argvPath, locale: null });
    assert.equal(await fs.readFile(argvPath, 'utf8'), '{\n\n\t// c\n\t"enable-crash-reporter": true\n}\n');
  });
});

describe('languagepacks.json registration', () => {
  async function fakeExtension() {
    const ext = path.join(await tmp('ext-'), 'ms-ceintl.vscode-language-pack-zh-hans-1.128.0');
    await fs.mkdir(ext, { recursive: true });
    await fs.writeFile(path.join(ext, 'package.json'), JSON.stringify({
      name: 'vscode-language-pack-zh-hans', publisher: 'MS-CEINTL', version: '1.128.0',
      contributes: { localizations: [{ languageId: 'zh-cn', languageName: 'Chinese Simplified', localizedLanguageName: '中文(简体)',
        translations: [{ id: 'vscode', path: './translations/main.i18n.json' }, { id: 'vscode.git', path: './translations/extensions/vscode.git.i18n.json' }] }] },
    }));
    return ext;
  }

  it('writes the entry the way Cursor does (same hash as Cursor-generated file), keeps other locales', async () => {
    const userDataDir = await tmp('ud-');
    await fs.writeFile(path.join(userDataDir, 'languagepacks.json'), JSON.stringify({ ja: { hash: 'x', extensions: [], translations: {}, label: '日本語' } }));
    const ext = await fakeExtension();
    const r = await registerLanguagePack({ userDataDir, extensionPath: ext });
    assert.deepEqual(r.locales, ['zh-cn']);
    const packs = JSON.parse(await fs.readFile(path.join(userDataDir, 'languagepacks.json'), 'utf8'));
    assert.ok(packs.ja);
    const zh = packs['zh-cn'];
    // box 上 Cursor 3.27.22 自己生成的 languagepacks.json 里就是这个 hash
    assert.equal(zh.hash, 'e847c90f9aa805971f169edf104a4233');
    assert.deepEqual(zh.extensions, [{ extensionIdentifier: { id: 'ms-ceintl.vscode-language-pack-zh-hans' }, version: '1.128.0' }]);
    assert.equal(zh.translations.vscode, path.join(ext, 'translations/main.i18n.json'));
    assert.equal(zh.translations['vscode.git'], path.join(ext, 'translations/extensions/vscode.git.i18n.json'));
    assert.equal(zh.label, '中文(简体)');
    // 幂等：再登记一次不会重复扩展
    await registerLanguagePack({ userDataDir, extensionPath: ext });
    const again = JSON.parse(await fs.readFile(path.join(userDataDir, 'languagepacks.json'), 'utf8'));
    assert.equal(again['zh-cn'].extensions.length, 1);
    assert.equal(again['zh-cn'].hash, zh.hash);
  });

  it('creates languagepacks.json when missing and unregister removes only our entry', async () => {
    const userDataDir = path.join(await tmp('ud-'), 'Cursor');
    await registerLanguagePack({ userDataDir, extensionPath: await fakeExtension() });
    const file = path.join(userDataDir, 'languagepacks.json');
    const packs = JSON.parse(await fs.readFile(file, 'utf8'));
    packs.ja = { hash: 'x', extensions: [{ extensionIdentifier: { id: 'ms-ceintl.vscode-language-pack-ja' }, version: '1' }], translations: {} };
    await fs.writeFile(file, JSON.stringify(packs));
    assert.equal(await unregisterLanguagePack({ userDataDir }), true);
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))), ['ja']);
    assert.equal(await unregisterLanguagePack({ userDataDir }), false);
  });
});
