import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';
import { spawn } from 'node:child_process';

// 找出某个 Cursor 安装（<root>/cursor）正在运行的进程。主进程 = 不带 --type= 的那个；cli.js 是一次性命令行进程，跳过
export async function listCursorProcesses(root, { procDir = '/proc', selfPid = process.pid } = {}) {
  if (process.platform !== 'linux' && procDir === '/proc') return [];
  const exe = path.join(root, 'cursor');
  let realExe = exe;
  try { realExe = await fs.realpath(exe); } catch {}
  const out = [];
  let pids = [];
  try { pids = (await fs.readdir(procDir)).filter((d) => /^\d+$/.test(d)); } catch { return out; }
  for (const d of pids) {
    const pid = Number(d);
    if (pid === selfPid) continue;
    let argv;
    try { argv = (await fs.readFile(path.join(procDir, d, 'cmdline'), 'utf8')).split('\0').filter((a, i, all) => a || i < all.length - 1); }
    catch { continue; }
    if (!argv.length || !argv[0]) continue;
    let exeLink = null;
    try { exeLink = await fs.readlink(path.join(procDir, d, 'exe')); } catch {}
    // Chromium 会改写进程标题：/proc/<pid>/cmdline 变成一整串用空格连接的命令行，按空格拆回参数（路径含空格时会有误差）
    if (argv.length === 1 && argv[0].includes(' ')) {
      const prefix = [exe, realExe].find((e) => argv[0].startsWith(e + ' '));
      argv = prefix ? [prefix, ...argv[0].slice(prefix.length + 1).split(' ').filter(Boolean)] : argv[0].split(' ');
    }
    if (argv[0] !== exe && argv[0] !== realExe && exeLink !== realExe) continue;
    if (argv.some((a) => /[/\\]out[/\\]cli\.js$/.test(a))) continue;
    let ppid = null;
    try { ppid = Number((await fs.readFile(path.join(procDir, d, 'stat'), 'utf8')).replace(/^.*\)\s+/s, '').split(' ')[1]); } catch {}
    out.push({ pid, ppid, argv });
  }
  // 主进程：父进程不是同一个 Cursor 的进程，且没有 --type=（渲染/GPU/工具进程都有；扩展宿主、gitWorker 是主进程的子进程）
  const all = new Set(out.map((p) => p.pid));
  for (const p of out) p.main = !p.argv.some((a) => a.startsWith('--type=')) && !all.has(p.ppid);
  return out;
}

async function procInfo(procDir, pid) {
  const cwd = await fs.readlink(path.join(procDir, String(pid), 'cwd')).catch(() => undefined);
  const env = {};
  try {
    for (const kv of (await fs.readFile(path.join(procDir, String(pid), 'environ'), 'utf8')).split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  } catch {}
  return { cwd, env };
}

// Cursor/VS Code 收到 SIGTERM 会正常退出（未保存内容由热退出机制保存，下次启动恢复）
export async function closeCursor(root, { procDir = '/proc', timeoutMs = 20000, kill = process.kill.bind(process), log = () => {} } = {}) {
  const procs = await listCursorProcesses(root, { procDir });
  const mains = procs.filter((p) => p.main);
  if (!procs.length) return { ok: true, closed: false };
  const first = mains[0] ?? procs[0];
  const relaunch = { argv: first.argv, ...(await procInfo(procDir, first.pid)) };
  log(`正在关闭 Cursor（${mains.length || procs.length} 个主进程）…`);
  for (const p of mains.length ? mains : procs) { try { kill(p.pid, 'SIGTERM'); } catch {} }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await listCursorProcesses(root, { procDir })).length) return { ok: true, closed: true, relaunch };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, closed: false, relaunch, error: `Cursor 在 ${Math.round(timeoutMs / 1000)} 秒内没有退出，请手动关闭（可能有未保存文件的确认框）后重试` };
}

const DROP_ENV = /^(VSCODE_|ELECTRON_RUN_AS_NODE$)/;

export function relaunchCursor({ argv, cwd, env }, { spawnFn = spawn, logFile } = {}) {
  const e = { ...(env && Object.keys(env).length ? env : process.env) };
  for (const k of Object.keys(e)) if (DROP_ENV.test(k)) delete e[k];
  let stdio = 'ignore';
  if (logFile) { try { const fd = fsSync.openSync(logFile, 'a'); stdio = ['ignore', fd, fd]; } catch {} }
  const child = spawnFn(argv[0], argv.slice(1), { cwd: cwd || process.env.HOME, env: e, detached: true, stdio });
  child.unref?.();
  return { pid: child.pid };
}
