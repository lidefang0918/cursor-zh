#!/usr/bin/env node
// 汉化覆盖率扫描：通过 CDP 连接已用 --remote-debugging-port 启动的 Cursor，
// 遍历 Agents 窗口的设置各页、经典窗口的 Cursor 设置各页、命令面板前若干条、
// Agents 窗口菜单（文件/编辑/查看/帮助…）以及侧边栏右键菜单，输出每页剩余英文。
//
// 只做只读操作：点击设置导航项、打开/关闭菜单（Escape）。会跳过外链导航项
// （带 ↗ 图标、云端智能体、文档）、账户入口与“返回”，不点击页面内任何按钮。
//
// 默认严格口径（中英混排算半翻译、计入英文），--loose 用旧口径（含中文即算已译）。
// 用法（--palette-pages 为翻页上限，默认 400，翻到底自动停）：
//   cursor --remote-debugging-port=9333 &   # 临时调试端口，扫描后请正常重启
//   node scripts/coverage-scan.mjs [--port 9333] [--json out.json] [--md out.md] [--only agents-settings,classic-settings,palette,menus,context,chrome,dropdowns] [--loose]
// dropdowns：每个设置页展开全部折叠区（如 模型 > API 密钥），逐个打开下拉（只打开不选），外加聊天输入框里的模式/模型下拉；同时统计 aria-label/title/placeholder。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const PORT = +opt('port', '9333');
const PAGES = +opt('palette-pages', '400');
const ONLY = opt('only', 'agents-settings,classic-settings,palette,menus,context,chrome,dropdowns').split(',');
const here = dirname(fileURLToPath(import.meta.url));
const KEEP = JSON.parse(readFileSync(join(here, 'coverage-keep.json'), 'utf8'));
const SKIP_NAV = ['返回', 'Back', '云端智能体', 'Cloud Agents', '文档', 'Docs', 'VS Code 设置', 'VS Code Settings'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(titlePart) {
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && (titlePart instanceof RegExp ? titlePart.test(x.title) : x.title.includes(titlePart)));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'eval error');
    return m.result?.result?.value;
  };
  const KEYS = { ',': ['Comma', 188], p: ['KeyP', 80], j: ['KeyJ', 74], Escape: ['Escape', 27], PageDown: ['PageDown', 34] };
  const key = async (k, mod = 0) => { const [code, vk] = KEYS[k]; for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: mod }); };
  const click = async (x, y) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  };
  const rightClick = async (x, y) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'right', clickCount: 1 });
  };
  return { title: t.title, evaluate, key, click, rightClick, close: () => ws.close() };
}

// 页面内执行：收集 root 下可见文本节点（排除编辑器/代码/聊天内容），返回去重后的文本。
const COLLECT = `(sel, minX) => {
  const roots = sel ? [...document.querySelectorAll(sel)] : [document.body];
  const skip = /monaco-editor|view-lines|xterm|markdown|ProseMirror|tiptap|composer-human-message/;
  const out = new Set();
  for (const root of roots) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      const t = n.nodeValue.replace(/\\s+/g, ' ').trim();
      if (!t || !/[A-Za-z\\u3400-\\u9fff]/.test(t)) continue;
      const el = n.parentElement; if (!el) continue;
      if (el.closest('script,style,textarea,input,pre,code,[contenteditable=true],[aria-hidden=true]')) continue;
      let bad = false; for (let p = el; p && p !== document.body; p = p.parentElement) { if (typeof p.className === 'string' && skip.test(p.className)) { bad = true; break; } }
      if (bad) continue;
      // 字体选择器里每项用自身字体预览（字体名不翻）
      let font = false; for (let p = el, i = 0; p && i < 3; p = p.parentElement, i++) { const f = p.style && p.style.fontFamily; if (f && f !== 'inherit') { font = true; break; } }
      if (font) continue;
      const r = el.getClientRects(); if (!r.length || !r[0].width) continue;
      if (minX != null && r[0].x < minX) continue;
      const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      out.add(t.slice(0, 160));
    }
  }
  return [...out];
}`;

