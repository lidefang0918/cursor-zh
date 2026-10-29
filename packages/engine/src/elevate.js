import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './backup.js';
import { run } from './platform/exec.js';
import * as win from './platform/win.js';
import * as mac from './platform/mac.js';

// 提权写入：主程序（含 Electron 界面）始终以普通用户运行，只把“放文件”这一步交给 helper/czl-apply.sh。
// 顺序：能直接写 → 直接写；否则 pkexec（图形授权弹窗）→ 免密 sudo（sudo -n，不会弹出/卡住）→ 给出要在终端执行的 sudo 命令。
export const HELPER_PATH = fileURLToPath(new URL('../helper/czl-apply.sh', import.meta.url));
// 用本工具的 .deb 安装时，helper 以 root 所有的副本装在这里（配合 polkit 策略，授权弹窗显示中文说明）
export const SYSTEM_HELPER = '/usr/lib/cursor-zh-localizer/czl-apply';
export const DEFAULT_STRATEGIES = ['pkexec', 'sudo-n', 'manual'];
// 各平台的提权顺序：Windows 弹 UAC；macOS 弹系统管理员密码框（osascript with administrator privileges）
export const PLATFORM_STRATEGIES = { linux: DEFAULT_STRATEGIES, win32: ['uac', 'manual'], darwin: ['osascript', 'manual'] };

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const readHelper = (platform = 'linux') => fs.readFile(platform === 'win32' ? win.WIN_HELPER_PATH : HELPER_PATH, 'utf8');

