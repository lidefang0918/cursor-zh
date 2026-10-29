import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as win from '../src/platform/win.js';
import { detectAllCursors, detectCursor } from '../src/detect.js';
import { applyFiles, checkWritable } from '../src/elevate.js';
import { sha256File } from '../src/backup.js';
import { localize, revert, status, defaultPaths, readState } from '../src/localize.js';
import { closeCursor, listCursorProcesses, relaunchCursor } from '../src/process.js';
import { vscodeChecksum } from '../src/patch.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));
const REL = 'resources/app/out/vs/workbench/workbench.desktop.main.js';
const KEY = 'vs/workbench/workbench.desktop.main.js';
const PWSH = ['/workspace/tools/pwsh/pwsh', ...(process.env.PATH || '').split(':').map((d) => path.join(d, 'pwsh'))].find((p) => fsSync.existsSync(p));

async function fakeInstall(root, { js = 'a="Cursor Settings";b="New Agent";', version = 'test-shared', target = 'user' } = {}) {
  await fs.mkdir(path.dirname(path.join(root, REL)), { recursive: true });
  await fs.writeFile(path.join(root, REL), js);
  await fs.writeFile(path.join(root, 'Cursor.exe'), 'MZ');
  const product = { nameShort: 'Cursor', version, commit: 'c0ffee', vscodeVersion: '1.128.0', target, checksums: { [KEY]: vscodeChecksum(Buffer.from(js)) } };
  await fs.writeFile(path.join(root, 'resources/app/product.json'), JSON.stringify(product, null, '\t') + '\n');
  return root;
}

const REG_OUT = (loc) => `\r
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{DADADADA-0000-1111-2222-333333333333}_is1\r
    Inno Setup: App Path    REG_SZ    ${loc}\r
    InstallLocation    REG_SZ    ${loc}\\\r
    DisplayName    REG_SZ    Cursor (User)\r
    DisplayVersion    REG_SZ    3.27.22\r
    Publisher    REG_SZ    Anysphere\r
\r
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other\r
    DisplayName    REG_SZ    Not Cursor\r
    InstallLocation    REG_SZ    C:\\Other\r
    NoValue    REG_SZ\r
`;

describe('windows: detection & paths', () => {
  it('parses reg query output (values with spaces, empty values)', () => {
    const keys = win.parseRegQuery(REG_OUT('C:\\Users\\a b\\AppData\\Local\\Programs\\cursor'));
    assert.equal(keys.length, 2);
    assert.equal(keys[0].values.InstallLocation, 'C:\\Users\\a b\\AppData\\Local\\Programs\\cursor\\');
    assert.equal(keys[0].values['Inno Setup: App Path'], 'C:\\Users\\a b\\AppData\\Local\\Programs\\cursor');
    assert.equal(keys[1].values.NoValue, '');
  });

  it('finds user, Program Files and registry-only (custom dir with spaces) installs and classifies them', async () => {
    const base = await tmp('win-');
    const env = { LOCALAPPDATA: path.join(base, 'Local'), ProgramFiles: path.join(base, 'Program Files'), APPDATA: path.join(base, 'Roaming'), USERPROFILE: base };
    await fakeInstall(path.join(env.LOCALAPPDATA, 'Programs', 'cursor'));
    await fakeInstall(path.join(env.ProgramFiles, 'cursor'), { target: 'system' });
    const custom = await fakeInstall(path.join(base, 'My Apps', 'Cursor'));
    const calls = [];
    const runner = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'reg' && args[1].startsWith('HKCU')) return { code: 0, stdout: REG_OUT(custom), stderr: '' };
      return { code: 1, stdout: '', stderr: 'ERROR: not found' };
    };
    const all = await detectAllCursors({ platform: 'win32', env, runner });
    assert.deepEqual(all.map((i) => i.kind), ['win-user', 'win-system', 'win-other']);
    assert.equal(all[2].root, custom);
    assert.ok(calls.some((c) => c.startsWith('reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s')));
    const first = await detectCursor({ platform: 'win32', env, runner });
    assert.equal(first.root, path.join(env.LOCALAPPDATA, 'Programs', 'cursor'));
  });

  it('uses %APPDATA%\\Cursor and %USERPROFILE%\\.cursor', () => {
    const p = defaultPaths('/home/x', 'win32', { APPDATA: '/r/Roaming', USERPROFILE: '/r' });
    assert.equal(p.userDataDir, path.join('/r/Roaming', 'Cursor'));
    assert.equal(p.extensionsDir, path.join('/r', '.cursor', 'extensions'));
    assert.equal(p.argvPath, path.join('/r', '.cursor', 'argv.json'));
    assert.equal(p.dataDir, path.join('/r/Roaming', 'cursor-zh-localizer'));
    const cli = win.winCli('C:/Program Files/cursor');
    assert.equal(cli.env.ELECTRON_RUN_AS_NODE, '1');
    assert.match(cli.args[0], /out[\\/]cli\.js$/);
  });
});