// 页面内执行：收集 root 下可见元素的 aria-label / title / placeholder（下拉选项、图标按钮、输入框提示）
const COLLECT_ATTRS = `(sel, exclude) => {
  const roots = [...document.querySelectorAll(sel)];
  const skip = /monaco-editor|view-lines|xterm|markdown|ProseMirror|tiptap|composer-human-message/;
  const out = new Set();
  for (const root of roots) for (const el of [root, ...root.querySelectorAll('[aria-label],[title],[placeholder]')]) {
    if (exclude && el.closest(exclude)) continue;
    if (!el.getClientRects().length) continue;
    let bad = false; for (let p = el; p && p !== document.body; p = p.parentElement) { if (typeof p.className === 'string' && skip.test(p.className)) { bad = true; break; } }
    if (bad) continue;
    for (const a of ['aria-label', 'title', 'placeholder']) { const v = (el.getAttribute(a) || '').replace(/\\s+/g, ' ').trim(); if (v && /[A-Za-z\\u3400-\\u9fff]/.test(v)) out.add(v.slice(0, 160)); }
  }
  return [...out];
}`;
// 弹出层：下拉列表 / 菜单 / 浮层（React portal 挂在 body 下、VS Code context-view、monaco select box 列表）
const POPUP_SEL = '[role=listbox], [role=menu], [role=dialog]:not(.quick-input-widget), .context-view .monaco-select-box-dropdown-container, .context-view .monaco-menu, .monaco-select-box-dropdown-container, [data-side], [data-base-ui-portal], .ui-select-popup, .ui-menu-popup, .ui-popover, .typeahead-popover';
const POPUP_EXCLUDE = '.quick-input-widget, .cursor-settings-pane-content, [data-component=glass-settings-panel]';

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const keepRe = KEEP.regex.map((r) => new RegExp(r));
// 严格口径：中英混排（如“开发人员: Show GPU Info”）去掉保留词后仍剩 ≥2 个英文单词的，算“半翻译”，计入英文。
const keepWords = new RegExp(`\\b(?:${[...KEEP.exact, ...(KEEP.words || [])].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
const STRICT = !args.includes('--loose');
function isPartial(t) {
  const rest = t.replace(keepWords, ' ').replace(/\{[^}]*\}|https?:\S+|\b[\w-]+\.(?:com|dev|io|org|ai)(?:\/\S*)?|[\w.-]+\.(?:json|md|py|ts|js|mdc)\b/g, ' ');
  return (rest.match(/[A-Za-z]{3,}/g) || []).length >= 2;
}
function classify(texts) {
  const zh = [], en = [], kept = [];
  for (const t of texts) {
    if (CJK.test(t)) (STRICT && isPartial(t) ? en : zh).push(t);
    else if (!/[A-Za-z]{2,}/.test(t)) continue;
    else if (KEEP.exact.includes(t) || keepRe.some((r) => r.test(t))) kept.push(t);
    else en.push(t);
  }
  const total = zh.length + en.length;
  return { zh: zh.length, en: en.length, kept: kept.length, coverage: total ? +(100 * zh.length / total).toFixed(1) : 100, english: en, keptStrings: kept };
}

const report = [];
const add = (section, page, texts) => { const c = classify(texts); report.push({ section, page, ...c }); process.stderr.write(`  ${section} / ${page}: ${c.coverage}% (${c.en} 英文)\n`); };

async function settingsPages(win, section, { open, navSel, labelOf, contentSel }) {
  const ensureOpen = async () => {
    if (await win.evaluate(`!!document.querySelector(${JSON.stringify(contentSel)}) && document.querySelectorAll(${JSON.stringify(navSel)}).length > 0`)) return true;
    await open(); await sleep(1800);
    return win.evaluate(`!!document.querySelector(${JSON.stringify(contentSel)})`);
  };
  if (!await ensureOpen()) { process.stderr.write(`  无法打开设置页（${section}）\n`); return; }
  const navs = await win.evaluate(`(() => [...document.querySelectorAll(${JSON.stringify(navSel)})].filter(e => e.getClientRects().length).map(e => ({ label: (${labelOf})(e), ext: !!e.querySelector('[data-icon-name=arrow-right-up],.codicon-link-external,[data-icon-name=link-external]') })))()`);
  for (const [i, n] of navs.entries()) {
    if (!n.label || n.ext || SKIP_NAV.includes(n.label) || i === navs.length - 1 && section === 'agents-settings' && !/[\u3400-\u9fff]/.test(n.label)) continue;
    if (!await ensureOpen()) break;
    const ok = await win.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(navSel)})].filter(e => e.getClientRects().length).find(e => (${labelOf})(e) === ${JSON.stringify(n.label)}); if (!e) return false; e.click(); return true; })()`);
    if (!ok) continue;
    await sleep(1500);
    add(section, n.label, await win.evaluate(`(${COLLECT})(${JSON.stringify(contentSel)})`));
    // “自定义”页里还有一排标签（插件/MCP/技能…），每个标签单独扫
    for (const tab of CUSTOMIZE_TABS) {
      const hit = await win.evaluate(`(() => { const v = document.querySelector('.ui-customize-view'); if (!v) return false; const e = [...v.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(tab)} && e.getClientRects().length); if (!e) return false; e.click(); return true; })()`);
      if (!hit) continue;
      await sleep(1200);
      add(section, `${n.label} / ${tab}`, await win.evaluate(`(${COLLECT})('.ui-customize-view')`));
    }
  }
}
const CUSTOMIZE_TABS = ['插件', 'MCP', '技能', '子智能体', '规则', '命令', '钩子', 'Plugins', 'Skills', 'Subagents', 'Rules', 'Commands', 'Hooks'];

