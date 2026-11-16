// 仅供测试：给正式 apps/desktop/index.html + renderer.js 提供最小 DOM 和 mock window.engine。
// 不得被正式产品引用。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

class TextNode {
  constructor(text) { this.nodeType = 3; this.data = String(text); this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class ClassList {
  constructor(el) { this.el = el; }
  _parts() { return this.el.className.split(/\s+/).filter(Boolean); }
  _set(a) { this.el.className = a.join(' '); }
  contains(c) { return this._parts().includes(c); }
  add(...cs) { const s = new Set(this._parts()); for (const c of cs) s.add(c); this._set([...s]); }
  remove(...cs) { this._set(this._parts().filter((x) => !cs.includes(x))); }
  toggle(c, force) {
    const has = this.contains(c);
    if (force === true || (!has && force !== false)) this.add(c); else this.remove(c);
    return this.contains(c);
  }
}

class El {
  constructor(tag, owner) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = owner;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.className = '';
    this._id = '';
    this.hidden = false;
    this.disabled = false;
    this.onclick = null;
    this.onchange = null;
    this.onkeydown = null;
    this.style = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.classList = new ClassList(this);
    this.dataset = new Proxy({}, {
      get: (t, k) => this.getAttribute('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) ?? t[k],
      set: (t, k, v) => { this.setAttribute('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), v); return true; },
    });
  }
  get id() { return this._id; }
  set id(v) {
    if (this._id && this.ownerDocument) this.ownerDocument._ids.delete(this._id);
    this._id = String(v || '');
    if (this._id && this.ownerDocument) this.ownerDocument._ids.set(this._id, this);
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v != null && String(v) !== '') this.appendChild(new TextNode(v));
  }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return serialize(this); }
  set innerHTML(html) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    parseInto(this, String(html), this.ownerDocument);
  }
  setAttribute(k, v) {
    const key = String(k);
    const val = v == null ? '' : String(v);
    this.attributes.set(key, val);
    if (key === 'id') this.id = val;
    if (key === 'class') this.className = val;
    if (key === 'hidden') this.hidden = val !== 'false';
    if (key === 'disabled') this.disabled = val !== 'false';
    if (key === 'value') this.value = val;
  }
  getAttribute(k) {
    if (k === 'class') return this.className || null;
    if (k === 'id') return this.id || null;
    if (k === 'hidden') return this.hidden ? '' : null;
    if (k === 'disabled') return this.disabled ? '' : null;
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  hasAttribute(k) { return this.getAttribute(k) != null; }
  removeAttribute(k) {
    this.attributes.delete(k);
    if (k === 'hidden') this.hidden = false;
    if (k === 'disabled') this.disabled = false;
  }
  append(...nodes) { for (const n of nodes.flat()) this.appendChild(n); }
  appendChild(n) {
    if (n == null) return n;
    if (typeof n === 'string' || typeof n === 'number') n = new TextNode(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n) {
    this.childNodes = this.childNodes.filter((c) => c !== n);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) {
    ev.target ||= this;
    ev.currentTarget = this;
    const list = [...(this.listeners[ev.type] || [])];
    if (ev.type === 'click' && this.onclick) list.push(this.onclick);
    if (ev.type === 'change' && this.onchange) list.push(this.onchange);
    if (ev.type === 'keydown' && this.onkeydown) list.push(this.onkeydown);
    for (const fn of list) fn.call(this, ev);
    return !ev.defaultPrevented;
  }
  click() {
    if (this.disabled || this.hidden) return;
    this.dispatchEvent({ type: 'click', preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} });
  }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  matches(sel) { return matchOne(this, sel); }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
}

function serialize(el) {
  return el.childNodes.map((n) => {
    if (n.nodeType === 3) return n.textContent;
    const attrs = [];
    if (n.id) attrs.push(`id="${n.id}"`);
    if (n.className) attrs.push(`class="${n.className}"`);
    for (const [k, v] of n.attributes) if (k !== 'id' && k !== 'class') attrs.push(`${k}="${v}"`);
    const a = attrs.length ? ' ' + attrs.join(' ') : '';
    return `<${n.tagName.toLowerCase()}${a}>${serialize(n)}</${n.tagName.toLowerCase()}>`;
  }).join('');
}

const VOID = new Set(['BR', 'HR', 'IMG', 'INPUT', 'META', 'LINK', 'SOURCE', 'AREA', 'COL', 'WBR']);

function parseInto(parent, html, doc) {
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  const stack = [parent];
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[4] != null) {
      const t = m[4];
      if (t.trim()) stack[stack.length - 1].appendChild(new TextNode(decode(t)));
      continue;
    }
    const closing = !!m[1];
    const tag = m[2];
    if (closing) {
      while (stack.length > 1 && stack[stack.length - 1].tagName !== tag.toUpperCase()) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new El(tag, doc);
    const attrSrc = m[3] || '';
    const ar = /([:@]?[\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = ar.exec(attrSrc))) {
      const name = a[1];
      const val = a[2] ?? a[3] ?? a[4] ?? '';
      el.setAttribute(name, decode(val));
    }
    stack[stack.length - 1].appendChild(el);
    const self = attrSrc.trim().endsWith('/') || VOID.has(el.tagName);
    if (!self) stack.push(el);
  }
}
function decode(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

function tokenizeSel(sel) {
  return sel.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+/));
}
function matchSimple(el, tok) {
  if (tok === '*') return true;
  const m = tok.match(/^([a-zA-Z][\w-]*)?(?:#([\w-]+))?(?:\.([\w-]+))*(?:\[[^\]]+\])*$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  if (m[2] && el.id !== m[2]) return false;
  const classes = [...tok.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
  for (const c of classes) if (!el.classList.contains(c)) return false;
  const attrs = [...tok.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]);
  for (const raw of attrs) {
    const mm = raw.match(/^([\w-]+)(?:\s*=\s*["']?([^"'\]]+)["']?)?$/);
    if (!mm) return false;
    const got = el.getAttribute(mm[1]);
    if (mm[2] != null) { if (got !== mm[2]) return false; }
    else if (got == null) return false;
  }
  return true;
}
function matchOne(el, sel) {
  const groups = tokenizeSel(sel);
  return groups.some((parts) => {
    if (parts.length === 1) return matchSimple(el, parts[0]);
    // descendant: last must match el, ancestors match earlier
    if (!matchSimple(el, parts[parts.length - 1])) return false;
    let node = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (node && node.nodeType === 1 && !matchSimple(node, parts[i])) node = node.parentNode;
      if (!node || node.nodeType !== 1) return false;
      node = node.parentNode;
    }
    return true;
  });
}
function walk(el, out) {
  out.push(el);
  for (const c of el.children) walk(c, out);
}
function queryAll(root, sel) {
  const out = [];
  const all = [];
  walk(root, all);
  const start = root.nodeType === 1 && root.tagName === 'HTML' ? all : all.slice(1);
  for (const el of start) if (matchOne(el, sel)) out.push(el);
  return out;
}

function createDocument(html) {
  const doc = {
    _ids: new Map(),
    nodeType: 9,
    documentElement: null,
    body: null,
    head: null,
    activeElement: null,
    title: '',
    createElement(tag) { return new El(tag, doc); },
    createTextNode(t) { return new TextNode(t); },
    getElementById(id) { return doc._ids.get(id) ?? null; },
    querySelector(sel) { return doc.documentElement.querySelector(sel); },
    querySelectorAll(sel) { return doc.documentElement.querySelectorAll(sel); },
    addEventListener(type, fn) { doc.documentElement.addEventListener(type, fn); },
    removeEventListener(type, fn) { doc.documentElement.removeEventListener(type, fn); },
    dispatchEvent(ev) { return doc.documentElement.dispatchEvent(ev); },
  };
  const htmlEl = new El('html', doc);
  doc.documentElement = htmlEl;
  parseInto(htmlEl, html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, ''), doc);
  // If parse started from full file we already stripped html wrapper; also handle fragments
  if (!htmlEl.children.length) parseInto(htmlEl, html, doc);
  doc.head = htmlEl.querySelector('head') || htmlEl.appendChild(new El('head', doc));
  doc.body = htmlEl.querySelector('body') || htmlEl.appendChild(new El('body', doc));
  // register ids already set during parse
  const all = []; walk(htmlEl, all);
  for (const el of all) if (el.id) doc._ids.set(el.id, el);
  return doc;
}

