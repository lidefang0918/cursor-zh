import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackup } from '../src/backup.js';
import { restoreBackup } from '../src/restore.js';
import { sha256File } from '../src/backup.js';

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('backup/restore', () => {
  it('restores files byte-for-byte after modification', async () => {
    const installRoot = await tmp('inst-');
    const backupDir = path.join(await tmp('bk-'), '1.0.0');
    const rel = 'resources/app/out/main.js';
    await fs.mkdir(path.dirname(path.join(installRoot, rel)), { recursive: true });
    await fs.writeFile(path.join(installRoot, rel), 'Cursor Settings');
    await fs.writeFile(path.join(installRoot, 'product.json'), '{"a":1}');
    const before = await sha256File(path.join(installRoot, rel));

    const { manifestPath, files } = await createBackup({ installRoot, files: [rel, 'product.json'], backupDir });
    assert.ok(manifestPath.endsWith('manifest.json'));
    assert.equal(files.find((f) => f.relative === rel).sha256, before);

    await fs.writeFile(path.join(installRoot, rel), 'Cursor 设置');
    await fs.writeFile(path.join(installRoot, 'product.json'), '{"a":2}');
    await restoreBackup({ installRoot, backupDir });

    assert.equal(await fs.readFile(path.join(installRoot, rel), 'utf8'), 'Cursor Settings');
    assert.equal(await fs.readFile(path.join(installRoot, 'product.json'), 'utf8'), '{"a":1}');
  });

  it('refuses to overwrite an existing backup (would back up patched files)', async () => {
    const installRoot = await tmp('inst-');
    const backupDir = path.join(await tmp('bk-'), '1.0.0');
    await fs.writeFile(path.join(installRoot, 'a.js'), 'x');
    await createBackup({ installRoot, files: ['a.js'], backupDir });
    await assert.rejects(createBackup({ installRoot, files: ['a.js'], backupDir }), /已存在备份/);
  });

  it('restore fails when there is no manifest', async () => {
    await assert.rejects(restoreBackup({ installRoot: await tmp('i-'), backupDir: await tmp('b-') }), /没有备份/);
  });
});
