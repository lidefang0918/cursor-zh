import fs from 'node:fs/promises';
import path from 'node:path';

// 锚点按 anchors/<platform>/<cursorVersion>.json 存放；没有就返回 null（拒绝硬灌）
export async function loadAnchors({ platform, version, anchorsDir }) {
  try {
    return JSON.parse(await fs.readFile(path.join(anchorsDir, platform, `${version}.json`), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
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
