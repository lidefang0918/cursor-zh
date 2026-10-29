import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { applyFiles, applyDirect, HELPER_PATH, manifestText, mountOf, checkWritable, shq } from '../src/elevate.js';
import { sha256File } from '../src/backup.js';
import { listCursorProcesses, closeCursor, relaunchCursor } from '../src/process.js';
import { findAppImages, extractAppImage, listExtracted } from '../src/appimage.js';
import { detectAllCursors } from '../src/detect.js';
import { localize, revert, readState, status } from '../src/localize.js';
import { vscodeChecksum } from '../src/patch.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));
const sh = (args) => new Promise((res) => execFile(args[0], args.slice(1), (e, so, se) => res({ code: e ? e.code : 0, stdout: so, stderr: se })));
const REL = 'resources/app/out/vs/workbench/workbench.desktop.main.js';

async function fakeInstall(js = 'a="Cursor Settings";') {
  const root = await tmp('czl-inst-');
  await fs.mkdir(path.dirname(path.join(root, REL)), { recursive: true });
  await fs.writeFile(path.join(root, REL), js);
  await fs.writeFile(path.join(root, 'resources/app/product.json'), JSON.stringify({ nameShort: 'Cursor', version: 'test-fixture', commit: 'c0ffee', vscodeVersion: '1.128.0', checksums: { 'vs/workbench/workbench.desktop.main.js': vscodeChecksum(Buffer.from(js)) } }, null, 2));
  return root;
}
async function staged(content) {
  const d = await tmp('czl-stage-');
  const src = path.join(d, 'x.js');
  await fs.writeFile(src, content);
  return { src, sha256: await sha256File(src) };
}
const runHelper = (manifest) => sh(['/bin/sh', HELPER_PATH, manifest]);
async function writeManifest(root, items) {
  const m = path.join(await tmp('czl-m-'), 'm.tsv');
  await fs.writeFile(m, manifestText(root, items));
  return m;
}

describe('privileged helper (czl-apply.sh)', () => {
  it('places staged files atomically, keeps mode, verifies sha256', async () => {
    const root = await fakeInstall();
    await fs.chmod(path.join(root, REL), 0o640);
    const s = await staged('a="Cursor 设置";');
    const r = await runHelper(await writeManifest(root, [{ ...s, relative: REL }]));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^OK /m);
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), 'a="Cursor 设置";');
    assert.equal((await fs.stat(path.join(root, REL))).mode & 0o777, 0o640);
    assert.deepEqual((await fs.readdir(path.dirname(path.join(root, REL)))).filter((f) => f.endsWith('.czl-new')), []);
  });

  it('rejects path escapes, disallowed files, tampered sources and non-Cursor roots without touching anything', async () => {
    const root = await fakeInstall();
    const before = await fs.readFile(path.join(root, REL), 'utf8');
    const s = await staged('evil');
    for (const relative of ['../etc/passwd', 'resources/app/../../x.js', 'chrome-sandbox', '/etc/shadow', 'resources/app/node_modules/x.so']) {
      const r = await runHelper(await writeManifest(root, [{ ...s, relative }]));
      assert.equal(r.code, 2, `${relative}: ${r.stderr}`);
    }
    // 源文件在生成清单后被改
    const t = await staged('ok');
    const m = await writeManifest(root, [{ ...t, relative: REL }]);
    await fs.writeFile(t.src, 'tampered');
    assert.equal((await runHelper(m)).code, 3);
    // 软链逃逸
    await fs.mkdir(path.join(root, 'resources/app/out/link'), { recursive: true });
    await fs.symlink('/etc/hostname', path.join(root, 'resources/app/out/link/x.json'));
    const u = await staged('x');
    assert.equal((await runHelper(await writeManifest(root, [{ ...u, relative: 'resources/app/out/link/x.json' }]))).code, 2);
    // 不是 Cursor
    const other = await tmp('czl-notcursor-');
    await fs.mkdir(path.join(other, 'resources/app'), { recursive: true });
    await fs.writeFile(path.join(other, 'resources/app/product.json'), '{"nameShort": "Code"}');
    assert.equal((await runHelper(await writeManifest(other, [{ ...u, relative: 'resources/app/product.json' }]))).code, 2);
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), before);
  });
});

