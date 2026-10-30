import fs from 'node:fs/promises';
import path from 'node:path';
import { run as defaultRun } from './exec.js';

// macOS 支持。安装根统一取 Cursor.app/Contents（product.json 在 Contents/Resources/app/）。
//
// 签名：Cursor 是 Developer ID 签名 + 公证的应用，Resources/app 下的文件都被 _CodeSignature/CodeResources 封存。
// 改了 JS 后封存失效：带隔离属性时 Gatekeeper 报“已损坏”，Ventura 起 Gatekeeper 首次启动也会校验公证应用的完整性。
// 所以默认（macSign='adhoc'）在写入后对外层 Cursor.app 做 ad-hoc 重签名（只改 MacOS/Cursor 和 _CodeSignature/CodeResources，
// 内嵌的 Frameworks/Helpers 未改动、保留原 Developer ID 签名），并去掉 com.apple.quarantine。
// 重签名不加 --options runtime：主程序的权限声明里没有 disable-library-validation，ad-hoc（无团队 ID）的主程序若开着
// 加固运行时就无法加载 Cursor 团队签名的 Electron Framework。
// 'adhoc-deep' 按 `codesign --force --deep --sign -` 把所有内嵌代码也重签（备份整个 .app 的 APFS 克隆，还原时整体换回）。
// 'none' 不重签（保留原签名的“已损坏”风险，仅供高级用户）。
// 还原：把备份的 MacOS/Cursor 与 _CodeSignature/CodeResources 连同原版 JS 一起写回 → 原 Developer ID 签名重新有效。
export const MAC_SIGN_FILES = ['MacOS/Cursor', '_CodeSignature/CodeResources'];
export const SIGN_MODES = ['adhoc', 'adhoc-deep', 'none'];

export const appPathOf = (root) => (/\.app\/Contents\/?$/.test(root) ? root.replace(/\/Contents\/?$/, '') : null);

export function macDefaultRoots(env, home) {
  return ['/Applications/Cursor.app/Contents', path.join(home, 'Applications/Cursor.app/Contents')];
}

export function macDefaultPaths(home) {
  const support = path.join(home, 'Library', 'Application Support');
  return {
    userDataDir: path.join(support, 'Cursor'),
    extensionsDir: path.join(home, '.cursor', 'extensions'),
    argvPath: path.join(home, '.cursor', 'argv.json'),
    // 数据目录（含备份、状态、日志）沿用旧名 cursor-zh-localizer，不随项目改名为 cursor-zh：已汉化的用户靠这里的备份还原
    dataDir: path.join(support, 'cursor-zh-localizer'),
  };
}

// App Translocation：从“下载”里直接双击打开的隔离应用会被系统挂到 /private/var/folders/.../AppTranslocation/<随机>/d/ 下的只读位置运行
export const isTranslocated = (p) => /\/AppTranslocation\//.test(p);

export function macInstallKind(root, home) {
  if (isTranslocated(root)) return 'mac-translocated';
  if (root.startsWith('/Applications/')) return 'mac-applications';
  if (root.startsWith(path.join(home, 'Applications') + '/')) return 'mac-user-applications';
  return 'mac-other';
}

