#!/usr/bin/env node
// 改了词典或锚点后运行：重算 dicts/manifest.json（在线词典的清单，含每个文件的 sha256）。
// 用法：node scripts/build-manifest.mjs [--min-tool=0.3.0]   （词典格式变了、旧工具读不懂时才改 --min-tool）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, MANIFEST } from '../packages/engine/src/online.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const minTool = process.argv.find((a) => a.startsWith('--min-tool='))?.split('=')[1];
const m = await buildManifest(repo, { minTool });
await fs.writeFile(path.join(repo, MANIFEST), JSON.stringify(m, null, 2) + '\n');
console.log(`${MANIFEST}：${Object.keys(m.files).length} 个文件，updated ${m.updated}`);
