import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadLangpack, LANGPACK_ID } from '../src/langpack.js';

it('prefers a vendored vsix (offline bundle) over cache and network', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'czl-vendor-'));
  const vendor = path.join(dir, 'vendor');
  await fs.mkdir(vendor);
  await fs.writeFile(path.join(vendor, `${LANGPACK_ID}-1.128.0.vsix`), 'PK');
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network used'); };
  try {
    assert.equal(await downloadLangpack({ version: '1.128.0', cacheDir: path.join(dir, 'cache'), vendorDir: vendor }), path.join(vendor, `${LANGPACK_ID}-1.128.0.vsix`));
    await assert.rejects(downloadLangpack({ version: '1.129.0', cacheDir: path.join(dir, 'cache'), vendorDir: vendor }), /network used/);
  } finally { globalThis.fetch = realFetch; await fs.rm(dir, { recursive: true, force: true }); }
});
