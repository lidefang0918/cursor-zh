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
  const n = { nodeType: 1, tagName: tag, attrs: { ...attrs }, className: classes.join(" "), classList: { contains: (c) => classes.includes(c) },
    getAttribute(a) { return this.attrs[a] ?? null; }, setAttribute(a, v) { this.attrs[a] = v; },
    hasAttribute(a) { return a in this.attrs; },
    get textContent() { let s = ''; for (let c = this.firstChild; c; c = c.nextSibling) s += c.nodeType === 3 ? c.nodeValue : c.textContent; return s; } };
  children.forEach((c, i) => { c.parentNode = n; c.nextSibling = children[i + 1] || null; });
  n.firstChild = children[0] || null;
  n.firstElementChild = children.find((c) => c.nodeType === 1) || null;
  n.querySelector = (sel) => { // 只支持 "tag" 和 "tag[type=x]"
    const m = /^(\w+)(?:\[type=(\w+)\])?$/.exec(sel);
    if (!m) return null;
    const ok = (c) => c.nodeType === 1 && c.tagName.toLowerCase() === m[1] && (!m[2] || c.attrs.type === m[2]);
    const walk = (x) => { for (let c = x.firstChild; c; c = c.nextSibling) { if (ok(c)) return c; const r = c.nodeType === 1 && walk(c); if (r) return r; } return null; };
    return walk(n);
  };
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

  it('command palette: translates the primary command label only in ">" mode, keeps the English alias and file names', () => {
    const d = { 'Close Tab': '关闭标签页', 'Updates': '更新' };
    const label = (t) => el('A', [el('SPAN', [t], {}, ['monaco-highlighted-label'])], {}, ['label-name']);
    const rowOf = (main, alias) => el('DIV', [
      el('DIV', [el('DIV', [el('SPAN', [label(main)], {}, ['monaco-icon-name-container'])], {}, ['monaco-icon-label'])], {}, ['quick-input-list-row']),
      el('DIV', [el('DIV', [el('DIV', [el('SPAN', [label(alias)], {}, ['monaco-icon-name-container'])], {}, ['monaco-icon-label'])], {}, ['quick-input-list-label-meta'])], {}, ['quick-input-list-row']),
    ], {}, ['quick-input-list-rows']);
    const widget = (value, row) => el('DIV', [el('INPUT', [], { type: 'checkbox' }), el('INPUT', [], { type: 'text' }), row], {}, ['quick-input-widget']);
    const main = text('Close Tab'), alias = text('Close Tab');
    const cmd = widget('>', rowOf(main, alias));
    cmd.firstChild.value = 'on'; cmd.firstChild.nextSibling.value = '>';
    const file = text('Updates'), fileAlias = text('src');
    const quickOpen = widget('', rowOf(file, fileAlias));
    quickOpen.firstChild.value = 'on'; quickOpen.firstChild.nextSibling.value = 'upd';
    const tab = text('Updates');
    const explorer = el('DIV', [label(tab)]);
    runInFakeDom(buildInjection({ dict: d, runtimeSource: RUNTIME }), el('BODY', [cmd, quickOpen, explorer]));
    assert.equal(main.nodeValue, '关闭标签页');
    assert.equal(alias.nodeValue, 'Close Tab', 'English alias kept for search');
    assert.equal(file.nodeValue, 'Updates', 'quick open file names untouched');
    assert.equal(tab.nodeValue, 'Updates', 'explorer names untouched');
  });

  it('isolates errors: a throwing node never breaks other mutations, too many errors disable the observer', () => {
    let cb, disconnected = false;
    const MutationObserver = class { constructor(f) { cb = f; } observe() {} disconnect() { disconnected = true; } };
    const win = {};
    const body = el('BODY', [el('SPAN', [text('Search')])]);
    const document = { body, documentElement: body, readyState: 'complete', addEventListener() {}, defaultView: win };
    const warns = [];
    vm.runInNewContext(buildInjection({ dict, runtimeSource: RUNTIME }), { document, MutationObserver, console: { warn: (...a) => warns.push(a) }, performance: { now: () => 0 } });
    const bad = el('DIV', [text('Search')]); bad.getAttribute = () => { throw new Error('boom'); };
    const good = text('Search');
    assert.doesNotThrow(() => cb([{ type: 'childList', addedNodes: [bad] }, { type: 'childList', addedNodes: [el('DIV', [good])] }]));
    assert.equal(good.nodeValue, '搜索', 'later mutations in the same batch still processed');
    assert.equal(win.__cursorZhDom.errors, 1);
    assert.equal(warns.length, 1);
    for (let i = 0; i < 60; i++) cb([{ type: 'childList', addedNodes: [bad] }]);
    assert.ok(disconnected, 'observer disconnected after too many errors');
    assert.equal(win.__cursorZhDom.disabled, true);
    const after = text('Search');
    cb([{ type: 'childList', addedNodes: [el('DIV', [after])] }]);
    assert.equal(after.nodeValue, 'Search', 'disabled runtime does nothing');
    assert.ok(warns.length <= 2, 'no console spam');
  });

  it('fuzz: random trees never throw, are idempotent and never touch protected subtrees', () => {
    let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const words = ['Search', 'New Agent', 'Close Tab', 'IDE', 'Use /goal to set an objective', 'foo', '  Search  ', 'Close Pane (Ctrl+W)', '', '123', 'Tab Stats: 1/2 (50%)'];
    const d = { Search: '搜索', 'New Agent': '新建智能体', 'Close Tab': '关闭标签页', IDE: 'IDE', 'Use /goal to set an objective': '使用 /goal 设定目标', 'Close Pane': '关闭窗格' };
    const patterns = [{ from: 'Tab Stats: {n} ({n}%)', to: 'Tab 统计：{n} ({n}%)' }];
    const guards = [['DIV', {}, ['monaco-editor']], ['DIV', { 'data-message-role': 'ai' }, []], ['DIV', { contenteditable: 'true' }, []], ['PRE', {}, []], ['DIV', {}, ['markdown-root']], ['SPAN', {}, ['label-name']]];
    const plain = ['DIV', 'SPAN', 'BUTTON', 'P', 'A'];
    for (let round = 0; round < 200; round++) {
      const protectedTexts = [];
      const build = (depth, prot) => {
        const kids = [];
        for (let i = 0, n = rnd(4); i < n; i++) {
          if (depth > 4 || rnd(2)) { const t = text(words[rnd(words.length)]); if (prot) protectedTexts.push([t, t.nodeValue]); kids.push(t); continue; }
          if (rnd(5) === 0) { const [tag, at, cl] = guards[rnd(guards.length)]; kids.push(el(tag, build(depth + 1, true), at, cl)); }
          else kids.push(el(plain[rnd(plain.length)], build(depth + 1, prot), rnd(3) ? {} : { title: words[rnd(words.length)] }, rnd(4) ? [] : ['statusbar']));
        }
        return kids;
      };
      const body = el('BODY', build(0, false));
      const snapshot = (n) => n.nodeType === 3 ? n.nodeValue : `${n.tagName}${JSON.stringify(n.attrs)}[${(() => { let s = ''; for (let c = n.firstChild; c; c = c.nextSibling) s += snapshot(c) + ','; return s; })()}]`;
      let fire;
      assert.doesNotThrow(() => { fire = runInFakeDom(buildInjection({ dict: d, patterns, runtimeSource: RUNTIME }), body); });
      const once = snapshot(body);
      assert.doesNotThrow(() => fire([{ type: 'childList', target: body, addedNodes: [body.firstChild].filter(Boolean) }]));
      runInFakeDom(buildInjection({ dict: d, patterns, runtimeSource: RUNTIME }), body);
      assert.equal(snapshot(body), once, `round ${round}: second pass changes nothing`);
      for (const [t, v] of protectedTexts) assert.equal(t.nodeValue, v, `round ${round}: protected text changed`);
    }
  });
});

