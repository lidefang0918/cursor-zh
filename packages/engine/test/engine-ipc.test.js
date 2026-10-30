// scripts/engine-ipc.mjs：Tauri 外壳与引擎之间的 NDJSON 协议
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = path.join(repo, 'scripts/engine-ipc.mjs');
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), `czl-ipc-${p}`));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function ipc(args, env = {}) {
  return new Promise((res) => execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env } }, (e, stdout, stderr) => {
    const lines = stdout.split('\n').filter(Boolean);
    res({ code: e ? e.code : 0, lines: lines.map((l) => JSON.parse(l)), raw: lines, stderr });
  }));
}

async function fakeInstall(version = '0.0.1-ipc-test') {
  const root = await tmp('inst-');
  await fs.mkdir(path.join(root, 'resources/app/out'), { recursive: true });
  await fs.writeFile(path.join(root, 'resources/app/product.json'), JSON.stringify({ version, vscodeVersion: '1.128.0', commit: 'c0ffee', checksums: {} }));
  const home = await tmp('home-');
  return { root, home, env: { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), CZL_GUI_LOG: path.join(home, 'gui.log'), ELECTRON_RUN_AS_NODE: '1' } };
}

describe('engine-ipc', () => {
  it('status：只输出 JSON 行，最后一行是 result', async () => {
    const { root, env } = await fakeInstall();
    const r = await ipc(['status', b64({ installRoot: root })], env);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.lines.length >= 1);
    const last = r.lines.at(-1);
    assert.equal(last.t, 'result');
    assert.equal(last.data.cursor.root, root);
    assert.equal(last.data.supported, false);
    assert.equal(last.data.logFile, env.CZL_GUI_LOG);
  });

  it('localize 未适配版本：业务失败也以 result 结束，带 code/next，写 gui.log', async () => {
    const { root, env } = await fakeInstall();
    const r = await ipc(['localize', b64({ installRoot: root, closeRunning: true })], env);
    assert.equal(r.code, 0, r.stderr);
    for (const l of r.lines) assert.ok(l.t === 'log' || l.t === 'result');
    const last = r.lines.at(-1).data;
    assert.equal(last.ok, false);
    assert.ok(last.code);
    assert.ok(last.next, '应带下一步提示');
    const log = await fs.readFile(env.CZL_GUI_LOG, 'utf8');
    assert.match(log, /== localize/);
    assert.match(log, /结果 \{/);
  });

  it('选项也可以走环境变量 CZL_IPC_OPTS，且不传给引擎的子进程', async () => {
    const { root, env } = await fakeInstall();
    const r = await ipc(['status'], { ...env, CZL_IPC_OPTS: JSON.stringify({ installRoot: root }) });
    assert.equal(r.lines.at(-1).data.cursor.root, root);
  });

  it('未知操作退出码 2；坏参数返回 EXCEPTION', async () => {
    const { env } = await fakeInstall();
    const u = await ipc(['nope'], env);
    assert.equal(u.code, 2);
    assert.equal(u.lines.at(-1).data.code, 'USAGE');
    const b = await ipc(['status', '!!!'], env);
    assert.equal(b.code, 0);
    assert.equal(b.lines.at(-1).data.code, 'EXCEPTION');
    assert.ok(b.lines.at(-1).data.next);
  });
});
