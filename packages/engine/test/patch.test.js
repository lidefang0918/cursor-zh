import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAnchors, loadDict } from '../src/anchors.js';
import { applyPatch, vscodeChecksum, filesToBackup, replaceAllLiterals, applyFragments } from '../src/patch.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const anchorsDir = path.join(repo, 'packages/engine/test/fixtures/anchors');
const REL = 'resources/app/out/vs/workbench/workbench.desktop.main.js';

async function fakeInstall(js) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-'));
  await fs.mkdir(path.dirname(path.join(root, REL)), { recursive: true });
  await fs.writeFile(path.join(root, REL), js);
  const product = { version: 'test-fixture', checksums: { 'vs/workbench/workbench.desktop.main.js': vscodeChecksum(Buffer.from(js)) } };
  await fs.writeFile(path.join(root, 'resources/app/product.json'), JSON.stringify(product, null, '\t'));
  return root;
}

describe('anchors', () => {
  it('loads anchors by platform+version, null when missing', async () => {
    assert.equal((await loadAnchors({ platform: 'linux', version: 'test-fixture', anchorsDir })).version, 'test-fixture');
    assert.equal(await loadAnchors({ platform: 'linux', version: '0.0.0-nope', anchorsDir }), null);
  });
  it('lists files to back up incl. product.json', async () => {
    const a = await loadAnchors({ platform: 'linux', version: 'test-fixture', anchorsDir });
    assert.deepEqual(filesToBackup(a).sort(), [REL, 'resources/app/product.json'].sort());
    assert.deepEqual(filesToBackup({ files: [{ relative: 'a.js' }], productJson: 'p.json', nls: { relative: 'n.json' } }), ['a.js', 'p.json', 'n.json']);
  });
});

describe('applyPatch', () => {
  it('replaces whole string literals only, updates checksum, reports missing', async () => {
    const js = 'a="Cursor Settings";b=\'New Agent\';c=`Cursor Settings`;d="Open Cursor Settings";';
    const root = await fakeInstall(js);
    const anchors = await loadAnchors({ platform: 'linux', version: 'test-fixture', anchorsDir });
    const dict = await loadDict(path.join(repo, 'packages/engine/test/fixtures/dict.json'));
    const r = await applyPatch({ installRoot: root, anchors, dict });

    const out = await fs.readFile(path.join(root, REL), 'utf8');
    assert.equal(out, 'a="Cursor 设置";b=\'新建 Agent\';c=`Cursor 设置`;d="Open Cursor Settings";');
    assert.deepEqual(r.missing, ['Not In Bundle']);
    assert.equal(r.replaced, 3);
    const product = JSON.parse(await fs.readFile(path.join(root, 'resources/app/product.json'), 'utf8'));
    const expected = crypto.createHash('sha256').update(Buffer.from(out)).digest('base64').replace(/=+$/, '');
    assert.equal(product.checksums['vs/workbench/workbench.desktop.main.js'], expected);
  });

  it('throws when a required anchor is missing', async () => {
    const root = await fakeInstall('x="New Agent"');
    const anchors = await loadAnchors({ platform: 'linux', version: 'test-fixture', anchorsDir });
    await assert.rejects(applyPatch({ installRoot: root, anchors, dict: { 'Cursor Settings': 'Cursor 设置', 'New Agent': '新建' } }), /必需锚点缺失.*Cursor Settings/);
  });

  it('escapes quotes in translations', async () => {
    const root = await fakeInstall('x="New Agent";y="Cursor Settings"');
    const anchors = await loadAnchors({ platform: 'linux', version: 'test-fixture', anchorsDir });
    await applyPatch({ installRoot: root, anchors, dict: { 'Cursor Settings': 'Cursor 设置', 'New Agent': '新建 "代理"' } });
    assert.equal(await fs.readFile(path.join(root, REL), 'utf8'), 'x="新建 \\"代理\\"";y="Cursor 设置"');
  });
});

describe('updateChecksums', () => {
  it('only rewrites the checksum value, keeping product.json formatting byte-identical otherwise', async () => {
    const js = 'var a="Cursor Settings";';
    const root = await fakeInstall(js);
    const pp = path.join(root, 'resources/app/product.json');
    const old = vscodeChecksum(Buffer.from(js));
    const raw = `{\n  "nameShort": "Cursor",\n  "arr": ["a", "b"],\n  "checksums": {\n    "vs/workbench/workbench.desktop.main.js": "${old}"\n  }\n}`;
    await fs.writeFile(pp, raw);
    const a = await loadAnchors({ platform: 'linux', version: 'test-fixture', anchorsDir });
    await applyPatch({ installRoot: root, anchors: a, dict: { 'Cursor Settings': 'Cursor 设置' } });
    const fresh = vscodeChecksum(await fs.readFile(path.join(root, REL)));
    assert.notEqual(fresh, old);
    assert.equal(await fs.readFile(pp, 'utf8'), raw.replace(old, fresh));
  });
});

describe('replaceAllLiterals', () => {
  it('replaces all whole literals in one pass but keeps original: English for command palette search', () => {
    const src = `t={value:"Zoom In",original:"Zoom In"};a='Undo';b="Undo now";c=\`Undo\``;
    const { out, counts } = replaceAllLiterals(src, new Map([['Zoom In', '放大'], ['Undo', '撤销']]));
    assert.equal(out, `t={value:"放大",original:"Zoom In"};a='撤销';b="Undo now";c=\`撤销\``);
    assert.equal(counts.get('Zoom In'), 1);
    assert.equal(counts.get('Undo'), 2);
  });
});

describe('shipped dictionary', () => {
  it('has no value that is also a key (identity/chained entries make the DOM runtime loop)', async () => {
    const dict = await loadDict(path.join(repo, 'dicts/zh-cn.json'));
    const bad = Object.entries(dict).filter(([, v]) => Object.hasOwn(dict, v));
    assert.deepEqual(bad, []);
  });
});

describe('applyFragments', () => {
  const src = 'a={text:`$(tab) Tab Stats: ${x}/${y} (${e}%)`};b=`${e} percent acceptance rate`;c=`${t} percent acceptance rate`;';
  it('replaces template-literal fragments when the occurrence count matches exactly', () => {
    const r = applyFragments(src, [
      { from: '`$(tab) Tab Stats: ${', to: '`$(tab) Tab 统计：${', count: 1 },
      { from: '} percent acceptance rate`', to: '}%`', count: 2 },
    ]);
    assert.equal(r.replaced, 3);
    assert.deepEqual(r.missing, []);
    assert.equal(r.out, 'a={text:`$(tab) Tab 统计：${x}/${y} (${e}%)`};b=`${e}%`;c=`${t}%`;');
  });
  it('skips (and reports) a fragment whose count does not match, leaving the source untouched', () => {
    const r = applyFragments(src, [{ from: '} percent acceptance rate`', to: '}%`', count: 1 }, { from: 'Nope ${', to: 'x' }]);
    assert.equal(r.out, src);
    assert.equal(r.replaced, 0);
    assert.equal(r.missing.length, 2);
  });
});

