import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const QUOTES = ['"', "'", '`'];

// VS Code product.json checksums：sha256 的 base64，去掉末尾 '='
export function vscodeChecksum(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

export function filesToBackup(anchors) {
  return [
    ...anchors.files.map((f) => f.relative),
    ...(anchors.productJson ? [anchors.productJson] : []),
    ...(anchors.nls?.relative ? [anchors.nls.relative] : []),
  ];
}

const escapeFor = (s, q) => s.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`).replace(/\n/g, '\\n');

// 只替换"整段字符串字面量"：'"Cursor Settings"' 会被替换，'"Open Cursor Settings"' 不会
export function replaceLiterals(src, from, to) {
  let out = src;
  let count = 0;
  for (const q of QUOTES) {
    if (from.includes(q)) continue;
    const parts = out.split(q + from + q);
    count += parts.length - 1;
    out = parts.join(q + escapeFor(to, q) + q);
  }
  return { out, count };
}


// 一个文件一次扫描替换多条（每种引号一遍），大 bundle 上比逐条 split/join 快得多
export function replaceAllLiterals(src, map) {
  const counts = new Map();
  let out = src;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  for (const q of QUOTES) {
    const ks = keys.filter((k) => !k.includes(q));
    if (!ks.length) continue;
    // original: 后面的英文是命令面板的英文别名（{value, original}），永远不翻
    const re = new RegExp(`(?<!original:\\s*)${q}(${ks.map(escapeRe).join('|')})${q}`, 'g');
    out = out.replace(re, (_, k) => {
      counts.set(k, (counts.get(k) ?? 0) + 1);
      return q + escapeFor(map.get(k), q) + q;
    });
  }
  return { out, counts };
}

// 模板字面量里的固定片段（如 "`$(tab) Tab Stats: ${"）：带足上下文，出现次数必须和锚点里的 count 完全一致才替换，
// 否则整条跳过并记为未命中（版本变了、上下文对不上就不冒险）
export function applyFragments(src, fragments = []) {
  // 快路径：所有片段都带 count 时，用一个正则一遍扫完整个 bundle（比每条 indexOf 扫一遍快 2–3 倍）。
  // 正则匹配天然不重叠；只要每条的命中数都和 count 一致就直接用，否则（片段互相包含等）退回下面的逐条查找
  if (fragments.length > 1 && fragments.every((f) => f.count !== undefined && f.from)) {
    const byFrom = new Map(fragments.map((f) => [f.from, f]));
    if (byFrom.size === fragments.length) {
      const re = new RegExp([...byFrom.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g');
      const seen = new Map();
      const hits = [];
      for (const m of src.matchAll(re)) { seen.set(m[0], (seen.get(m[0]) ?? 0) + 1); hits.push([m.index, m.index + m[0].length, byFrom.get(m[0]).to]); }
      if (fragments.every((f) => seen.get(f.from) === f.count)) {
        const out = [];
        let last = 0;
        for (const [a, b, to] of hits) { out.push(src.slice(last, a), to); last = b; }
        out.push(src.slice(last));
        return { out: out.join(''), replaced: hits.length, missing: [] };
      }
    }
  }
  // 先在原文上用 indexOf 找齐所有片段的位置，最后一次性拼出结果（每条都 split/join 整个 50MB bundle 要好几秒）
  const hits = [];
  const missing = [];
  for (const { from, to, count } of fragments) {
    const at = [];
    for (let i = src.indexOf(from); i >= 0; i = src.indexOf(from, i + from.length)) at.push(i);
    if (at.length === 0 || (count !== undefined && at.length !== count)) { missing.push(`fragment:${from}（${at.length}/${count ?? '≥1'}）`); continue; }
    for (const i of at) hits.push([i, i + from.length, to]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  // 片段互相重叠时结果依赖顺序，退回逐条替换（目前锚点里没有这种情况）
  if (hits.some((h, k) => k > 0 && h[0] < hits[k - 1][1])) return applyFragmentsSequential(src, fragments);
  const out = [];
  let last = 0;
  for (const [a, b, to] of hits) { out.push(src.slice(last, a), to); last = b; }
  out.push(src.slice(last));
  return { out: out.join(''), replaced: hits.length, missing };
}

function applyFragmentsSequential(src, fragments) {
  let out = src;
  let replaced = 0;
  const missing = [];
  for (const { from, to, count } of fragments) {
    const n = out.split(from).length - 1;
    if (n === 0 || (count !== undefined && n !== count)) { missing.push(`fragment:${from}（${n}/${count ?? '≥1'}）`); continue; }
    out = out.split(from).join(to);
    replaced += n;
  }
  return { out, replaced, missing };
}

export async function applyPatch({ installRoot, anchors, dict }) {
  const patched = [];
  const missing = [];
  let replaced = 0;
  let fragmentsReplaced = 0;
  const perFileFragments = {};
  const changed = new Map(); // relative -> Buffer
  const perFile = {};

  for (const file of anchors.files) {
    const abs = path.join(installRoot, file.relative);
    const src = await fs.readFile(abs, 'utf8');
    const map = new Map();
    for (const s of file.strings) {
      const to = dict[s.from];
      if (!to) {
        if (s.required) throw new Error(`词典缺少必需条目：${s.from}`);
        continue;
      }
      map.set(s.from, to);
    }
    const lit = replaceAllLiterals(src, map);
    const { counts } = lit;
    const fr = applyFragments(lit.out, file.fragments);
    const out = fr.out;
    missing.push(...fr.missing);
    perFileFragments[file.relative] = fr.replaced;
    fragmentsReplaced += fr.replaced;
    let fileCount = 0;
    for (const s of file.strings) {
      if (!map.has(s.from)) continue;
      const n = counts.get(s.from) ?? 0;
      if (n === 0) {
        if (s.required) throw new Error(`必需锚点缺失：${s.from}（${file.relative}）`);
        missing.push(s.from);
      }
      fileCount += n;
    }
    perFile[file.relative] = fileCount;
    if (fileCount > 0 || fr.replaced > 0) {
      changed.set(file.relative, Buffer.from(out, 'utf8'));
      replaced += fileCount;
    }
  }

  // 先全部算完再落盘，减少半写状态
  for (const [relative, buf] of changed) {
    await fs.writeFile(path.join(installRoot, relative), buf);
    patched.push(relative);
  }

  const { checksumsUpdated } = await updateChecksums({ installRoot, anchors, relatives: [...changed.keys()] });
  return { patched, missing, replaced, perFile, fragmentsReplaced, perFileFragments, checksumsUpdated };
}

// 按文件当前内容重算 product.json 里对应的 checksum（Cursor/VS Code 启动时校验，不一致会提示"安装已损坏"）
export async function updateChecksums({ installRoot, anchors, relatives }) {
  const checksumsUpdated = [];
  if (!anchors.productJson || !relatives.length) return { checksumsUpdated };
  const productPath = path.join(installRoot, anchors.productJson);
  const raw = await fs.readFile(productPath, 'utf8');
  const product = JSON.parse(raw);
  if (!product.checksums) return { checksumsUpdated };
  const base = path.join(installRoot, anchors.checksumBase || path.join(path.dirname(anchors.productJson), 'out'));
  let text = raw;
  for (const relative of relatives) {
    const key = path.relative(base, path.join(installRoot, relative)).split(path.sep).join('/');
    if (!(key in product.checksums)) continue;
    // 只替换值本身，保持 product.json 其余字节不变
    const fresh = vscodeChecksum(await fs.readFile(path.join(installRoot, relative)));
    const re = new RegExp(`(${escapeRe(JSON.stringify(key))}\\s*:\\s*)${escapeRe(JSON.stringify(product.checksums[key]))}`);
    if (!re.test(text)) throw new Error(`product.json 中找不到 ${key} 的校验值`);
    text = text.replace(re, (_, k) => k + JSON.stringify(fresh));
    checksumsUpdated.push(key);
  }
  if (checksumsUpdated.length) await fs.writeFile(productPath, text);
  return { checksumsUpdated };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
