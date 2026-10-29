// Cursor 渲染进程 DOM 补漏：只做"整段精确匹配"替换。
// 由 engine 包成 (function(DICT){ ... })({...}) 追加到 workbench bundle 末尾。
// 规则：
//  1. 文本节点：去掉首尾空白后与词典 key 完全相等，且它不是一句话里的一个词（同级没有其他含字母的文本节点）。
//  2. 整句：元素的 textContent（归一化空白/破折号/引号）等于词典里的多词 key 时，整句替换：
//     译文写进第一个文本节点，其余文本节点清空（保留 React 持有的节点引用，不删节点）。
//  3. 属性 title/placeholder/aria-label：完全相等，或 "文案 (快捷键)" 形式只翻前半段。
// 跳过编辑器内容、可编辑区域（聊天输入框）、文件名和 script/style，避免改动用户自己的文字。
function cursorZhDom(DICT, doc, MO) {
  var ATTRS = ['title', 'placeholder', 'aria-label'];
  var has = Object.prototype.hasOwnProperty;
  // label-name / monaco-icon-name-container：资源管理器、标签页里的文件名，不能翻
  var SKIP_CLASSES = ['view-lines', 'monaco-editor-background', 'xterm', 'label-name', 'monaco-icon-name-container'];
  var MAX_SENTENCE = 400;

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
  function skip(node) {
    var tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') return true;
    if (node.hasAttribute && node.hasAttribute('contenteditable')) return true;
    for (var i = 0; i < SKIP_CLASSES.length; i++) if (node.classList && node.classList.contains(SKIP_CLASSES[i])) return true;
    return false;
  }
  function inSkipped(node) {
    for (var p = node.parentNode; p; p = p.parentNode) if (p.nodeType === 1 && skip(p)) return true;
    return false;
  }
  function attrs(node) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = tr(node.getAttribute(ATTRS[i]));
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
  function text(t) {
    if (!/[A-Za-z]/.test(t.nodeValue || '')) return;
    if (sentence(t)) return;
    if (partOfSentence(t)) return;
    var v = tr(t.nodeValue);
    if (v && v !== t.nodeValue) t.nodeValue = v;
  }
  function walk(node) {
    if (node.nodeType === 3) return text(node);
    if (node.nodeType !== 1 || skip(node)) return;
    attrs(node);
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }
  function start() {
    walk(doc.body);
    new MO(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (inSkipped(m.target || {})) continue;
        if (m.type === 'childList') for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
        else if (m.type === 'characterData') walk(m.target);
        else if (m.type === 'attributes') attrs(m.target);
      }
    }).observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (doc.body) start();
  else doc.addEventListener('DOMContentLoaded', start);
}
