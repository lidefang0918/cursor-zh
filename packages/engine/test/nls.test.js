import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nlsTranslate, applyNls, clearNlsCache } from '../src/nls.js';

const REL = 'resources/app/out/nls.messages.json';

describe('nls', () => {
  it('translates plain messages and keeps the && mnemonic as (&&X)', () => {
    const dict = { File: '文件', 'Close Window': '关闭窗口' };
    assert.equal(nlsTranslate('&&File', dict), '文件(&&F)');
    assert.equal(nlsTranslate('Close Window', dict), '关闭窗口');
    assert.equal(nlsTranslate('Nope', dict), null);
  });

  it('patches only listed indices whose English still matches; reports the rest as missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nls-'));
    await fs.mkdir(path.join(root, path.dirname(REL)), { recursive: true });
    await fs.writeFile(path.join(root, REL), JSON.stringify(['OK', '&&File', 'Close Window', 'Changed upstream']));
    const anchors = { nls: { relative: REL, entries: [{ index: 1, from: '&&File' }, { index: 2, from: 'Close Window' }, { index: 3, from: 'Close Window' }] } };
    const r = await applyNls({ installRoot: root, anchors, dict: { File: '文件', 'Close Window': '关闭窗口' } });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, REL), 'utf8')), ['OK', '文件(&&F)', '关闭窗口', 'Changed upstream']);
    assert.equal(r.replaced, 2);
    assert.deepEqual(r.missing, ['Close Window@3']);
  });

  it('clears only the cached translation folder for this commit', async () => {
    const ud = await fs.mkdtemp(path.join(os.tmpdir(), 'ud-'));
    await fs.mkdir(path.join(ud, 'clp/abc.zh-cn/commit1'), { recursive: true });
    await fs.mkdir(path.join(ud, 'clp/abc.zh-cn/other'), { recursive: true });
    const removed = await clearNlsCache({ userDataDir: ud, commit: 'commit1' });
    assert.equal(removed.length, 1);
    assert.deepEqual(await fs.readdir(path.join(ud, 'clp/abc.zh-cn')), ['other']);
    assert.deepEqual(await clearNlsCache({ userDataDir: path.join(ud, 'none'), commit: 'x' }), []);
  });
});
