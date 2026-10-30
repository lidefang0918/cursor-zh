import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as mac from '../src/platform/mac.js';
import { applyFiles, checkWritable, HELPER_PATH } from '../src/elevate.js';
import { sha256File } from '../src/backup.js';
import { localize, revert, status, defaultPaths, readState } from '../src/localize.js';
import { closeCursor, listCursorProcesses, relaunchCursor } from '../src/process.js';
import { detectAllCursors } from '../src/detect.js';
import { vscodeChecksum } from '../src/patch.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// macOS 的 /var 是 /private/var 的符号链接，用真实路径，检测结果里的 root 才能对得上
const tmp = async (p) => fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), p));
const REL = 'Resources/app/out/vs/workbench/workbench.desktop.main.js';
const KEY = 'vs/workbench/workbench.desktop.main.js';
const JS = 'a="Cursor Settings";b="New Agent";';

async function fakeApp(dir, { js = JS, version = 'test-shared' } = {}) {
  const root = path.join(dir, 'Cursor.app', 'Contents');
  await fs.mkdir(path.dirname(path.join(root, REL)), { recursive: true });
  await fs.writeFile(path.join(root, REL), js);
  const product = { nameShort: 'Cursor', version, commit: 'c0ffee', vscodeVersion: '1.128.0', checksums: { [KEY]: vscodeChecksum(Buffer.from(js)) } };
  await fs.writeFile(path.join(root, 'Resources/app/product.json'), JSON.stringify(product, null, '\t') + '\n');
  await fs.mkdir(path.join(root, 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(root, 'MacOS/Cursor'), 'MACHO-developer-id-signed', { mode: 0o755 });
  await fs.mkdir(path.join(root, '_CodeSignature'), { recursive: true });
  await fs.writeFile(path.join(root, '_CodeSignature/CodeResources'), '<plist>original seal</plist>');
  await fs.mkdir(path.join(root, 'Frameworks/Electron Framework.framework'), { recursive: true });
  await fs.writeFile(path.join(root, 'Frameworks/Electron Framework.framework/Electron Framework'), 'MACHO-fw-developer-id');
  return root;
}

// 假的 codesign / xattr / ps / cp：签名 = 改写主程序与 CodeResources（和真 codesign 改的文件一致）
function fakeTools(calls = []) {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === '/usr/bin/codesign' && args.includes('--force')) {
      const app = args.at(-1);
      await fs.writeFile(path.join(app, 'Contents/MacOS/Cursor'), 'MACHO-adhoc');
      await fs.writeFile(path.join(app, 'Contents/_CodeSignature/CodeResources'), '<plist>adhoc seal</plist>');
      if (args.includes('--deep')) await fs.writeFile(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'), 'MACHO-fw-adhoc');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === '/bin/cp') { await fs.cp(args.at(-2), args.at(-1), { recursive: true }); return { code: 0, stdout: '', stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
}

async function fakeCli(dir) {
  const cliPath = path.join(dir, 'cursor-cli.sh');
  await fs.writeFile(cliPath, `#!/bin/sh
ext=""; while [ $# -gt 0 ]; do case "$1" in --extensions-dir) ext="$2"; shift;; --install-extension) mode=i;; --uninstall-extension) mode=u;; esac; shift; done
[ "$mode" = i ] && mkdir -p "$ext/ms-ceintl.vscode-language-pack-zh-hans-1.128.0"
[ "$mode" = u ] && rm -rf "$ext"/ms-ceintl.vscode-language-pack-zh-hans-*
exit 0
`, { mode: 0o755 });
  return cliPath;
}

async function setup(extra = {}) {
  const home = await tmp('machome-');
  const root = await fakeApp(path.join(home, 'Applications'), extra);
  const calls = [];
  const opts = {
    platform: 'darwin', env: { HOME: home }, installRoot: root, cliPath: await fakeCli(home), vsixPath: '/fake.vsix',
    ...defaultPaths(home, 'darwin'), platformRunner: fakeTools(calls),
    anchorsDir: path.join(repo, 'packages/engine/test/fixtures/anchors'), dictPath: path.join(repo, 'packages/engine/test/fixtures/dict.json'),
  };
  return { home, root, app: path.dirname(root), calls, opts };
}
const read = (p) => fs.readFile(p, 'utf8');

describe('macOS: detection, paths, processes', () => {
  it('uses ~/Library/Application Support and the bundled cli.js', () => {
    const p = defaultPaths('/Users/u', 'darwin');
    assert.equal(p.userDataDir, '/Users/u/Library/Application Support/Cursor');
    assert.equal(p.dataDir, '/Users/u/Library/Application Support/cursor-zh-localizer');
    assert.equal(p.extensionsDir, '/Users/u/.cursor/extensions');
    const cli = mac.macCli('/Applications/Cursor.app/Contents');
    assert.equal(cli.cmd, '/Applications/Cursor.app/Contents/MacOS/Cursor');
    assert.deepEqual(cli.args, ['/Applications/Cursor.app/Contents/Resources/app/out/cli.js']);
    assert.equal(mac.appPathOf('/Applications/Cursor.app/Contents'), '/Applications/Cursor.app');
  });

  it('classifies install locations, including App Translocation', async () => {
    assert.equal(mac.macInstallKind('/Applications/Cursor.app/Contents', '/Users/u'), 'mac-applications');
    assert.equal(mac.macInstallKind('/Users/u/Applications/Cursor.app/Contents', '/Users/u'), 'mac-user-applications');
    assert.equal(mac.macInstallKind('/private/var/folders/x/T/AppTranslocation/1234/d/Cursor.app/Contents', '/Users/u'), 'mac-translocated');
    const { home, root } = await setup();
    const all = await detectAllCursors({ platform: 'darwin', env: { HOME: home } });
    assert.ok(all.some((i) => i.root === root && i.kind === 'mac-user-applications' && i.appDir.endsWith('Resources/app')));
  });

  const root = '/Applications/Cursor.app/Contents';
  const PS = [
    `  101     1 ${root}/MacOS/Cursor`,
    `  102   101 ${root}/Frameworks/Cursor Helper (GPU).app/Contents/MacOS/Cursor Helper (GPU) --type=gpu-process`,
    `  103   101 ${root}/Frameworks/Cursor Helper (Renderer).app/Contents/MacOS/Cursor Helper (Renderer) --type=renderer`,
    `  200     1 /Users/u/Downloads/Cursor.app/Contents/MacOS/Cursor`,
    `  300     1 ${root}/MacOS/Cursor ${root}/Resources/app/out/cli.js --list-extensions`,
    `  400     1 /bin/zsh`,
  ].join('\n');

  it('lists main + helper processes of this bundle only', async () => {
    const runner = async () => ({ code: 0, stdout: PS, stderr: '' });
    const ps = await listCursorProcesses(root, { platform: 'darwin', runner });
    assert.deepEqual(ps.map((p) => p.pid), [101, 102, 103]);
    assert.deepEqual(ps.filter((p) => p.main).map((p) => p.pid), [101]);
  });

  it('does not treat the Tauri engine (engine-ipc.mjs) as a Cursor GUI process', async () => {
    const stdout = `${PS}\n  500     1 ${root}/MacOS/Cursor /tmp/czl/scripts/engine-ipc.mjs status`;
    const ps = await listCursorProcesses(root, { platform: 'darwin', runner: async () => ({ code: 0, stdout, stderr: '' }) });
    assert.deepEqual(ps.map((p) => p.pid), [101, 102, 103]);
  });

  it('builds an AppleEvent quit with the .app path in argv (not SIGTERM)', () => {
    const args = mac.quitMacArgs('/Applications/Cursor.app');
    assert.equal(args.at(-1), '/Applications/Cursor.app');
    assert.ok(args.includes('tell application (POSIX file (item 1 of argv) as text) to quit'));
    assert.ok(!args.some((a) => /SIGTERM|SIGKILL|kill/i.test(a)));
  });

  it('quits via osascript AppleEvent, never SIGTERM, waits until gone, then relaunches through `open`', async () => {
    let alive = true;
    const killed = [];
    const cmds = [];
    const sleeps = [];
    const runner = async (cmd, args = []) => {
      cmds.push([cmd, ...args]);
      if (cmd === '/usr/bin/osascript') { alive = false; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: alive ? PS : '', stderr: '' };
    };
    const r = await closeCursor(root, {
      platform: 'darwin', runner, timeoutMs: 5000, settleMs: 25,
      kill: (pid, sig) => { killed.push([pid, sig]); },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(killed.length, 0, 'must not SIGTERM/SIGKILL; that triggers macOS Crash Reporter');
    const osa = cmds.find((c) => c[0] === '/usr/bin/osascript');
    assert.ok(osa, 'should send AppleEvent quit via osascript');
    assert.deepEqual(osa.slice(1), mac.quitMacArgs('/Applications/Cursor.app'));
    assert.ok(!cmds.some((c) => c[0] === 'kill' || c.includes?.('SIGTERM')));
    assert.ok(sleeps.includes(25), 'settle after processes vanish so later codesign/write does not kill a still-exiting process');
    assert.deepEqual(r.relaunch, { platform: 'darwin', app: '/Applications/Cursor.app' });
    let got;
    relaunchCursor(r.relaunch, { spawnFn: (c, a) => { got = [c, ...a]; return { pid: 1, unref() {} }; } });
    assert.deepEqual(got, ['/usr/bin/open', '/Applications/Cursor.app']);
  });

  it('does not fall back to kill when osascript fails; asks the user to ⌘Q', async () => {
    const killed = [];
    const runner = async (cmd) => {
      if (cmd === '/usr/bin/osascript') return { code: 1, stdout: '', stderr: 'not authorized to send Apple events to Cursor.' };
      return { code: 0, stdout: PS, stderr: '' };
    };
    const r = await closeCursor(root, {
      platform: 'darwin', runner, timeoutMs: 40,
      kill: (pid, sig) => { killed.push([pid, sig]); },
      sleep: async () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(killed.length, 0);
    assert.match(r.error, /⌘Q/);
  });
});

describe('macOS: writing into Cursor.app', () => {
  it('App Management (TCC) EPERM is reported with a hint instead of trying sudo', async () => {
    const { root } = await setup();
    const w = await checkWritable(root, [REL], { platform: 'darwin', probe: async () => 'EPERM' });
    assert.equal(w.appManagement, true);
    const seen = [];
    const r = await applyFiles({ installRoot: root, items: [{ relative: REL, src: '/x', sha256: '0' }], workDir: '/nonexistent', platform: 'darwin', probe: async () => 'EPERM', runner: async (c) => { seen.push(c); return { code: 0 }; } });
    assert.equal(r.code, 'MAC_APP_MANAGEMENT');
    assert.match(r.error, /App 管理/);
    assert.equal(r.settingsUrl, mac.APP_MANAGEMENT_SETTINGS_URL);
    assert.deepEqual(seen, []);
  });

  it('refuses App-Translocated bundles', async () => {
    const r = await applyFiles({ installRoot: '/private/var/folders/x/T/AppTranslocation/1/d/Cursor.app/Contents', items: [{ relative: REL }], workDir: '/x', platform: 'darwin' });
    assert.equal(r.code, 'MAC_TRANSLOCATED');
  });

  it('EACCES → osascript admin prompt carrying the helper script, manifest and re-sign actions via argv', async () => {
    const { home, root } = await setup();
    const src = path.join(home, 'staged.js');
    await fs.writeFile(src, 'patched');
    const items = [{ relative: REL, src, sha256: await sha256File(src) }];
    let seen;
    const runner = async (cmd, args) => {
      seen = [cmd, args];
      await fs.copyFile(src, path.join(root, REL));
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await applyFiles({ installRoot: root, items, workDir: path.join(home, 'work'), platform: 'darwin', runner, probe: async () => 'EACCES', actions: mac.postWriteActions('adhoc') });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.method, 'osascript');
    assert.equal(seen[0], '/usr/bin/osascript');
    assert.match(seen[1][3], /with administrator privileges/);
    assert.equal(seen[1][6], await fs.readFile(HELPER_PATH, 'utf8'));
    const manifest = await read(seen[1][7]);
    assert.match(manifest, /^CZL1\t.*Cursor\.app\/Contents\n/);
    assert.match(manifest, /\n!codesign-adhoc\n!unquarantine\n$/);

    const cancel = await applyFiles({ installRoot: root, items, workDir: path.join(home, 'work'), platform: 'darwin', probe: async () => 'EACCES', runner: async () => ({ code: 1, stdout: '', stderr: '0:180: execution error: User canceled. (-128)' }) });
    assert.equal(cancel.code, 'NEED_ELEVATION');
    assert.match(cancel.command, /^sudo sh '.*czl-apply\.sh' '.*apply\.tsv'$/);
    const failed = await applyFiles({ installRoot: root, items, workDir: path.join(home, 'work'), platform: 'darwin', probe: async () => 'EACCES', runner: async () => ({ code: 1, stdout: '', stderr: 'execution error: czl-apply: 重签名失败 (6)' }) });
    assert.equal(failed.code, 'HELPER_FAILED');
    assert.match(failed.error, /重签名失败/);
  });

  it('parses osascript errors', () => {
    assert.deepEqual(mac.parseOsascriptError('execution error: User canceled. (-128)'), { cancelled: true, code: null });
    assert.deepEqual(mac.parseOsascriptError('execution error: czl-apply: 写入失败 (4)'), { cancelled: false, code: 4 });
  });

  it('the POSIX helper refuses macOS-only actions and signature paths on a non-mac root', async () => {
    const { home, root } = await setup();
    const linuxRoot = path.join(home, 'linroot');
    await fs.mkdir(path.join(linuxRoot, 'resources/app'), { recursive: true });
    await fs.writeFile(path.join(linuxRoot, 'resources/app/product.json'), '{"nameShort": "Cursor"}');
    await fs.writeFile(path.join(linuxRoot, 'resources/app/a.js'), 'x');
    const src = path.join(home, 's.js');
    await fs.writeFile(src, 'y');
    const sha = await sha256File(src);
    const m = path.join(home, 'm.tsv');
    const runHelper = () => { try { execFileSync('sh', [HELPER_PATH, m], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
    await fs.writeFile(m, `CZL1\t${linuxRoot}\n${sha}\t${src}\tresources/app/a.js\n!codesign-adhoc\n`);
    assert.equal(runHelper(), 2);
    // 在 macOS 主机上 *.app/Contents 就是合法的 mac 根目录，这一条只在非 mac 主机上成立
    if (process.platform !== 'darwin') {
      await fs.writeFile(m, `CZL1\t${root}\n${sha}\t${src}\tMacOS/Cursor\n`);
      assert.equal(runHelper(), 2);
    }
    await fs.writeFile(m, `CZL1\t${linuxRoot}\n${sha}\t${src}\tresources/app/a.js\n`);
    assert.equal(runHelper(), 0);
    assert.equal(await read(path.join(linuxRoot, 'resources/app/a.js')), 'y');
  });
});

describe('macOS: localize/revert with re-signing', () => {
  it('adhoc: patches Resources/app, re-signs the outer bundle (no --deep / no hardened runtime), strips quarantine; revert restores the original signature', async () => {
    const { root, app, calls, opts } = await setup();
    const productBefore = await read(path.join(root, 'Resources/app/product.json'));
    const logs = [];
    const r = await localize({ ...opts, onLog: (m) => logs.push(m) });
    assert.equal(r.ok, true, r.error);
    assert.match(await read(path.join(root, REL)), /"Cursor 设置"/);
    const product = JSON.parse(await read(path.join(root, 'Resources/app/product.json')));
    assert.equal(product.checksums[KEY], vscodeChecksum(await fs.readFile(path.join(root, REL))));
    const sign = calls.find((c) => c[0] === '/usr/bin/codesign' && c.includes('--force'));
    assert.deepEqual(sign, ['/usr/bin/codesign', '--force', '--sign', '-', '--preserve-metadata=entitlements', app]);
    assert.ok(calls.some((c) => c.join(' ') === `/usr/bin/codesign --verify --deep --strict --verbose=2 ${app}`));
    assert.ok(calls.some((c) => c.join(' ') === `/usr/bin/xattr -dr com.apple.quarantine ${app}`));
    assert.equal(await read(path.join(root, 'MacOS/Cursor')), 'MACHO-adhoc');
    const state = await readState(opts.dataDir);
    assert.equal(state.macSign, 'adhoc');
    assert.ok(logs.some((l) => /钥匙串/.test(l)));
    const st = await status(opts);
    assert.equal(st.localized, true);
    assert.equal(st.mac.signMode, 'adhoc');

    const rv = await revert(opts);
    assert.equal(rv.ok, true, rv.error);
    assert.equal(await read(path.join(root, REL)), JS);
    assert.equal(await read(path.join(root, 'Resources/app/product.json')), productBefore);
    assert.equal(await read(path.join(root, 'MacOS/Cursor')), 'MACHO-developer-id-signed');
    assert.equal(await read(path.join(root, '_CodeSignature/CodeResources')), '<plist>original seal</plist>');
  });

  it('none: leaves the signature alone', async () => {
    const { root, calls, opts } = await setup();
    const r = await localize({ ...opts, macSign: 'none' });
    assert.equal(r.ok, true, r.error);
    assert.equal(calls.filter((c) => c.includes('--force')).length, 0);
    assert.equal(await read(path.join(root, 'MacOS/Cursor')), 'MACHO-developer-id-signed');
    assert.equal((await revert(opts)).ok, true);
  });

  it('adhoc-deep: clones the bundle first and swaps it back on revert', async () => {
    const { root, app, calls, opts } = await setup();
    const r = await localize({ ...opts, macSign: 'adhoc-deep' });
    assert.equal(r.ok, true, r.error);
    assert.ok(calls.some((c) => c[0] === '/usr/bin/codesign' && c.includes('--deep') && c.includes('--force')));
    assert.equal(await read(path.join(root, 'Frameworks/Electron Framework.framework/Electron Framework')), 'MACHO-fw-adhoc');
    const rv = await revert(opts);
    assert.equal(rv.ok, true, rv.error);
    assert.equal(await read(path.join(root, 'Frameworks/Electron Framework.framework/Electron Framework')), 'MACHO-fw-developer-id');
    assert.equal(await read(path.join(root, 'MacOS/Cursor')), 'MACHO-developer-id-signed');
    assert.equal(await read(path.join(root, REL)), JS);
    assert.deepEqual((await fs.readdir(path.dirname(app))).sort(), ['Cursor.app']);
  });

  it('refuses an install whose bundle differs from the known pristine sha (already modified by another tool)', async () => {
    const { opts } = await setup({ js: 'a="Cursor Settings";b="New Agent";/*other tool*/', version: 'test-pristine' });
    const r = await localize(opts);
    assert.equal(r.code, 'MODIFIED_INSTALL');
    const ok = await setup({ version: 'test-pristine' });
    assert.equal((await localize(ok.opts)).ok, true);
  });
});

describe('macOS: codesign must not race live Cursor processes', () => {
  it('listMacProcesses skips engine-ipc by default but includeEngine keeps them', async () => {
    const root = '/tmp/Cursor.app/Contents';
    const exe = path.join(root, 'MacOS/Cursor');
    const fw = path.join(root, 'Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper');
    const runner = async (cmd, args) => {
      assert.equal(cmd, 'ps');
      return {
        code: 0, stderr: '',
        stdout: [
          `  101  1 ${exe}`,
          `  102 101 ${fw} --type=gpu-process`,
          `  201  1 ${exe} /x/engine-ipc.mjs status`,
        ].join('\n'),
      };
    };
    const gui = await mac.listMacProcesses(root, { runner });
    assert.equal(gui.length, 2);
    assert.ok(gui.every((p) => !/engine-ipc/.test(p.command)));
    const all = await mac.listMacProcesses(root, { runner, includeEngine: true });
    assert.equal(all.length, 3);
    assert.ok(all.some((p) => /engine-ipc/.test(p.command)));
  });

  it('signAdhoc waits until includeEngine list is empty, then codesigns', async () => {
    const home = await tmp('signwait-');
    const root = await fakeApp(home);
    const app = path.dirname(root);
    const exe = path.join(root, 'MacOS/Cursor');
    let rounds = 0;
    const runner = async (cmd, args) => {
      if (cmd === 'ps') {
        rounds++;
        const lines = rounds < 3 ? [`  201  1 ${exe} /x/engine-ipc.mjs status`] : [];
        return { code: 0, stdout: lines.join('\n'), stderr: '' };
      }
      if (cmd === '/usr/bin/codesign' && args.includes('--force')) {
        await fs.writeFile(path.join(app, 'Contents/MacOS/Cursor'), 'MACHO-adhoc');
        await fs.writeFile(path.join(app, 'Contents/_CodeSignature/CodeResources'), '<plist>adhoc</plist>');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === '/usr/bin/codesign') return { code: 0, stdout: '', stderr: 'Signature=adhoc\n' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await mac.signAdhoc(app, { runner, sleep: async () => {}, timeoutMs: 5000 });
    assert.ok(rounds >= 3);
    assert.equal(await read(path.join(app, 'Contents/MacOS/Cursor')), 'MACHO-adhoc');
  });
});
