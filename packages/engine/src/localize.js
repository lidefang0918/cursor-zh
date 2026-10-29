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
  ensureLanguagePack, uninstallLanguagePack, setLocale, findConflicts, downloadLangpack, langpackVersionFor,
} from './langpack.js';
import { readState, writeState } from './state.js';

export { readState };
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

// Linux 实测路径（Cursor 3.x：product.dataFolderName = .cursor）
export function defaultPaths(home = os.homedir()) {
  return {
    userDataDir: path.join(home, '.config/Cursor'),
    extensionsDir: path.join(home, '.cursor/extensions'),
    argvPath: path.join(home, '.cursor/argv.json'),
    dataDir: path.join(home, '.config/cursor-zh-localizer'),
    anchorsDir: path.join(REPO, 'anchors'),
    dictPath: path.join(REPO, 'dicts/zh-cn.json'),
    patternsPath: path.join(REPO, 'dicts/zh-cn.patterns.json'),
  };
}

async function resolve(opts) {
  const o = { platform: process.platform, ...defaultPaths(), onLog: () => {}, ...opts };
  const info = await detectCursor({ platform: o.platform, extraRoots: o.installRoot ? [o.installRoot] : [], defaults: !o.installRoot });
  if (info) {
    o.installRoot ??= info.root;
    o.cliPath ??= path.join(info.root, 'bin', 'cursor');
  }
  // 兼容旧选项 isCursorRunning（测试用）；默认读 /proc
  if (!o.listRunning) {
    o.listRunning = o.isCursorRunning
      ? async () => ((await o.isCursorRunning()) ? [{ pid: -1, main: true, argv: [] }] : [])
      : async () => (o.installRoot ? listCursorProcesses(o.installRoot) : []);
  }
  o.closeCursor ??= (log) => closeCursor(o.installRoot, { log });
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

// 记录说“已汉化”，但安装文件是原版（重装/更新/被清掉）→ 过期记录
async function isStale(o, info, anchors, state) {
  if (!state.localized) return false;
  if (!info) return true;
  if (state.version && state.version !== info.version) return true;
  if (state.installRoot && state.installRoot !== info.root) return true;
  return !(await installPatched(info.root, domRelatives(anchors, state)));
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

const elevationOpts = (o) => ({ workDir: path.join(o.dataDir, 'elevate'), log: o.onLog, strategies: o.elevateStrategies, assumeUnwritable: o.assumeUnwritable, runner: o.elevateRunner });
const METHOD = { direct: '直接写入', pkexec: 'pkexec 管理员授权', 'sudo-n': '免密 sudo', manual: '终端 sudo 命令' };

export async function status(opts = {}) {
  const { o, info } = await resolve(opts);
  const state = await readState(o.dataDir);
  const anchors = info ? await loadAnchors({ platform: o.platform, version: info.version, anchorsDir: o.anchorsDir }) : null;
  const patched = info ? await installPatched(info.root, domRelatives(anchors, state)) : false;
  const stale = await isStale(o, info, anchors, state);
  const base = { cursor: info, supported: !!anchors, supportedVersions: await supportedVersions(o), state, patched, stale, localized: !!state.localized && !stale };
  if (o.platform !== 'linux' || opts.light) return base;
  const files = anchors ? targetFiles(anchors) : [];
  const w = info && files.length ? await checkWritable(info.root, files) : null;
  const pending = state.pending && info && state.pending.installRoot === info.root ? state.pending : null;
  return {
    ...base,
    kind: info ? await installKind(info.root) : null,
    writable: w ? w.writable : null,
    readOnlyFs: w ? w.readOnlyFs : null,
    needsElevation: !!w && !w.writable && !w.readOnlyFs,
    elevation: await elevationInfo(),
    running: info ? (await o.listRunning()).length : 0,
    installs: await detectAllCursors({ platform: o.platform }),
    appImages: await findAppImages(),
    extracted: await listExtracted(),
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
  const w = await checkWritable(o.installRoot, files);
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
    o.vsixPath ??= await downloadLangpack({ version: langpackVersionFor(info.vscodeVersion), cacheDir: path.join(o.dataDir, 'cache') });

    const backupDir = path.join(o.dataDir, 'backups', info.version);
    if (pending && (await exists(path.join(backupDir, 'manifest.json'))) && (await filesMatch(o.installRoot, shaMap(await backupItems(backupDir))))) {
      log(`沿用上次的备份：${backupDir}`);
    } else {
      if (pending) await dropBackup({ backupDir });
      await createBackup({ installRoot: o.installRoot, files, backupDir });
      log(`已备份 ${files.length} 个文件 → ${backupDir}`);
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
    const a = await applyFiles({ installRoot: o.installRoot, items, ...elevationOpts(o) });
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
    if (!o.vsixPath) o.vsixPath = await downloadLangpack({ version: langpackVersionFor(info.vscodeVersion), cacheDir: path.join(o.dataDir, 'cache') });
    const lp = await ensureLanguagePack({ cliPath: o.cliPath, extensionsDir: o.extensionsDir, userDataDir: o.userDataDir, vsixPath: o.vsixPath });
    undo.langpack = lp.installed;
    log(lp.installed ? `已安装语言包：${lp.extensionPath}` : `语言包已存在：${lp.extensionPath}`);
    undo.prevLocale = await setLocale({ argvPath: o.argvPath, locale: 'zh-cn' });
    log(`已设置 locale=zh-cn：${o.argvPath}`);
    if (info.commit) {
      const cleared = await clearNlsCache({ userDataDir: o.userDataDir, commit: info.commit });
      if (cleared.length) log(`已清理译文缓存 ${cleared.length} 处`);
    }
    await writeState(o.dataDir, {
      localized: true, version: info.version, installRoot: o.installRoot, backupDir, at: new Date().toISOString(), method,
      installedLangpack: undo.langpack || !!carry?.installedLangpack,
      prevLocale: carry && undo.prevLocale === 'zh-cn' ? carry.prevLocale : undo.prevLocale,
      ...result, commit: info.commit,
    });
    await fs.rm(path.join(o.dataDir, 'staging', info.version), { recursive: true, force: true });
    log('完成，重启 Cursor 后生效');
    return { ok: true, method, ...result };
  } catch (e) {
    log(`✖ 失败：${e.message}，正在回滚`);
    let restored = true;
    const back = await applyFiles({ installRoot: o.installRoot, items: await backupItems(backupDir), ...elevationOpts(o) }).catch((x) => ({ ok: false, error: x.message }));
    if (back.ok) await dropBackup({ backupDir }); else restored = false;
    try { if (undo.prevLocale !== undefined) await setLocale({ argvPath: o.argvPath, locale: undo.prevLocale }); } catch { restored = false; }
    try { if (undo.langpack) await uninstallLanguagePack(o); } catch { restored = false; }
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
  if (!state.localized && !state.pending) return fail('NOT_LOCALIZED', '当前未处于汉化状态');
  const anchors = info ? await loadAnchors({ platform: o.platform, version: info.version, anchorsDir: o.anchorsDir }) : null;
  const stale = state.localized ? await isStale(o, info, anchors, state) : false;
  if (stale) {
    // 安装已是原版：不能拿旧备份覆盖（可能是别的版本），只清理语言包/locale
    await retireStale(o, state, log);
    return cleanupUser(o, state, { stale: true });
  }
  const installRoot = state.installRoot ?? state.pending?.installRoot;
  const backupDir = state.backupDir ?? state.pending?.backupDir;
  return withCursorClosed(o, async () => {
    const items = await backupItems(backupDir);
    if (await filesMatch(installRoot, shaMap(items))) {
      log('安装文件已是原版（管理员命令已执行），继续清理');
    } else {
      const a = await applyFiles({ installRoot, items, ...elevationOpts(o) });
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

async function cleanupUser(o, state, { stale = false, backupDir } = {}) {
  const log = o.onLog;
  try {
    if (state.commit) await clearNlsCache({ userDataDir: o.userDataDir, commit: state.commit });
    const prevLocale = state.prevLocale ?? state.pending?.carry?.prevLocale ?? state.carry?.prevLocale ?? null;
    await setLocale({ argvPath: o.argvPath, locale: prevLocale });
    log(`locale 已恢复为 ${prevLocale ?? '(默认)'}`);
    if (state.installedLangpack || state.carry?.installedLangpack) { await uninstallLanguagePack(o); log('已卸载语言包'); }
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
