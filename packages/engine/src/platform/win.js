import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as defaultRun } from './exec.js';

// Windows 支持：安装检测（用户版 / 系统版 / 注册表卸载项）、用户目录、进程关闭与重开、UAC 提权写入。
// 用户版（CursorUserSetup）：%LOCALAPPDATA%\Programs\cursor，当前用户可写，不需要提权；
// 系统版（CursorSetup）：C:\Program Files\cursor，需要管理员（UAC）。
export const WIN_HELPER_PATH = fileURLToPath(new URL('../../helper/czl-apply.ps1', import.meta.url));
const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];
const lower = (s) => String(s).toLowerCase();
const norm = (p) => lower(p).replace(/\//g, '\\').replace(/\\+$/, '');
const under = (p, dir) => !!dir && norm(p).startsWith(norm(dir) + '\\');

export function winDefaultRoots(env) {
  const out = [];
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Programs', 'cursor'));
  for (const pf of [env.ProgramFiles, env.ProgramW6432]) if (pf) out.push(path.join(pf, 'cursor'));
  return [...new Set(out)];
}

// 解析 `reg query <key> /s` 的输出：每个子键一段，值行形如 "    InstallLocation    REG_SZ    C:\...\cursor\"
export function parseRegQuery(text) {
  const keys = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) { cur = { key: line.trim(), values: {} }; keys.push(cur); continue; }
    const m = line.match(/^\s{2,}(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/) || line.match(/^\s{2,}(.+?)\s{2,}(REG_\w+)\s*$/);
    if (cur && m) cur.values[m[1]] = (m[3] ?? '').trim();
  }
  return keys;
}

// 注册表卸载项里 DisplayName 以 Cursor 开头的安装位置（Inno Setup 写的 InstallLocation）
export async function winRegistryRoots({ runner = defaultRun } = {}) {
  const out = [];
  for (const k of UNINSTALL_KEYS) {
    const r = await runner('reg', ['query', k, '/s']);
    if (r.code !== 0) continue;
    for (const e of parseRegQuery(r.stdout)) {
      const name = e.values.DisplayName ?? '';
      const loc = (e.values.InstallLocation ?? '').replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
      if (/^Cursor\b/i.test(name) && loc) out.push({ root: loc, hive: k.slice(0, 4), displayName: name, version: e.values.DisplayVersion ?? null });
    }
  }
  return out;
}

export function winInstallKind(root, env) {
  if (under(root, env.LOCALAPPDATA)) return 'win-user';
  if ([env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].some((d) => under(root, d))) return 'win-system';
  return 'win-other';
}

export function winDefaultPaths(env, home) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const profile = env.USERPROFILE || home;
  return {
    userDataDir: path.join(appData, 'Cursor'),
    extensionsDir: path.join(profile, '.cursor', 'extensions'),
    argvPath: path.join(profile, '.cursor', 'argv.json'),
    dataDir: path.join(appData, 'cursor-zh-localizer'),
  };
}

// Cursor 自带 CLI（resources\app\bin\cursor.cmd）就是 ELECTRON_RUN_AS_NODE=1 Cursor.exe out\cli.js；
// 直接这样调用，免得 .cmd 必须走 shell（Node 18.20+/20.12+ 禁止不经 shell 执行 .cmd）
export function winCli(root) {
  return { cmd: path.join(root, 'Cursor.exe'), args: [path.join(root, 'resources', 'app', 'out', 'cli.js')], env: { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } };
}

// 进程列表：PowerShell 的 CIM 查询给出可执行文件路径和完整命令行（tasklist 没有路径）
const PS_LIST = "Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
export async function listWinProcesses(root, { runner = defaultRun, selfPid = process.pid } = {}) {
  const r = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST]);
  if (r.code !== 0 || !r.stdout.trim()) return [];
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return []; }
  if (!Array.isArray(rows)) rows = [rows];
  const exe = norm(path.join(root, 'Cursor.exe'));
  const out = rows
    .filter((p) => p && p.ProcessId !== selfPid && p.ExecutablePath && norm(p.ExecutablePath) === exe)
    .filter((p) => !/[\\/]out[\\/]cli\.js/i.test(p.CommandLine ?? ''))
    .map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, exe: p.ExecutablePath, commandLine: p.CommandLine ?? '', argv: [p.ExecutablePath] }));
  const all = new Set(out.map((p) => p.pid));
  for (const p of out) p.main = !/\s--type=/.test(p.commandLine) && !all.has(p.ppid);
  return out;
}

