import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectCursor } from '../src/detect.js';

async function fakeRoot(product, sub = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-fake-'));
  const dir = path.join(root, sub);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'product.json'), JSON.stringify(product));
  return root;
}

describe('detectCursor', () => {
  it('reads version from product.json under a candidate root', async () => {
    const root = await fakeRoot({ nameShort: 'Cursor', version: '1.2.3' });
    const found = await detectCursor({ extraRoots: [root], platform: 'linux' });
    assert.equal(found?.version, '1.2.3');
    assert.equal(found?.root, root);
  });

  it('finds product.json in resources/app (real Linux layout)', async () => {
    const root = await fakeRoot({ version: '9.9.9', vscodeVersion: '1.99.0' }, 'resources/app');
    const found = await detectCursor({ extraRoots: [root], platform: 'linux' });
    assert.equal(found?.version, '9.9.9');
    assert.equal(found?.appDir, path.join(root, 'resources/app'));
    assert.equal(found?.vscodeVersion, '1.99.0');
  });

  it('returns null when nothing found', async () => {
    const found = await detectCursor({ extraRoots: ['/no/such/cursor-root-xyz'], platform: 'linux', defaults: false });
    assert.equal(found, null);
  });
});
