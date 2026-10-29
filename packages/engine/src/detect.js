import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { extractBase, listExtracted } from './appimage.js';
import { mountOf } from './elevate.js';

// 安装根候选（root 下再找 product.json 或 resources/app/product.json）
function defaultRoots(platform, env) {
  const home = env.HOME || os.homedir();
  if (platform === 'linux') {
    return ['/usr/share/cursor', '/opt/cursor', '/opt/Cursor', path.join(home, '.local/share/cursor')];
  }
  if (platform === 'darwin') return ['/Applications/Cursor.app/Contents', path.join(home, 'Applications/Cursor.app/Contents')];
  if (platform === 'win32' && env.LOCALAPPDATA) return [path.join(env.LOCALAPPDATA, 'Programs', 'cursor')];
  return [];
}

const APP_SUBDIRS = ['', 'resources/app', 'Resources/app'];

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
  for (const sub of APP_SUBDIRS) {
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
export async function detectAllCursors({ platform = process.platform, env = process.env, extraRoots = [] } = {}) {
  const home = env.HOME || os.homedir();
  const roots = [...extraRoots, ...defaultRoots(platform, env)];
  if (platform === 'linux') roots.push(...(await listExtracted({ home })).map((x) => x.root));
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    const info = await probe(r);
    if (!info) continue;
    const key = await fs.realpath(info.root).catch(() => info.root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...info, kind: await installKind(info.root, { home }) });
  }
  return out;
}

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, (e, so) => res(e ? null : String(so).trim())));

// 安装方式：deb / rpm（/usr/share/cursor，归 root，升级会覆盖汉化）、appimage-extracted（本工具解包，用户可写）、
// appimage-mounted（运行中的 AppImage 只读挂载，不能改）、manual（手动解压的 tar 等）
export async function installKind(root, { home = os.homedir() } = {}) {
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
} = {}) {
  const roots = [
    ...extraRoots,
    ...(await rootFromWhich(whichPath)),
    ...(defaults ? defaultRoots(platform, env) : []),
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
