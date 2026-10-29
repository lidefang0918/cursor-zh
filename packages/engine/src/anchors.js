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
