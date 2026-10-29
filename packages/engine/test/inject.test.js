import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildInjection, injectDomRuntime, BEGIN, END } from '../src/inject.js';
const RUNTIME = await fs.readFile(new URL('../../dom-runtime/runtime.js', import.meta.url), 'utf8');

// 极简假 DOM，够跑 runtime
function el(tag, children = [], attrs = {}, classes = []) {
  const n = { nodeType: 1, tagName: tag, attrs: { ...attrs }, classList: { contains: (c) => classes.includes(c) },
    getAttribute(a) { return this.attrs[a] ?? null; }, setAttribute(a, v) { this.attrs[a] = v; },
    hasAttribute(a) { return a in this.attrs; },
    get textContent() { let s = ''; for (let c = this.firstChild; c; c = c.nextSibling) s += c.nodeType === 3 ? c.nodeValue : c.textContent; return s; } };
  children.forEach((c, i) => { c.parentNode = n; c.nextSibling = children[i + 1] || null; });
  n.firstChild = children[0] || null;
  return n;
}
const text = (v) => ({ nodeType: 3, nodeValue: v });

function runInFakeDom(code, body) {
  let cb;
  const MutationObserver = class { constructor(f) { cb = f; } observe() {} };
  const document = { body, documentElement: body, readyState: 'complete', addEventListener() {} };
  vm.runInNewContext(code, { document, MutationObserver, console });
  return (muts) => cb(muts);
}