export async function which(bin, env = process.env) {
  for (const dir of (env.PATH || '/usr/bin:/bin').split(':')) {
    const p = path.join(dir || '.', bin);
    try { await fs.access(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// /proc/mounts 里找 p 所在的挂载点（最长前缀），判断是否只读（AppImage 的 squashfs、只读挂载等）
export async function mountOf(p, { mountsFile = '/proc/mounts' } = {}) {
  let real = p;
  try { real = await fs.realpath(p); } catch {}
  let text = '';
  try { text = await fs.readFile(mountsFile, 'utf8'); } catch { return null; }
  const unesc = (s) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  let best = null;
  for (const line of text.split('\n')) {
    const [dev, mp0, fstype, opts] = line.split(' ');
    if (!mp0) continue;
    const mp = unesc(mp0);
    const inside = mp === '/' || real === mp || real.startsWith(mp.endsWith('/') ? mp : mp + '/');
    if (inside && (!best || mp.length > best.mountpoint.length)) best = { device: dev, mountpoint: mp, fstype, options: opts.split(',') };
  }
  if (best) best.readOnly = best.options.includes('ro') || /squashfs|iso9660|erofs/.test(best.fstype);
  return best;
}

// 安装目录能否被当前用户直接改写。
// Linux 逐个文件 W_OK；Windows 的 W_OK 只看只读属性、macOS 的 App 管理（TCC）拦截只在真正写时才出现，所以这两个平台以写方式打开一次。
// macOS：EPERM = App 管理拦截（sudo 也没用），EACCES = 普通文件权限（管理员授权可解决）
export async function checkWritable(installRoot, relatives, { platform = process.platform, probe = win.probeWritable } = {}) {
  if (platform === 'darwin' && mac.isTranslocated(installRoot)) {
    return { writable: false, readOnlyFs: false, translocated: true, mount: null, unwritable: relatives.map((r) => ({ relative: r, reason: 'TRANSLOCATED' })) };
  }
  const mount = platform === 'linux' ? await mountOf(installRoot) : null;
  const unwritable = [];
  for (const r of relatives) {
    const file = path.join(installRoot, r);
    if (platform === 'linux') {
      try { await fs.access(file, fs.constants.W_OK); }
      catch (e) { unwritable.push({ relative: r, reason: e.code }); }
    } else {
      const code = await probe(file);
      if (code) unwritable.push({ relative: r, reason: code });
    }
  }
  const readOnlyFs = !!mount?.readOnly || unwritable.some((u) => u.reason === 'EROFS');
  const appManagement = platform === 'darwin' && unwritable.some((u) => u.reason === 'EPERM');
  return { writable: unwritable.length === 0 && !readOnlyFs, readOnlyFs, appManagement, mount, unwritable };
}

export async function filesMatch(installRoot, shaByRelative) {
  for (const [rel, sha] of Object.entries(shaByRelative ?? {})) {
    try { if ((await sha256File(path.join(installRoot, rel))) !== sha) return false; } catch { return false; }
  }
  return Object.keys(shaByRelative ?? {}).length > 0;
}

export function manifestText(installRoot, items, actions = []) {
  for (const it of items) {
    if (/[\t\r\n]/.test(it.src + it.relative)) throw new Error(`路径含制表符/换行，无法写入清单：${it.relative}`);
  }
  if (/[\t\r\n]/.test(installRoot)) throw new Error(`安装路径含制表符/换行：${installRoot}`);
  return [`CZL1\t${installRoot}`, ...items.map((it) => `${it.sha256}\t${it.src}\t${it.relative}`), ...actions].join('\n') + '\n';
}

async function systemHelperUsable() {
  try {
    const st = await fs.stat(SYSTEM_HELPER);
    return st.uid === 0 && (st.mode & 0o022) === 0 && (st.mode & 0o111) !== 0;
  } catch { return false; }
}

// 主程序有写权限时，在进程内完成同样的事。崩溃/断电安全：
//  1) 每个文件先写到同目录的 <文件>.czl-new 并校验 sha256（安装文件此时一个字节都没动）；
//  2) 再逐个 rename 覆盖（同一文件系统内原子），原文件先改名为 .czl-old；
//  3) 中途任何一步失败，已替换的按 .czl-old 换回，安装目录回到写入前的样子。
// Windows 上刚退出的进程可能还短暂占用文件，EBUSY/EPERM/EACCES 重试几次。
async function retry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tries - 1 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code) || process.platform !== 'win32') throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
export async function applyDirect(installRoot, items, { hooks = {} } = {}) {
  const jobs = items.map((it) => ({ it, dst: path.join(installRoot, it.relative) }));
  const cleanup = async (suffix) => { for (const j of jobs) await fs.rm(j.dst + suffix, { force: true }).catch(() => {}); };
  try {
    for (const j of jobs) {
      await retry(() => fs.copyFile(j.it.src, j.dst + '.czl-new'));
      if ((await sha256File(j.dst + '.czl-new')) !== j.it.sha256) throw new Error(`写入后校验失败：${j.it.relative}`);
    }
  } catch (e) { await cleanup('.czl-new'); throw e; }
  const done = [];
  try {
    for (const j of jobs) {
      const had = await fs.access(j.dst).then(() => true, () => false);
      if (had) await retry(() => fs.rename(j.dst, j.dst + '.czl-old'));
      done.push({ ...j, had });
      if (hooks.beforeSwap) await hooks.beforeSwap(j.it.relative);
      await retry(() => fs.rename(j.dst + '.czl-new', j.dst));
      j.swapped = true;
    }
  } catch (e) {
    for (const j of done.reverse()) {
      try {
        if (j.had) await retry(() => fs.rename(j.dst + '.czl-old', j.dst));
        else if (j.swapped) await fs.rm(j.dst, { force: true });
      } catch {}
    }
    await cleanup('.czl-new');
    e.message = `${e.message}（已回滚，安装目录未改动）`;
    throw e;
  }
  await cleanup('.czl-old');
  for (const j of jobs) {
    if ((await sha256File(j.dst)) !== j.it.sha256) throw new Error(`写入后校验失败：${j.it.relative}`);
  }
}

const HELPER_ERRORS = { 2: '清单不合法', 3: '准备好的文件被改动过', 4: '写入失败（安装目录未改动）', 5: '写入后校验失败', 6: '重签名失败' };

/**
 * 把 items（{relative, src, sha256}）放进 installRoot。
 * 返回 {ok:true, method} | {ok:false, code:'NEED_ELEVATION', command, tried} | {ok:false, code:'READ_ONLY_FS'|'HELPER_FAILED', error}
 */
export async function applyFiles({
  installRoot, items, workDir, platform = process.platform, strategies,
  log = () => {}, assumeUnwritable = false, runner = run, env = process.env, actions = [], probe,
}) {
  strategies ??= process.env.CZL_ELEVATE?.split(',') ?? PLATFORM_STRATEGIES[platform] ?? DEFAULT_STRATEGIES;
  const w = await checkWritable(installRoot, items.map((i) => i.relative), { platform, ...(probe ? { probe } : {}) });
  if (w.translocated) return { ok: false, code: 'MAC_TRANSLOCATED', error: mac.TRANSLOCATED_HINT };
  if (w.appManagement) return { ok: false, code: 'MAC_APP_MANAGEMENT', error: mac.APP_MANAGEMENT_HINT, settingsUrl: mac.APP_MANAGEMENT_SETTINGS_URL };
  if (w.readOnlyFs) {
    return { ok: false, code: 'READ_ONLY_FS', mount: w.mount, error: `安装目录在只读文件系统上（${w.mount?.fstype ?? 'ro'}，${w.mount?.mountpoint ?? installRoot}），任何权限都无法修改` };
  }
  if (w.writable && !assumeUnwritable) {
    await applyDirect(installRoot, items);
    return { ok: true, method: 'direct' };
  }
  log(`安装目录需要管理员权限才能写入（${w.unwritable.map((u) => u.relative.split('/').pop()).join('、') || installRoot}）`);

  await fs.mkdir(workDir, { recursive: true });
  const manifest = path.join(workDir, 'apply.tsv');
  const helperCopy = path.join(workDir, platform === 'win32' ? 'czl-apply.ps1' : 'czl-apply.sh');
  const script = await readHelper(platform);
  await fs.writeFile(manifest, manifestText(installRoot, items, platform === 'darwin' ? actions : []));
  // .ps1 带 BOM：Windows PowerShell 5.1 没有 BOM 时按系统代码页读，中文会乱
  await fs.writeFile(helperCopy, platform === 'win32' ? '\ufeff' + script : script, { mode: 0o755 });
  const command = platform === 'win32' ? win.manualCommand(helperCopy, manifest) : `sudo sh ${shq(helperCopy)} ${shq(manifest)}`;
  // pkexec / sudo 都直接执行 /bin/sh -c <脚本正文>：脚本内容随参数固定下来，不会在授权后被替换
  const shArgs = ['-c', script, 'czl-apply', manifest];
  const tried = [];
  const helperFailed = (r, via) => ({
    ok: false, code: 'HELPER_FAILED', via,
    error: `提权写入失败（${HELPER_ERRORS[r.code] ?? `退出码 ${r.code}`}）：${r.stderr.trim()}`,
  });

  for (const s of strategies) {
    if (s === 'uac') {
      if (platform !== 'win32') continue;
      log('正在请求管理员授权（UAC）…');
      const r = await win.runUac({ script, manifest, resultFile: path.join(workDir, 'apply.result.txt'), runner });
      if (r.code === 0) return verifyAfter(installRoot, items, 'uac');
      if (r.cancelled) { tried.push({ via: 'UAC', reason: '授权被取消' }); continue; }
      if (r.code === 127 || r.spawnError) { tried.push({ via: 'UAC', reason: `无法弹出授权：${(r.stderr.trim() || r.spawnError || '').split('\n')[0]}` }); continue; }
      return helperFailed(r, 'uac');
    }
    if (s === 'osascript') {
      if (platform !== 'darwin') continue;
      log('正在请求管理员授权（macOS 密码框）…');
      const r = await runner('/usr/bin/osascript', mac.osascriptArgs(script, manifest));
      if (r.code === 0) return verifyAfter(installRoot, items, 'osascript');
      const e = mac.parseOsascriptError(r.stderr);
      if (e.cancelled) { tried.push({ via: 'osascript', reason: '授权被取消' }); continue; }
      if (r.spawnError || e.code === null) { tried.push({ via: 'osascript', reason: `无法完成授权：${(r.stderr.trim() || r.spawnError || '').split('\n')[0]}` }); continue; }
      if (/Operation not permitted/.test(r.stderr)) return { ok: false, code: 'MAC_APP_MANAGEMENT', error: mac.APP_MANAGEMENT_HINT, settingsUrl: mac.APP_MANAGEMENT_SETTINGS_URL };
      return helperFailed({ ...r, code: e.code }, 'osascript');
    }
    if (s === 'pkexec') {
      if (platform !== 'linux') continue;
      const bin = await runnerWhich('pkexec', env, runner);
      if (!bin) { tried.push({ via: 'pkexec', reason: '系统没有安装 pkexec（polkit）' }); continue; }
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) { tried.push({ via: 'pkexec', reason: '没有图形会话，无法弹出授权窗口' }); continue; }
      log('正在请求管理员授权（pkexec）…');
      const args = (await systemHelperUsable()) ? [SYSTEM_HELPER, manifest] : ['/bin/sh', ...shArgs];
      const r = await runner(bin, args);
      if (r.code === 0) return verifyAfter(installRoot, items, 'pkexec');
      if (r.code === 126) { tried.push({ via: 'pkexec', reason: '授权被取消或被拒绝' }); continue; }
      if (r.code === 127 || r.spawnError) { tried.push({ via: 'pkexec', reason: `无法完成授权：${(r.stderr.trim() || r.spawnError || '').split('\n')[0]}` }); continue; }
      return helperFailed(r, 'pkexec');
    }
    if (s === 'sudo-n') {
      if (platform !== 'linux') continue;
      const bin = await runnerWhich('sudo', env, runner);
      if (!bin) { tried.push({ via: 'sudo -n', reason: '系统没有 sudo' }); continue; }
      const r = await runner(bin, ['-n', '/bin/sh', ...shArgs]);
      if (r.code === 0) return verifyAfter(installRoot, items, 'sudo-n');
      if (/^sudo:/m.test(r.stderr) || r.spawnError) { tried.push({ via: 'sudo -n', reason: 'sudo 需要密码（不会在后台询问）' }); continue; }
      return helperFailed(r, 'sudo-n');
    }
    if (s === 'manual') break;
  }
  return {
    ok: false, code: 'NEED_ELEVATION', command, manifest, helper: helperCopy, tried,
    error: platform === 'win32'
      ? `需要管理员权限才能修改 ${installRoot}。请以管理员身份打开 PowerShell 执行：${command}`
      : `需要管理员权限才能修改 ${installRoot}。请在终端执行：${command}`,
  };
}

async function runnerWhich(bin, env, runner) {
  return runner === run ? which(bin, env) : `/usr/bin/${bin}`;
}

async function verifyAfter(installRoot, items, method) {
  for (const it of items) {
    if ((await sha256File(path.join(installRoot, it.relative))) !== it.sha256) {
      return { ok: false, code: 'HELPER_FAILED', error: `提权写入后校验不一致：${it.relative}` };
    }
  }
  return { ok: true, method };
}

export async function elevationInfo(env = process.env, platform = process.platform) {
  if (platform === 'win32') return { uac: true, graphical: true };
  if (platform === 'darwin') return { osascript: true, graphical: true };
  return {
    pkexec: !!(await which('pkexec', env)),
    sudo: !!(await which('sudo', env)),
    graphical: !!(env.DISPLAY || env.WAYLAND_DISPLAY),
    systemHelper: await systemHelperUsable(),
  };
}
