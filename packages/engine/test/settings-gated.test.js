// 设置里被功能/套餐/平台开关挡住、box 上渲染不出来的分区（远程控制、运行模式与确认框、Tab 的 Python 自动导入……）：
// 静态可见字符串扫描（scripts/static-strings.mjs）+ 代表词条 + JSX 拆分句 / 嵌套模板规则 + 片段顺序
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadContext, scan, looksVisible } from '../../../scripts/static-strings.mjs';
import { checkGlossary } from '../../../scripts/check-glossary.mjs';
import { applyFragments } from '../src/patch.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(root + p, 'utf8'));
const py = (code) => JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ba', 'scripts/build-anchors.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${code}`], { cwd: root, encoding: 'utf8' }).trim().split('\n').pop());

describe('settings sections hidden behind feature gates', () => {
  it('representative entries from the screenshots are translated with the glossary terms', () => {
    const d = read('dicts/zh-cn.json');
    const want = {
      'Remote Control': '远程控制', 'Automatically register computers': '自动注册电脑', 'Computer Name': '电脑名称',
      'Keep This Computer Awake': '让这台电脑保持唤醒', 'Unregister All': '全部取消注册', 'Paired Devices': '已配对的设备',
      'Self-Hosted Workers': '自托管 Worker', 'Auto-Review': '自动审查', 'Run Everything (Unsandboxed)': '全部运行（无沙箱）',
      'Allowlist (with Sandbox)': '允许列表（沙箱）', 'Auto Import for Python': 'Python 自动导入',
    };
    for (const [en, zh] of Object.entries(want)) assert.equal(d[en], zh, en);
    assert.match(d['Enabled by Run Everything Auto-Run Mode.'], /全部运行/);
    assert.match(d['Disable Remote Control on all of my computers'], /远程控制/);
    for (const zh of Object.values(d)) assert.doesNotMatch(zh, /白名单|沙盒/);
  });

  it('glossary rejects 白名单 / 沙盒 and requires the new terms, ignoring file names like sandbox.json', () => {
    assert.equal(checkGlossary({ 'Shell allowlist': 'Shell 白名单' }).length, 2);
    assert.equal(checkGlossary({ 'Sandbox mode': '沙盒模式' }).length, 2);
    assert.equal(checkGlossary({ 'Remote Control': '远程操控' }).length, 1);
    assert.equal(checkGlossary({ 'Auto-Review': '自动检查' }).length, 1);
    assert.deepEqual(checkGlossary({ 'Edit sandbox.json in your workspace': '在工作区中编辑 sandbox.json' }), []);
  });

  it('JSX split sentences and nested templates are rewritten in place', () => {
    const src = [
      'a=x("p",{children:["Data Sharing is controlled by ",y?"the":"your"," team admin."]});',
      'b=x("p",{children:["Sharing will activate in ",m," hour",m===1?"":"s","."]});',
      'c=x(B,{children:["With your Cursor ",c,"subscription, you do not need to use your own ",n," key!"]});',
      'd=x(B,{children:["Turn Off ",n," Key"]});',
      'e=`Included usage with your subscription.${t?` Resets ${Xtc(t)}.`:""}`;',
      'f=`Paired with this computer \\xB7 ${q}`;',
    ].join('');
    const got = Object.fromEntries(py(`src = ${JSON.stringify(src)}\nprint(json.dumps([(f['from'], f['to']) for f in m.template_fragments(src)], ensure_ascii=False))`));
    let out = src;
    for (const [from, to] of Object.entries(got)) out = out.split(from).join(to);
    assert.match(out, /"数据共享由",y\?"":"你的","团队管理员控制。"/);
    assert.match(out, /"数据共享将在 ",m," 小时后开启",m===1\?"":"","。"/);
    assert.match(out, /children:\["你的 Cursor ",c,"订阅已包含，无需使用自己的 ",n," 密钥！"\]/);
    assert.match(out, /children:\["关闭 ",n," 密钥"\]/);
    assert.match(out, /`订阅包含的用量。\$\{t\?` 重置于 \$\{Xtc\(t\)\}。`:""\}`/);
    assert.match(out, /`已与这台电脑配对 · \$\{q\}`/);
    assert.doesNotThrow(() => new Function(out));
  });

  it('a fragment contained in a longer one is ordered after it, so both apply', () => {
    const anchors = read('anchors/3.27.22.json');
    for (const f of anchors.files) {
      const fr = f.fragments.map((g) => g.from);
      fr.forEach((a, i) => fr.forEach((b, j) => { if (i !== j && b.includes(a)) assert.ok(j < i, `${a} must come after ${b}`); }));
    }
    const src = 'x=`Prevent Agent from automatically running MCP tools${r?" (controlled by admin)":""}`;y=r?" (controlled by admin)":"";';
    const frags = anchors.files[1].fragments.filter((g) => src.includes(g.from)).map((g) => ({ ...g, count: src.split(g.from).length - 1 }));
    assert.equal(frags.length, 2);
    const { out, missing } = applyFragments(src, frags);
    assert.deepEqual(missing, []);
    assert.equal(out, 'x=`阻止智能体自动运行 MCP 工具${r?"（由管理员控制）":""}`;y=r?"（由管理员控制）":"";');
  });

  it('static scan finds display strings in settings modules and ignores logs, errors and identifiers', () => {
    loadContext('3.27.22', root);
    const src = 'var A=L({"remote-control-section.react.js"(){X={label:"Keep This Computer Awake",description:"Brand new sentence nobody translated."};'
      + 'console.log("Not a visible string here");throw new Error("Failed to do the thing");k=t?"Ask Every Time":"Totally Unknown Option";'
      + 'm=`Disconnect ${n.name} from this computer?`;z={id:"remote-control"}}});';
    const items = scan(src, 'out/vs/workbench/workbench.glass.main.js', { minModules: 0 });
    const by = Object.fromEntries(items.map((x) => [x.text, x.covered]));
    assert.equal(by['Keep This Computer Awake'], 'dict');
    assert.equal(by['Ask Every Time'], 'dict');
    assert.equal(by['Disconnect ${1} from this computer?'], 'template');
    assert.equal(by['Brand new sentence nobody translated.'], null);
    assert.equal(by['Totally Unknown Option'], null);
    for (const t of ['Not a visible string here', 'Failed to do the thing', 'remote-control']) assert.ok(!(t in by), t);
    assert.ok(looksVisible('Unregisters every computer on your account; you can register any of them again later', { display: true }));
    assert.ok(!looksVisible('a;b;c', { display: true }));
  });

  it('static-skip only keeps internal/dev strings, each list documented', () => {
    const s = read('scripts/static-skip.json');
    assert.ok(s._note && s.exact.length && s.regex.length);
    for (const r of s.regex) new RegExp(r);
    const d = read('dicts/zh-cn.json');
    for (const t of s.exact) assert.ok(!(t in d), `skip and dict both have ${t}`);
  });
});
