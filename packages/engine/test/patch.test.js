import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAnchors, loadDict } from '../src/anchors.js';
import { applyPatch, vscodeChecksum, filesToBackup } from '../src/patch.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const anchorsDir = path.join(repo, 'anchors');
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
  });
});

describe('applyPatch', () => {
  it('replaces whole string literals only, updates checksum, reports missing', async () => {
    const js = 'a="Cursor Settings";b=\'New Agent\';c=`Cursor Settings`;d="Open Cursor Settings";';
    const root = await fakeInstall(js);
    const anchors = await loadAnchors({ platform: 'linux', version: 'test-fixture', anchorsDir });
    const dict = await loadDict(path.join(repo, 'dicts/zh-cn.json'));
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
