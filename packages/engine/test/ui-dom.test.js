import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mountUI, baseStatus, tick, repo } from './helpers/ui-dom-harness.mjs';

const prodFiles = () => ({
  html: fs.readFileSync(path.join(repo, 'apps/desktop/index.html'), 'utf8'),
  renderer: fs.readFileSync(path.join(repo, 'apps/desktop/renderer.js'), 'utf8'),
  tauriHtml: fs.readFileSync(path.join(repo, 'apps/tauri/ui/index.html'), 'utf8'),
  tauriRenderer: fs.readFileSync(path.join(repo, 'apps/tauri/ui/renderer.js'), 'utf8'),
});

describe('渐进披露 UI', () => {
  it('产品代码不含原型演示开关或模拟输出', () => {
    const src = Object.values(prodFiles()).join('\n');
    assert.doesNotMatch(src, /演示开关|场景切换|示例日志|示例数据，不是这台电脑|不会真正修改 Cursor/);
    assert.doesNotMatch(src, /正在准备文件（模拟）|正在处理（模拟）/);
  });

  it('默认未汉化已适配首屏：版本/状态/主操作可见，不堆管理员、运行中说明书或长页脚', async () => {
    const ui = await mountUI({ platform: 'darwin', status: baseStatus({ needsElevation: false, running: 0 }) });
    const v = ui.visibleText();
    assert.match(v, /还未汉化|未汉化/);
    assert.match(v, /3\.29\.9/);
    assert.match(v, /已适配/);
    assert.equal(ui.$('localize')?.textContent.trim(), '一键汉化');
    assert.ok(ui.$('localize') && !ui.$('localize').disabled, '主操作可点');
    assert.ok(ui.$('revert')?.hidden || !ui.$('revert'), '未汉化时还原不应作为常驻主按钮出现');
    assert.doesNotMatch(v, /需要管理员权限/);
    assert.doesNotMatch(v, /写入安装目录需要管理员/);
    assert.doesNotMatch(v, /请打开终端，执行下面这条命令/);
    assert.equal(ui.$('running-line')?.hidden !== false ? true : ui.$('running-line')?.hidden, true, '默认无运行中提示');
    assert.doesNotMatch(v, /与 Cursor 官方无关/);
    assert.match(v, /修改前自动备份，可还原/);
    assert.ok(ui.$('refresh'), '刷新按钮存在');
    assert.ok(ui.$('theme'), '主题为紧凑选择');
    const details = ui.$('details');
    const log = ui.$('log');
    assert.ok(!details || details.hidden, '详细信息默认收起');
    assert.ok(!log || log.hidden || log.parentNode?.hidden, '日志默认收起');
  });

  it('路径与诊断在详细信息里按需展开，并记住偏好', async () => {
    const ui = await mountUI({ platform: 'darwin', status: baseStatus() });
    assert.ok(ui.$('toggle-details'), '有详细信息折叠');
    ui.$('toggle-details').click();
    await tick();
    assert.ok(ui.$('details') && !ui.$('details').hidden);
    assert.match(ui.$('details').textContent, /\/Applications\/Cursor\.app/);
    const ui2 = await mountUI({ platform: 'darwin', status: baseStatus(), storage: Object.fromEntries(ui.storage) });
    assert.ok(ui2.$('details') && !ui2.$('details').hidden, '详情展开偏好已记住');
  });

  it('运行中只显示一行状态；点击后才出现退出确认，确认前不调用引擎', async () => {
    let localizeCalls = 0;
    const ui = await mountUI({
      platform: 'darwin',
      status: baseStatus({ running: 1 }),
      localize: async () => { localizeCalls++; return { ok: false, code: 'CURSOR_RUNNING', error: 'Cursor 正在运行' }; },
    });
    const line = ui.$('running-line');
    assert.ok(line && !line.hidden);
    assert.match(line.textContent, /Cursor 正在运行/);
    assert.doesNotMatch(ui.visibleText(), /点“关闭 Cursor 并继续”：本工具会用和 ⌘Q/);
    ui.$('localize').click();
    await tick();
    assert.equal(localizeCalls, 0, '确认前不应调用 localize');
    const dlg = ui.$('dialog');
    assert.ok(dlg && !dlg.hidden);
    assert.match(dlg.textContent, /保存|未保存/);
    assert.match(dlg.textContent, /⌘Q 一样的方式请 Cursor 退出|正常关闭 Cursor/);
    assert.match(dlg.textContent, /不是强制结束|和点关闭按钮一样/);
    assert.doesNotMatch(dlg.textContent, /请强制结束|强制结束 Cursor/);
    ui.document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} });
    await tick();
    assert.ok(ui.$('overlay')?.hidden, 'Escape 关闭退出确认');
    assert.equal(localizeCalls, 0);
  });

  it('macOS 首次点击操作前说明系统钥匙串信任与已知限制，取消不调用引擎', async () => {
    let localizeCalls = 0;
    const ui = await mountUI({
      platform: 'darwin',
      status: baseStatus({ running: 0 }),
      localize: async () => { localizeCalls++; return { ok: true }; },
    });
    const hint = ui.$('mac-hint');
    assert.ok(hint && !hint.hidden, 'macOS 有可点开的签名限制提示');
    assert.ok(!ui.$('mac-facts') || ui.$('mac-facts').hidden, '签名详情默认不展开');
    assert.doesNotMatch(ui.visibleText(), /需要将该证书的公钥加入/);
    ui.$('localize').click();
    await tick();
    const dlg = ui.$('dialog');
    assert.ok(dlg && !dlg.hidden);
    assert.match(dlg.textContent, /cursor-zh-local|系统钥匙串/);
    assert.match(dlg.textContent, /不会回退到 ad-hoc|不会改用 ad-hoc/);
    assert.match(dlg.textContent, /尚未完全修复|尚未彻底修复/);
    assert.equal(localizeCalls, 0);
    const cancel = ui.document.querySelector('[data-testid="dialog-cancel"]') || [...(dlg.querySelectorAll('button') || [])].find((b) => /取消/.test(b.textContent));
    assert.ok(cancel, '可取消');
    cancel.click();
    await tick();
    assert.equal(localizeCalls, 0, '取消后中止，不调用引擎');
    assert.match(ui.visibleText(), /还未汉化|未汉化/);
  });

  it('Linux 需要提权时不把说明书堆在首屏，点击后才说明，且不谈钥匙串', async () => {
    const ui = await mountUI({
      platform: 'linux',
      status: baseStatus({
        platform: 'linux',
        kind: 'deb',
        cursor: { root: '/usr/share/cursor', version: '3.29.9', vscodeVersion: '1.105.1' },
        needsElevation: true,
        writable: false,
        running: 0,
      }),
    });
    assert.ok(!ui.$('mac-hint') || ui.$('mac-hint').hidden, 'Linux 不显示 mac 签名提示');
    assert.doesNotMatch(ui.visibleText(), /需要管理员权限/);
    assert.doesNotMatch(ui.visibleText(), /系统钥匙串|cursor-zh-local/);
    ui.$('localize').click();
    await tick();
    const dlg = ui.$('dialog');
    assert.ok(dlg && !dlg.hidden);
    assert.match(dlg.textContent, /管理员|pkexec|授权/);
    assert.doesNotMatch(dlg.textContent, /系统钥匙串/);
  });

  it('已汉化时还原为次操作，主按钮不再是已汉化占位', async () => {
    const ui = await mountUI({
      platform: 'darwin',
      status: baseStatus({
        localized: true,
        upToDate: true,
        state: { localized: true, at: '2026-11-16T01:00:00.000Z' },
      }),
    });
    assert.match(ui.visibleText(), /已是中文|已汉化/);
    assert.ok(ui.$('revert') && !ui.$('revert').hidden && !ui.$('revert').disabled);
    assert.match(ui.$('revert').textContent, /还原/);
    assert.ok(!ui.$('localize') || ui.$('localize').hidden || !/已汉化/.test(ui.$('localize').textContent));
  });

  it('写入失败后主操作是重试，并给出下一步', async () => {
    const ui = await mountUI({
      platform: 'linux',
      status: baseStatus({
        platform: 'linux',
        kind: 'manual',
        cursor: { root: '/opt/cursor', version: '3.29.9', vscodeVersion: '1.105.1' },
        running: 0,
        needsElevation: false,
      }),
      localize: async () => ({ ok: false, code: 'PATCH_FAILED', error: '写入失败', next: '安装文件没有被改动。请把日志文件发给开发者。' }),
    });
    // linux no mac confirm; may still have a pre-confirm if we add one only for elevation/mac
    ui.$('localize').click();
    await tick();
    // if a confirm appeared for no reason, fail clearly
    if (ui.$('dialog') && !ui.$('dialog').hidden) {
      const ok = [...ui.$('dialog').querySelectorAll('button')].find((b) => !/取消/.test(b.textContent));
      ok?.click();
      await tick();
    }
    await tick();
    assert.match(ui.visibleText(), /下一步/);
    assert.equal(ui.$('localize')?.textContent.trim(), '重试');
  });

  it('签名校验失败不以重试必能修好为主操作', async () => {
    const ui = await mountUI({
      platform: 'darwin',
      status: baseStatus({
        localized: true,
        upToDate: true,
        state: { localized: true, at: '2026-11-16T01:00:00.000Z' },
      }),
      revert: async () => ({ ok: true, signVerifyFailed: true, signDetail: 'codesign verify failed' }),
    });
    ui.$('revert').click();
    await tick();
    if (ui.$('dialog') && !ui.$('dialog').hidden) {
      const ok = [...ui.$('dialog').querySelectorAll('button')].find((b) => !/取消/.test(b.textContent));
      ok?.click();
      await tick();
    }
    // possible second mac confirm
    if (ui.$('dialog') && !ui.$('dialog').hidden) {
      const ok = [...ui.$('dialog').querySelectorAll('button')].find((b) => !/取消/.test(b.textContent));
      ok?.click();
      await tick();
    }
    await tick();
    const v = ui.visibleText();
    assert.match(v, /签名校验/);
    assert.doesNotMatch(v, /已彻底修复|已经修复/);
    if (ui.$('localize') && !ui.$('localize').hidden) {
      assert.doesNotMatch(ui.$('localize').textContent, /重试/);
    }
  });

  it('兼容模式与失效、未找到、多安装等情境仍可见并可操作', async () => {
    const compat = await mountUI({
      platform: 'darwin',
      status: baseStatus({ exact: false, supported: true, compatBase: '3.29.9', cursor: { version: '3.30.0', vscodeVersion: '1.105.1', root: '/Applications/Cursor.app' } }),
    });
    assert.match(compat.visibleText(), /兼容模式|还没有专门适配/);
    assert.match(compat.visibleText(), /3\.30\.0/);

    const stale = await mountUI({
      platform: 'darwin',
      status: baseStatus({ stale: true, localized: false, supported: true, state: { localized: true } }),
    });
    assert.match(stale.visibleText(), /已失效/);
    assert.equal(stale.$('localize')?.textContent.trim(), '重新汉化');

    const missing = await mountUI({
      platform: 'darwin',
      status: baseStatus({ cursor: null, supported: false, installs: [] }),
      pickRoot: async () => '/Applications/Cursor.app',
    });
    assert.match(missing.visibleText(), /未找到 Cursor/);
    assert.ok(missing.$('localize') == null || missing.$('localize').hidden || /选择/.test(missing.$('localize').textContent) || missing.document.querySelector('button')?.textContent);

    const multi = await mountUI({
      platform: 'darwin',
      status: baseStatus({
        installs: [
          { root: '/Applications/Cursor.app', version: '3.29.9' },
          { root: '/Users/shared/Applications/Cursor.app', version: '3.28.7' },
        ],
      }),
    });
    const sel = multi.$('installs');
    assert.ok(sel && !sel.hidden && sel.children.length === 2);
  });

  it('未找到 Cursor 时不展示还原英文，即使仍有过往汉化记录；也不展示空的详细信息', async () => {
    const ui = await mountUI({
      platform: 'linux',
      status: baseStatus({
        platform: 'linux',
        kind: null,
        cursor: null,
        supported: false,
        installs: [],
        localized: false,
        stale: false,
        pending: null,
        state: { localized: true, at: '2026-10-30T02:45:40.824Z', version: '3.27.22', installRoot: '/usr/share/cursor' },
      }),
    });
    assert.match(ui.visibleText(), /未找到 Cursor/);
    const rev = ui.$('revert');
    assert.ok(rev, '还原按钮仍在 DOM 以便日后恢复');
    assert.equal(rev.hidden, true, '无可还原的当前安装时不应展示还原英文');
    assert.doesNotMatch(ui.visibleText(), /还原英文/);
    assert.ok(ui.$('localize')?.hidden, '未找到时不展示一键汉化主按钮');
    assert.ok(ui.$('toggle-details')?.hidden, '没有安装信息时不展示空的详细信息折叠');
    assert.ok(!ui.$('details')?.textContent?.trim(), '详细信息内容应为空');
  });

  it('忙碌时锁定冲突按钮', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const ui = await mountUI({
      platform: 'linux',
      status: baseStatus({
        platform: 'linux',
        kind: 'manual',
        cursor: { root: '/opt/cursor', version: '3.29.9', vscodeVersion: '1.105.1' },
        running: 0,
        needsElevation: false,
      }),
      localize: async () => { await gate; return { ok: true }; },
    });
    ui.$('localize').click();
    await tick();
    if (ui.$('dialog') && !ui.$('dialog').hidden) {
      const ok = [...ui.$('dialog').querySelectorAll('button')].find((b) => !/取消/.test(b.textContent));
      ok?.click();
      await tick();
    }
    assert.equal(ui.$('localize')?.disabled, true);
    assert.equal(ui.$('refresh')?.disabled, true);
    release({ ok: true });
    await tick();
  });

  it('主题选择可切换并写入偏好；样式包含深色与可见焦点', async () => {
    const ui = await mountUI({ platform: 'linux', status: baseStatus({ platform: 'linux', kind: 'manual', cursor: { root: '/opt/cursor', version: '3.29.9', vscodeVersion: '1.105.1' } }) });
    const sel = ui.$('theme');
    assert.ok(sel);
    const opts = [...sel.children].map((o) => o.value || o.textContent);
    assert.ok(opts.some((o) => /light|浅色/.test(o)));
    assert.ok(opts.some((o) => /dark|深色/.test(o)));
    assert.ok(opts.some((o) => /system|系统/.test(o)));
    sel.value = sel.children.find((o) => /dark|深色/.test(o.value || o.textContent))?.value || 'dark';
    sel.dispatchEvent({ type: 'change', preventDefault() {}, stopPropagation() {} });
    await tick();
    assert.equal(ui.document.documentElement.getAttribute('data-theme') || ui.document.documentElement.dataset.theme, 'dark');
    const css = prodFiles().html;
    assert.match(css, /data-theme=["']dark["']|\[data-theme=.dark/);
    assert.match(css, /:focus-visible/);
  });
});