export function baseStatus(over = {}) {
  const cursorDefault = { root: '/Applications/Cursor.app', version: '3.29.9', vscodeVersion: '1.105.1' };
  const cursor = over.cursor === null ? null : { ...cursorDefault, ...(over.cursor || {}) };
  const platform = over.platform || 'darwin';
  return {
    ok: true,
    cursor,
    supported: over.supported ?? !!cursor,
    exact: over.exact ?? true,
    compatBase: over.compatBase ?? null,
    data: over.data ?? null,
    supportedVersions: over.supportedVersions ?? ['3.27.22', '3.28.7', '3.29.9'],
    state: over.state ?? {},
    patched: over.patched ?? false,
    stale: over.stale ?? false,
    localized: over.localized ?? false,
    upToDate: over.upToDate === undefined ? null : over.upToDate,
    platform,
    kind: over.kind ?? (cursor ? 'mac-applications' : null),
    writable: over.writable ?? true,
    readOnlyFs: over.readOnlyFs ?? false,
    needsElevation: over.needsElevation ?? false,
    ...(platform === 'darwin' ? { mac: { translocated: false, appManagement: false, signMode: 'adhoc', ...(over.mac || {}) } } : {}),
    elevation: over.elevation ?? { pkexec: false, graphical: false },
    running: over.running ?? 0,
    installs: over.installs ?? (cursor ? [{ root: cursor.root, version: cursor.version }] : []),
    appImages: over.appImages ?? [],
    extracted: over.extracted ?? [],
    otherInstall: over.otherInstall ?? null,
    pending: over.pending ?? null,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['cursor', 'mac'].includes(k))),
  };
}

