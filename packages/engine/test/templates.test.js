import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(root + p, 'utf8'));
const slots = (s) => (s.match(/\$\{\d+\}/g) || []).sort().join();
const exprs = (s) => (s.match(/\$\{[^{}`]+\}/g) || []).sort().join();

describe('template literals and JSX sentence heads', () => {
  it('templates dict keeps every ${n} slot and is not an identity mapping', () => {
    const { templates } = read('dicts/zh-cn.templates.json');
    assert.ok(Object.keys(templates).length >= 10);
    for (const [en, zh] of Object.entries(templates)) {
      assert.ok(slots(en), `no slot: ${en}`);
      assert.equal(slots(zh), slots(en), `slots: ${en}`);
      assert.notEqual(zh, en);
      assert.match(zh, /[\u4e00-\u9fff]/, `untranslated: ${en}`);
    }
  });

  it('build-anchors rules translate a whole template literal and only a multi-word JSX sentence head', () => {
    const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ba', 'scripts/build-anchors.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
src = 'a=\`Remove \${e.name} from your Cursor account?\`;b=\`Skip step \${n.ordinal} of \${n.total}\`;c=\`Remove \${x}s\`;d=x("p",{children:["You can put in"," ",l]});e=x("p",{children:["Default",y]});'
print(json.dumps(sorted((f['from'], f['to']) for f in m.template_fragments(src)), ensure_ascii=False))`;
    const got = JSON.parse(execFileSync('python3', ['-c', py], { cwd: root, encoding: 'utf8' }).trim().split('\n').pop());
    const map = Object.fromEntries(got);
    assert.equal(map['`Remove ${e.name} from your Cursor account?`'], '`要从 Cursor 账户中移除 ${e.name} 吗？`');
    assert.equal(map['`Skip step ${n.ordinal} of ${n.total}`'], '`跳过第 ${n.ordinal} 步（共 ${n.total} 步）`');
    assert.equal(map['children:["You can put in",'], 'children:["可填入",');
    assert.ok(!('`Remove ${x}s`' in map), 'partial template must not match');
    assert.ok(!('children:["Default",' in map), 'single word JSX head must not be rewritten');
  });

  it('generated template fragments keep the original ${…} expressions', () => {
    for (const v of ['3.27.22', '3.27.14']) {
      for (const f of read(`anchors/${v}.json`).files) {
        for (const g of f.fragments) if (g.from.startsWith('`')) assert.equal(exprs(g.to), exprs(g.from), `${v}: ${g.from}`);
      }
    }
  });

  it('new dictionary entries: no identity mappings, placeholders and brand names kept', () => {
    const dict = read('dicts/zh-cn.json');
    const brands = ['OpenAI', 'Anthropic', 'Claude', 'Azure', 'AWS Bedrock', 'Google', 'Gemini', 'GitHub', 'Cursor'];
    for (const [en, zh] of Object.entries(dict)) {
      if (!/[\u4e00-\u9fff]/.test(zh)) continue; // 少数刻意保留原文的条目（快捷键、单位）不查
      for (const b of brands) if (en.includes(b)) assert.ok(zh.includes(b), `brand ${b} lost in: ${en} => ${zh}`);
      assert.equal(((zh.match(/\{\w+\}/g)) || []).sort().join(), ((en.match(/\{\w+\}/g)) || []).sort().join(), `placeholders: ${en}`);
    }
    for (const k of ['API Key', 'Access Key ID', 'Secret Access Key', 'Region', 'You can put in', 'Off', 'On', 'Nightly']) assert.ok(dict[k] && dict[k] !== k, k);
  });
});
