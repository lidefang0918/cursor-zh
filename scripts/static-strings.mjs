#!/usr/bin/env node
// 静态可见字符串扫描：不依赖界面渲染，直接对工作台 bundle 做词法分析（acorn tokenizer），
// 找出“设置相关模块”里所有像展示文案的字符串字面量 / 模板字面量，统计词典覆盖率，列出还没汉化的。
// 解决的问题：coverage-scan.mjs 只统计 box 上实际渲染出来的 DOM，被功能开关 / 套餐 / 平台挡住的分区
// （远程控制、自托管 Worker、运行模式说明与确认框、Python 自动导入 Beta 等）永远渲染不出来，就一直漏掉。
// 用法：node scripts/static-strings.mjs <安装根> [--json out.json] [--all]
//   安装根同 build-anchors.py（Linux /usr/share/cursor、macOS Cursor.app/Contents）；应传原版（未汉化）目录。
//   --all：不限设置模块，扫整个 bundle（只用于排查）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
let ALL = false;
let dict = {}, templates = {}, patterns = [], keep = { exact: [], regex: [] }, skip = { exact: [], regex: [], modules: [] }, anchors = { files: [] };
export function loadContext(version, repo = REPO) {
  dict = readJson(path.join(repo, 'dicts/zh-cn.json'), {});
  templates = readJson(path.join(repo, 'dicts/zh-cn.templates.json'), { templates: {} }).templates;
  patterns = readJson(path.join(repo, 'dicts/zh-cn.patterns.json'), []);
  keep = readJson(path.join(repo, 'scripts/coverage-keep.json'), { exact: [], regex: [] });
  skip = { exact: [], regex: [], ...readJson(path.join(repo, 'scripts/static-skip.json'), {}) };
  anchors = readJson(path.join(repo, 'anchors', `${version}.json`), { files: [] });
}

// 设置相关模块（glass bundle 里 esbuild 的 L({"文件名.js"(){…}}) 包装能给出源文件名）
export const SETTINGS_MODULE = /setting|preferences|section\.react|remote-control|auto-?run|allowlist|cursor-tab-config|plan-usage|account-closed|computer-use-section|default-environment|run-mode|ToolApproval/i;
// 只看界面层：React 组件、*-copy.js 文案表，以及设置目录 / 运行模式文案这几个纯数据模块
const UI_MODULE = /\.react\.js$|-copy\.js$|^(settingsCatalog|autorunSettingsValues|composerToolApprovalContextValue|settingsNavVisibility)\.js$/;
const NOT_SETTINGS = new RegExp(['gallery', 'Gallery', '^[A-Z]\\w*Section\\.js$', 'badgesSection', 'customer-evals', 'computer-use-preview', 'environment-setup', 'file-tree', 'editor-preferences-menu', 'managed-automation', '_pb\\.js$', '\\.ts$', 'plan-references', 'plan-todos', 'diff-tab', 'pr-tab', 'tab-content', 'environment-setup-tab'].join('|'));
const WINDOW = 1500;
const DISPLAY = new Set(['label', 'title', 'children', 'tooltip', 'heading', 'description', 'placeholder', 'primaryLabel', 'secondaryLabel', 'defaultLabel', 'accessibleLabel', 'displayName', 'buttonText', 'text', 'message', 'detail', 'header', 'subtitle', 'ariaLabel', 'aria-label', 'confirmLabel', 'cancelLabel', 'emptyMessage', 'sectionTitle', 'workersLabel', 'workersDescription', 'hint', 'caption', 'body', 'content', 'helperText', 'errorMessage', 'subtext', 'badge', 'name']);