export function macCli(root) {
  return { cmd: path.join(root, 'MacOS', 'Cursor'), args: [path.join(root, 'Resources', 'app', 'out', 'cli.js')], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

export const TRANSLOCATED_HINT = 'Cursor 正在从“隔离转移”（App Translocation）的只读位置运行，无法修改。请先把 Cursor.app 拖进“应用程序”文件夹，打开一次后退出，再重试。';
export const APP_MANAGEMENT_HINT = 'macOS 阻止了修改 Cursor.app（“App 管理”权限，即使管理员/sudo 也会被拒绝）。请打开 系统设置 → 隐私与安全性 → App 管理，允许本工具（命令行用法则允许你使用的终端），然后重试。';
export const APP_MANAGEMENT_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles';

// 进程：ps 给出完整命令行。主进程 = <root>/MacOS/Cursor 且没有 --type=；Helper 进程在 Frameworks 里，一并等待退出
export async function listMacProcesses(root, { runner = defaultRun, selfPid = process.pid, includeEngine = false } = {}) {
  const r = await runner('ps', ['-axww', '-o', 'pid=,ppid=,command=']);
  if (r.code !== 0) return [];
  const exe = path.join(root, 'MacOS', 'Cursor');
  const fw = path.join(root, 'Frameworks') + '/';
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [pid, ppid, cmd] = [Number(m[1]), Number(m[2]), m[3]];
    if (pid === selfPid) continue;
    const isMain = cmd === exe || cmd.startsWith(exe + ' ');
    if (!isMain && !cmd.startsWith(fw)) continue;
    if (/\/out\/cli\.js(\s|$)/.test(cmd)) continue;
    // 本工具借用 Cursor 主程序跑引擎（ELECTRON_RUN_AS_NODE）时，ps 里也会出现这条命令行，不能当成 GUI 进程去退出；
    // 重签名前要等它们也退出（includeEngine），否则内核会 SIGKILL 并弹出「意外退出」
    if (!includeEngine && /engine-ipc\.mjs(\s|$)/.test(cmd)) continue;
    out.push({ pid, ppid, command: cmd, argv: [isMain ? exe : cmd], main: isMain && !/\s--type=/.test(cmd) });
  }
  return out;
}

// AppleEvent 退出：argv 传入 .app 路径，避免拼进 AppleScript 源码。等价于 ⌘Q / Dock「退出」，
// 走 NSApplication.terminate，Crash Reporter 不会当成「意外退出」。不要用 SIGTERM/SIGKILL。
export function quitMacArgs(app) {
  return [
    '-e', 'on run argv',
    '-e', 'tell application (POSIX file (item 1 of argv) as text) to quit',
    '-e', 'end run',
    app,
  ];
}

export const MAC_QUIT_SETTLE_MS = 800;

// 等主进程和 Helper 都消失后再返回，并多等一小段：随后会改写/重签 Cursor.app，进程还在退出时内核会因签名校验把它们杀掉，看起来像崩溃
export async function closeMac(root, { runner = defaultRun, timeoutMs = 20000, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), list = listMacProcesses, settleMs = MAC_QUIT_SETTLE_MS } = {}) {
  const procs = await list(root, { runner });
  if (!procs.length) return { ok: true, closed: false };
  const mains = procs.filter((p) => p.main);
  const app = appPathOf(root);
  const relaunch = { platform: 'darwin', app };
  log(`正在关闭 Cursor（${mains.length || procs.length} 个主进程，等同 ⌘Q）…`);
  const quit = await runner('/usr/bin/osascript', quitMacArgs(app));
  if (quit.code !== 0) {
    const detail = (quit.stderr || quit.stdout).trim().split('\n')[0];
    log(`通过系统退出 Cursor 未成功${detail ? `：${detail}` : ''}。请用 ⌘Q 退出（首次可能需要允许本工具控制 Cursor）`);
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await list(root, { runner })).length) {
      await sleep(settleMs);
      if (!(await list(root, { runner })).length) return { ok: true, closed: true, relaunch };
      continue;
    }
    await sleep(300);
  }
  return { ok: false, closed: false, relaunch, error: `Cursor 在 ${Math.round(timeoutMs / 1000)} 秒内没有退出，请用 ⌘Q 退出 Cursor（可能有未保存文件的确认框，或需在「隐私与安全性 → 自动化」中允许本工具控制 Cursor）后重试` };
}

