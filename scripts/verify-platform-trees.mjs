#!/usr/bin/env node
// 离线验证：拿官方 Windows / macOS / Linux 安装包解出的目录，复制成假安装根，跑引擎完整补丁流程并校验。
// 用法：node scripts/verify-platform-trees.mjs <名字>=<平台>:<安装根> ...
//   例：win-user=win32:/workspace/cache/ex/win-user/Cursor mac-arm64=darwin:/workspace/cache/ex/mac-arm64/Cursor.app/Contents
// 检查：未命中 0；补丁后的 JS 能过 node --check；nls.messages.json 是合法 JSON；product.json 的 checksums
// 与 VS Code 启动时的算法一致（sha256 → base64 去掉 '='，键相对 out/）；product.json 除 checksums 外逐字节不变（Windows 的 target 字段保留）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadAnchors, loadDict, loadPatterns, patchTree, defaultPaths } from '../packages/engine/src/index.js';

const P = defaultPaths();
const dict = await loadDict(P.dictPath);
const patterns = await loadPatterns(P.patternsPath);
const b64 = (buf) => crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let failed = 0;

for (const spec of process.argv.slice(2)) {
  const [name, rest] = spec.split('=');
  const i = rest.indexOf(':');
  const platform = rest.slice(0, i);
  const src = rest.slice(i + 1);
  const product = JSON.parse(await fs.readFile(path.join(src, platform === 'darwin' ? 'Resources/app/product.json' : 'resources/app/product.json'), 'utf8'));
  const anchors = await loadAnchors({ platform, version: product.version, anchorsDir: P.anchorsDir });
  const checks = [];
  const ok = (cond, msg) => { checks.push(`${cond ? '✔' : '✖'} ${msg}`); if (!cond) failed++; };
  if (!anchors) { ok(false, `${name}: 没有 ${platform} ${product.version} 的锚点`); console.log(checks.join('\n')); continue; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `czl-verify-${name}-`));
  const rels = [...new Set([anchors.productJson, anchors.nls?.relative, ...anchors.files.map((f) => f.relative), ...(anchors.dom?.relatives ?? [])].filter(Boolean))];
  for (const r of rels) { await fs.mkdir(path.dirname(path.join(root, r)), { recursive: true }); await fs.copyFile(path.join(src, r), path.join(root, r)); }
  const before = Object.fromEntries(await Promise.all(rels.map(async (r) => [r, await fs.readFile(path.join(root, r))])));
  for (const [r, s] of Object.entries(anchors.pristine ?? {})) ok(sha(before[r]) === s, `${name}: 原版 sha256 与锚点 pristine 一致 ${r.split('/').pop()}`);

  const res = await patchTree({ root, anchors, dict, patterns });
  ok(res.missing.length === 0, `${name}: 静态补丁 ${res.replaced} 处 + 片段 ${res.fragmentsReplaced} 处，未命中 ${res.missing.length}${res.missing.length ? '：' + res.missing.slice(0, 5).join('；') : ''}`);
  ok(res.nlsMissing.length === 0, `${name}: NLS ${res.nlsReplaced} 条，未命中 ${res.nlsMissing.length}`);
  for (const f of anchors.dom?.relatives ?? []) {
    try { execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' }); ok(true, `${name}: node --check ${f.split('/').pop()}`); }
    catch (e) { ok(false, `${name}: node --check ${f}：${String(e.stderr).slice(0, 300)}`); }
  }
  try { JSON.parse(await fs.readFile(path.join(root, anchors.nls.relative), 'utf8')); ok(true, `${name}: nls.messages.json 是合法 JSON`); } catch (e) { ok(false, `${name}: nls JSON ${e.message}`); }

  const rawAfter = await fs.readFile(path.join(root, anchors.productJson), 'utf8');
  const pAfter = JSON.parse(rawAfter);
  const pBefore = JSON.parse(before[anchors.productJson].toString('utf8'));
  const base = path.join(root, anchors.checksumBase);
  let changedKeys = 0;
  for (const [key, val] of Object.entries(pAfter.checksums ?? {})) {
    const cur = b64(await fs.readFile(path.join(base, key)).catch(() => fs.readFile(path.join(src, anchors.checksumBase, key))));
    ok(val === cur, `${name}: checksum ${key} ${val === pBefore.checksums[key] ? '(未改动文件)' : '(已更新)'} = base64(sha256) 去 '='`);
    if (val !== pBefore.checksums[key]) changedKeys++;
  }
  ok(changedKeys === res.checksumsUpdated.length && changedKeys >= 1, `${name}: 更新了 ${changedKeys} 个 checksum：${res.checksumsUpdated.join(', ')}`);
  // 除 checksum 值外 product.json 逐字节不变
  let normalized = rawAfter;
  for (const k of res.checksumsUpdated) normalized = normalized.replace(JSON.stringify(pAfter.checksums[k]), JSON.stringify(pBefore.checksums[k]));
  ok(normalized === before[anchors.productJson].toString('utf8'), `${name}: product.json 其余字节不变${pBefore.target ? `（target=${pAfter.target}）` : ''}`);
  console.log(`== ${name} (${platform}, ${anchors.source}, ${product.version}, 根=${src})\n${checks.join('\n')}`);
  await fs.rm(root, { recursive: true, force: true });
}
console.log(failed ? `\n✖ ${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