export function looksVisible(s, ctx) {
  const t = s.trim();
  if (!/[A-Za-z]{2}/.test(t) || t.length > 400) return false;
  if (/^(https?:|\.{0,2}\/|#|--|@|\$\(|vscode|cursor:\/\/)/.test(t) || /[{}<>=]|=>|\\n|^\W/.test(t) || (/;/.test(t) && !/^[A-Z][^;]*[a-z]; [a-z]/.test(t))) return false;
  if (/^[\w.:/-]+$/.test(t) && !/^[A-Z][a-z]+$/.test(t) && !/^[A-Z][a-z]+(?:[- ][A-Z]?[a-z]+)+$/.test(t)) return false; // id / css / 路径 / camelCase
  if (/^[a-z0-9:[\]._/!-]+( [a-z0-9:[\]._/!%#()-]+)+$/.test(t) && !/[.?!]$/.test(t)) return false; // 全小写 class 列表
  if (/\s/.test(t)) return /^[A-Z"'“(]/.test(t) || /[.?!:…]$/.test(t);
  return /^[A-Z]/.test(t) && (ctx.display || ctx.assign); // 单词：只认展示字段 / 常量赋值
}

// 日志 / 异常 / 遥测参数：Error("…")、console.warn("…")、logger.info("…")，用户看不到
function isLog(toks, i) {
  const a = toks[i - 1], b = toks[i - 2], c = toks[i - 3];
  if (a?.value !== undefined || a?.type?.label !== '(') return false;
  return /Error$/.test(String(b?.value)) || (c?.type?.label === '.' && /^(log|warn|error|info|debug|trace)$/.test(String(b?.value)));
}

function isCovered(s, tplKey) {
  const t = s.trim();
  if (dict[t] !== undefined || dict[s] !== undefined) return 'dict';
  if (keep.exact.includes(t) || keep.regex.some((r) => new RegExp(r).test(t))) return 'keep';
  if (skip.exact.includes(t) || skip.regex.some((r) => new RegExp(r).test(t))) return 'skip';
  if (tplKey && templates[tplKey] !== undefined) return 'template';
  const nr = (x) => x.replace(/\$\{\d+\}|\{n\}|\d+/g, '#');
  if (patterns.some((p) => nr(p.from) === nr(t))) return 'pattern';
  return null;
}

export function scan(src, rel, { minModules = 500 } = {}) {
  const frags = (anchors.files.find((f) => f.relative.endsWith(rel))?.fragments) || [];
  const fragCovered = (raw) => frags.some((f) => f.from.includes(raw) || (/[A-Za-z]{3,} [A-Za-z]{3,}/.test(f.from) && raw.includes(f.from)));
  const toks = [];
  for (const tok of acorn.tokenizer(src, { ecmaVersion: 'latest', sourceType: 'module' })) toks.push(tok);
  const tt = acorn.tokTypes;
  // 模块区间：L({"x.js"(){ … }}) 包装体之前到上一个包装体结束之间的代码都属于 x.js
  const mods = []; let depth = 0; const open = [];
  const modAt = new Array(toks.length);
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i].type;
    if (k === tt.braceL || k === tt.dollarBraceL) depth++;
    else if (k === tt.braceR) { depth--; if (open.length && open[open.length - 1].depth === depth) { const m = open.pop(); m.end = i; mods.push(m); } }
    if (k === tt.string && /\.(js|ts)$/.test(toks[i].value) && toks[i - 1]?.type === tt.braceL && toks[i - 2]?.type === tt.parenL && toks[i + 1]?.type === tt.parenL && toks[i + 2]?.type === tt.parenR && toks[i + 3]?.type === tt.braceL) {
      open.push({ name: toks[i].value, start: i, depth: depth });
    }
  }
  mods.sort((a, b) => a.end - b.end);
  let mi = 0;
  // 只有少数模块带包装（desktop 只有十几个）时，按模块名归属不可靠，全部走组件邻近范围
  const byModule = mods.length > minModules; // desktop bundle 的设置代码在最后一个模块包装之后，没有模块名，走下面的命名空间邻近窗口
  for (let i = 0; i < toks.length; i++) { while (mi < mods.length && mods[mi].end < i) mi++; modAt[i] = byModule ? mods[mi]?.name ?? '' : ''; }
  // 没有模块名的 bundle（desktop 大部分代码）：设置页都用同一个设置组件命名空间 X.Root / X.Entry / X.Preview，
  // 取每处 X.Root / X.Entry 前后 WINDOW 个 token 作为“设置组件”范围
  const members = new Map();
  for (let i = 2; i < toks.length; i++) if (toks[i - 1].type === tt.dot && toks[i - 2].type === tt.name && /^(Root|Entry|Preview)$/.test(toks[i].value)) {
    const m = members.get(toks[i - 2].value) ?? new Set(); m.add(toks[i].value); members.set(toks[i - 2].value, m);
  }
  const ns = new Set([...members].filter(([, m]) => m.size === 3).map(([k]) => k));
  const near = new Uint8Array(toks.length);
  for (let i = 2; i < toks.length; i++) if (toks[i - 1].type === tt.dot && ns.has(toks[i - 2].value) && /^(Root|Entry)$/.test(toks[i].value)) near.fill(1, Math.max(0, i - WINDOW), Math.min(toks.length, i + WINDOW));
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const mod = modAt[i];
    const inScope = ALL || (mod ? SETTINGS_MODULE.test(mod) && UI_MODULE.test(mod) && !NOT_SETTINGS.test(mod) : near[i] === 1);
    if (!inScope) continue;
    const p1 = toks[i - 1], p2 = toks[i - 2];
    const propName = p1?.type === tt.colon ? (p2?.value ?? '') : (p1?.type === tt.bracketL && toks[i - 2]?.type === tt.colon ? toks[i - 3]?.value : '');
    const tern = p1?.type === tt.colon && (p2?.type === tt.string || p2?.type === tt.backQuote); // a?"x":"y"
    const ctx = { display: DISPLAY.has(String(propName)) || tern, assign: p1?.type === tt.eq && /^[\w$]+$/.test(String(p2?.value ?? '')) };
    if (ctx.assign && p2?.type === tt.name && toks[i - 3]?.type === tt.dot) ctx.assign = false; // obj.x="…" 多是逻辑
    if (tok.type === tt.string) {
      if (p1?.type === tt.equality || p1?.type?.keyword === 'case' || p1?.type?.keyword === 'in' || toks[i + 1]?.type === tt.equality || toks[i + 1]?.type === tt.colon && !ctx.display && (p1?.type === tt.braceL || p1?.type === tt.comma)) continue;
      if (isLog(toks, i)) continue;
      if (looksVisible(tok.value, ctx)) out.push({ text: tok.value, raw: src.slice(tok.start, tok.end), kind: 'string', module: mod, prop: tern ? '' : propName });
    } else if (tok.type === tt.backQuote && toks[i - 1]?.type !== tt.template && toks[i + 1]?.type === tt.template) {
      // 模板：拼出 ${1}${2}… 形式的 key，与 dicts/zh-cn.templates.json 一致
      let j = i + 1, text = '', rawKey = '', n = 0, d = 0;
      for (; j < toks.length; j++) {
        const k = toks[j].type;
        if (d === 0 && k === tt.template) { text += toks[j].value ?? ''; rawKey += src.slice(toks[j].start, toks[j].end); }
        else if (d === 0 && k === tt.backQuote) break;
        if (k === tt.dollarBraceL) { if (d === 0) { text += '${' + ++n + '}'; rawKey += '${' + n + '}'; } d++; } else if (k === tt.braceL) d++; else if (k === tt.braceR && d > 0) d--;
      }
      const raw = src.slice(tok.start, toks[j].end);
      if (!n) { if (looksVisible(text, ctx)) out.push({ text, raw, kind: 'string', module: mod, prop: propName }); continue; }
      const plain = text.replace(/\$\{\d+\}/g, 'X');
      if (/[A-Za-z]{3,} [A-Za-z]{2,}/.test(plain) && looksVisible(plain.replace(/^X\s*/, 'X '), { display: true }) && !/^[a-z-]+ /.test(plain)) out.push({ text, rawKey, raw, kind: 'template', module: mod, prop: propName });
    }
  }
  return out.map((e) => ({ ...e, covered: isCovered(e.text, e.kind === 'template' ? e.text : null) || (e.rawKey && templates[e.rawKey] !== undefined ? 'template' : null) || ((e.kind === 'template' || e.raw.length >= 8) && fragCovered(e.raw) ? 'fragment' : null) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  ALL = args.includes('--all');
  const app = ['resources/app', 'Resources/app'].map((d) => path.join(args[0], d)).find((d) => fs.existsSync(path.join(d, 'product.json')));
  if (!app) { console.error(`找不到 resources/app/product.json：${args[0]}`); process.exit(2); }
  const version = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8')).version;
  loadContext(version);
  const report = { version, bundles: {} };
  const uniq = new Map();
  for (const b of ['workbench.desktop.main.js', 'workbench.glass.main.js']) {
    const rel = `out/vs/workbench/${b}`;
    const items = scan(fs.readFileSync(path.join(app, rel), 'utf8'), rel);
    report.bundles[b] = { total: items.length, covered: items.filter((x) => x.covered).length };
    for (const x of items) if (!uniq.has(x.text) || (!x.covered && uniq.get(x.text).covered)) uniq.set(x.text, x);
  }
  const all = [...uniq.values()];
  const miss = all.filter((x) => !x.covered);
  const skipped = all.filter((x) => x.covered === 'skip').length;
  const by = {}; for (const x of all) if (x.covered) by[x.covered] = (by[x.covered] ?? 0) + 1;
  // 口径：已翻译 = 词典/模板/片段/规则命中；有意保留英文 = coverage-keep（品牌/术语）+ static-skip（内部开发项/日志）
  report.unique = { total: all.length, covered: all.length - miss.length, translated: all.length - miss.length - skipped - (by.keep ?? 0), keep: (by.keep ?? 0) + skipped, missing: miss.length, by,
    rate: +(100 * (all.length - miss.length) / Math.max(1, all.length)).toFixed(1) };
  report.missing = miss.map(({ text, kind, module, prop }) => ({ text, kind, module, prop }));
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(report, null, 2));
  for (const x of miss) console.log(`MISS ${x.kind === 'template' ? 'T' : 'S'} [${x.module}] ${x.prop ? x.prop + ':' : ''}${JSON.stringify(x.text)}`);
  const u = report.unique;
  console.log(`静态可见字符串（设置相关模块，去重）：${u.covered}/${u.total} 已覆盖（${u.rate}%）= 已翻译 ${u.translated} + 有意保留英文 ${u.keep}；未覆盖 ${u.missing}`);
  console.log(`  命中来源：${Object.entries(u.by).map(([k, v]) => `${k} ${v}`).join('，')}；desktop ${report.bundles['workbench.desktop.main.js'].covered}/${report.bundles['workbench.desktop.main.js'].total}，glass ${report.bundles['workbench.glass.main.js'].covered}/${report.bundles['workbench.glass.main.js'].total}`);
}
