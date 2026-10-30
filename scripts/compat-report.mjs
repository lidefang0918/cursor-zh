#!/usr/bin/env node
// 兼容性报告：拿现有词典/锚点在一份 Cursor 安装上“试打补丁”（在临时副本上，安装本身不动），统计能匹配多少、列出没匹配上的。
// Cursor 出新版时（.github/workflows/cursor-watch.yml）和本地验证兼容模式都用它。
// 用法：node scripts/compat-report.mjs <安装根> [--base=<锚点版本>] [--platform=linux|win32|darwin] [--md=报告.md]
//   默认按“除安装版本外最新的锚点”走兼容模式，模拟用户升级 Cursor 后、本工具还没适配时的效果。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAnchors, fallbackAnchors, supportedVersions, loadDict, loadNlsDict, loadPatterns } from '../packages/engine/src/anchors.js';
import { patchTree } from '../packages/engine/src/localize.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const val = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const root = path.resolve(args.find((a) => !a.startsWith('--')) ?? '/usr/share/cursor');
const platform = val('platform') ?? ((await fs.access(path.join(root, 'Resources/app')).then(() => true, () => false)) ? 'darwin' : 'linux');
const app = root.endsWith(".app/Contents") || platform === "darwin" ? 'Resources/app' : 'resources/app';
const product = JSON.parse(await fs.readFile(path.join(root, app, 'product.json'), 'utf8'));
const anchorsDir = path.join(repo, 'anchors');
const base = val('base') ?? (await supportedVersions({ platform, anchorsDir })).filter((v) => /^\d+(\.\d+)+$/.test(v) && v !== product.version).at(-1);
const anchors = await fallbackAnchors(await loadAnchors({ platform, version: base, anchorsDir }), product.version, root);
if (!anchors) { console.error(`在 ${root} 找不到锚点里的界面文件`); process.exit(2); }

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'czl-compat-'));
const rels = [...new Set([...anchors.files.map((f) => f.relative), ...(anchors.dom?.relatives ?? []), anchors.productJson, anchors.nls?.relative].filter(Boolean))];
for (const r of rels) { await fs.mkdir(path.dirname(path.join(tmp, r)), { recursive: true }); await fs.copyFile(path.join(root, r), path.join(tmp, r)); }
const t0 = Date.now();
const r = await patchTree({
  root: tmp, anchors, dict: await loadDict(path.join(repo, 'dicts/zh-cn.json')),
  nlsDict: await loadNlsDict(path.join(repo, 'dicts/zh-cn.nls.json')), patterns: await loadPatterns(path.join(repo, 'dicts/zh-cn.patterns.json')),
});
await fs.rm(tmp, { recursive: true, force: true });
const missing = [...r.missing, ...r.nlsMissing.map((m) => `nls:${m}`)];
const rate = ((100 * r.matched) / (r.matched + r.unmatched)).toFixed(1);
const md = [
  `## Cursor ${product.version}（commit ${String(product.commit).slice(0, 8)}）兼容性报告`,
  '',
  `按 **${base}** 的锚点走兼容模式试打补丁（临时副本，${Date.now() - t0} ms）：`,
  `- 已匹配 **${r.matched}** 条，未匹配 **${r.unmatched}** 条（匹配率 ${rate}%）；静态替换 ${r.replaced} 处，模板片段 ${r.fragmentsReplaced} 处，NLS ${r.nlsReplaced} 条`,
  '- 未匹配的条目在界面上仍由 DOM 补漏兜底；改了英文原文的需要补词典，再用 `sh scripts/new-version.sh` 生成新锚点',
  '',
  `<details><summary>未匹配的条目（${missing.length}）</summary>`,
  '',
  ...missing.map((m) => `- \`${m.replace(/`/g, 'ˋ')}\``),
  '',
  '</details>',
].join('\n');
if (val('md')) await fs.writeFile(val('md'), md + '\n');
console.log(md.split('<details>')[0].trim());
