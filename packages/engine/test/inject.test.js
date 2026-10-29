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
    hasAttribute(a) { return a in this.attrs; } };
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
});

