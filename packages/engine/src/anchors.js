import fs from 'node:fs/promises';
import path from 'node:path';

// 锚点查找顺序：anchors/<platform>/<版本>.json（某平台 bundle 不同时的专用覆盖）→ anchors/<版本>.json（三平台共用）。
// 共用文件里的路径统一写 Linux/Windows 的 resources/app/…；macOS 安装根是 Cursor.app/Contents，目录叫 Resources/app，
// 这里统一映射（Linux 上文件名区分大小写，测试假树也按真实大小写建）。都没有就返回 null（拒绝硬灌）
export const appPrefix = (platform) => (platform === 'darwin' ? 'Resources/app/' : 'resources/app/');

export function remapAnchors(a, platform) {
  const pre = appPrefix(platform);
  if (pre === 'resources/app/') return a;
  const m = (r) => (typeof r === 'string' && r.startsWith('resources/app') ? pre.slice(0, -1) + r.slice('resources/app'.length) : r);
  return {
    ...a,
    productJson: m(a.productJson),
    checksumBase: m(a.checksumBase),
    ...(a.dom ? { dom: { ...a.dom, relatives: a.dom.relatives?.map(m) } } : {}),
    files: a.files.map((f) => ({ ...f, relative: m(f.relative) })),
    ...(a.nls ? { nls: { ...a.nls, relative: m(a.nls.relative) } } : {}),
    ...(a.pristine ? { pristine: Object.fromEntries(Object.entries(a.pristine).map(([k, v]) => [m(k), v])) } : {}),
  };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function loadAnchors({ platform, version, anchorsDir }) {
  let a = await readJson(path.join(anchorsDir, platform, `${version}.json`));
  if (!a) {
    a = await readJson(path.join(anchorsDir, `${version}.json`));
    if (a && a.platforms && !a.platforms.includes(platform)) a = null;
  }
  return a ? { ...remapAnchors(a, platform), source: a.platforms ? 'shared' : platform } : null;
}

// 当前平台能用的版本（共用 + 平台专用）
export async function supportedVersions({ platform, anchorsDir }) {
  const out = new Set();
  const ls = async (d) => { try { return (await fs.readdir(d)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } };
  for (const v of await ls(path.join(anchorsDir, platform))) out.add(v);
  for (const v of await ls(anchorsDir)) {
    const a = await readJson(path.join(anchorsDir, `${v}.json`)).catch(() => null);
    if (a && (!a.platforms || a.platforms.includes(platform))) out.add(v);
  }
  return [...out].sort();
}
// 词典：英文原文 → 中文；静态补丁和 DOM 补漏共用
export async function loadDict(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// 数字模板（"Tab Stats: {n} ({n}%)" → "Tab 统计：{n} ({n}%)"）：只给 DOM 补漏在界面外壳区域用；文件缺失就当没有
export async function loadPatterns(file) {
  if (!file) return [];
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