describe('DOM runtime injection', () => {
  const dict = { 'New Agent': '新建 Agent', 'Search': '搜索' };

  it('translates exact-match text nodes and attributes, skips editors/inputs', () => {
    const t1 = text('  New Agent '), t2 = text('New Agent now'), t3 = text('New Agent'), t4 = text('New Agent');
    const btn = el('DIV', [t1], { title: 'Search', 'aria-label': 'Nope' });
    const editor = el('DIV', [t3], {}, ['view-lines']);
    const input = el('DIV', [t4], { contenteditable: 'true' });
    const t5 = text('Search');
    const fileName = el('SPAN', [t5], {}, ['label-name']);
    const body = el('BODY', [btn, el('SPAN', [t2]), editor, input, fileName]);
    const fire = runInFakeDom(buildInjection({ dict, runtimeSource: RUNTIME }), body);
    assert.equal(t1.nodeValue, '  新建 Agent ');
    assert.equal(t2.nodeValue, 'New Agent now');
    assert.equal(btn.attrs.title, '搜索');
    assert.equal(btn.attrs['aria-label'], 'Nope');
    assert.equal(t3.nodeValue, 'New Agent');
    assert.equal(t4.nodeValue, 'New Agent');
    assert.equal(t5.nodeValue, 'Search', 'file/explorer names must not be translated');

    const late = text('Search');
    fire([{ type: 'childList', addedNodes: [el('DIV', [late])] }]);
    assert.equal(late.nodeValue, '搜索');
  });

  it('translates a sentence split across nodes as a whole, never single words inside it', () => {
    const d = { 'Use /goal to set an objective': '使用 /goal 设定目标', 'Hooks': '钩子', 'Close Pane': '关闭窗格' };
    const a = text('Use '), code = text('/goal'), b = text(' to set   an objective');
    const tip = el('SPAN', [a, el('CODE', [code]), b]);
    const w1 = text('Hooks'), w2 = text(' let you control');
    const tip2 = el('SPAN', [w1, w2]);
    const btn = el('DIV', [], { 'aria-label': 'Close Pane (Ctrl+W)' });
    const body = el('BODY', [el('DIV', [tip]), tip2, btn]);
    runInFakeDom(buildInjection({ dict: d, runtimeSource: RUNTIME }), body);
    assert.equal(a.nodeValue + code.nodeValue + b.nodeValue, '使用 /goal 设定目标');
    assert.equal(w1.nodeValue, 'Hooks', 'a word inside a sentence must stay as is');
    assert.equal(btn.attrs['aria-label'], '关闭窗格 (Ctrl+W)');
  });

  it('never rewrites its own output (no MutationObserver feedback loop)', () => {
    let writes = 0;
    const watched = (v) => { let val = v; return { nodeType: 3, get nodeValue() { return val; }, set nodeValue(x) { writes++; val = x; } }; };
    const a = watched('IDE'), b = watched('Ping'), attrEl = el('DIV', [], { title: 'IDE' });
    const origSet = attrEl.setAttribute; attrEl.setAttribute = function (k, v) { writes++; origSet.call(this, k, v); };
    const body = el('BODY', [el('SPAN', [a]), el('SPAN', [b]), attrEl]);
    const fire = runInFakeDom(buildInjection({ dict: { IDE: 'IDE', Ping: 'Pong', Pong: '乒' }, runtimeSource: RUNTIME }), body);
    assert.equal(b.nodeValue, 'Pong');
    const before = writes;
    for (let i = 0; i < 5; i++) fire([{ type: 'characterData', target: a }, { type: 'characterData', target: b }, { type: 'attributes', target: attrEl }]);
    assert.equal(b.nodeValue, 'Pong');
    assert.equal(writes, before, 'mutations caused by our own writes must be no-ops');
    assert.equal(before, 1);
  });

  it('appends once between markers (idempotent)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inj-'));
    const rel = 'out/wb.js';
    await fs.mkdir(path.join(root, 'out'));
    await fs.writeFile(path.join(root, rel), 'orig();');
    await injectDomRuntime({ installRoot: root, relative: rel, dict });
    await injectDomRuntime({ installRoot: root, relative: rel, dict });
    const out = await fs.readFile(path.join(root, rel), 'utf8');
    assert.ok(out.startsWith('orig();'));
    assert.equal(out.split(BEGIN).length - 1, 1);
    assert.ok(out.trimEnd().endsWith(END));
  });

  it('translates only the default title of a chat (composer) tab, never file names or user titles', () => {
    const d = { 'New Agent': '新建智能体', 'New Chat': '新建智能体', Search: '搜索' };
    const tabTitle = text('New Agent'), userTitle = text('Search'), fileTab = text('Search');
    const composerTab = (t) => el('DIV', [el('DIV', [el('A', [el('SPAN', [t], {}, ['monaco-highlighted-label'])], {}, ['label-name'])], {}, ['monaco-icon-name-container'])], {}, ['monaco-icon-label', 'composer-tab-label']);
    const tab1 = composerTab(tabTitle), tab2 = composerTab(userTitle);
    const file = el('DIV', [el('A', [fileTab], {}, ['label-name'])], {}, ['monaco-icon-label']);
    const body = el('BODY', [el('DIV', [tab1, tab2, file], {}, ['tabs-container'])]);
    const fire = runInFakeDom(buildInjection({ dict: d, runtimeSource: RUNTIME }), body);
    assert.equal(tabTitle.nodeValue, '新建智能体');
    assert.equal(userTitle.nodeValue, 'Search', 'user-chosen chat titles stay as is');
    assert.equal(fileTab.nodeValue, 'Search', 'file names stay as is');
    // 标签页标题被 Cursor 改回默认名（characterData）时也要翻
    userTitle.nodeValue = 'New Chat';
    fire([{ type: 'characterData', target: userTitle }]);
    assert.equal(userTitle.nodeValue, '新建智能体');
    fileTab.nodeValue = 'New Agent';
    fire([{ type: 'characterData', target: fileTab }]);
    assert.equal(fileTab.nodeValue, 'New Agent', 'a file literally named "New Agent" is not a chat tab');
  });

  it('applies number templates only in chrome areas (status bar, hovers), on text and attributes', () => {
    const patterns = [
      { from: 'Tab Stats: {n} ({n}%)', to: 'Tab 统计：{n} ({n}%)' },
      { from: 'Tab AI Stats: {n} accepted out of {n} suggested, {n} percent acceptance rate', to: 'Tab AI 统计：已采纳 {n}，共建议 {n}，采纳率 {n}%' },
    ];
    const sb = text(' Tab Stats: 12/40 (30%)'), chat = text('Tab Stats: 12/40 (30%)'), notNum = text('Tab Stats: lots (30%)');
    const item = el('A', [el('SPAN', [], {}, ['codicon']), sb], { 'aria-label': 'Tab AI Stats: 12 accepted out of 40 suggested, 30 percent acceptance rate' }, ['statusbar-item-label']);
    const statusbar = el('FOOTER', [el('DIV', [item], {}, ['statusbar-item']), el('SPAN', [notNum])], {}, ['part', 'statusbar']);
    const panel = el('DIV', [el('P', [chat])], { 'aria-label': 'Tab AI Stats: 1 accepted out of 2 suggested, 50 percent acceptance rate' });
    const body = el('BODY', [statusbar, panel]);
    const fire = runInFakeDom(buildInjection({ dict: {}, patterns, runtimeSource: RUNTIME }), body);
    assert.equal(sb.nodeValue, ' Tab 统计：12/40 (30%)');
    assert.equal(item.attrs['aria-label'], 'Tab AI 统计：已采纳 12，共建议 40，采纳率 30%');
    assert.equal(notNum.nodeValue, 'Tab Stats: lots (30%)', '{n} only matches numbers');
    assert.equal(chat.nodeValue, 'Tab Stats: 12/40 (30%)', 'templates never apply outside chrome areas');
    assert.equal(panel.attrs['aria-label'], 'Tab AI Stats: 1 accepted out of 2 suggested, 50 percent acceptance rate');
    // 状态栏数字刷新（characterData）后再次翻译
    sb.nodeValue = 'Tab Stats: 13/41 (31%)';
    fire([{ type: 'characterData', target: sb }]);
    assert.equal(sb.nodeValue, 'Tab 统计：13/41 (31%)');
  });

  it('never translates user/AI content: chat messages, markdown, editors, inputs, code', () => {
    const d = { Search: '搜索', 'Keep All': '全部保留', 'Use /goal to set an objective': '使用 /goal 设定目标' };
    const cases = [];
    const mk = (wrap) => { const t = text('Search'); cases.push(t); return wrap(t); };
    const nodes = [
      mk((t) => el('DIV', [el('P', [t])], { 'data-message-role': 'ai', 'data-message-kind': 'assistant' })),
      mk((t) => el('DIV', [el('SPAN', [t])], { 'data-message-role': 'human' })),
      mk((t) => el('DIV', [el('P', [t])], {}, ['markdown-root'])),
      mk((t) => el('DIV', [el('P', [t])], {}, ['ui-markdown'])),
      mk((t) => el('DIV', [t], {}, ['rendered-markdown'])),
      mk((t) => el('DIV', [el('SPAN', [t])], {}, ['agent-transcript-row-markdown'])),
      mk((t) => el('DIV', [t], {}, ['agent-transcript-row-human'])),
      mk((t) => el('DIV', [t], {}, ['composer-human-message-content'])),
      mk((t) => el('DIV', [t], { 'data-sent-message-bubble-text': '' })),
      mk((t) => el('DIV', [el('DIV', [t], {}, ['view-line'])], {}, ['monaco-editor'])),
      mk((t) => el('DIV', [el('P', [t])], { contenteditable: 'plaintext-only' })),
      mk((t) => el('DIV', [el('P', [t])], { role: 'textbox' })),
      mk((t) => el('DIV', [el('P', [t])], {}, ['ProseMirror'])),
      mk((t) => el('PRE', [t])),
      mk((t) => el('CODE', [t])),
    ];
    const sentence = [text('Use '), text('/goal'), text(' to set an objective')];
    nodes.push(el('DIV', [el('P', sentence)], { 'data-message-role': 'ai' }));
    const ok = text('Keep All');
    const notEditable = text('Search');
    const body = el('BODY', [...nodes, el('BUTTON', [ok]), el('DIV', [notEditable], { contenteditable: 'false' })]);
    const fire = runInFakeDom(buildInjection({ dict: d, runtimeSource: RUNTIME }), body);
    cases.forEach((t, i) => assert.equal(t.nodeValue, 'Search', `case ${i} must stay untouched`));
    assert.equal(sentence.map((t) => t.nodeValue).join(''), 'Use /goal to set an objective');
    assert.equal(ok.nodeValue, '全部保留', 'normal UI still translated');
    assert.equal(notEditable.nodeValue, '搜索', 'contenteditable="false" is not an input');
    // 流式输出：AI 消息里后来追加的节点，以及消息里文本的变化，都不能被翻
    const streamed = text('Search');
    const msg = nodes[0];
    fire([{ type: 'childList', target: msg, addedNodes: [el('SPAN', [streamed])] }]);
    const p = el('SPAN', [streamed]); p.parentNode = msg;
    fire([{ type: 'characterData', target: streamed }]);
    assert.equal(streamed.nodeValue, 'Search');
  });
});

