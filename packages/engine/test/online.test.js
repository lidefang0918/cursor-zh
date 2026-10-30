import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { syncData, buildManifest, usable, MANIFEST, DICT_FILES, SOURCES } from '../src/online.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));

// 一份“仓库”：词典 + 某版本锚点 + manifest
function remote({ updated = '2030-01-01T00:00:00.000Z', dict = '{"New Agent":"新建智能体"}', schema = 1, minTool = '0.0.1' } = {}) {
  const files = { 'dicts/zh-cn.json': dict, 'dicts/zh-cn.nls.json': '{}', 'dicts/zh-cn.patterns.json': '[]', 'anchors/9.0.0.json': '{"version":"9.0.0","files":[]}' };
  const manifest = JSON.stringify({ schema, minTool, updated, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])) });
  return { ...files, [MANIFEST]: manifest };
}
// 假 fetch：hosts = { 'https://a/': 仓库 | null(断网) }
const fakeFetch = (hosts, seen = []) => async (url) => {
  seen.push(url);
  const host = Object.keys(hosts).find((h) => url.startsWith(h));
  const files = host && hosts[host];
  if (!files) throw new TypeError('fetch failed');
  const body = files[url.slice(host.length)];
  return body === undefined ? { ok: false, status: 404 } : { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
};
const sources = [['GitHub', 'https://a/'], ['jsDelivr', 'https://b/']];
async function ctx() {
  const bundledDir = await tmp('bundled-');
  await fs.mkdir(path.join(bundledDir, 'dicts'));
  await fs.writeFile(path.join(bundledDir, MANIFEST), JSON.stringify({ schema: 1, updated: '2026-01-01T00:00:00.000Z', files: {} }));
  return { bundledDir, cacheDir: path.join(await tmp('data-'), 'online'), toolVersion: '0.2.0', version: '9.0.0', platform: 'linux', sources };
}

describe('online dictionaries', () => {
  it('fetches from GitHub, verifies sha256, caches dicts and the anchors for this Cursor version', async () => {
    const c = await ctx();
    const d = await syncData({ ...c, fetchImpl: fakeFetch({ 'https://a/': remote() }) });
    assert.deepEqual([d.source, d.dir, d.updated], ['GitHub', c.cacheDir, '2030-01-01T00:00:00.000Z']);
    assert.equal(await fs.readFile(path.join(c.cacheDir, 'dicts/zh-cn.json'), 'utf8'), '{"New Agent":"新建智能体"}');
    assert.ok(await fs.stat(path.join(c.cacheDir, 'anchors/9.0.0.json')));
    // 第二次：文件没变就只取 manifest
    const seen = [];
    assert.equal((await syncData({ ...c, fetchImpl: fakeFetch({ 'https://a/': remote() }, seen) })).source, 'GitHub');
    assert.deepEqual(seen, ['https://a/dicts/manifest.json']);
  });

  it('falls back to jsDelivr when GitHub is unreachable, and when GitHub serves a file that fails the hash', async () => {
    const c = await ctx();
    assert.equal((await syncData({ ...c, fetchImpl: fakeFetch({ 'https://a/': null, 'https://b/': remote() }) })).source, 'jsDelivr');
    const v2 = remote({ updated: '2031-01-01T00:00:00.000Z', dict: '{"New Agent":"新建智能体 v2"}' });
    const bad = { ...v2, 'dicts/zh-cn.json': '{"tampered":1}' };
    const logs = [];
    const d = await syncData({ ...c, log: (m) => logs.push(m), fetchImpl: fakeFetch({ 'https://a/': bad, 'https://b/': v2 }) });
    assert.equal(d.source, 'jsDelivr');
    assert.match(await fs.readFile(path.join(c.cacheDir, 'dicts/zh-cn.json'), 'utf8'), /v2/);
    assert.match(logs.join(), /校验不符/);
  });

  it('offline: uses the last good cache, else the bundled copy; never loads an incompatible format', async () => {
    const c = await ctx();
    const off = fakeFetch({});
    assert.deepEqual(await syncData({ ...c, fetchImpl: off }), { dir: c.bundledDir, source: '内置', updated: '2026-01-01T00:00:00.000Z' });
    await syncData({ ...c, fetchImpl: fakeFetch({ 'https://a/': remote() }) });
    assert.equal((await syncData({ ...c, fetchImpl: off })).source, '缓存');
    assert.equal((await syncData({ ...c, network: false })).source, '缓存');
    // 缓存被改坏 → 内置
    await fs.writeFile(path.join(c.cacheDir, 'dicts/zh-cn.json'), '{}');
    assert.equal((await syncData({ ...c, fetchImpl: off })).source, '内置');
    // 新格式 / 需要新版工具的词典不用
    const c2 = await ctx();
    assert.equal((await syncData({ ...c2, fetchImpl: fakeFetch({ 'https://a/': remote({ schema: 2 }), 'https://b/': remote({ minTool: '9.0.0' }) }) })).source, '内置');
    // 比安装包自带的旧（工具已升级）→ 用自带
    assert.equal((await syncData({ ...c2, fetchImpl: fakeFetch({ 'https://a/': remote({ updated: '2020-01-01T00:00:00.000Z' }) }) })).source, '内置');
  });

  it('uses GitHub raw first and jsDelivr second for this repo', () => {
    assert.deepEqual(SOURCES.map(([, u]) => new URL(u).host), ['raw.githubusercontent.com', 'cdn.jsdelivr.net']);
    assert.equal(usable({ schema: 1, minTool: '0.2.0', files: Object.fromEntries(DICT_FILES.map((f) => [f, 'x'])) }, '0.10.0'), true);
  });

  it('dicts/manifest.json is up to date (run node scripts/build-manifest.mjs after editing dicts/anchors)', async () => {
    const m = JSON.parse(await fs.readFile(path.join(repo, MANIFEST), 'utf8'));
    const fresh = await buildManifest(repo);
    assert.deepEqual(m.files, fresh.files);
    assert.equal(fresh.updated, m.updated);
    const tool = JSON.parse(await fs.readFile(path.join(repo, 'packages/engine/package.json'), 'utf8')).version;
    assert.equal(usable(m, tool), true, 'this tool can read its own manifest');
  });
});