// ---------- 签名 ----------
export async function hasQuarantine(app, { runner = defaultRun } = {}) {
  const r = await runner('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app]);
  return r.code === 0;
}

export async function removeQuarantine(app, { runner = defaultRun } = {}) {
  await runner('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]);
}

export async function verifySignature(app, { runner = defaultRun } = {}) {
  const r = await runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  return { ok: r.code === 0, detail: (r.stderr || r.stdout).trim() };
}

export async function signatureInfo(app, { runner = defaultRun } = {}) {
  const r = await runner('/usr/bin/codesign', ['-dv', '--verbose=2', app]);
  const t = r.stderr + r.stdout;
  return {
    adhoc: /Signature=adhoc/.test(t),
    team: t.match(/TeamIdentifier=(\S+)/)?.[1] ?? null,
    authority: t.match(/Authority=(.+)/)?.[1]?.trim() ?? null,
    runtime: /flags=.*runtime/.test(t),
  };
}

// 写入后的签名处理（直接写入时由引擎执行；需要管理员时由 helper 按清单里的 !动作 执行）
export function postWriteActions(mode) {
  if (mode === 'none') return ['!unquarantine'];
  if (mode === 'adhoc') return ['!codesign-adhoc', '!unquarantine'];
  return [];
}

function isEngineLikeMacProcess(cmd) {
  // 借用主程序跑 Node 时，ps 看不到 ELECTRON_RUN_AS_NODE，只能靠命令行特征区分；杀这些不会弹「意外退出」
  return /engine-ipc\.mjs(\s|$)/.test(cmd) || /\s-e(\s|$)/.test(cmd) || /\s-p(\s|$)/.test(cmd);
}

export async function signAdhoc(app, {
  deep = false,
  runner = defaultRun,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 15000,
  kill = (pid, sig) => process.kill(pid, sig),
} = {}) {
  // 任何仍映射 Contents/MacOS/Cursor 的进程（含本工具的 engine-ipc）在重签名时都会被 SIGKILL → 系统弹「意外退出」
  const root = path.join(app, 'Contents');
  const end = Date.now() + timeoutMs;
  const tryKill = (pid, sig) => { try { kill(pid, sig); } catch { /* 已退出 */ } };
  while (Date.now() < end) {
    const still = await listMacProcesses(root, { runner, includeEngine: true });
    if (!still.length) break;
    // 主动结束引擎类进程，避免等待窗口里又被并发 status 拉起后撞上 codesign
    for (const p of still) {
      if (isEngineLikeMacProcess(p.command)) tryKill(p.pid, 'SIGTERM');
    }
    await sleep(200);
  }
  const leftover = await listMacProcesses(root, { runner, includeEngine: true });
  const guiLeft = leftover.filter((p) => !isEngineLikeMacProcess(p.command));
  if (guiLeft.length) {
    throw new Error(`重签名前仍有 ${guiLeft.length} 个 Cursor 进程在运行，请完全退出 Cursor 后重试`);
  }
  for (const p of leftover) tryKill(p.pid, 'SIGKILL');
  if (leftover.length) await sleep(100);
  // 再扫一次，尽量缩窄 TOCTOU；随后立刻 codesign
  const again = await listMacProcesses(root, { runner, includeEngine: true });
  for (const p of again) {
    if (isEngineLikeMacProcess(p.command)) tryKill(p.pid, 'SIGKILL');
    else throw new Error(`重签名前仍有 Cursor 进程在运行，请完全退出 Cursor 后重试`);
  }
  const args = ['--force', ...(deep ? ['--deep'] : []), '--sign', '-', '--preserve-metadata=entitlements', app];
  const r = await runner('/usr/bin/codesign', args);
  if (r.code !== 0) throw new Error(`ad-hoc 重签名失败：${(r.stderr || r.stdout).trim()}`);
  // macOS（尤其新系统）在 codesign 刚写完时立刻 exec 同路径，子进程可能被 taskgated 以 Invalid Signature SIGKILL
  await sleep(1500);
  const v = await verifySignature(app, { runner });
  if (!v.ok) throw new Error(`重签名后校验失败：${v.detail}`);
}

// adhoc-deep：签名前把整个 .app 克隆一份（APFS 上 cp -c 是写时复制，几乎不占空间、瞬间完成）
export async function cloneBundle(app, dest, { runner = defaultRun } = {}) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let r = await runner('/bin/cp', ['-Rpc', app, dest]);
  if (r.code !== 0) r = await runner('/usr/bin/ditto', [app, dest]);
  if (r.code !== 0) throw new Error(`备份 Cursor.app 失败：${(r.stderr || '').trim()}`);
}

// 用克隆整体换回：先把当前的挪开，再放回原版，成功后删除挪开的那份
export async function restoreBundle(app, clone, { runner = defaultRun } = {}) {
  const aside = `${app}.czl-old-${Date.now()}`;
  await fs.rename(app, aside);
  try {
    let r = await runner('/bin/cp', ['-Rpc', clone, app]);
    if (r.code !== 0) r = await runner('/usr/bin/ditto', [clone, app]);
    if (r.code !== 0) throw new Error((r.stderr || '').trim());
  } catch (e) {
    await fs.rm(app, { recursive: true, force: true }).catch(() => {});
    await fs.rename(aside, app);
    throw new Error(`还原 Cursor.app 失败：${e.message}`);
  }
  await fs.rm(aside, { recursive: true, force: true });
}

// ---------- osascript 管理员授权 ----------
// 脚本正文和清单路径都通过 argv 传给 AppleScript（quoted form of 负责转义），不拼进 AppleScript 源码
export function osascriptArgs(script, manifest) {
  return [
    '-e', 'on run argv',
    '-e', 'do shell script "/bin/sh -c " & quoted form of (item 1 of argv) & " czl-apply " & quoted form of (item 2 of argv) with administrator privileges',
    '-e', 'end run',
    script, manifest,
  ];
}

// osascript 失败：-128 = 用户取消；其余 "… (N)" 里的 N 是 helper 退出码
export function parseOsascriptError(stderr) {
  if (/\(-128\)/.test(stderr) || /User canceled/i.test(stderr)) return { cancelled: true, code: null };
  const m = stderr.match(/\((\d+)\)\s*$/m);
  return { cancelled: false, code: m ? Number(m[1]) : null };
}

export async function probeWritable(file) {
  try { const h = await fs.open(file, 'r+'); await h.close(); return null; }
  catch (e) { return e.code; }
}
