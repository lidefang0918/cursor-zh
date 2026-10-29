import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkGlossary } from '../../../scripts/check-glossary.mjs';

describe('glossary', () => {
  it('dictionary follows the glossary (dicts/glossary.md)', () => {
    const dict = JSON.parse(fs.readFileSync(new URL('../../../dicts/zh-cn.json', import.meta.url), 'utf8'));
    assert.deepEqual(checkGlossary(dict), []);
  });
  it('flags a stray translation', () => {
    assert.equal(checkGlossary({ 'New Agent': '新建代理', Undo: '撤消' }).length, 3);
  });
});
