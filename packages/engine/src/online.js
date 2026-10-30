import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// 在线词典：词典和锚点就是 GitHub 仓库里的 JSON 文件，不用服务器。
// 顺序：GitHub 原始文件 → jsDelivr 镜像 → 上次下载的缓存 → 安装包自带。每个文件都按 dicts/manifest.json 里的 sha256 校验；
// manifest 的 schema / minTool 不兼容（新格式、需要新版工具）就不用，绝不加载看不懂的词典。
export const SOURCES = [
  ['GitHub', 'https://raw.githubusercontent.com/lidefang0918/cursor-zh/main/'],
  ['jsDelivr', 'https://cdn.jsdelivr.net/gh/lidefang0918/cursor-zh@main/'],
];
export const SCHEMA = 1;
export const MANIFEST = 'dicts/manifest.json';
export const DICT_FILES = ['dicts/zh-cn.json', 'dicts/zh-cn.nls.json', 'dicts/zh-cn.patterns.json'];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (p) => fs.readFile(p, 'utf8').then(JSON.parse, () => null);
const newer = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }) > 0;

// 用得上的 manifest：格式版本一致、本工具版本够新、词典文件都列了
export function usable(m, toolVersion) {
  return !!m && m.schema === SCHEMA && !newer(m.minTool ?? '0', toolVersion) && DICT_FILES.every((f) => m.files?.[f]);
}

// 要下载的文件：词典 + 当前 Cursor 版本的锚点（有的话）
const wanted = (m, version, platform) => [...DICT_FILES, `anchors/${version}.json`, `anchors/${platform}/${version}.json`].filter((f) => m.files[f]);

async function verified(dir, m, files) {
  for (const f of files) if (sha(await fs.readFile(path.join(dir, f)).catch(() => '')) !== m.files[f]) return false;
  return true;
}

async function get(url, fetchImpl, timeout) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeout), cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// 返回 { dir, source, updated }：dir 下是和仓库一样的 dicts/、anchors/ 布局。network=false 只看缓存和自带
export async function syncData({ bundledDir, cacheDir, toolVersion, version, platform, network = true, sources = SOURCES, fetchImpl = globalThis.fetch, timeout = 5000, log = () => {} }) {
  const bundled = await readJson(path.join(bundledDir, MANIFEST));
  const floor = bundled?.updated ?? '';
  const fail = [];
  for (const [name, base] of network && fetchImpl ? sources : []) {
    try {
      const raw = await get(base + MANIFEST, fetchImpl, timeout);
      const m = JSON.parse(raw);
      if (!usable(m, toolVersion)) { fail.push(`${name}：词典格式需要新版工具`); continue; }
      if (newer(floor, m.updated)) { fail.push(`${name}：不比自带的新`); break; }
      const files = wanted(m, version, platform);
      const cached = await readJson(path.join(cacheDir, MANIFEST));
      const got = new Map();
      for (const f of files) {
        if (cached?.files?.[f] === m.files[f] && (await verified(cacheDir, m, [f]))) continue;
        const buf = await get(base + f, fetchImpl, timeout * 3);
        if (sha(buf) !== m.files[f]) throw new Error(`${f} 校验不符（镜像可能还没同步）`);
        got.set(f, buf);
      }
      // 全部下好、校验通过后才落盘；manifest 最后写
      for (const [f, buf] of got) {
        await fs.mkdir(path.dirname(path.join(cacheDir, f)), { recursive: true });
        await fs.writeFile(path.join(cacheDir, f), buf);
      }
      await fs.mkdir(path.join(cacheDir, 'dicts'), { recursive: true });
      await fs.writeFile(path.join(cacheDir, MANIFEST), raw);
      if (fail.length) log(`已改用 ${name}（${fail.join('；')}）`);
      return { dir: cacheDir, source: name, updated: m.updated };
    } catch (e) { fail.push(`${name}：${e.message}`); }
  }
  if (fail.length) log(`在线词典不可用（${fail.join('；')}）`);
  const c = await readJson(path.join(cacheDir, MANIFEST));
  if (usable(c, toolVersion) && !newer(floor, c.updated) && (await verified(cacheDir, c, DICT_FILES))) return { dir: cacheDir, source: '缓存', updated: c.updated };
  return { dir: bundledDir, source: '内置', updated: bundled?.updated ?? null };
}

// 生成 manifest（scripts/build-manifest.mjs 和测试共用）：文件没变就沿用原来的 updated
export async function buildManifest(repo, { minTool, now = new Date().toISOString() } = {}) {
  const old = await readJson(path.join(repo, MANIFEST));
  const files = {};
  const anchors = [];
  for (const d of ['anchors', ...(await fs.readdir(path.join(repo, 'anchors'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => `anchors/${e.name}`)]) {
    for (const f of (await fs.readdir(path.join(repo, d))).filter((n) => n.endsWith('.json')).sort()) anchors.push(`${d}/${f}`);
  }
  for (const f of [...DICT_FILES, ...anchors]) files[f] = sha(await fs.readFile(path.join(repo, f)));
  const same = old && JSON.stringify(old.files) === JSON.stringify(files) && old.minTool === (minTool ?? old.minTool);
  return { schema: SCHEMA, minTool: minTool ?? old?.minTool ?? '0.1.1', updated: same ? old.updated : now, files };
}
