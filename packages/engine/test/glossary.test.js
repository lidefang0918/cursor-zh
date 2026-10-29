import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkGlossary } from '../../../scripts/check-glossary.mjs';

describe('glossary', () => {
  it('dictionary follows the glossary (dicts/glossary.md)', () => {
    const dict = JSON.parse(fs.readFileSync(new URL('../../../dicts/zh-cn.json', import.meta.url), 'utf8'));
    assert.deepEqual(checkGlossary(dict), []);
  });
  it('NLS dictionary follows the glossary and keeps placeholders/mnemonics', () => {
    const nls = JSON.parse(fs.readFileSync(new URL('../../../dicts/zh-cn.nls.json', import.meta.url), 'utf8'));
    assert.deepEqual(checkGlossary(nls), []);
    const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
    for (const [en, zh] of Object.entries(nls)) {
      assert.equal(ph(zh), ph(en), `placeholders: ${en}`);
      assert.equal(zh.includes('&&'), en.includes('&&'), `mnemonic: ${en}`);
      assert.equal(zh.split('\n').length, en.split('\n').length, `newlines: ${en}`);
    }
  });
  it('flags a stray translation', () => {
    assert.equal(checkGlossary({ 'New Agent': '新建代理', Undo: '撤消' }).length, 3);
  });
});
