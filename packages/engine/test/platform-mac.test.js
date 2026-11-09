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
import { writeState } from '../src/state.js';
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

// 假的 codesign / xattr / ps / cp / security：签名 = 改写主程序与 CodeResources（和真 codesign 改的文件一致）
function fakeTools(calls = [], { hasLocalIdentity = true } = {}) {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === '/usr/bin/security' && args[0] === 'find-identity') {
      const line = hasLocalIdentity
        ? '  1) AABBCCDDEEFF00112233445566778899AABBCCDD "cursor-zh-local"\n'
        : '     0 valid identities found\n';
      return { code: 0, stdout: line, stderr: '' };
    }
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
    assert.deepEqual(sign, ['/usr/bin/codesign', '--force', '--sign', 'cursor-zh-local', '--preserve-metadata=entitlements', app]);
    assert.notEqual(sign[sign.indexOf('--sign') + 1], '-');
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

  it('revert: Squirrel auto-update race — detects version mismatch and skips restoring old MacOS/Cursor to prevent SIGTRAP', async () => {
    // 场景：本工具汉化成功后，Squirrel（ShipIt）对整个 Cursor.app 做了原子目录替换（升级到新版）。
    // 还原时 isStale 可能因备份期间 workbench.js 的 DOM 标记尚存而误判为"未过期"，进而尝试把
    // 备份里的旧版 MacOS/Cursor 写入已升级 bundle（Frameworks 是新版）→ 版本不一致 → SIGTRAP。
    // 修复：还原前比较安装目录 product.json 版本与备份版本，若不一致则只清理汉化设置，不写入文件。
    const { root, opts } = await setup();
    const logs = [];
    assert.equal((await localize({ ...opts, onLog: (m) => logs.push(m) })).ok, true);

    // 模拟 Squirrel ShipIt 完成整包替换：更新 product.json 版本号和 MacOS/Cursor 二进制内容
    // 注意：使用数字版本号，确保 fallbackAnchors 能正确加载（filter 要求 /^\d+(\.\d+)+$/）
    const productPath = path.join(root, 'Resources/app/product.json');
    const product = JSON.parse(await read(productPath));
    const originalVersion = product.version; // 'test-shared'
    product.version = '99.9.9'; // 模拟 Squirrel 升级后的新版本
    await fs.writeFile(productPath, JSON.stringify(product, null, '\t') + '\n');
    await fs.writeFile(path.join(root, 'MacOS/Cursor'), 'MACHO-squirrel-new-version', { mode: 0o755 });

    const rv = await revert({ ...opts, onLog: (m) => logs.push(m) });
    assert.equal(rv.ok, true, rv.error);

    // 旧版 MacOS/Cursor 不能被还原回来（否则与新版 Frameworks 不一致 → SIGTRAP）
    assert.equal(
      await read(path.join(root, 'MacOS/Cursor')),
      'MACHO-squirrel-new-version',
      '版本不一致时不应把旧版 MacOS/Cursor 写回安装目录',
    );

    // product.json 版本也不应被还原（Squirrel 更新的版本号应保留）
    assert.equal(JSON.parse(await read(productPath)).version, '99.9.9');

    // 汉化记录已清除
    const st = await readState(opts.dataDir);
    assert.equal(st.localized, false);

    // 日志应包含版本不一致警告，以及新旧版本号
    assert.ok(logs.some((l) => /已更新/.test(l) && /99\.9\.9/.test(l) && new RegExp(String(originalVersion)).test(l)), `日志未包含版本不一致警告，实际日志：${logs.join(' | ')}`);
  });

  it('revert: suppresses auto-relaunch when codesign --verify fails after restore (possible binary/framework version mismatch)', async () => {
    // 场景：还原备份中的 MacOS/Cursor 后，codesign --verify --deep 失败，说明主程序与 Frameworks 版本
    // 仍不一致（可能 ShipIt 只部分完成）。此时不能自动重开 Cursor，否则 V8 Isolate 初始化 SIGTRAP。
    const { root, app, opts } = await setup();
    assert.equal((await localize(opts)).ok, true);

    const logs = [];
    const relaunches = [];

    // 模拟 codesign --verify 失败的 runner（主程序与 Frameworks 版本不一致时会如此）
    const verifyFailRunner = async (cmd, args) => {
      if (cmd === '/usr/bin/codesign' && args.includes('--verify')) {
        return { code: 1, stdout: '', stderr: 'invalid or unsupported format for signature\n' };
      }
      // 其余调用（xattr、security 等）正常通过
      return { code: 0, stdout: '', stderr: '' };
    };

    // 注入 closeCursor：模拟有一个 Cursor 实例在运行，并在 close 后产生 relaunch 信息
    // 这样 withCursorClosed 才会尝试调用 relaunchCursor，才能验证抑制生效
    const closeCursor = async () => ({ ok: true, closed: true, relaunch: { platform: 'darwin', app } });

    const rv = await revert({
      ...opts,
      onLog: (m) => logs.push(m),
      platformRunner: verifyFailRunner,
      closeCursor,
      relaunchCursor: (ri) => relaunches.push(ri),
    });

    assert.equal(rv.ok, true, rv.error);
    assert.equal(relaunches.length, 0, '签名校验失败时不应自动重开 Cursor（避免 SIGTRAP）');
    assert.ok(logs.some((l) => /签名校验未通过/.test(l)), `日志未包含签名校验失败警告，实际日志：${logs.join(' | ')}`);
  });

  it('revert B: 同号 commit 变更时跳过还原旧 MacOS/Cursor（同版本补丁更新同样危险）', async () => {
    // 场景：ShipIt 在同一版本号内发布了修复（commit 变了但 version 字段未改）。
    // 若把汉化时备份的旧 MacOS/Cursor 写入新 bundle，依然可能因 ABI 不兼容导致 SIGTRAP。
    const { root, opts } = await setup();
    const logs = [];
    assert.equal((await localize({ ...opts, onLog: (m) => logs.push(m) })).ok, true);

    // 保持 version 不变，只改 commit 和 MacOS/Cursor（模拟同号补丁更新）
    const productPath = path.join(root, 'Resources/app/product.json');
    const product = JSON.parse(await read(productPath));
    product.commit = 'squirrel-new-commit-deadbeef';
    await fs.writeFile(productPath, JSON.stringify(product, null, '\t') + '\n');
    await fs.writeFile(path.join(root, 'MacOS/Cursor'), 'MACHO-squirrel-patched-binary', { mode: 0o755 });

    const rv = await revert({ ...opts, onLog: (m) => logs.push(m) });
    assert.equal(rv.ok, true, rv.error);
    // 旧版 MacOS/Cursor 不能被写回（否则与新 Frameworks/commit 不一致 → SIGTRAP）
    assert.equal(
      await read(path.join(root, 'MacOS/Cursor')),
      'MACHO-squirrel-patched-binary',
      'commit 不一致时不应把旧版 MacOS/Cursor 写回安装目录',
    );
    assert.equal((await readState(opts.dataDir)).localized, false);
    // commit 在日志里截为前 8 字符：'squirrel-new-commit-deadbeef' → 'squirrel'
    assert.ok(
      logs.some((l) => /commit/.test(l) && /squirrel/.test(l)),
      `日志未含 commit 变更警告，实际日志：${logs.join(' | ')}`,
    );
  });

  it('revert C: product.json 读取异常 → fail-closed，不写旧文件，不自动重开', async () => {
    // 场景：关闭 Cursor 后读取安装目录 product.json 失败（ShipIt 正在替换 bundle 时可能出现）。
    // 此时不能继续写入，应 fail-closed：返回错误，抑制 relaunch，不恢复旧 MacOS/Cursor。
    const { root, app, opts } = await setup();
    assert.equal((await localize(opts)).ok, true);

    const logs = [];
    const relaunches = [];
    const productPath = path.join(root, 'Resources/app/product.json');
    const originalBinary = await read(path.join(root, 'MacOS/Cursor'));

    // closeCursor 注入：在"关闭 Cursor"后删除 product.json（模拟 ShipIt 操作 bundle 时临时不可读）
    const injectCloseCursor = async () => {
      await fs.rm(productPath, { force: true });
      return { ok: true, closed: true, relaunch: { platform: 'darwin', app } };
    };

    const rv = await revert({
      ...opts,
      onLog: (m) => logs.push(m),
      isCursorRunning: async () => true,
      closeRunning: true,
      closeCursor: injectCloseCursor,
      relaunchCursor: (ri) => relaunches.push(ri),
    });

    // fail-closed：返回错误，不写文件，不重开
    assert.equal(rv.ok, false);
    assert.equal(rv.code, 'PRODUCT_READ_FAILED');
    assert.equal(relaunches.length, 0, 'product.json 不可读时不应自动重开 Cursor（避免以不一致 bundle 启动）');
    assert.ok(
      logs.some((l) => /读取失败/.test(l) || /安全起见/.test(l)),
      `日志未含读取失败警告，实际日志：${logs.join(' | ')}`,
    );
    // MacOS/Cursor 未被写回（restoreInstall 未执行）
    assert.equal(await read(path.join(root, 'MacOS/Cursor')), originalBinary, 'fail-closed 时不应修改安装目录文件');
  });

  it('localize D: backup 期间 commit 变更阻止汉化（backupChanged commit 双检）', async () => {
    // 场景：closeCursor 返回后（备份期间），ShipIt 完成了同号 commit 更新。
    // createBackup 拷贝了新 commit 的 product.json；backupChanged 比较 backup.commit vs info.commit → 中止。
    const { root, opts } = await setup();
    const logs = [];
    const productPath = path.join(root, 'Resources/app/product.json');

    // closeCursor 注入：在"关闭 Cursor"后修改 product.json commit（info.commit = 'c0ffee' 已在 resolve 时记录）
    const injectCommitChange = async () => {
      const p = JSON.parse(await read(productPath));
      p.commit = 'newcommit-after-close-squirrel';
      await fs.writeFile(productPath, JSON.stringify(p, null, '\t') + '\n');
      return { ok: true, closed: true, relaunch: null };
    };

    const r = await localize({
      ...opts,
      onLog: (m) => logs.push(m),
      isCursorRunning: async () => true,
      closeRunning: true,
      closeCursor: injectCommitChange,
    });

    assert.equal(r.code, 'INSTALL_CHANGED', `应为 INSTALL_CHANGED，实际：${JSON.stringify(r)}`);
    assert.ok(/commit/.test(r.error), `错误信息应含 commit，实际：${r.error}`);
    // 安装目录未被写入汉化内容
    const content = await read(path.join(root, REL));
    assert.ok(!content.includes('"Cursor 设置"'), '汉化内容不应写入安装目录（INSTALL_CHANGED 应在 patch 前中止）');
  });

  it('revert E-recover: recoverFromBackup 路径签名校验失败时同样不自动重开 Cursor', async () => {
    // 场景：state.localized = false（记录丢失），但安装文件仍带补丁 → 走 recoverFromBackup 路径。
    // 若 codesign --verify --deep 失败，同样必须抑制 relaunch，避免以不一致 bundle 启动。
    const { root, app, opts } = await setup();
    const logs = [];
    const relaunches = [];

    // 1. 汉化成功，记录 backupDir
    const lr = await localize(opts);
    assert.equal(lr.ok, true);
    const st = await readState(opts.dataDir);
    const backupDir = st.backupDir;
    assert.ok(backupDir, '汉化后应有 backupDir');

    // 2. 模拟旧版工具误清记录但未还原文件（state.localized = false，workbench.js 仍带补丁）
    await writeState(opts.dataDir, { localized: false });

    // 3. codesign --verify 失败的 runner
    const verifyFailRunner = async (cmd, args) => {
      if (cmd === '/usr/bin/codesign' && args.includes('--verify')) {
        return { code: 1, stdout: '', stderr: 'invalid or unsupported format for signature\n' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    const rv = await revert({
      ...opts,
      fromBackup: backupDir,
      onLog: (m) => logs.push(m),
      platformRunner: verifyFailRunner,
      isCursorRunning: async () => true,
      closeRunning: true,
      closeCursor: async () => ({ ok: true, closed: true, relaunch: { platform: 'darwin', app } }),
      relaunchCursor: (ri) => relaunches.push(ri),
    });

    assert.equal(rv.ok, true, rv.error);
    assert.equal(relaunches.length, 0, 'recoverFromBackup 路径签名校验失败时不应自动重开 Cursor（避免 SIGTRAP）');
    assert.ok(
      logs.some((l) => /签名校验未通过/.test(l)),
      `日志未含签名校验失败警告，实际日志：${logs.join(' | ')}`,
    );
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
    const kills = [];
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
    await mac.signAdhoc(app, { runner, sleep: async () => {}, timeoutMs: 5000, kill: (pid, sig) => kills.push([pid, sig]), identity: 'cursor-zh-local' });
    assert.ok(rounds >= 3);
    assert.ok(kills.some(([pid, sig]) => pid === 201 && sig === 'SIGTERM'));
    assert.equal(await read(path.join(app, 'Contents/MacOS/Cursor')), 'MACHO-adhoc');
  });

  it('signAdhoc renames the .app aside and back after codesign', async () => {
    const home = await tmp('signrename-');
    const root = await fakeApp(home);
    const app = path.dirname(root);
    const runner = async (cmd, args) => {
      if (cmd === 'ps') return { code: 0, stdout: '', stderr: '' };
      if (cmd === '/usr/bin/codesign' && args.includes('--force')) {
        await fs.writeFile(path.join(app, 'Contents/MacOS/Cursor'), 'MACHO-adhoc');
        await fs.writeFile(path.join(app, 'Contents/_CodeSignature/CodeResources'), '<plist>adhoc</plist>');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === '/usr/bin/codesign') return { code: 0, stdout: '', stderr: 'Signature=adhoc\n' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const signCalls = [];
    const wrapped = async (cmd, args) => {
      const r = await runner(cmd, args);
      if (cmd === '/usr/bin/codesign' && args.includes('--force')) signCalls.push([cmd, ...args]);
      return r;
    };
    await mac.signAdhoc(app, { runner: wrapped, sleep: async () => {}, identity: 'cursor-zh-local' });
    assert.equal(await read(path.join(app, 'Contents/MacOS/Cursor')), 'MACHO-adhoc');
    assert.equal(await fs.access(app).then(() => true, () => false), true);
    assert.equal(await fs.access(`${app}.czl-resign-${process.pid}`).then(() => true, () => false), false);
    assert.equal(signCalls[0][signCalls[0].indexOf('--sign') + 1], 'cursor-zh-local');
    assert.notEqual(signCalls[0][signCalls[0].indexOf('--sign') + 1], '-');
  });

  it('signAdhoc SIGTERMs engine-like -e leftovers then codesigns', async () => {
    const home = await tmp('signkill-');
    const root = await fakeApp(home);
    const app = path.dirname(root);
    const exe = path.join(root, 'MacOS/Cursor');
    let rounds = 0;
    const kills = [];
    const runner = async (cmd, args) => {
      if (cmd === 'ps') {
        rounds++;
        const lines = rounds < 2 ? [`  303  1 ${exe} -e process.stdout.write(1)`] : [];
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
    await mac.signAdhoc(app, { runner, sleep: async () => {}, timeoutMs: 5000, kill: (pid, sig) => kills.push([pid, sig]), identity: 'cursor-zh-local' });
    assert.ok(kills.some(([pid, sig]) => pid === 303 && sig === 'SIGTERM'));
    assert.equal(await read(path.join(app, 'Contents/MacOS/Cursor')), 'MACHO-adhoc');
  });

  it('signAdhoc falls back to ad-hoc when local identity codesign fails', async () => {
    const home = await tmp('signfallback-');
    const root = await fakeApp(home);
    const app = path.dirname(root);
    const forceSigns = [];
    const logs = [];
    const runner = async (cmd, args) => {
      if (cmd === 'ps') return { code: 0, stdout: '', stderr: '' };
      if (cmd === '/usr/bin/codesign' && args.includes('--force')) {
        forceSigns.push([...args]);
        if (args.includes('cursor-zh-local')) return { code: 1, stdout: '', stderr: 'CSSMERR_TP_NOT_TRUSTED' };
        await fs.writeFile(path.join(app, 'Contents/MacOS/Cursor'), 'MACHO-adhoc');
        await fs.writeFile(path.join(app, 'Contents/_CodeSignature/CodeResources'), '<plist>adhoc</plist>');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === '/usr/bin/codesign') return { code: 0, stdout: '', stderr: 'Signature=adhoc\n' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await mac.signAdhoc(app, { runner, sleep: async () => {}, identity: 'cursor-zh-local', onLog: (m) => logs.push(m) });
    assert.equal(forceSigns.length, 2);
    assert.equal(forceSigns[0][forceSigns[0].indexOf('--sign') + 1], 'cursor-zh-local');
    assert.equal(forceSigns[1][forceSigns[1].indexOf('--sign') + 1], '-');
    assert.ok(logs.some((l) => /回退 ad-hoc/.test(l)));
  });
});

describe('macOS: local codesign identity', () => {
  it('findLocalSignIdentity reads security find-identity', async () => {
    const runner = async (cmd, args) => {
      assert.equal(cmd, '/usr/bin/security');
      assert.deepEqual(args, ['find-identity', '-v', '-p', 'codesigning']);
      return { code: 0, stdout: '  1) DEAD "cursor-zh-local"\n', stderr: '' };
    };
    assert.equal(await mac.findLocalSignIdentity({ runner }), 'cursor-zh-local');
    assert.equal(await mac.findLocalSignIdentity({
      runner: async () => ({ code: 0, stdout: '     0 valid identities found\n', stderr: '' }),
    }), null);
  });

  it('ensureLocalSignIdentity returns existing identity without openssl', async () => {
    const calls = [];
    const runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === '/usr/bin/security' && args[0] === 'find-identity') {
        return { code: 0, stdout: '  1) DEAD "cursor-zh-local"\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    assert.equal(await mac.ensureLocalSignIdentity({ runner }), 'cursor-zh-local');
    assert.ok(calls.every((c) => c[0] !== 'openssl'));
  });

  it('ensureLocalSignIdentity creates cert when missing (mocked openssl/security)', async () => {
    const home = await tmp('certcreate-');
    const workDir = path.join(home, 'work');
    await fs.mkdir(workDir);
    let finds = 0;
    const runner = async (cmd, args) => {
      if (cmd === '/usr/bin/security' && args[0] === 'find-identity') {
        finds++;
        // 第一次没有；导入后再有
        if (finds === 1) return { code: 0, stdout: '     0 valid identities found\n', stderr: '' };
        return { code: 0, stdout: '  1) DEAD "cursor-zh-local"\n', stderr: '' };
      }
      if (cmd === 'openssl' && args[0] === 'req') {
        await fs.writeFile(args[args.indexOf('-keyout') + 1], 'KEY');
        await fs.writeFile(args[args.indexOf('-out') + 1], 'CRT');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'openssl' && args[0] === 'pkcs12') {
        assert.ok(args.includes('-legacy') || args.includes('-export'));
        await fs.writeFile(args[args.indexOf('-out') + 1], 'P12');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === '/usr/bin/security' && args[0] === 'import') {
        assert.equal(args[args.indexOf('-P') + 1].length, 32); // hex password, not logged
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === '/usr/bin/security' && args[0] === 'add-trusted-cert') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const logs = [];
    assert.equal(await mac.ensureLocalSignIdentity({
      runner,
      workDir,
      onLog: (m) => logs.push(m),
      randomBytes: (n) => Buffer.alloc(n, 7),
    }), 'cursor-zh-local');
    assert.ok(logs.some((l) => /创建本地代码签名证书/.test(l)));
    // 临时密钥材料应已清理
    assert.equal(await fs.readdir(workDir).then((x) => x.length), 0);
  });
});
