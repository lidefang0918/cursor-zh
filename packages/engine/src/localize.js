import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectCursor, detectAllCursors, installKind } from './detect.js';
import { applyFiles, checkWritable, filesMatch, elevationInfo } from './elevate.js';
import { listCursorProcesses, closeCursor, relaunchCursor } from './process.js';
import { findAppImages, listExtracted } from './appimage.js';
import { loadAnchors, loadDict, loadPatterns, supportedVersions as listVersions } from './anchors.js';
import { createBackup, sha256File, exists } from './backup.js';
import { dropBackup } from './restore.js';
import { applyPatch, filesToBackup, updateChecksums } from './patch.js';
import { injectDomRuntime, BEGIN as DOM_BEGIN } from './inject.js';
import { applyNls, clearNlsCache } from './nls.js';
import {
  ensureLanguagePack, uninstallLanguagePack, registerLanguagePack, unregisterLanguagePack, setLocale, findConflicts, downloadLangpack, langpackVersionFor,
} from './langpack.js';
import { readState, writeState } from './state.js';
import * as win from './platform/win.js';
import * as mac from './platform/mac.js';

export { readState };
// fileURLToPath：Windows 上 URL.pathname 是 /C:/...，路径里有空格/中文时还是 %20 编码，都不能直接当路径用
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// 用户目录（Cursor 3.x：product.dataFolderName = .cursor，三平台扩展目录都在 ~/.cursor）
// Linux：~/.config/Cursor；Windows：%APPDATA%\Cursor；macOS：~/Library/Application Support/Cursor
export function defaultPaths(home = os.homedir(), platform = process.platform, env = process.env) {
  const plat = platform === 'win32' ? win.winDefaultPaths(env, home) : platform === 'darwin' ? mac.macDefaultPaths(home) : {
    userDataDir: path.join(home, '.config/Cursor'),
    extensionsDir: path.join(home, '.cursor/extensions'),
    argvPath: path.join(home, '.cursor/argv.json'),
    dataDir: path.join(home, '.config/cursor-zh-localizer'),
  };
  return {
    ...plat,
    anchorsDir: path.join(REPO, 'anchors'),
    dictPath: path.join(REPO, 'dicts/zh-cn.json'),
    patternsPath: path.join(REPO, 'dicts/zh-cn.patterns.json'),
  };
}

export function cliFor(platform, root) {
  if (platform === 'win32') return win.winCli(root);
  if (platform === 'darwin') return mac.macCli(root);
  return path.join(root, 'bin', 'cursor');
}

async function resolve(opts) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const o = { platform, env, ...defaultPaths(os.homedir(), platform, env), onLog: () => {}, macSign: 'adhoc', ...opts };
  if (!mac.SIGN_MODES.includes(o.macSign)) throw new Error(`macSign 只能是 ${mac.SIGN_MODES.join(' / ')}`);
  const runner = o.platformRunner;
  const info = await detectCursor({ platform: o.platform, env: o.env, extraRoots: o.installRoot ? [o.installRoot] : [], defaults: !o.installRoot, runner });
  if (info) {
    o.installRoot ??= info.root;
    o.cliPath ??= cliFor(o.platform, info.root);
  }
  // 兼容旧选项 isCursorRunning（测试用）；默认读 /proc
  if (!o.listRunning) {
    o.listRunning = o.isCursorRunning
      ? async () => ((await o.isCursorRunning()) ? [{ pid: -1, main: true, argv: [] }] : [])
      : async () => (o.installRoot ? listCursorProcesses(o.installRoot, { platform: o.platform, runner }) : []);
  }
  o.closeCursor ??= (log) => closeCursor(o.installRoot, { log, platform: o.platform, runner });
  o.relaunchCursor ??= (r) => relaunchCursor(r, { logFile: path.join(o.dataDir, 'cursor-relaunch.log') });
  return { o, info };
}

// 安装目录里的文件是否真的带着我们的补丁（DOM 运行时标记）。
// state.json 和备份在用户目录，安装目录可能被重装/更新/清掉（box 重启就会），两者会对不上。
const domRelatives = (anchors, state) =>
  anchors ? (anchors.dom?.relatives ?? [anchors.files[0].relative]) : Object.keys(state?.perFile ?? {});

