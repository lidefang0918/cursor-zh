// 术语一致性检查（dicts/glossary.md 的机器可查部分）：英文里出现术语，译文里就必须出现统一译名
// node scripts/check-glossary.mjs [dict.json]  → 有违例时列出并以 1 退出；npm test 里也会跑
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RULES = [
  [/\bsub-?agents?\b/i, '子智能体'],
  [/\bagents?\b/i, '智能体'],
  [/\bskills?\b/i, '技能'],
  [/\bworktrees?\b/i, '工作树'],
  [/\bmarketplace\b/i, '插件市场'],
  [/\brepositor(y|ies)\b/i, '仓库'],
  [/\bplugins?\b/i, '插件'],
  [/\bhooks?\b/i, '钩子'],
  [/\bundo\b/i, '撤销'],
];
// 禁用的旧译/异译
export const BANNED = [[/撤消/, '撤销'], [/工作区树/, '工作树']];

export function checkGlossary(dict) {
  const bad = [];
  for (const [en, zh] of Object.entries(dict)) {
    if (typeof zh !== 'string') continue;
    const text = en.replace(/(^|\s)[/@][\w-]+/g, ' '); // 斜杠命令、@ 提及原样保留，不算术语
    for (const [re, want] of RULES) if (re.test(text) && !zh.includes(want)) bad.push(`${en} → ${zh}（应含“${want}”）`);
    for (const [re, want] of BANNED) if (re.test(zh)) bad.push(`${en} → ${zh}（用“${want}”）`);
  }
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? new URL('../dicts/zh-cn.json', import.meta.url);
  const bad = checkGlossary(JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const b of bad) console.log('✖ ' + b);
  console.log(bad.length ? `术语不一致 ${bad.length} 条` : '✔ 术语一致');
  process.exit(bad.length ? 1 : 0);
}
