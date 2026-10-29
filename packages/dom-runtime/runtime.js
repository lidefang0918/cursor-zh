// Cursor 渲染进程 DOM 补漏：只做"整段精确匹配"替换（外加界面外壳里的少量数字模板）。
// 由 engine 包成 (function(DICT, PATTERNS){ ... })({...}, [...]) 追加到 workbench bundle 末尾。
// 规则：
//  1. 文本节点：去掉首尾空白后与词典 key 完全相等，且它不是一句话里的一个词（同级没有其他含字母的文本节点）。
//  2. 整句：元素的 textContent（归一化空白/破折号/引号）等于词典里的多词 key 时，整句替换：
//     译文写进第一个文本节点，其余文本节点清空（保留 React 持有的节点引用，不删节点）。
//  3. 属性 title/placeholder/aria-label：完全相等，或 "文案 (快捷键)" 形式只翻前半段。
//  4. 模板（PATTERNS，如 "Tab Stats: {n} ({n}%)"）：只在状态栏/标题栏/标签栏/悬浮提示这些外壳区域、短文本上生效。
// 永远不碰用户/AI 的内容：编辑器、终端、输入框/可编辑区、聊天消息体、markdown 渲染容器、代码块、文件名。
// 唯一例外：聊天标签页标题只翻默认名（New Agent / New Chat），用户自己起的标题不动。
function cursorZhDom(DICT, doc, MO, PATTERNS) {
  var ATTRS = ['title', 'placeholder', 'aria-label'];
  var has = Object.prototype.hasOwnProperty;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, PRE: 1, CODE: 1 };
  var SKIP_CLASSES = [
    // 编辑器 / 终端
    'monaco-editor', 'view-lines', 'monaco-editor-background', 'xterm',
    // 聊天消息体与 markdown 渲染（AI 回复、用户消息）
    'agent-transcript-row-markdown', 'agent-transcript-row-human', 'composer-human-message-content',
    'markdown-root', 'rendered-markdown', 'ui-markdown', 'ProseMirror', 'tiptap',
  ];
  var SKIP_ATTRS = ['data-message-role', 'data-message-kind', 'data-agent-transcript-human-bubble', 'data-sent-message-bubble', 'data-sent-message-bubble-text'];
  // label-name / monaco-icon-name-container：资源管理器、标签页里的文件名，不能翻
  var NAME_CLASSES = ['label-name', 'monaco-icon-name-container'];
  // 聊天标签页（composer-tab-label）里的名字只允许翻这些默认标题
  var DEFAULT_TITLES = { 'New Agent': 1, 'New Chat': 1 };
  // 模板只在这些外壳区域生效
  var CHROME_CLASSES = ['statusbar', 'titlebar', 'tabs-container', 'monaco-hover', 'workbench-hover', 'custom-hover', 'monaco-action-bar', 'statusbar-item'];
  var MAX_PATTERN_TEXT = 120;
  var MAX_SENTENCE = 400;

  var PATS = [];
  (PATTERNS || []).forEach(function (p) {
    var parts = p.from.split('{n}').map(function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    PATS.push({ re: new RegExp('^' + parts.join('(\\d[\\d.,/]*)') + '$'), to: p.to });
  });

  function norm(s) {
    return s.replace(/[\u2014\u2013]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
  }
  // 多词 key 进整句表（归一化后）
  var SENT = {};
  // 我们自己写出去的值（译文）：再次看到时一律不处理，避免 IDE→IDE 这类恒等/互指词条让
  // MutationObserver 自己触发自己、渲染进程死循环
  var OUT = {};
  for (var k in DICT) {
    if (!has.call(DICT, k)) continue;
    OUT[DICT[k]] = 1;
    if (k.indexOf(' ') > 0 && k.split(' ').length >= 4) SENT[norm(k)] = DICT[k];
  }

  function tr(s) {
    if (!s) return null;
    var t = s.trim();
    if (!t || has.call(OUT, t)) return null;
    if (has.call(DICT, t)) return s.replace(t, DICT[t]);
    var m = /^(.+?) (\([^()]+\))$/.exec(t); // "Close Pane (Ctrl+W)"
    if (m && has.call(DICT, m[1]) && !has.call(OUT, m[1])) return s.replace(t, DICT[m[1]] + ' ' + m[2]);
    return null;
  }
  function hasClass(node, list) {
    if (!node.classList) return false;
    for (var i = 0; i < list.length; i++) if (node.classList.contains(list[i])) return true;
    return false;
  }
  // 0 = 正常；1 = 整棵子树跳过；2 = 文件名/标题区（只在聊天标签页里翻默认标题）
  function skip(node) {
    if (node.nodeType !== 1) return 0;
    if (has.call(SKIP_TAGS, node.tagName)) return 1;
    if (node.hasAttribute) {
      if (node.hasAttribute('contenteditable') && node.getAttribute('contenteditable') !== 'false') return 1;
      if (node.getAttribute('role') === 'textbox') return 1;
      for (var i = 0; i < SKIP_ATTRS.length; i++) if (node.hasAttribute(SKIP_ATTRS[i])) return 1;
    }
    if (hasClass(node, SKIP_CLASSES)) return 1;
    if (hasClass(node, NAME_CLASSES)) return 2;
    return 0;
  }
  function inComposerTab(node) {
    for (var p = node; p; p = p.parentNode) if (p.nodeType === 1 && p.classList && p.classList.contains('composer-tab-label')) return true;
    return false;
  }
  // 返回节点所处的模式（按祖先链）：1 跳过，2 名字区，0 正常
  function modeOf(node) {
    var mode = 0;
    for (var p = node; p; p = p.parentNode) {
      var m = p.nodeType === 1 ? skip(p) : 0;
      if (m === 1) return 1;
      if (m === 2) mode = 2;
    }
    return mode === 2 ? (inComposerTab(node) ? 2 : 1) : 0;
  }
  function inChrome(node) {
    for (var p = node; p; p = p.parentNode) if (p.nodeType === 1 && hasClass(p, CHROME_CLASSES)) return true;
    return false;
  }
  function pattern(s) {
    if (!PATS.length || !s) return null;
    var t = s.trim();
    if (!t || t.length > MAX_PATTERN_TEXT) return null;
    for (var i = 0; i < PATS.length; i++) {
      var m = PATS[i].re.exec(t);
      if (!m) continue;
      var k = 1;
      return s.replace(t, PATS[i].to.replace(/\{n\}/g, function () { return m[k++] || ''; }));
    }
    return null;
  }
  function attrs(node) {
    for (var i = 0; i < ATTRS.length; i++) {
      var raw = node.getAttribute(ATTRS[i]);
      var v = tr(raw);
      if (!v && raw) { var pv = pattern(raw); if (pv && inChrome(node)) v = pv; }
      if (v && v !== node.getAttribute(ATTRS[i])) node.setAttribute(ATTRS[i], v);
    }
  }
  // 同级还有含字母的文本节点 → 这是句子里的一个词，不单独翻
  function partOfSentence(t) {
    var p = t.parentNode;
    if (!p) return false;
    for (var c = p.firstChild; c; c = c.nextSibling) if (c !== t && c.nodeType === 3 && /[A-Za-z]/.test(c.nodeValue)) return true;
    return false;
  }
  function textNodes(node, out) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.push(c);
      else if (c.nodeType === 1) textNodes(c, out);
    }
    return out;
  }
  // 从文本节点往上最多 3 层找整句匹配
  function sentence(t) {
    for (var e = t.parentNode, i = 0; e && e.nodeType === 1 && i < 3; e = e.parentNode, i++) {
      if (skip(e)) return false;
      var raw = e.textContent;
      if (!raw || raw.length > MAX_SENTENCE) return false;
      var key = norm(raw);
      if (has.call(SENT, key) && !has.call(OUT, key)) {
        var nodes = textNodes(e, []);
        nodes[0].nodeValue = SENT[key];
        for (var j = 1; j < nodes.length; j++) nodes[j].nodeValue = '';
        return true;
      }
    }
    return false;
  }
  function text(t, mode) {
    if (!/[A-Za-z]/.test(t.nodeValue || '')) return;
    if (mode === 2) { // 聊天标签页标题：只翻默认名
      var n = (t.nodeValue || '').trim();
      if (has.call(DEFAULT_TITLES, n) && has.call(DICT, n)) t.nodeValue = t.nodeValue.replace(n, DICT[n]);
      return;
    }
    if (sentence(t)) return;
    if (partOfSentence(t)) return;
    var v = tr(t.nodeValue);
    if (!v) { var pv = pattern(t.nodeValue); if (pv && inChrome(t)) v = pv; } // 先匹配模板再查祖先，避免每个文本节点都爬到根
    if (v && v !== t.nodeValue) t.nodeValue = v;
  }
  // mode：0 正常；2 名字区（只在聊天标签页里出现，其余名字区已在 skip 时整棵跳过）
  function walk(node, mode) {
    mode = mode || 0;
    if (node.nodeType === 3) return text(node, mode);
    if (node.nodeType !== 1) return;
    var m = skip(node);
    if (m === 1) return;
    if (m === 2) { if (!inComposerTab(node)) return; mode = 2; }
    if (mode !== 2) attrs(node);
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c, mode);
  }
  function start() {
    walk(doc.body);
    new MO(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        var mode = modeOf(m.target || {});
        if (mode === 1) continue;
        if (m.type === 'childList') for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j], mode);
        else if (m.type === 'characterData') text(m.target, mode);
        else if (m.type === 'attributes' && mode === 0) attrs(m.target);
      }
    }).observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (doc.body) start();
  else doc.addEventListener('DOMContentLoaded', start);
}