export async function installPatched(installRoot, relatives) {
  for (const r of relatives) {
    try { if ((await fs.readFile(path.join(installRoot, r), 'latin1')).includes(DOM_BEGIN)) return true; } catch {}
  }
  return false;
}

// 记录说“已汉化”，但安装文件是原版（重装/更新/被清掉）→ 过期记录。
// 只看安装文件里有没有我们的标记：版本号/路径对不上不算过期（macOS 上关闭 Cursor 时 Squirrel 可能刚好装完自动更新，
// 记录里的版本号就会和 product.json 不一致，但文件仍是我们打的补丁，必须按备份还原，而不是丢掉记录）。
const markerRelatives = (anchors, state) => [...new Set([...domRelatives(anchors, state), ...Object.keys(state?.perFile ?? {})])];
async function isStale(o, info, anchors, state) {
  if (!state.localized) return false;
  const root = state.installRoot ?? info?.root;
  if (!root) return true;
  return !(await installPatched(root, markerRelatives(anchors, state)));
}

// 备份可用 = manifest 里每个文件都在、sha256 对得上
async function verifyBackup(backupDir) {
  let items;
  try { items = await backupItems(backupDir); } catch (e) { return { ok: false, error: `读不到备份清单：${e.message}` }; }
  for (const i of items) {
    const sha = await sha256File(i.src).catch(() => null);
    if (sha !== i.sha256) return { ok: false, error: `备份文件损坏或缺失：${i.relative}` };
  }
  return { ok: true, items };
}

// 找可用于恢复的备份：显式 --from-backup，否则 backups/ 下最新的、属于这个安装根的 *.stale-*
async function findRecoveryBackup(o, installRoot) {
  if (o.fromBackup) return o.fromBackup;
  const dir = path.join(o.dataDir, 'backups');
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => n.includes('.stale-')).sort().reverse();
  for (const n of names) {
    try {
      const m = JSON.parse(await fs.readFile(path.join(dir, n, 'manifest.json'), 'utf8'));
      if (!m.installRoot || m.installRoot === installRoot) return path.join(dir, n);
    } catch {}
  }
  return null;
}