describe('windows: processes', () => {
  const root = 'C:\\Program Files\\cursor';
  const exe = `${root}\\Cursor.exe`;
  const rows = [
    { ProcessId: 10, ParentProcessId: 1, ExecutablePath: exe, CommandLine: `"${exe}" C:\\proj` },
    { ProcessId: 11, ParentProcessId: 10, ExecutablePath: exe, CommandLine: `"${exe}" --type=renderer` },
    { ProcessId: 12, ParentProcessId: 10, ExecutablePath: exe, CommandLine: `"${exe}" --type=utility` },
    { ProcessId: 20, ParentProcessId: 1, ExecutablePath: 'C:\\Other\\Cursor.exe', CommandLine: 'other' },
    { ProcessId: 30, ParentProcessId: 1, ExecutablePath: exe.toLowerCase(), CommandLine: `"${exe}" "${root}\\resources\\app\\out\\cli.js" --list-extensions` },
  ];

  it('lists processes of this install only (case-insensitive path, skips cli.js) and finds the main one', async () => {
    const runner = async (cmd) => (cmd === 'powershell.exe' ? { code: 0, stdout: JSON.stringify(rows), stderr: '' } : { code: 1, stdout: '', stderr: '' });
    const ps = await listCursorProcesses(root, { platform: 'win32', runner });
    assert.deepEqual(ps.map((p) => p.pid), [10, 11, 12]);
    assert.deepEqual(ps.filter((p) => p.main).map((p) => p.pid), [10]);
    const single = await win.listWinProcesses(root, { runner: async () => ({ code: 0, stdout: JSON.stringify(rows[0]), stderr: '' }) });
    assert.equal(single.length, 1);
  });

  it('closes gracefully with taskkill, then forces /T /F when Cursor does not exit', async () => {
    let alive = true;
    const cmds = [];
    const runner = async (cmd, args) => {
      if (cmd === 'taskkill') { cmds.push(args.join(' ')); if (args.includes('/F')) alive = false; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: alive ? JSON.stringify(rows.slice(0, 3)) : '', stderr: '' };
    };
    const r = await win.closeWin(root, { runner, timeoutMs: 50, forceTimeoutMs: 50, sleep: async () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.forced, true);
    assert.deepEqual(cmds, ['/PID 10', '/PID 10 /T /F']);
    assert.deepEqual(r.relaunch, { platform: 'win32', argv: [exe] });

    alive = true; cmds.length = 0;
    const graceful = async (cmd, args) => {
      if (cmd === 'taskkill') { cmds.push(args.join(' ')); alive = false; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: alive ? JSON.stringify(rows.slice(0, 3)) : '', stderr: '' };
    };
    const g = await closeCursor(root, { platform: 'win32', runner: graceful, timeoutMs: 1000 });
    assert.equal(g.ok, true);
    assert.equal(g.forced, undefined);
    assert.deepEqual(cmds, ['/PID 10']);
  });

  it('relaunches the exe detached without inheriting ELECTRON_RUN_AS_NODE', () => {
    let got;
    relaunchCursor({ platform: 'win32', argv: [exe] }, { spawnFn: (c, a, o) => { got = { c, a, o }; return { pid: 5, unref() {} }; } });
    assert.equal(got.c, exe);
    assert.deepEqual(got.a, []);
    assert.equal(got.o.detached, true);
    assert.equal(got.o.env.ELECTRON_RUN_AS_NODE, undefined);
  });
});

describe('windows: UAC helper', () => {
  it('builds an -EncodedCommand that embeds the helper and safely quoted paths (spaces, apostrophes)', () => {
    const enc = win.encodeHelper("param([string]$Manifest)\n# comment\nWrite-Output $Manifest", "C:\\Users\\O'Brien\\a b\\apply.tsv", 'C:\\r.txt');
    const text = Buffer.from(enc, 'base64').toString('utf16le');
    assert.match(text, /-Manifest 'C:\\Users\\O''Brien\\a b\\apply.tsv'/);
    assert.doesNotMatch(text, /# comment/);
    const launcher = win.uacLauncher(enc);
    assert.match(launcher, /Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru/);
    assert.match(launcher, /exit 1223/);
    assert.ok(launcher.length < 32000);
    assert.equal(win.manualCommand('C:\\a b\\czl-apply.ps1', 'C:\\a b\\apply.tsv'), 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\a b\\czl-apply.ps1" -Manifest "C:\\a b\\apply.tsv"');
  });

  it('the real helper length stays well under the 32767-char command line limit', async () => {
    const script = await fs.readFile(win.WIN_HELPER_PATH, 'utf8');
    const launcher = win.uacLauncher(win.encodeHelper(script, 'C:\\Users\\someone with a long name\\AppData\\Roaming\\cursor-zh-localizer\\elevate\\apply.tsv', 'C:\\x\\apply.result.txt'));
    assert.ok(launcher.length < 20000, `launcher ${launcher.length}`);
  });

  async function stagedInstall() {
    const base = await tmp('winuac-');
    const root = await fakeInstall(path.join(base, 'Program Files', 'cursor'), { target: 'system' });
    const stage = path.join(base, "stage dir'x");
    await fs.mkdir(stage, { recursive: true });
    const src = path.join(stage, 'w.js');
    await fs.writeFile(src, 'a="Cursor 设置";');
    return { base, root, items: [{ relative: REL, src, sha256: await sha256File(src) }] };
  }

  it('applyFiles(win32): Program Files not writable → UAC; cancelled → manual admin PowerShell command with BOM helper copy', async () => {
    const { base, root, items } = await stagedInstall();
    const seen = [];
    const runner = async (cmd, args) => { seen.push(cmd); return { code: 1223, stdout: '', stderr: '' }; };
    const r = await applyFiles({ installRoot: root, items, workDir: path.join(base, 'work'), platform: 'win32', runner, probe: async () => 'EPERM' });
    assert.equal(r.code, 'NEED_ELEVATION');
    assert.deepEqual(r.tried, [{ via: 'UAC', reason: '授权被取消' }]);
    assert.deepEqual(seen, ['powershell.exe']);
    assert.match(r.command, /^powershell -NoProfile -ExecutionPolicy Bypass -File ".*czl-apply\.ps1" -Manifest ".*apply\.tsv"$/);
    assert.match(r.error, /管理员身份打开 PowerShell/);
    const helper = await fs.readFile(r.helper);
    assert.deepEqual([...helper.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  it('checkWritable(win32) probes by opening for write (W_OK ignores ACLs on Windows)', async () => {
    const { root } = await stagedInstall();
    const w = await checkWritable(root, [REL], { platform: 'win32', probe: async () => 'EPERM' });
    assert.equal(w.writable, false);
    assert.equal(w.readOnlyFs, false);
    assert.equal((await checkWritable(root, [REL], { platform: 'win32' })).writable, true);
  });

  it('real czl-apply.ps1 under PowerShell: UAC path end-to-end, rejects tampering and disallowed targets', { skip: !PWSH && 'pwsh not installed' }, async () => {
    const { base, root, items } = await stagedInstall();
    // 假 runner：把 UAC 启动器里的 -EncodedCommand 取出来直接交给 pwsh 运行（相当于用户点了“是”）
    const runner = async (cmd, args) => {
      const enc = args.at(-1).match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
      try { execFileSync(PWSH, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { stdio: 'pipe' }); return { code: 0, stdout: '', stderr: '' }; }
      catch (e) { return { code: e.status, stdout: '', stderr: String(e.stderr) }; }
    };
    const r = await applyFiles({ installRoot: root, items, workDir: path.join(base, 'work dir'), platform: 'win32', runner, probe: async () => 'EPERM' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.method, 'uac');
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), 'a="Cursor 设置";');
    assert.match(await fs.readFile(path.join(base, 'work dir', 'apply.result.txt'), 'utf8'), /^OK .*EXIT 0/s);

    // 准备好的文件被改动 → 3，安装目录不变
    await fs.writeFile(items[0].src, 'tampered');
    const t = await applyFiles({ installRoot: root, items, workDir: path.join(base, 'work dir'), platform: 'win32', runner, probe: async () => 'EPERM' });
    assert.equal(t.code, 'HELPER_FAILED');
    assert.match(t.error, /准备好的文件被改动过/);
    assert.match(t.error, /源文件校验失败/);
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), 'a="Cursor 设置";');

    // 清单直接交给 -File 模式（手动命令）：不允许改白名单外的文件
    const evil = path.join(base, 'evil.tsv');
    await fs.writeFile(path.join(root, 'Cursor.exe.js'), 'x');
    await fs.writeFile(evil, `CZL1\t${root}\n${items[0].sha256}\t${items[0].src}\tCursor.exe.js\n`);
    let code = 0;
    try { execFileSync(PWSH, ['-NoProfile', '-File', win.WIN_HELPER_PATH, '-Manifest', evil], { stdio: 'pipe' }); } catch (e) { code = e.status; }
    assert.equal(code, 2);
    await fs.writeFile(evil, `CZL1\t${root}\n${items[0].sha256}\t${items[0].src}\tresources/app/../../x.js\n`);
    try { execFileSync(PWSH, ['-NoProfile', '-File', win.WIN_HELPER_PATH, '-Manifest', evil], { stdio: 'pipe' }); code = 0; } catch (e) { code = e.status; }
    assert.equal(code, 2);
  });
});

describe('windows: localize/revert on a fake user install', () => {
  it('localizes, keeps product.json target, writes checksum, reverts byte-for-byte', async () => {
    const base = await tmp('winloc-');
    const env = { LOCALAPPDATA: path.join(base, 'Local'), APPDATA: path.join(base, 'Roaming'), USERPROFILE: base };
    const root = await fakeInstall(path.join(env.LOCALAPPDATA, 'Programs', 'cursor'));
    const productBefore = await fs.readFile(path.join(root, 'resources/app/product.json'), 'utf8');
    const cliPath = path.join(base, 'cursor-cli.sh');
    await fs.writeFile(cliPath, `#!/bin/sh
ext=""; while [ $# -gt 0 ]; do case "$1" in --extensions-dir) ext="$2"; shift;; --install-extension) mode=i;; --uninstall-extension) mode=u;; esac; shift; done
[ "$mode" = i ] && mkdir -p "$ext/ms-ceintl.vscode-language-pack-zh-hans-1.128.0"
[ "$mode" = u ] && rm -rf "$ext"/ms-ceintl.vscode-language-pack-zh-hans-*
exit 0
`, { mode: 0o755 });
    const runner = async () => ({ code: 0, stdout: '', stderr: '' }); // 没有运行中的 Cursor、注册表为空
    const opts = {
      platform: 'win32', env, installRoot: root, cliPath, vsixPath: '/fake.vsix', platformRunner: runner,
      ...defaultPaths(base, 'win32', env),
      anchorsDir: path.join(repo, 'packages/engine/test/fixtures/anchors'), dictPath: path.join(repo, 'packages/engine/test/fixtures/dict.json'),
    };
    const r = await localize(opts);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.method, 'direct');
    const product = JSON.parse(await fs.readFile(path.join(root, 'resources/app/product.json'), 'utf8'));
    assert.equal(product.target, 'user');
    assert.equal(product.checksums[KEY], vscodeChecksum(await fs.readFile(path.join(root, REL))));
    const st = await status(opts);
    assert.equal(st.localized, true);
    assert.equal(st.kind, 'win-user');
    assert.equal(st.platform, 'win32');
    assert.equal(st.needsElevation, false);
    assert.deepEqual(st.appImages, []);
    const rv = await revert(opts);
    assert.equal(rv.ok, true, rv.error);
    assert.equal(await fs.readFile(path.join(root, 'resources/app/product.json'), 'utf8'), productBefore);
    assert.equal((await readState(opts.dataDir)).localized, false);
  });
});