export async function mountUI(opts = {}) {
  const htmlPath = path.join(repo, 'apps/desktop/index.html');
  const rendererPath = path.join(repo, 'apps/desktop/renderer.js');
  const rawHtml = fs.readFileSync(htmlPath, 'utf8');
  const rendererSrc = fs.readFileSync(rendererPath, 'utf8');
  const document = createDocument(rawHtml);
  const store = new Map(Object.entries(opts.storage || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const prefersDark = !!opts.prefersDark;
  const mq = {
    matches: prefersDark,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  };
  let statusValue = opts.status || baseStatus();
  const calls = { status: [], localize: [], revert: [], extractAppImage: [], showLog: [], copy: [], pickRoot: [] };
  let statusDefer = Promise.resolve();
  const engine = {
    platform: opts.platform || statusValue.platform || 'darwin',
    getStatus: async (o) => {
      calls.status.push(o || {});
      await statusDefer;
      return typeof statusValue === 'function' ? statusValue(o) : statusValue;
    },
    localize: async (o) => {
      calls.localize.push(o || {});
      if (opts.localize) return opts.localize(o || {});
      return { ok: true };
    },
    revert: async (o) => {
      calls.revert.push(o || {});
      if (opts.revert) return opts.revert(o || {});
      return { ok: true };
    },
    extractAppImage: async (p) => {
      calls.extractAppImage.push(p);
      if (opts.extractAppImage) return opts.extractAppImage(p);
      return { ok: true, root: '/tmp/extracted' };
    },
    copy: async (t) => { calls.copy.push(t); return true; },
    showLog: async () => { calls.showLog.push(true); return '/tmp/gui.log'; },
    onLog: (cb) => { engine._onLog = cb; },
    ...(opts.pickRoot ? { pickRoot: async () => { calls.pickRoot.push(true); return opts.pickRoot(); } } : {}),
  };
  const window = {
    engine,
    document,
    localStorage,
    matchMedia: (q) => mq,
    getComputedStyle: (el) => ({
      getPropertyValue: () => '',
      outlineStyle: 'solid',
      outlineWidth: '2px',
    }),
  };
  const context = vm.createContext({
    window,
    document,
    localStorage,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: { userAgent: opts.ua || 'Mozilla/5.0' },
  });
  context.window = window;
  context.globalThis = context;
  // renderer uses window.engine and document.getElementById as globals? It uses document and window.engine.
  // In browsers, document is a global. Provide it.
  vm.runInContext(rendererSrc, context, { filename: 'renderer.js' });
  // initial refresh() is fire-and-forget
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const $ = (id) => document.getElementById(id);
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const visibleText = () => {
    const skip = new Set(['STYLE', 'SCRIPT']);
    const parts = [];
    const walkVis = (n) => {
      if (n.nodeType === 3) { parts.push(n.textContent); return; }
      if (n.nodeType !== 1) return;
      if (skip.has(n.tagName) || n.hidden) return;
      for (const c of n.childNodes) walkVis(c);
    };
    walkVis(document.body);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  return {
    document,
    window,
    engine,
    calls,
    localStorage,
    storage: store,
    $,
    text,
    visibleText,
    setStatus(s) { statusValue = s; },
    async clickRefresh() { $('refresh')?.click(); await tick(); },
    tick,
  };
}

export function tick() { return new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r))); }

export { repo };
