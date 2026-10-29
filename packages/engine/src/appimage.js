import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// AppImage 版 Cursor：运行时挂载为只读 squashfs（/tmp/.mount_Cursor*），不能原地修改。
// 处理方式：“解包模式”——把用户的 AppImage 解包到 ~/.local/share/cursor-zh-localizer/cursor-appimage/<版本>/，
// 汉化这份解包副本（普通用户权限即可写，不需要提权），并创建启动器；原 AppImage 文件原样保留。
export const extractBase = (home = os.homedir()) => path.join(home, '.local/share/cursor-zh-localizer/cursor-appimage');
export const INNER_ROOT = 'usr/share/cursor';

const NAME_RE = /^cursor.*\.appimage$/i;
export const versionFromName = (file) => path.basename(file).match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;

export async function findAppImages({ home = os.homedir(), dirs, procDir = '/proc' } = {}) {
  const candidates = dirs ?? ['Applications', 'Downloads', 'Desktop', '', '.local/bin', 'bin', 'AppImages', '.local/share/applications']
    .map((d) => path.join(home, d)).concat(['/opt', '/opt/appimages', '/opt/cursor']);
  const found = new Map();
  for (const dir of candidates) {
    let names = [];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!NAME_RE.test(n)) continue;
      const p = path.join(dir, n);
      try { const st = await fs.stat(p); if (st.isFile()) found.set(p, { path: p, version: versionFromName(n), size: st.size, running: false }); } catch {}
    }
  }
  // 正在运行的 AppImage：进程环境里有 APPIMAGE=<文件路径>
  try {
    for (const d of (await fs.readdir(procDir)).filter((x) => /^\d+$/.test(x))) {
      let env;
      try { env = await fs.readFile(path.join(procDir, d, 'environ'), 'utf8'); } catch { continue; }
      const m = env.split('\0').find((kv) => kv.startsWith('APPIMAGE='));
      if (!m) continue;
      const p = m.slice(9);
      if (!NAME_RE.test(path.basename(p))) continue;
      const prev = found.get(p) ?? { path: p, version: versionFromName(p), size: null };
      found.set(p, { ...prev, running: true });
    }
  } catch {}
  return [...found.values()];
}

export async function listExtracted({ home = os.homedir() } = {}) {
  const base = extractBase(home);
  let names = [];
  try { names = await fs.readdir(base); } catch { return []; }
  const out = [];
  for (const n of names) {
    const root = path.join(base, n, INNER_ROOT);
    try { await fs.access(path.join(root, 'resources/app/product.json')); out.push({ version: n, dir: path.join(base, n), root }); } catch {}
  }
  return out;
}

const execP = (cmd, args, opts) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 24, ...opts }, (e, so, se) => (e ? rej(Object.assign(e, { stderr: se })) : res({ stdout: so, stderr: se }))));

// 解包（AppImage 运行时自带 --appimage-extract，不需要 FUSE）并创建启动器
export async function extractAppImage({ appImagePath, home = os.homedir(), log = () => {}, exec = execP }) {
  const base = extractBase(home);
  await fs.mkdir(base, { recursive: true });
  try { await fs.access(appImagePath, fs.constants.X_OK); }
  catch {
    await fs.chmod(appImagePath, (await fs.stat(appImagePath)).mode | 0o100);
    log(`已给 ${appImagePath} 加上可执行权限（解包需要）`);
  }
  const work = await fs.mkdtemp(path.join(base, '.extract-'));
  try {
    log(`正在解包 ${appImagePath}（约 1 GB，需要几十秒）…`);
    await exec(appImagePath, ['--appimage-extract'], { cwd: work, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '' } });
    const sq = path.join(work, 'squashfs-root');
    const product = JSON.parse(await fs.readFile(path.join(sq, INNER_ROOT, 'resources/app/product.json'), 'utf8'));
    const version = String(product.version);
    const dir = path.join(base, version);
    try { await fs.access(dir); throw Object.assign(new Error(`已经解包过 ${version}：${dir}`), { code: 'EXISTS', dir }); }
    catch (e) { if (e.code === 'EXISTS') throw e; }
    await fs.rename(sq, dir);
    const launcher = await createLauncher({ dir, version, home });
    log(`已解包到 ${dir}；启动器：${launcher.desktopFile}`);
    return { version, dir, root: path.join(dir, INNER_ROOT), ...launcher };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

export async function createLauncher({ dir, version, home = os.homedir() }) {
  const apps = path.join(home, '.local/share/applications');
  const bin = path.join(home, '.local/bin');
  await fs.mkdir(apps, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  const desktopFile = path.join(apps, 'cursor-zh.desktop');
  const binLink = path.join(bin, 'cursor-zh');
  const appRun = path.join(dir, 'AppRun');
  const icon = path.join(dir, 'co.anysphere.cursor.png');
  await fs.writeFile(desktopFile, `[Desktop Entry]
Name=Cursor（中文）
Comment=Cursor ${version}（由 cursor-zh-localizer 从 AppImage 解包并汉化）
Exec="${appRun}" %F
Icon=${icon}
Type=Application
Categories=Development;IDE;
StartupWMClass=Cursor
`);
  await fs.rm(binLink, { force: true });
  await fs.symlink(appRun, binLink);
  return { desktopFile, binLink, appRun };
}

export async function removeExtracted({ dir, home = os.homedir() }) {
  if (!dir.startsWith(extractBase(home) + path.sep)) throw new Error(`拒绝删除解包目录以外的路径：${dir}`);
  await fs.rm(dir, { recursive: true, force: true });
  for (const f of [path.join(home, '.local/share/applications/cursor-zh.desktop'), path.join(home, '.local/bin/cursor-zh')]) {
    try { const t = await fs.readlink(f).catch(() => null); if (!t || t.startsWith(dir)) await fs.rm(f, { force: true }); } catch {}
  }
}
