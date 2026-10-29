// Cursor 渲染进程 DOM 补漏：只做"整段精确匹配"替换（去掉首尾空白后与词典 key 完全相等）。
// 由 engine 包成 (function(DICT){ ... })({...}) 追加到 workbench.desktop.main.js 末尾。
// 跳过编辑器内容、可编辑区域（聊天输入框）和 script/style，避免改动用户自己的文字。
function cursorZhDom(DICT, doc, MO) {
  var ATTRS = ['title', 'placeholder', 'aria-label'];
  var has = Object.prototype.hasOwnProperty;
  var SKIP_CLASSES = ['view-lines', 'monaco-editor-background', 'xterm'];

  function tr(s) {
    if (!s) return null;
    var t = s.trim();
    if (!t || !has.call(DICT, t)) return null;
    return s.replace(t, DICT[t]);
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
      if (v) node.setAttribute(ATTRS[i], v);
    }
  }
  function walk(node) {
    if (node.nodeType === 3) {
      var v = tr(node.nodeValue);
      if (v) node.nodeValue = v;
      return;
    }
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