// 先 taskkill（不带 /F，发 WM_CLOSE，Cursor 正常退出、热退出保存未保存内容），超时再 /F /T 强制结束整棵进程树
export async function closeWin(root, { runner = defaultRun, timeoutMs = 20000, forceTimeoutMs = 8000, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), list = listWinProcesses } = {}) {
  const procs = await list(root, { runner });
  if (!procs.length) return { ok: true, closed: false };
  const mains = procs.filter((p) => p.main);
  const targets = mains.length ? mains : procs;
  const relaunch = { platform: 'win32', argv: [targets[0].exe] };
  log(`正在关闭 Cursor（${targets.length} 个主进程）…`);
  for (const p of targets) await runner('taskkill', ['/PID', String(p.pid)]);
  const waitGone = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await list(root, { runner })).length) return true;
      await sleep(500);
    }
    return !(await list(root, { runner })).length;
  };
  if (await waitGone(timeoutMs)) return { ok: true, closed: true, relaunch };
  log('Cursor 未在规定时间内退出（可能有确认框），强制结束…');
  for (const p of targets) await runner('taskkill', ['/PID', String(p.pid), '/T', '/F']);
  if (await waitGone(forceTimeoutMs)) return { ok: true, closed: true, forced: true, relaunch };
  return { ok: false, closed: false, relaunch, error: '无法结束 Cursor 进程，请在任务管理器里结束 Cursor 后重试' };
}

// ---------- UAC 提权 ----------
export const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// 把 helper 正文（去掉纯注释行）包成脚本块带参数调用，再按 -EncodedCommand 要求编码成 UTF-16LE base64
export function encodeHelper(script, manifest, resultFile) {
  const body = script.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  const text = `& {\n${body}\n} -Manifest ${psq(manifest)} -ResultFile ${psq(resultFile)}`;
  return Buffer.from(text, 'utf16le').toString('base64');
}

// 普通权限的 powershell 启动 UAC 提权的 powershell 并等待它结束，把退出码原样带回；用户点“否” → 1223
export function uacLauncher(encoded) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded].map(psq).join(',');
  return [
    "$ErrorActionPreference = 'Stop'",
    `try { $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(${args}); exit $p.ExitCode }`,
    "catch { if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.HResult -eq -2147023673 -or $_.Exception.Message -match 'cancel') { exit 1223 }; [Console]::Error.WriteLine($_.Exception.Message); exit 127 }",
  ].join('\n');
}

export function manualCommand(helperCopy, manifest) {
  const dq = (s) => `"${String(s).replace(/"/g, '`"')}"`;
  return `powershell -NoProfile -ExecutionPolicy Bypass -File ${dq(helperCopy)} -Manifest ${dq(manifest)}`;
}

/**
 * 通过 UAC 运行 helper。返回 {code, stderr, cancelled}
 * 结果文件由提权后的进程写（它的输出无法被普通权限进程捕获）
 */
export async function runUac({ script, manifest, resultFile, runner = defaultRun }) {
  await fs.rm(resultFile, { force: true });
  const r = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', uacLauncher(encodeHelper(script, manifest, resultFile))]);
  let detail = '';
  try { detail = (await fs.readFile(resultFile, 'utf8')).split(/\r?\n/).filter((l) => l && !l.startsWith('EXIT ')).join('\n'); } catch {}
  return { code: r.code, cancelled: r.code === 1223, stderr: detail || r.stderr, spawnError: r.spawnError };
}

// Windows 上 fs.access(W_OK) 只看只读属性，不看 ACL：真正以写方式打开一次才知道（Program Files 下会 EPERM）
export async function probeWritable(file) {
  try { const h = await fs.open(file, 'r+'); await h.close(); return null; }
  catch (e) { return e.code; }
}