// 丢弃过期记录：旧备份对应的是已不存在的安装，挪到 backups/<ver>.stale-<时间> 留档，绝不拿它覆盖新安装
async function retireStale(o, state, log) {
  let movedTo = null;
  if (state.backupDir) {
    try {
      await fs.access(state.backupDir);
      movedTo = `${state.backupDir}.stale-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.rename(state.backupDir, movedTo);
    } catch { movedTo = null; }
  }
  await writeState(o.dataDir, {
    localized: false, staleRetiredAt: new Date().toISOString(),
    // 语言包/locale 仍是上次汉化留下的，记住原始值，之后还原时才能真正恢复
    carry: { installedLangpack: !!state.installedLangpack, prevLocale: state.prevLocale ?? null },
  });
  log(`⚠ 汉化记录已过期（安装文件是原版，可能被重装/更新），已丢弃旧记录${movedTo ? `，旧备份移到 ${movedTo}` : ''}`);
  return movedTo;
}

const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

const supportedVersions = (o) => listVersions({ platform: o.platform, anchorsDir: o.anchorsDir });

// 另一个安装（比如系统 deb）还处于汉化状态时，不能对当前选中的安装动手（state.json 只记录一份）
async function otherInstall(state, info) {
  if (!state.localized || !state.installRoot || !info || state.installRoot === info.root) return null;
  return (await installPatched(state.installRoot, Object.keys(state.perFile ?? {}))) ? state.installRoot : null;
}

const targetFiles = (anchors) => [...new Set([...filesToBackup(anchors), ...(anchors.dom?.relatives ?? [])])];

async function backupItems(backupDir) {
  const m = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  return m.files.map(({ relative, sha256 }) => ({ relative, sha256, src: path.join(backupDir, 'files', relative) }));
}
const shaMap = (items) => Object.fromEntries(items.map((i) => [i.relative, i.sha256]));

// 运行中的 Cursor：没同意关闭就返回 CURSOR_RUNNING；同意了就优雅关闭，fn 结束后按原命令行重新打开
// 运行中的 Cursor：没同意关闭就返回 CURSOR_RUNNING；同意了就优雅关闭，fn 结束后按原命令行重新打开。
// 等管理员命令（NEED_ELEVATION）时 Cursor 保持关闭，命令行记在 relaunch.json，用户点“继续”完成后再打开。
async function withCursorClosed(o, fn) {
  const relaunchFile = path.join(o.dataDir, 'relaunch.json');
  const running = await o.listRunning();
  let relaunch = null;
  if (running.length) {
    if (!o.closeRunning) return fail('CURSOR_RUNNING', 'Cursor 正在运行。汉化/还原需要重启 Cursor 才能生效，请允许本工具关闭 Cursor（完成后自动重新打开）', { processes: running.filter((p) => p.main).length || running.length });
    const c = await o.closeCursor(o.onLog);
    if (!c.ok) return fail('CLOSE_FAILED', c.error);
    relaunch = c.relaunch;
    o.onLog('Cursor 已关闭');
  } else {
    try { relaunch = JSON.parse(await fs.readFile(relaunchFile, 'utf8')); } catch {}
  }
  const r = await fn();
  if (r.code === 'NEED_ELEVATION') {
    if (relaunch) {
      await fs.mkdir(o.dataDir, { recursive: true });
      await fs.writeFile(relaunchFile, JSON.stringify(relaunch));
      r.cursorLeftClosed = true;
    }
    return r;
  }
  await fs.rm(relaunchFile, { force: true });
  if (relaunch && o.relaunch !== false) {
    try { o.relaunchCursor(relaunch); r.relaunched = true; o.onLog(r.ok ? '已重新打开 Cursor' : '已重新打开 Cursor（未做改动）'); }
    catch (e) { o.onLog(`⚠ 重新打开 Cursor 失败：${e.message}，请手动打开`); }
  }
  return r;
}

const elevationOpts = (o, actions = []) => ({ workDir: path.join(o.dataDir, 'elevate'), log: o.onLog, strategies: o.elevateStrategies, assumeUnwritable: o.assumeUnwritable, runner: o.elevateRunner, platform: o.platform, actions, probe: o.probeWritable });
const METHOD = { direct: '直接写入', pkexec: 'pkexec 管理员授权', 'sudo-n': '免密 sudo', manual: '管理员命令', uac: 'UAC 管理员授权', osascript: 'macOS 管理员授权' };

// macOS 重签名要备份的签名文件（还原时写回 → 原 Developer ID 签名恢复有效）
const signFiles = (o) => (o.platform === 'darwin' && o.macSign !== 'none' ? mac.MAC_SIGN_FILES : []);
const runnerOf = (o) => o.platformRunner ?? undefined;

export async function status(opts = {}) {
  const { o, info } = await resolve(opts);
  const state = await readState(o.dataDir);
  const anchors = info ? await loadAnchors({ platform: o.platform, version: info.version, anchorsDir: o.anchorsDir }) : null;
  const patched = info ? await installPatched(info.root, domRelatives(anchors, state)) : false;
  const stale = await isStale(o, info, anchors, state);
  const base = { cursor: info, supported: !!anchors, supportedVersions: await supportedVersions(o), state, patched, stale, localized: !!state.localized && !stale };
  if (opts.light) return base;
  const files = anchors ? [...targetFiles(anchors), ...signFiles(o)] : [];
  const w = info && files.length ? await checkWritable(info.root, files, { platform: o.platform, probe: o.probeWritable }) : null;
  const pending = state.pending && info && state.pending.installRoot === info.root ? state.pending : null;
  const linux = o.platform === 'linux';
  return {
    ...base,
    platform: o.platform,
    kind: info ? await installKind(info.root, { platform: o.platform, env: o.env }) : null,
    writable: w ? w.writable : null,
    readOnlyFs: w ? w.readOnlyFs : null,
    needsElevation: !!w && !w.writable && !w.readOnlyFs && !w.appManagement && !w.translocated,
    ...(o.platform === 'darwin' ? { mac: { translocated: !!w?.translocated, appManagement: !!w?.appManagement, signMode: o.macSign } } : {}),
    elevation: await elevationInfo(process.env, o.platform),
    running: info ? (await o.listRunning()).length : 0,
    installs: await detectAllCursors({ platform: o.platform, env: o.env, runner: runnerOf(o) }),
    appImages: linux ? await findAppImages() : [],
    extracted: linux ? await listExtracted() : [],
    otherInstall: await otherInstall(state, info),
    pending: pending ? { kind: pending.kind, command: pending.command, at: pending.at, applied: await filesMatch(info.root, pending.staged) } : null,
  };
}

export async function localize(opts = {}) {
  const { o, info } = await resolve(opts);
  const log = o.onLog;
  if (!info) return fail('NOT_FOUND', '未找到 Cursor 安装');
  log(`检测到 Cursor ${info.version}（VS Code ${info.vscodeVersion}）：${info.root}`);

  const anchors = await loadAnchors({ platform: o.platform, version: info.version, anchorsDir: o.anchorsDir });
  let state = await readState(o.dataDir);
  const other = await otherInstall(state, info);
  if (other) return fail('OTHER_INSTALL', `另一个 Cursor 安装（${other}）处于汉化状态，请先还原它`);
  if (state.localized) {
    if (!(await isStale(o, info, anchors, state))) return fail('ALREADY', '已汉化，如需重做请先还原');
    await retireStale(o, state, log);
    state = await readState(o.dataDir);
  }
  if (!anchors) {
    const sv = await supportedVersions(o);
    return fail('UNSUPPORTED', `Cursor ${info.version} 暂未适配（目前支持：${sv.join('、') || '无'}），为避免损坏安装，已拒绝修改`, { supportedVersions: sv });
  }
  const files = targetFiles(anchors);
  const backupFiles = [...files, ...signFiles(o)];
  const w = await checkWritable(o.installRoot, backupFiles, { platform: o.platform, probe: o.probeWritable });
  if (w.translocated) return fail('MAC_TRANSLOCATED', mac.TRANSLOCATED_HINT);
  if (w.appManagement) return fail('MAC_APP_MANAGEMENT', mac.APP_MANAGEMENT_HINT, { settingsUrl: mac.APP_MANAGEMENT_SETTINGS_URL });
  if (o.platform === 'darwin' && o.macSign === 'adhoc-deep' && !w.writable) return fail('NEED_DIRECT_WRITE', 'adhoc-deep 重签名需要当前用户能直接修改 Cursor.app；请改用默认的 adhoc 模式，或先把 Cursor.app 改为当前用户所有');
  if (w.readOnlyFs) return fail('READ_ONLY_FS', `Cursor 安装在只读文件系统上（${w.mount?.fstype}：${w.mount?.mountpoint}），无法直接修改。AppImage 版请使用“解包后汉化”`);

  const pending = state.pending?.kind === 'localize' && state.pending.installRoot === o.installRoot && state.pending.version === info.version ? state.pending : null;
  if (!pending && (await installPatched(o.installRoot, domRelatives(anchors)))) {
    return fail('PATCHED_NO_STATE', '安装文件已带汉化补丁但没有汉化记录，请重装 Cursor 后再汉化');
  }

  if (!pending && anchors.pristine) {
    const changed = [];
    for (const [rel, sha] of Object.entries(anchors.pristine)) {
      if ((await sha256File(path.join(o.installRoot, rel)).catch(() => null)) !== sha) changed.push(rel.split('/').pop());
    }
    if (changed.length) return fail('MODIFIED_INSTALL', `安装文件与 Cursor ${info.version} 官方原版不一致（${changed.join('、')}），可能被其他汉化/美化工具改过。为避免把改过的文件当原版备份，已拒绝修改；请重装 Cursor 后再试`, { changed });
  }

  return withCursorClosed(o, async () => {
    if (pending && (await filesMatch(o.installRoot, pending.staged))) {
      log('检测到补丁文件已写入安装目录（管理员命令已执行），继续完成剩余步骤');
      return finishLocalize(o, info, state, pending.backupDir, pending.result, pending.carry, 'manual');
    }
    const conflicts = await findConflicts(o.extensionsDir);
    if (conflicts.length) log(`⚠ 检测到可能冲突的汉化扩展：${conflicts.join(', ')}，建议先禁用`);

    const dict = await loadDict(o.dictPath);
    const patterns = await loadPatterns(o.patternsPath);
    // 先把需要联网的语言包下好：失败的话什么都还没改
    o.vsixPath ??= await downloadLangpack({ version: langpackVersionFor(info.vscodeVersion), cacheDir: path.join(o.dataDir, 'cache'), vendorDir: path.join(REPO, 'vendor') });

    const backupDir = path.join(o.dataDir, 'backups', info.version);
    if (pending && (await exists(path.join(backupDir, 'manifest.json'))) && (await filesMatch(o.installRoot, shaMap(await backupItems(backupDir))))) {
      log(`沿用上次的备份：${backupDir}`);
    } else {
      if (pending) await dropBackup({ backupDir });
      await createBackup({ installRoot: o.installRoot, files: backupFiles, backupDir });
      log(`已备份 ${backupFiles.length} 个文件 → ${backupDir}`);
      // 关闭 Cursor 时 macOS 可能正好装上自动更新：备份到的就不是刚才检查过的版本了 → 放弃，让用户重跑
      const changed = await backupChanged(backupDir, anchors, info);
      if (changed) {
        await dropBackup({ backupDir });
        log(`✖ ${changed}`);
        return fail('INSTALL_CHANGED', `${changed}。可能是 Cursor 关闭时装上了自动更新，安装目录未改动，请重新运行汉化`);
      }
      if (o.platform === 'darwin' && o.macSign === 'adhoc-deep') {
        await mac.cloneBundle(mac.appPathOf(o.installRoot), path.join(backupDir, 'bundle', 'Cursor.app'), { runner: runnerOf(o) });
        log('已克隆整个 Cursor.app（adhoc-deep 还原用）');
      }
    }

    // 在用户目录的暂存区里算好补丁（普通权限），安装目录此时还没动
    const staging = path.join(o.dataDir, 'staging', info.version);
    await fs.rm(staging, { recursive: true, force: true });
    for (const f of files) {
      await fs.mkdir(path.dirname(path.join(staging, f)), { recursive: true });
      await fs.copyFile(path.join(backupDir, 'files', f), path.join(staging, f));
    }
    let result;
    try {
      result = await patchTree({ root: staging, anchors, dict, patterns, log });
    } catch (e) {
      log(`✖ 失败：${e.message}（安装目录未改动）`);
      await fs.rm(staging, { recursive: true, force: true });
      await dropBackup({ backupDir });
      return fail('PATCH_FAILED', e.message, { restored: true });
    }

    const items = [];
    for (const f of files) items.push({ relative: f, src: path.join(staging, f), sha256: await sha256File(path.join(staging, f)) });
    const a = await applyFiles({ installRoot: o.installRoot, items, ...elevationOpts(o, o.platform === 'darwin' ? mac.postWriteActions(o.macSign) : []) });
    if (!a.ok) {
      if (a.code === 'NEED_ELEVATION') {
        await writeState(o.dataDir, {
          localized: false, carry: state.carry,
          pending: { kind: 'localize', installRoot: o.installRoot, version: info.version, backupDir, staged: shaMap(items), result, carry: state.carry, command: a.command, at: new Date().toISOString() },
        });
        log(`需要管理员权限：${a.tried.map((t) => `${t.via}：${t.reason}`).join('；') || '已跳过自动提权'}`);
        return { ...a, restored: true };
      }
      log(`✖ ${a.error}`);
      await dropBackup({ backupDir });
      return { ...a, restored: true };
    }
    log(`已写入安装目录（${METHOD[a.method] ?? a.method}）`);
    return finishLocalize(o, info, state, backupDir, result, state.carry, a.method);
  });
}

async function backupChanged(backupDir, anchors, info) {
  const m = shaMap(await backupItems(backupDir));
  for (const [rel, sha] of Object.entries(anchors.pristine ?? {})) if (m[rel] && m[rel] !== sha) return `备份时 ${rel.split('/').pop()} 已不是 Cursor ${info.version} 原版`;
  if (anchors.productJson) {
    try {
      const v = JSON.parse(await fs.readFile(path.join(backupDir, 'files', anchors.productJson), 'utf8')).version;
      if (v && String(v) !== info.version) return `备份时版本已变为 ${v}（检测时为 ${info.version}）`;
    } catch {}
  }
  return null;
}

// macOS 写入后：直接写入时由引擎重签名、去隔离属性；经管理员授权时 helper 已做过，这里只校验
async function macAfterWrite(o, method) {
  const app = mac.appPathOf(o.installRoot);
  if (!app) return;
  const runner = runnerOf(o);
  if (method === 'direct') {
    if (o.macSign === 'adhoc' || o.macSign === 'adhoc-deep') {
      await mac.signAdhoc(app, { deep: o.macSign === 'adhoc-deep', runner });
      o.onLog(`已对 Cursor.app 做 ad-hoc 重签名（${o.macSign === 'adhoc-deep' ? '含内嵌代码 --deep' : '外层'}）`);
    }
    await mac.removeQuarantine(app, { runner });
  } else if (o.macSign !== 'none') {
    const v = await mac.verifySignature(app, { runner });
    if (!v.ok) throw new Error(`签名校验失败：${v.detail}`);
  }
  if (o.macSign !== 'none') o.onLog('提示：重签名后首次启动 Cursor 时，macOS 可能询问是否允许访问钥匙串“Cursor Safe Storage”，请选“始终允许”；Cursor 自动更新可能失败，更新前请先还原');
}

// 把安装恢复成备份里的原版。macOS adhoc：备份里含原始签名文件，一并写回；adhoc-deep：用整包克隆换回
async function restoreInstall(o, installRoot, backupDir, macSign) {
  if (o.platform === 'darwin' && macSign === 'adhoc-deep') {
    const clone = path.join(backupDir, 'bundle', 'Cursor.app');
    if (await exists(clone)) {
      await mac.restoreBundle(mac.appPathOf(installRoot), clone, { runner: runnerOf(o) });
      return { ok: true, method: 'direct' };
    }
  }
  const a = await applyFiles({ installRoot, items: await backupItems(backupDir), ...elevationOpts(o) });
  if (a.ok && o.platform === 'darwin' && mac.appPathOf(installRoot)) {
    const v = await mac.verifySignature(mac.appPathOf(installRoot), { runner: runnerOf(o) });
    o.onLog(v.ok ? '已恢复 Cursor 原始签名（codesign 校验通过）' : `⚠ 恢复后签名校验未通过：${v.detail}`);
  }
  return a;
}

// 在一棵目录树（暂存区或测试用假安装根）上完成全部补丁：静态替换 + NLS + DOM 补漏注入 + product.json 校验值
export async function patchTree({ root, anchors, dict, patterns = [], log = () => {} }) {
  const p = await applyPatch({ installRoot: root, anchors, dict });
  log(`静态补丁：替换 ${p.replaced} 处，模板片段 ${p.fragmentsReplaced} 处；未命中 ${p.missing.length} 条`);
  const n = await applyNls({ installRoot: root, anchors, dict });
  if (anchors.nls) log(`NLS 文案：替换 ${n.replaced} 条；未命中 ${n.missing.length} 条`);
  const domTargets = anchors.dom?.relatives ?? [anchors.files[0].relative];
  for (const relative of domTargets) await injectDomRuntime({ installRoot: root, relative, dict, patterns });
  const { checksumsUpdated } = await updateChecksums({ installRoot: root, anchors, relatives: [...new Set([...p.patched, ...domTargets])] });
  log(`DOM 补漏已注入；已更新校验：${checksumsUpdated.join(', ') || '无'}`);
  return { replaced: p.replaced, perFile: p.perFile, fragmentsReplaced: p.fragmentsReplaced, perFileFragments: p.perFileFragments, missing: p.missing, nlsReplaced: n.replaced, nlsMissing: n.missing, checksumsUpdated };
}

// 安装文件已就位：装语言包、设 locale、清译文缓存、写记录；失败则把安装文件也换回原版
async function finishLocalize(o, info, state, backupDir, result, carry, method) {
  const log = o.onLog;
  const undo = { langpack: false, prevLocale: undefined };
  try {
    if (o.platform === 'darwin') await macAfterWrite(o, method);
    if (!o.vsixPath) o.vsixPath = await downloadLangpack({ version: langpackVersionFor(info.vscodeVersion), cacheDir: path.join(o.dataDir, 'cache'), vendorDir: path.join(REPO, 'vendor') });
    const lp = await ensureLanguagePack({ cliPath: o.cliPath, extensionsDir: o.extensionsDir, userDataDir: o.userDataDir, vsixPath: o.vsixPath });
    undo.langpack = lp.installed;
    log(lp.installed ? `已安装语言包：${lp.extensionPath}` : `语言包已存在：${lp.extensionPath}`);
    // 登记失败不致命：Cursor 启动后会自己重建清单，只是要多重启一次
    try {
      const reg = await registerLanguagePack({ userDataDir: o.userDataDir, extensionPath: lp.extensionPath });
      log(`已登记语言包（首次重启即生效）：${reg.file}`);
    } catch (e) { log(`⚠ 登记语言包失败（需多重启一次 Cursor 才生效）：${e.message}`); }
    undo.prevLocale = await setLocale({ argvPath: o.argvPath, locale: 'zh-cn' });
    log(`已设置 locale=zh-cn：${o.argvPath}`);
    if (info.commit) {
      const cleared = await clearNlsCache({ userDataDir: o.userDataDir, commit: info.commit });
      if (cleared.length) log(`已清理译文缓存 ${cleared.length} 处`);
    }
    await writeState(o.dataDir, {
      localized: true, version: info.version, installRoot: o.installRoot, backupDir, at: new Date().toISOString(), method,
      installedLangpack: undo.langpack || !!carry?.installedLangpack,
      ...(o.platform === 'darwin' ? { macSign: o.macSign } : {}),
      prevLocale: carry && undo.prevLocale === 'zh-cn' ? carry.prevLocale : undo.prevLocale,
      ...result, commit: info.commit,
    });
    await fs.rm(path.join(o.dataDir, 'staging', info.version), { recursive: true, force: true });
    log('完成，重启 Cursor 后生效');
    return { ok: true, method, ...result };
  } catch (e) {
    log(`✖ 失败：${e.message}，正在回滚`);
    let restored = true;
    const back = await restoreInstall(o, o.installRoot, backupDir, o.macSign).catch((x) => ({ ok: false, error: x.message }));
    if (back.ok) await dropBackup({ backupDir }); else restored = false;
    try { if (undo.prevLocale !== undefined) await setLocale({ argvPath: o.argvPath, locale: undo.prevLocale }); } catch { restored = false; }
    try { if (undo.langpack) { await uninstallLanguagePack(o); await unregisterLanguagePack(o); } } catch { restored = false; }
    await writeState(o.dataDir, { localized: false, carry: state.carry });
    log(restored ? '已回滚' : `⚠ 回滚不完整${back.command ? `，请执行：${back.command}` : ''}`);
    return fail('FINISH_FAILED', e.message, { restored, command: back.command });
  }
}

export async function revert(opts = {}) {
  const { o, info } = await resolve(opts);
  const log = o.onLog;
  const state = await readState(o.dataDir);
  if (state.pending && !state.localized) {
    // 汉化做到一半（等管理员命令）：若补丁已被写入就按备份还原，否则直接丢弃暂存
    const p = state.pending;
    if (!(await filesMatch(p.installRoot, p.staged))) {
      await fs.rm(path.join(o.dataDir, 'staging', p.version), { recursive: true, force: true });
      await dropBackup({ backupDir: p.backupDir });
      await writeState(o.dataDir, { localized: false, carry: state.carry });
      log('已取消未完成的汉化（安装文件未改动）');
      return { ok: true, cancelledPending: true };
    }
  }
  const anchors = info ? await loadAnchors({ platform: o.platform, version: info.version, anchorsDir: o.anchorsDir }) : null;
  if (!state.localized && !state.pending) {
    // 记录已丢（旧版误判“过期”），但安装文件仍带补丁 → 用 .stale-* / --from-backup 里的原版恢复
    if (info && (o.fromBackup || (await installPatched(info.root, markerRelatives(anchors, state))))) return recoverFromBackup(o, info, anchors, state);
    return fail('NOT_LOCALIZED', '当前未处于汉化状态');
  }
  const stale = state.localized ? await isStale(o, info, anchors, state) : false;
  if (stale && !o.fromBackup) {
    // 安装已是原版：不能拿旧备份覆盖（可能是别的版本），只清理语言包/locale
    await retireStale(o, state, log);
    return cleanupUser(o, state, { stale: true });
  }
  const installRoot = state.installRoot ?? state.pending?.installRoot;
  const backupDir = o.fromBackup ?? state.backupDir ?? state.pending?.backupDir;
  const vb = await verifyBackup(backupDir);
  if (!vb.ok) return fail('BACKUP_INVALID', `${vb.error}（${backupDir}）。安装文件仍带汉化补丁，未做任何改动；请重装 Cursor`);
  return withCursorClosed(o, async () => {
    const items = vb.items;
    if (await filesMatch(installRoot, shaMap(items))) {
      log('安装文件已是原版（管理员命令已执行），继续清理');
    } else {
      const a = await restoreInstall(o, installRoot, backupDir, state.macSign ?? (o.platform === 'darwin' ? 'adhoc' : undefined));
      if (!a.ok) {
        if (a.code === 'NEED_ELEVATION') log(`需要管理员权限：${a.tried.map((t) => `${t.via}：${t.reason}`).join('；') || '已跳过自动提权'}`);
        else log(`✖ 还原失败：${a.error}`);
        return a;
      }
      log(`已按备份还原安装文件（${METHOD[a.method] ?? a.method}，sha256 校验通过）`);
    }
    return cleanupUser(o, state, { backupDir });
  });
}

// 安装文件带补丁、却没有有效记录：备份逐个校验 sha256 后写回（含 macOS 签名文件），再清理语言包/locale
async function recoverFromBackup(o, info, anchors, state) {
  const log = o.onLog;
  const backupDir = await findRecoveryBackup(o, info.root);
  if (!backupDir) return fail('NO_BACKUP', '安装文件带汉化补丁，但找不到可用的备份；请重装 Cursor（或用 --from-backup=<备份目录> 指定）');
  const vb = await verifyBackup(backupDir);
  if (!vb.ok) return fail('BACKUP_INVALID', `${vb.error}（${backupDir}）。未做任何改动`);
  // 备份必须是当前版本的原版，避免拿别的版本的文件覆盖
  for (const [rel, sha] of Object.entries(anchors?.pristine ?? {})) {
    const b = vb.items.find((i) => i.relative === rel);
    if (b && b.sha256 !== sha) return fail('BACKUP_MISMATCH', `备份里的 ${rel.split('/').pop()} 不是 Cursor ${info.version} 原版（${backupDir}），未做任何改动`);
  }
  log(`安装文件仍带汉化补丁，按备份恢复：${backupDir}（${vb.items.length} 个文件 sha256 校验通过）`);
  return withCursorClosed(o, async () => {
    const a = await restoreInstall(o, info.root, backupDir, o.platform === 'darwin' ? (o.macSign === 'adhoc-deep' ? 'adhoc' : o.macSign) : undefined);
    if (!a.ok) {
      if (a.code === 'NEED_ELEVATION') log(`需要管理员权限：${a.tried.map((t) => `${t.via}：${t.reason}`).join('；') || '已跳过自动提权'}`);
      else log(`✖ 还原失败：${a.error}`);
      return a;
    }
    log(`已按备份还原安装文件（${METHOD[a.method] ?? a.method}，sha256 校验通过）`);
    // 有 carry（语言包/locale 是我们改的）才动用户设置；没有说明旧版已清理过，只清译文缓存
    if (state.carry) {
      const r = await cleanupUser(o, { ...state, commit: info.commit }, { stale: true });
      return r.ok ? { ...r, recovered: backupDir } : r;
    }
    if (info.commit) await clearNlsCache({ userDataDir: o.userDataDir, commit: info.commit });
    await writeState(o.dataDir, { localized: false, revertedAt: new Date().toISOString(), recoveredFrom: backupDir });
    log('还原完成（语言包/locale 之前已清理），重启 Cursor 后生效');
    return { ok: true, recovered: backupDir };
  });
}

async function cleanupUser(o, state, { stale = false, backupDir } = {}) {
  const log = o.onLog;
  try {
    if (state.commit) await clearNlsCache({ userDataDir: o.userDataDir, commit: state.commit });
    const prevLocale = state.prevLocale ?? state.pending?.carry?.prevLocale ?? state.carry?.prevLocale ?? null;
    await setLocale({ argvPath: o.argvPath, locale: prevLocale });
    log(`locale 已恢复为 ${prevLocale ?? '(默认)'}`);
    if (state.installedLangpack || state.carry?.installedLangpack) { await uninstallLanguagePack(o); await unregisterLanguagePack(o); log('已卸载语言包'); }
    if (!stale && backupDir) await dropBackup({ backupDir });
    await writeState(o.dataDir, { localized: false, revertedAt: new Date().toISOString() });
    log('还原完成，重启 Cursor 后生效');
    return { ok: true, stale };
  } catch (e) {
    log(`✖ 还原失败：${e.message}`);
    return fail('REVERT_FAILED', e.message);
  }
}

export { detectAllCursors, findAppImages, listExtracted };
