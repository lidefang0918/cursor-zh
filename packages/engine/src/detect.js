import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