describe('applyFiles elevation strategies', () => {
  const realRun = async (bin, args) => sh(args); // 假装 pkexec/sudo 授权成功：直接以当前用户执行 helper
  it('direct write when writable', async () => {
    const root = await fakeInstall();
    const s = await staged('direct');
    const r = await applyFiles({ installRoot: root, items: [{ ...s, relative: REL }], workDir: await tmp('czl-w-') });
    assert.deepEqual(r, { ok: true, method: 'direct' });
  });
  it('uses pkexec when available and authorised', async () => {
    const root = await fakeInstall();
    const s = await staged('via pkexec');
    const calls = [];
    const r = await applyFiles({ installRoot: root, items: [{ ...s, relative: REL }], workDir: await tmp('czl-w-'), assumeUnwritable: true, env: { DISPLAY: ':9' },
      runner: async (bin, args) => { calls.push(bin); return realRun(bin, args); } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.method, 'pkexec');
    assert.deepEqual(calls, ['/usr/bin/pkexec']);
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), 'via pkexec');
  });
  it('falls back pkexec(no agent) → sudo -n(password needed) → manual command that works when run', async () => {
    const root = await fakeInstall();
    const before = await fs.readFile(path.join(root, REL), 'utf8');
    const s = await staged('manual');
    const r = await applyFiles({ installRoot: root, items: [{ ...s, relative: REL }], workDir: await tmp('czl-w-'), assumeUnwritable: true, env: { DISPLAY: ':9' },
      runner: async (bin) => (bin.endsWith('pkexec')
        ? { code: 127, stdout: '', stderr: 'Error executing command as another user: No authentication agent found.' }
        : { code: 1, stdout: '', stderr: 'sudo: a password is required\n' }) });
    assert.equal(r.code, 'NEED_ELEVATION');
    assert.deepEqual(r.tried.map((t) => t.via), ['pkexec', 'sudo -n']);
    assert.match(r.tried[0].reason, /No authentication agent/);
    assert.equal(r.command, `sudo sh ${shq(r.helper)} ${shq(r.manifest)}`);
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), before);
    // 用户在终端执行的就是同一个 helper（这里不带 sudo 跑）
    assert.equal((await sh(['/bin/sh', r.helper, r.manifest])).code, 0);
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), 'manual');
  });
  it('pkexec cancelled (126) is reported; helper errors are not retried', async () => {
    const root = await fakeInstall();
    const s = await staged('x');
    const items = [{ ...s, relative: REL }];
    const r = await applyFiles({ installRoot: root, items, workDir: await tmp('czl-w-'), assumeUnwritable: true, env: { DISPLAY: ':9' }, strategies: ['pkexec', 'manual'],
      runner: async () => ({ code: 126, stdout: '', stderr: '' }) });
    assert.equal(r.code, 'NEED_ELEVATION');
    assert.match(r.tried[0].reason, /取消/);
    const calls = [];
    const r2 = await applyFiles({ installRoot: root, items, workDir: await tmp('czl-w-'), assumeUnwritable: true, env: { DISPLAY: ':9' },
      runner: async (bin) => { calls.push(bin); return { code: 3, stdout: '', stderr: 'czl-apply: 源文件校验失败' }; } });
    assert.equal(r2.code, 'HELPER_FAILED');
    assert.deepEqual(calls, ['/usr/bin/pkexec']);
  });
  it('detects read-only mounts (AppImage squashfs)', async () => {
    const mf = path.join(await tmp('czl-mounts-'), 'mounts');
    await fs.writeFile(mf, 'sysfs /sys sysfs rw 0 0\n/dev/vda / ext4 rw,relatime 0 0\nCursor.AppImage /tmp/.mount_CursorAbc fuse.Cursor.AppImage ro,nosuid 0 0\n/dev/loop0 /snap/x squashfs ro 0 0\n');
    assert.equal((await mountOf('/tmp/.mount_CursorAbc/usr/share/cursor', { mountsFile: mf })).readOnly, true);
    assert.equal((await mountOf('/snap/x/y', { mountsFile: mf })).fstype, 'squashfs');
    assert.equal((await mountOf('/usr/share/cursor', { mountsFile: mf })).readOnly, false);
    assert.equal((await checkWritable(await fakeInstall(), [REL])).writable, true);
  });
});

