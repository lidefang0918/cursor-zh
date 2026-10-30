import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { extractBase, listExtracted } from './appimage.js';
import { mountOf } from './elevate.js';
import * as win from './platform/win.js';
import * as mac from './platform/mac.js';

// 安装根候选（root 下再找 product.json 或 resources/app/product.json）
function defaultRoots(platform, env) {
  const home = env.HOME || os.homedir();
  if (platform === 'linux') {
    return ['/usr/share/cursor', '/opt/cursor', '/opt/Cursor', path.join(home, '.local/share/cursor')];
  }
  if (platform === 'darwin') return mac.macDefaultRoots(env, home);
  if (platform === 'win32') return win.winDefaultRoots(env);
  return [];
}

// Windows 额外查注册表卸载项（自定义安装目录）；runner 可注入（测试）
async function registryRoots(platform, runner) {
  if (platform !== 'win32') return [];
  return (await win.winRegistryRoots({ runner })).map((r) => r.root);
}

const APP_SUBDIRS = ['', 'resources/app', 'Resources/app'];
// macOS 默认文件系统不区分大小写，'resources/app' 也能读到；*.app/Contents 先试 'Resources/app'，返回的路径大小写才和磁盘上一致
const MAC_APP_SUBDIRS = ['Resources/app', '', 'resources/app'];

// `cursor` 在 PATH 里通常是 <root>/bin/cursor 的软链；向上两级当安装根
async function rootFromWhich(whichPath) {
  if (!whichPath) return [];
  try {
    const real = await fs.realpath(whichPath);
    return [path.dirname(path.dirname(real))];
  } catch {
    return [];
  }
}

async function probe(root) {
  for (const sub of /\.app[\\/]Contents[\\/]?$/.test(root) ? MAC_APP_SUBDIRS : APP_SUBDIRS) {
    const appDir = path.join(root, sub);
    const productPath = path.join(appDir, 'product.json');
    try {
      const product = JSON.parse(await fs.readFile(productPath, 'utf8'));
      const version = product.version || product.cursorVersion;
      if (!version) continue;
      return { root, appDir, productPath, version: String(version), vscodeVersion: product.vscodeVersion || null, commit: product.commit || null };
    } catch { continue; }
  }
  return null;
}

// 所有能找到的安装（系统包 + 本工具解包的 AppImage），去重
export async function detectAllCursors({ platform = process.platform, env = process.env, extraRoots = [], runner } = {}) {
  const home = env.HOME || os.homedir();
  const roots = [...extraRoots, ...defaultRoots(platform, env), ...(await registryRoots(platform, runner))];
  if (platform === 'linux') roots.push(...(await listExtracted({ home })).map((x) => x.root));
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    const info = await probe(r);
    if (!info) continue;
    const key = await fs.realpath(info.root).catch(() => info.root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...info, kind: await installKind(info.root, { home, platform, env }) });
  }
  return out;
}

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true }, (e, so) => res(e ? null : String(so).trim())));

// 安装方式：deb / rpm（/usr/share/cursor，归 root，升级会覆盖汉化）、appimage-extracted（本工具解包，用户可写）、
// appimage-mounted（运行中的 AppImage 只读挂载，不能改）、manual（手动解压的 tar 等）
// Windows：win-user（用户版，可直接写）/ win-system（Program Files，需 UAC）/ win-other；
// macOS：mac-applications / mac-user-applications / mac-translocated（只读转移位置）/ mac-other
export async function installKind(root, { home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return win.winInstallKind(root, env);
  if (platform === 'darwin') return mac.macInstallKind(root, home);
  if (root.startsWith(extractBase(home) + path.sep)) return 'appimage-extracted';
  const m = await mountOf(root);
  if (root.startsWith('/tmp/.mount_') || (m?.readOnly && /squashfs|fuse/.test(m.fstype))) return 'appimage-mounted';
  const product = path.join(root, 'resources/app/product.json');
  if (await run('dpkg-query', ['-S', product])) return 'deb';
  if (await run('rpm', ['-qf', product])) return 'rpm';
  return 'manual';
}

export async function detectCursor({
  platform = process.platform,
  env = process.env,
  whichPath = null,
  extraRoots = [],
  defaults = true,
  runner,
} = {}) {
  const roots = [
    ...extraRoots,
    ...(await rootFromWhich(whichPath)),
    ...(defaults ? defaultRoots(platform, env) : []),
    ...(defaults ? await registryRoots(platform, runner) : []),
  ];
  for (const root of roots) {
    for (const sub of APP_SUBDIRS) {
      const appDir = path.join(root, sub);
      const productPath = path.join(appDir, 'product.json');
      try {
        const product = JSON.parse(await fs.readFile(productPath, 'utf8'));
        const version = product.version || product.cursorVersion;
        if (!version) continue;
        return {
          root,
          appDir,
          productPath,
          version: String(version),
          vscodeVersion: product.vscodeVersion || null,
          commit: product.commit || null,
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}
