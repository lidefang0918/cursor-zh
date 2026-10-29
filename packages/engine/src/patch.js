import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const QUOTES = ['"', "'", '`'];

// VS Code product.json checksums：sha256 的 base64，去掉末尾 '='
export function vscodeChecksum(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

export function filesToBackup(anchors) {
  return [...anchors.files.map((f) => f.relative), ...(anchors.productJson ? [anchors.productJson] : [])];
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

export async function applyPatch({ installRoot, anchors, dict }) {
  const patched = [];
  const missing = [];
  let replaced = 0;
  const changed = new Map(); // relative -> Buffer

  for (const file of anchors.files) {
    const abs = path.join(installRoot, file.relative);
    let src = await fs.readFile(abs, 'utf8');
    let fileCount = 0;
    for (const s of file.strings) {
      const to = dict[s.from];
      if (!to) {
        if (s.required) throw new Error(`词典缺少必需条目：${s.from}`);
        continue;
      }
      const { out, count } = replaceLiterals(src, s.from, to);
      if (count === 0) {
        if (s.required) throw new Error(`必需锚点缺失：${s.from}（${file.relative}）`);
        missing.push(s.from);
        continue;
      }
      src = out;
      fileCount += count;
    }
    if (fileCount > 0) {
      changed.set(file.relative, Buffer.from(src, 'utf8'));
      replaced += fileCount;
    }
  }

  // 先全部算完再落盘，减少半写状态
  for (const [relative, buf] of changed) {
    await fs.writeFile(path.join(installRoot, relative), buf);
    patched.push(relative);
  }

  const checksumsUpdated = [];
  if (anchors.productJson && changed.size) {
    const productPath = path.join(installRoot, anchors.productJson);
    const raw = await fs.readFile(productPath, 'utf8');
    const product = JSON.parse(raw);
    if (product.checksums) {
      const base = path.join(installRoot, anchors.checksumBase || path.dirname(anchors.productJson) + '/out');
      for (const [relative, buf] of changed) {
        const key = path.relative(base, path.join(installRoot, relative)).split(path.sep).join('/');
        if (key in product.checksums) {
          product.checksums[key] = vscodeChecksum(buf);
          checksumsUpdated.push(key);
        }
      }
      if (checksumsUpdated.length) {
        const indent = raw.match(/^\{\r?\n(\s+)/)?.[1] ?? '\t';
        await fs.writeFile(productPath, JSON.stringify(product, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
      }
    }
  }
  return { patched, missing, replaced, checksumsUpdated };
}
