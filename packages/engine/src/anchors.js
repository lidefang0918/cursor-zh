import fs from 'node:fs/promises';
import path from 'node:path';

// 锚点查找顺序：anchors/<platform>/<版本>.json（某平台 bundle 不同时的专用覆盖）→ anchors/<版本>.json（三平台共用）。
// 共用文件里的路径统一写 Linux/Windows 的 resources/app/…；macOS 安装根是 Cursor.app/Contents，目录叫 Resources/app，
// 这里统一映射（Linux 上文件名区分大小写，测试假树也按真实大小写建）。都没有就退到兼容模式
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

const dirsOf = (d) => [...new Set([d].flat().filter(Boolean))];
const exists = (p) => fs.access(p).then(() => true, () => false);
export const cmpVersion = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// anchorsDir 可以是多个目录（在线词典缓存在前、安装包自带在后），按顺序找第一个命中的。
// 精确版本找不到、但给了 installRoot：用最新一版锚点“尽力匹配”（见 fallbackAnchors），不再拒绝
export async function loadAnchors({ platform, version, anchorsDir, installRoot }) {
  for (const dir of dirsOf(anchorsDir)) {
    let a = await readJson(path.join(dir, platform, `${version}.json`));
    if (!a) {
      a = await readJson(path.join(dir, `${version}.json`));
      if (a && a.platforms && !a.platforms.includes(platform)) a = null;
    }
    if (a) return { ...remapAnchors(a, platform), source: a.platforms ? 'shared' : platform };
  }
  if (!installRoot) return null;
  const vs = (await supportedVersions({ platform, anchorsDir })).filter((v) => /^\d+(\.\d+)+$/.test(v));
  const base = vs.at(-1);
  return base ? fallbackAnchors(await loadAnchors({ platform, version: base, anchorsDir }), version, installRoot) : null;
}

// 未适配版本的兼容模式：沿用旧版本锚点，但
//  · 去掉原版 sha256 校验（新版文件本来就不同）、去掉“必需”条目和模板片段的出现次数要求：匹配不上的跳过、只计数
//  · NLS 改按原文匹配（新版 nls.messages.json 的下标会变）
//  · 新版里不存在的文件直接剔除；一个目标文件都没有才返回 null（真的不认识这个安装）
// DOM 补漏是追加在 bundle 末尾的，不依赖代码结构，新版照样生效
export async function fallbackAnchors(base, version, installRoot) {
  const has = (r) => exists(path.join(installRoot, r));
  const files = [];
  for (const f of base.files) {
    if (await has(f.relative)) files.push({ ...f, strings: f.strings.map(({ from }) => ({ from })), fragments: f.fragments?.map(({ from, to }) => ({ from, to })) });
  }
  if (!files.length) return null;
  const relatives = [];
  for (const r of base.dom?.relatives ?? []) if (await has(r)) relatives.push(r);
  const { pristine, nls, dom, ...rest } = base;
  return {
    ...rest, version, files, fallback: true, base: base.version,
    ...(relatives.length ? { dom: { ...dom, relatives } } : {}),
    ...(nls && (await has(nls.relative)) ? { nls: { ...nls, byText: true } } : {}),
  };
}

// 当前平台能用的版本（共用 + 平台专用）
export async function supportedVersions({ platform, anchorsDir }) {
  const out = new Set();
  const ls = async (d) => { try { return (await fs.readdir(d)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } };
  for (const dir of dirsOf(anchorsDir)) {
    for (const v of await ls(path.join(dir, platform))) out.add(v);
    for (const v of await ls(dir)) {
      const a = await readJson(path.join(dir, `${v}.json`)).catch(() => null);
      if (a && (!a.platforms || a.platforms.includes(platform))) out.add(v);
    }
  }
  return [...out].sort(cmpVersion);
}
// 词典：英文原文 → 中文；静态补丁和 DOM 补漏共用
export async function loadDict(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// NLS 专用词典（Cursor 自己加的菜单/命令/对话框文案，只写进 nls.messages.json，不进静态补丁和 DOM 补漏）；缺失当空
export async function loadNlsDict(file) {
  if (!file) return {};
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

// 数字模板（"Tab Stats: {n} ({n}%)" → "Tab 统计：{n} ({n}%)"）：只给 DOM 补漏在界面外壳区域用；文件缺失就当没有
export async function loadPatterns(file) {
  if (!file) return [];
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