async function fakeProc(entries) {
  const d = await tmp('czl-proc-');
  for (const { pid, argv, env = {}, ppid = 1 } of entries) {
    await fs.mkdir(path.join(d, String(pid)));
    await fs.writeFile(path.join(d, String(pid), 'cmdline'), argv.join('\0') + '\0');
    await fs.writeFile(path.join(d, String(pid), 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
    await fs.symlink('/home', path.join(d, String(pid), 'cwd'));
    await fs.writeFile(path.join(d, String(pid), 'stat'), `${pid} (cursor) S ${ppid} 0 0`);
  }
  return d;
}

describe('Cursor process handling', () => {
  it('finds main + child processes, ignores cli.js and other apps; closes and captures relaunch info', async () => {
    const root = '/opt/fake-cursor';
    const exe = `${root}/cursor`;
    const procDir = await fakeProc([
      { pid: 100, argv: [exe, '--disable-gpu'], env: { DISPLAY: ':5', VSCODE_CWD: '/x', HOME: '/home/u' } },
      { pid: 101, argv: [exe, '--type=renderer'] },
      { pid: 102, argv: [exe, `${root}/resources/app/out/cli.js`, '--list-extensions'] },
      { pid: 103, argv: ['/usr/bin/code', '--type=renderer'] },
      { pid: 104, argv: [`${exe} --type=gpu-process --enable-crash-reporter`] }, // Chromium 改写过的标题
      { pid: 105, argv: [exe, '/x/gitWorker.js'], ppid: 100 }, // 主进程派生的工具进程
    ]);
    const ps = await listCursorProcesses(root, { procDir });
    assert.deepEqual(ps.map((p) => [p.pid, p.main]), [[100, true], [101, false], [104, false], [105, false]]);
    assert.deepEqual(ps[2].argv, [exe, '--type=gpu-process', '--enable-crash-reporter']);
    const killed = [];
    const c = await closeCursor(root, { procDir, timeoutMs: 3000, kill: async (pid, sig) => {
      killed.push([pid, sig]);
      for (const p of [100, 101, 104, 105]) await fs.rm(path.join(procDir, String(p)), { recursive: true, force: true });
    } });
    assert.equal(c.ok, true);
    assert.deepEqual(killed, [[100, 'SIGTERM']]);
    assert.deepEqual(c.relaunch.argv, [exe, '--disable-gpu']);
    assert.equal(c.relaunch.env.DISPLAY, ':5');
    let spawned;
    relaunchCursor(c.relaunch, { spawnFn: (cmd, args, o) => { spawned = { cmd, args, o }; return { pid: 1, unref() {} }; } });
    assert.equal(spawned.cmd, exe);
    assert.deepEqual(spawned.args, ['--disable-gpu']);
    assert.equal(spawned.o.detached, true);
    assert.equal(spawned.o.env.VSCODE_CWD, undefined);
    assert.equal(spawned.o.env.DISPLAY, ':5');
  });
  it('reports when Cursor does not exit in time', async () => {
    const root = '/opt/fake-cursor';
    const procDir = await fakeProc([{ pid: 200, argv: [`${root}/cursor`] }]);
    const c = await closeCursor(root, { procDir, timeoutMs: 400, kill: () => {} });
    assert.equal(c.ok, false);
    assert.match(c.error, /没有退出/);
  });
});

describe('AppImage', () => {
  it('finds Cursor AppImages, extracts into a user-writable copy with launcher, and detects it', async () => {
    const home = await tmp('czl-home-');
    await fs.mkdir(path.join(home, 'Applications'));
    const ai = path.join(home, 'Applications', 'Cursor-9.9.9-x86_64.AppImage');
    // 假 AppImage：--appimage-extract 时在 cwd 生成 squashfs-root
    await fs.writeFile(ai, `#!/bin/sh
[ "$1" = --appimage-extract ] || exit 9
mkdir -p squashfs-root/usr/share/cursor/resources/app
echo '{"nameShort":"Cursor","version":"9.9.9","vscodeVersion":"1.128.0"}' > squashfs-root/usr/share/cursor/resources/app/product.json
printf '#!/bin/sh\\n' > squashfs-root/AppRun; chmod +x squashfs-root/AppRun
`, { mode: 0o644 });
    const found = await findAppImages({ home, dirs: [path.join(home, 'Applications')], procDir: await tmp('czl-noproc-') });
    assert.deepEqual(found.map((f) => [path.basename(f.path), f.version]), [['Cursor-9.9.9-x86_64.AppImage', '9.9.9']]);
    const logs = [];
    const x = await extractAppImage({ appImagePath: ai, home, log: (m) => logs.push(m) });
    assert.equal(x.version, '9.9.9');
    assert.ok(logs.some((l) => /可执行权限/.test(l)));
    assert.match(await fs.readFile(x.desktopFile, 'utf8'), /Exec=".*\/9\.9\.9\/AppRun" %F/);
    assert.equal(await fs.readlink(x.binLink), x.appRun);
    assert.deepEqual((await listExtracted({ home })).map((e) => e.version), ['9.9.9']);
    const all = await detectAllCursors({ platform: 'linux', env: { HOME: home } });
    const mine = all.find((i) => i.root === x.root);
    assert.equal(mine.kind, 'appimage-extracted');
    await assert.rejects(extractAppImage({ appImagePath: ai, home }), /已经解包过/);
  });
});

// 安装文件不可写（模拟 root 所有）时的完整流程：等管理员命令 → 执行 → 继续完成；还原同理
async function engineSetup() {
  const root = await fakeInstall('a="Cursor Settings";b="New Agent";');
  const home = await tmp('czl-h-');
  const cliDir = await tmp('czl-cli-');
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
    listRunning: async () => [], assumeUnwritable: true, elevateStrategies: ['manual'],
  };
  return { root, opts };
}

describe('localize/revert with elevation', () => {
  it('manual sudo path: pending → run command → continue; revert the same way', async () => {
    const { root, opts } = await engineSetup();
    const orig = await fs.readFile(path.join(root, REL), 'utf8');
    const r = await localize(opts);
    assert.equal(r.code, 'NEED_ELEVATION');
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), orig);
    const st = await status(opts);
    assert.equal(st.pending.kind, 'localize');
    assert.equal(st.pending.applied, false);
    assert.equal(st.localized, false);
    // 用户执行命令（去掉 sudo）
    assert.equal((await sh(['/bin/sh', r.helper, r.manifest])).code, 0);
    assert.equal((await status(opts)).pending.applied, true);
    const r2 = await localize(opts);
    assert.equal(r2.ok, true, r2.error);
    assert.match(await fs.readFile(path.join(root, REL), 'utf8'), /Cursor 设置/);
    assert.equal((await readState(opts.dataDir)).localized, true);
    assert.equal((await readState(opts.dataDir)).pending, undefined);

    const v = await revert(opts);
    assert.equal(v.code, 'NEED_ELEVATION');
    assert.match(await fs.readFile(path.join(root, REL), 'utf8'), /Cursor 设置/);
    assert.equal((await sh(['/bin/sh', v.helper, v.manifest])).code, 0);
    const v2 = await revert(opts);
    assert.equal(v2.ok, true, v2.error);
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), orig);
    assert.equal((await readState(opts.dataDir)).localized, false);
  });
  it('revert cancels a pending localize that was never applied', async () => {
    const { root, opts } = await engineSetup();
    assert.equal((await localize(opts)).code, 'NEED_ELEVATION');
    const v = await revert(opts);
    assert.equal(v.ok, true);
    assert.equal(v.cancelledPending, true);
    assert.equal((await readState(opts.dataDir)).pending, undefined);
    assert.equal((await localize(opts)).code, 'NEED_ELEVATION'); // 可以重新开始
  });
  it('closes a running Cursor when allowed and relaunches it afterwards', async () => {
    const { opts } = await engineSetup();
    let running = [{ pid: 1, main: true, argv: ['/x/cursor'] }];
    const events = [];
    const o = { ...opts, assumeUnwritable: false, listRunning: async () => running,
      closeCursor: async () => { events.push('close'); running = []; return { ok: true, closed: true, relaunch: { argv: ['/x/cursor', '--a'] } }; },
      relaunchCursor: (rl) => events.push(`relaunch ${rl.argv.join(' ')}`) };
    assert.equal((await localize(o)).code, 'CURSOR_RUNNING');
    assert.deepEqual(events, []);
    const r = await localize({ ...o, closeRunning: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.relaunched, true);
    assert.deepEqual(events, ['close', 'relaunch /x/cursor --a']);
  });
});

