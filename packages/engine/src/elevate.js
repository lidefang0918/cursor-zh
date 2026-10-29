import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256File } from './backup.js';

// 提权写入：主程序（含 Electron 界面）始终以普通用户运行，只把“放文件”这一步交给 helper/czl-apply.sh。
// 顺序：能直接写 → 直接写；否则 pkexec（图形授权弹窗）→ 免密 sudo（sudo -n，不会弹出/卡住）→ 给出要在终端执行的 sudo 命令。
export const HELPER_PATH = fileURLToPath(new URL('../helper/czl-apply.sh', import.meta.url));
// 用本工具的 .deb 安装时，helper 以 root 所有的副本装在这里（配合 polkit 策略，授权弹窗显示中文说明）
export const SYSTEM_HELPER = '/usr/lib/cursor-zh-localizer/czl-apply';
export const DEFAULT_STRATEGIES = ['pkexec', 'sudo-n', 'manual'];

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const readHelper = () => fs.readFile(HELPER_PATH, 'utf8');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout: String(stdout), stderr: String(stderr), spawnError: err && typeof err.code === 'string' ? err.code : null });
    });
  });
}

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

// 安装目录能否被当前用户直接改写（逐个文件 W_OK）
export async function checkWritable(installRoot, relatives) {
  const mount = await mountOf(installRoot);
  const unwritable = [];
  for (const r of relatives) {
    try { await fs.access(path.join(installRoot, r), fs.constants.W_OK); }
    catch (e) { unwritable.push({ relative: r, reason: e.code }); }
  }
  const readOnlyFs = !!mount?.readOnly || unwritable.some((u) => u.reason === 'EROFS');
  return { writable: unwritable.length === 0 && !readOnlyFs, readOnlyFs, mount, unwritable };
}

export async function filesMatch(installRoot, shaByRelative) {
  for (const [rel, sha] of Object.entries(shaByRelative ?? {})) {
    try { if ((await sha256File(path.join(installRoot, rel))) !== sha) return false; } catch { return false; }
  }
  return Object.keys(shaByRelative ?? {}).length > 0;
}

export function manifestText(installRoot, items) {
  for (const it of items) {
    if (/[\t\n]/.test(it.src + it.relative)) throw new Error(`路径含制表符/换行，无法写入清单：${it.relative}`);
  }
  return [`CZL1\t${installRoot}`, ...items.map((it) => `${it.sha256}\t${it.src}\t${it.relative}`)].join('\n') + '\n';
}

async function systemHelperUsable() {
  try {
    const st = await fs.stat(SYSTEM_HELPER);
    return st.uid === 0 && (st.mode & 0o022) === 0 && (st.mode & 0o111) !== 0;
  } catch { return false; }
}

// 主程序有写权限时，在进程内完成同样的事：原地覆盖 + 校验
async function applyDirect(installRoot, items) {
  for (const it of items) await fs.copyFile(it.src, path.join(installRoot, it.relative));
  for (const it of items) {
    if ((await sha256File(path.join(installRoot, it.relative))) !== it.sha256) throw new Error(`写入后校验失败：${it.relative}`);
  }
}

const HELPER_ERRORS = { 2: '清单不合法', 3: '准备好的文件被改动过', 4: '写入失败（安装目录未改动）', 5: '写入后校验失败' };

/**
 * 把 items（{relative, src, sha256}）放进 installRoot。
 * 返回 {ok:true, method} | {ok:false, code:'NEED_ELEVATION', command, tried} | {ok:false, code:'READ_ONLY_FS'|'HELPER_FAILED', error}
 */
export async function applyFiles({
  installRoot, items, workDir, strategies = (process.env.CZL_ELEVATE?.split(',') ?? DEFAULT_STRATEGIES),
  log = () => {}, assumeUnwritable = false, runner = run, env = process.env,
}) {
  const w = await checkWritable(installRoot, items.map((i) => i.relative));
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
  const helperCopy = path.join(workDir, 'czl-apply.sh');
  const script = await readHelper();
  await fs.writeFile(manifest, manifestText(installRoot, items));
  await fs.writeFile(helperCopy, script, { mode: 0o755 });
  const command = `sudo sh ${shq(helperCopy)} ${shq(manifest)}`;
  // pkexec / sudo 都直接执行 /bin/sh -c <脚本正文>：脚本内容随参数固定下来，不会在授权后被替换
  const shArgs = ['-c', script, 'czl-apply', manifest];
  const tried = [];
  const helperFailed = (r, via) => ({
    ok: false, code: 'HELPER_FAILED', via,
    error: `提权写入失败（${HELPER_ERRORS[r.code] ?? `退出码 ${r.code}`}）：${r.stderr.trim()}`,
  });

  for (const s of strategies) {
    if (s === 'pkexec') {
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
    error: `需要管理员权限才能修改 ${installRoot}。请在终端执行：${command}`,
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

export async function elevationInfo(env = process.env) {
  return {
    pkexec: !!(await which('pkexec', env)),
    sudo: !!(await which('sudo', env)),
    graphical: !!(env.DISPLAY || env.WAYLAND_DISPLAY),
    systemHelper: await systemHelperUsable(),
  };
}