// 下拉与折叠区：在每个设置页里先展开所有折叠区（aria-expanded=false 且不是下拉触发器），
// 再逐个打开下拉（combobox / aria-haspopup / 原生 select），收集弹出列表文本与选项 aria-label，然后 Escape 关闭。
// 只打开、不选择任何选项，不改动设置。
const TRIGGER_SEL = '[role=combobox], [aria-haspopup=listbox], [aria-haspopup=menu], [aria-haspopup=true], [aria-haspopup=dialog], select, .monaco-select-box';
async function dropdownPages(win, section, { open, navSel, labelOf, contentSel }) {
  const ensureOpen = async () => {
    if (await win.evaluate(`!!document.querySelector(${JSON.stringify(contentSel)}) && document.querySelectorAll(${JSON.stringify(navSel)}).length > 0`)) return true;
    await open(); await sleep(1800);
    return win.evaluate(`!!document.querySelector(${JSON.stringify(contentSel)})`);
  };
  if (!await ensureOpen()) { process.stderr.write(`  无法打开设置页（${section}）\n`); return; }
  const navs = await win.evaluate(`(() => [...document.querySelectorAll(${JSON.stringify(navSel)})].filter(e => e.getClientRects().length).map(e => ({ label: (${labelOf})(e), ext: !!e.querySelector('[data-icon-name=arrow-right-up],.codicon-link-external,[data-icon-name=link-external]') })))()`);
  for (const [i, n] of navs.entries()) {
    if (!n.label || n.ext || SKIP_NAV.includes(n.label) || i === navs.length - 1 && /agents/.test(section) && !/[\u3400-\u9fff]/.test(n.label)) continue;
    if (!await ensureOpen()) break;
    const ok = await win.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(navSel)})].filter(e => e.getClientRects().length).find(e => (${labelOf})(e) === ${JSON.stringify(n.label)}); if (!e) return false; e.click(); return true; })()`);
    if (!ok) continue;
    await sleep(1500);
    // 展开折叠区（最多 3 轮，展开后可能出现嵌套折叠区）
    let expanded = 0;
    for (let round = 0; round < 3; round++) {
      const c = await win.evaluate(`(() => { const root = document.querySelector(${JSON.stringify(contentSel)}); if (!root) return 0; let c = 0; for (const b of root.querySelectorAll('[aria-expanded=false]')) { if (b.matches(${JSON.stringify(TRIGGER_SEL)}) || b.getAttribute('aria-haspopup') || !b.getClientRects().length) continue; b.click(); c++; } return c; })()`);
      expanded += c; if (!c) break; await sleep(700);
    }
    const page = [...await win.evaluate(`(${COLLECT})(${JSON.stringify(contentSel)})`), ...await win.evaluate(`(${COLLECT_ATTRS})(${JSON.stringify(contentSel)})`)];
    add(section, `${n.label}（展开 ${expanded} 个折叠区 + 属性）`, page);
    const count = await win.evaluate(`[...document.querySelector(${JSON.stringify(contentSel)}).querySelectorAll(${JSON.stringify(TRIGGER_SEL)})].filter(e => e.getClientRects().length).length`);
    const popupTexts = new Set();
    for (let k = 0; k < Math.min(count, 40); k++) {
      const p = await win.evaluate(`(() => { const e = [...document.querySelector(${JSON.stringify(contentSel)}).querySelectorAll(${JSON.stringify(TRIGGER_SEL)})].filter(e => e.getClientRects().length)[${k}]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, native: e.tagName === 'SELECT', opts: e.tagName === 'SELECT' ? [...e.options].map(o => o.textContent.trim()) : [] }; })()`);
      if (!p) continue;
      if (p.native) { p.opts.forEach((t) => popupTexts.add(t)); continue; }
      await win.click(p.x, p.y); await sleep(600);
      for (const t of await win.evaluate(`(${COLLECT})(${JSON.stringify(POPUP_SEL)})`)) popupTexts.add(t);
      for (const t of await win.evaluate(`(${COLLECT_ATTRS})(${JSON.stringify(POPUP_SEL)}, ${JSON.stringify(POPUP_EXCLUDE)})`)) popupTexts.add(t);
      await win.key('Escape'); await sleep(350);
      if (!await win.evaluate(`!!document.querySelector(${JSON.stringify(contentSel)})`)) { await ensureOpen(); await win.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(navSel)})].find(e => (${labelOf})(e) === ${JSON.stringify(n.label)}); e && e.click(); })()`); await sleep(1200); }
    }
    if (count) add(section, `${n.label} / 下拉列表（${count} 个）`, [...popupTexts]);
  }
}
// 聊天输入框/主界面里的下拉：模式（智能体/计划/询问…）、模型选择器、项目/环境选择、账户菜单等（标题栏菜单另由 menus 扫）
async function composerDropdowns(win, section, sel) {
  const triggers = await win.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.getClientRects().length && !e.closest('[role=banner], .titlebar, .part.titlebar')).map((e, i) => { const r = e.getBoundingClientRect(); return { i, t: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 24), x: r.x + r.width / 2, y: r.y + r.height / 2 }; })`);
  const seen = new Set();
  for (const t of triggers) {
    if (seen.has(t.t)) continue; seen.add(t.t);
    await win.key('Escape'); await sleep(200);
    await win.click(t.x, t.y); await sleep(800);
    const texts = [...await win.evaluate(`(${COLLECT})(${JSON.stringify(POPUP_SEL)})`), ...await win.evaluate(`(${COLLECT_ATTRS})(${JSON.stringify(POPUP_SEL)}, '.quick-input-widget')`)];
    if (texts.length) add(section, `下拉：${t.t}`, texts);
    await win.key('Escape'); await sleep(400);
  }
}

const agents = await connect(/^Cursor Agents$/) || await connect('Cursor Agents');
const classic = await connect(/ - Cursor$/);
if (!agents && !classic) { console.error(`没有找到 Cursor 窗口（localhost:${PORT}）`); process.exit(1); }

if (agents && ONLY.includes('agents-settings')) {
  process.stderr.write('Agents 窗口设置：\n');
  await settingsPages(agents, 'agents-settings', {
    open: () => agents.key(',', 2),
    navSel: 'nav[data-component=workspace-sidebar] .ui-sidebar-menu-button',
    labelOf: "e => (e.querySelector('.ui-sidebar-menu-button-label') || e).textContent.trim()",
    contentSel: '[data-component=glass-settings-panel]',
  });
  // 返回主界面
  await agents.evaluate(`(() => { const b = [...document.querySelectorAll('.ui-sidebar-menu-button')].find(e => e.textContent.trim() === '返回' || e.textContent.trim() === 'Back'); b && b.click(); })()`);
  await sleep(1200);
}

if (agents && ONLY.includes('menus')) {
  process.stderr.write('Agents 窗口菜单：\n');
  const names = await agents.evaluate(`[...document.querySelectorAll('[role=banner] button')].map(b => b.textContent.trim()).filter(t => t && t.length <= 6)`);
  for (const name of names) {
    const opened = await agents.evaluate(`(async () => { const b = [...document.querySelectorAll('[role=banner] button')].find(e => e.textContent.trim() === ${JSON.stringify(name)}); b.click(); await new Promise(r => setTimeout(r, 700)); return document.querySelectorAll('[role=menu]').length; })()`);
    if (opened) add('agents-menus', name, await agents.evaluate(`(${COLLECT})('[role=menu]')`));
    await agents.key('Escape'); await sleep(400);
  }
}

// 右键菜单：Agents 窗口侧边栏条目 + 经典窗口资源管理器/侧边栏面板标题。只打开菜单再 Escape 关闭，不点选任何菜单项。
const MENU_SEL = '[role=menu], .context-view .monaco-menu';
async function contextMenus(win, section, targetSel) {
  const targets = await win.evaluate(`(() => { const seen = new Set(); return [...document.querySelectorAll(${JSON.stringify(targetSel)})].map(e => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 30), x: r.x + Math.min(r.width / 2, 120), y: r.y + r.height / 2, w: r.width }; }).filter(o => o.t && o.w > 0 && o.y > 40 && !/GitHub|跳过|Skip/.test(o.t) && !seen.has(o.t) && seen.add(o.t)).slice(0, 12); })()`);
  for (const t of targets) {
    await win.rightClick(t.x, t.y); await sleep(700);
    const texts = await win.evaluate(`(${COLLECT})(${JSON.stringify(MENU_SEL)})`);
    if (texts.length) add(section, t.t, texts);
    await win.key('Escape'); await sleep(400);
  }
}
if (agents && ONLY.includes('context')) {
  process.stderr.write('Agents 窗口侧边栏右键菜单：\n');
  await contextMenus(agents, 'agents-context', 'nav[data-component=workspace-sidebar] .ui-sidebar-menu-button, nav[data-component=workspace-sidebar] [role=treeitem], nav[data-component=workspace-sidebar] [role=listitem]');
}
if (classic && ONLY.includes('context')) {
  process.stderr.write('经典窗口侧边栏右键菜单：\n');
  await classic.key('Escape'); await sleep(300);
  await contextMenus(classic, 'classic-context', '.explorer-folders-view .monaco-list-row, .sidebar .pane-header, .activitybar .action-item');
}

// 界面框架：经典窗口的标题栏/活动栏/侧边栏/面板/状态栏，编辑器右键菜单；Agents 窗口主界面（聊天内容由 COLLECT 排除）。
if (classic && ONLY.includes('chrome')) {
  process.stderr.write('经典窗口界面框架：\n');
  await classic.key('Escape'); await sleep(300);
  for (const [name, sel] of [['标题栏', '.part.titlebar'], ['活动栏', '.part.activitybar, .part.sidebar .composite.title'], ['侧边栏', '.part.sidebar'], ['面板', '.part.panel'], ['状态栏', '.part.statusbar'], ['辅助侧边栏', '.part.auxiliarybar']]) {
    const texts = await classic.evaluate(`(${COLLECT})(${JSON.stringify(sel)})`);
    if (texts.length) add('classic-chrome', name, texts);
  }
  const ed = await classic.evaluate(`(() => { const e = document.querySelector('.editor-instance .monaco-editor .view-lines'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + 40, y: r.y + 10 }; })()`);
  if (ed) { await classic.rightClick(ed.x, ed.y); await sleep(800); add('classic-context', '编辑器', await classic.evaluate(`(${COLLECT})(${JSON.stringify(MENU_SEL)})`)); await classic.key('Escape'); await sleep(300); }
}
if (agents && ONLY.includes('chrome')) {
  process.stderr.write('Agents 窗口主界面：\n');
  add('agents-chrome', '主界面', await agents.evaluate(`(${COLLECT})(null)`));
}

if (classic && ONLY.includes('classic-settings')) {
  process.stderr.write('经典窗口 Cursor 设置：\n');
  await settingsPages(classic, 'classic-settings', {
    open: () => classic.key('j', 10),
    navSel: '.cursor-settings-sidebar-nav-cell',
    labelOf: 'e => e.textContent.trim()',
    contentSel: '.cursor-settings-pane-content, .ui-customize-view',
  });
}

if (ONLY.includes('dropdowns')) {
  if (classic) {
    process.stderr.write('经典窗口 Cursor 设置（下拉/折叠区）：\n');
    await classic.key('Escape'); await sleep(300);
    await dropdownPages(classic, 'classic-dropdowns', { open: () => classic.key('j', 10), navSel: '.cursor-settings-sidebar-nav-cell', labelOf: 'e => e.textContent.trim()', contentSel: '.cursor-settings-pane-content, .ui-customize-view' });
    await composerDropdowns(classic, 'classic-dropdowns', '.composer-unified-dropdown, .ui-model-picker__trigger, .part.auxiliarybar [aria-haspopup], .part.auxiliarybar [role=combobox]');
  }
  if (agents) {
    process.stderr.write('Agents 窗口设置（下拉/折叠区）：\n');
    await dropdownPages(agents, 'agents-dropdowns', { open: () => agents.key(',', 2), navSel: 'nav[data-component=workspace-sidebar] .ui-sidebar-menu-button', labelOf: "e => (e.querySelector('.ui-sidebar-menu-button-label') || e).textContent.trim()", contentSel: '[data-component=glass-settings-panel]' });
    await agents.evaluate(`(() => { const b = [...document.querySelectorAll('.ui-sidebar-menu-button')].find(e => e.textContent.trim() === '返回' || e.textContent.trim() === 'Back'); b && b.click(); })()`);
    await sleep(1200);
    await composerDropdowns(agents, 'agents-dropdowns', '[aria-haspopup], [role=combobox]');
  }
}

if (classic && ONLY.includes('palette')) {
  process.stderr.write('命令面板：\n');
  await classic.key('Escape'); await sleep(300);
  await classic.key('p', 10); await sleep(1200);
  const all = new Set();
  // 一直翻到底（连续 5 页没有新条目即停），PAGES 是上限
  for (let i = 0, same = 0, prev = -1; i < PAGES && same < 5; i++) {
    for (const t of await classic.evaluate(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(r => { const e = r.querySelector('.label-name'); return e ? e.textContent.trim() : ''; }).filter(Boolean)`)) all.add(t);
    same = all.size === prev ? same + 1 : 0; prev = all.size;
    await classic.key('PageDown'); await sleep(150);
  }
  add('palette', `命令面板（全部 ${all.size} 条）`, [...all]);
  await classic.key('Escape');
}

for (const w of [agents, classic]) w && w.close();

const json = opt('json'); if (json) writeFileSync(json, JSON.stringify({ scannedAt: new Date().toISOString(), port: PORT, pages: report }, null, 2));
const lines = ['| 区域 | 页面 | 中文 | 英文 | 保留 | 覆盖率 |', '|---|---|---|---|---|---|', ...report.map((r) => `| ${r.section} | ${r.page} | ${r.zh} | ${r.en} | ${r.kept} | ${r.coverage}% |`)];
const tot = report.reduce((a, r) => ({ zh: a.zh + r.zh, en: a.en + r.en }), { zh: 0, en: 0 });
lines.push('', `合计：中文 ${tot.zh}，英文 ${tot.en}，覆盖率 ${tot.zh + tot.en ? (100 * tot.zh / (tot.zh + tot.en)).toFixed(1) : 100}%`, '');
for (const r of report) if (r.en) lines.push(`### ${r.section} / ${r.page}`, ...r.english.map((s) => `- ${s}`), '');
const md = lines.join('\n');
const mdOut = opt('md'); if (mdOut) writeFileSync(mdOut, md);
console.log(md);