describe('applyDirect (crash safety)', () => {
  const setup = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-'));
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'ads-'));
    const items = [];
    for (const [rel, orig, next] of [['a/x.js', 'X0', 'X1'], ['b/y.json', 'Y0', 'Y1'], ['z.txt', 'Z0', 'Z1']]) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), orig);
      await fs.writeFile(path.join(stage, rel.replace(/\//g, '_')), next);
      items.push({ relative: rel, src: path.join(stage, rel.replace(/\//g, '_')), sha256: crypto.createHash('sha256').update(next).digest('hex') });
    }
    return { root, items };
  };
  const read = (root) => Promise.all(['a/x.js', 'b/y.json', 'z.txt'].map((r) => fs.readFile(path.join(root, r), 'utf8')));
  const leftovers = async (root) => (await fs.readdir(root, { recursive: true })).filter((f) => /\.czl-(new|old)$/.test(f));

  it('replaces all files and leaves no temp files', async () => {
    const { root, items } = await setup();
    await applyDirect(root, items);
    assert.deepEqual(await read(root), ['X1', 'Y1', 'Z1']);
    assert.deepEqual(await leftovers(root), []);
  });

  it('rolls back every file when a swap fails midway', async () => {
    const { root, items } = await setup();
    let n = 0;
    await assert.rejects(applyDirect(root, items, { hooks: { beforeSwap: () => { if (++n === 3) throw new Error('disk full'); } } }), /已回滚/);
    assert.deepEqual(await read(root), ['X0', 'Y0', 'Z0']);
    assert.deepEqual(await leftovers(root), []);
  });

  it('never touches the install when a staged file is corrupt', async () => {
    const { root, items } = await setup();
    items[1].sha256 = 'bad';
    await assert.rejects(applyDirect(root, items), /校验失败/);
    assert.deepEqual(await read(root), ['X0', 'Y0', 'Z0']);
    assert.deepEqual(await leftovers(root), []);
  });
});
