import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectCursor } from './detect.js';
import { loadAnchors, loadDict, loadPatterns } from './anchors.js';
import { createBackup } from './backup.js';
import { restoreBackup, dropBackup } from './restore.js';
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

async function linuxCursorRunning(root) {
  if (process.platform !== 'linux') return false; // TODO: Win/macOS
  const { stdout } = await promisify(execFile)('ps', ['-eo', 'args=']);
  const exe = path.join(root, 'cursor');
  return stdout.split('\n').some((l) => l.startsWith(exe + ' ') || l === exe);
}

async function resolve(opts) {
  const o = { platform: process.platform, ...defaultPaths(), onLog: () => {}, ...opts };
  const info = await detectCursor({ platform: o.platform, extraRoots: o.installRoot ? [o.installRoot] : [], defaults: !o.installRoot });
  if (info) {
    o.installRoot ??= info.root;
    o.cliPath ??= path.join(info.root, 'bin', 'cursor');
    o.isCursorRunning ??= () => linuxCursorRunning(info.root);
  }
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

export async function status(opts = {}) {
  const { o, info } = await resolve(opts);
  const state = await readState(o.dataDir);
  const anchors = info ? await loadAnchors({ platform: o.platform, version: info.version, anchorsDir: o.anchorsDir }) : null;
  const patched = info ? await installPatched(info.root, domRelatives(anchors, state)) : false;
  const stale = await isStale(o, info, anchors, state);
  return { cursor: info, supported: !!anchors, state, patched, stale, localized: !!state.localized && !stale };
}

export async function localize(opts = {}) {
  const { o, info } = await resolve(opts);
  const log = o.onLog;
  if (!info) return { ok: false, error: '未找到 Cursor 安装', restored: false };
  log(`检测到 Cursor ${info.version}（VS Code ${info.vscodeVersion}）：${info.root}`);
  if (await o.isCursorRunning()) return { ok: false, error: '请先退出 Cursor 再操作', restored: false };

  const anchors = await loadAnchors({ platform: o.platform, version: info.version, anchorsDir: o.anchorsDir });
  let state = await readState(o.dataDir);
  if (state.localized) {
    if (!(await isStale(o, info, anchors, state))) return { ok: false, error: '已汉化，如需重做请先还原', restored: false };
    await retireStale(o, state, log);
    state = await readState(o.dataDir);
  }
  if (!anchors) return { ok: false, error: `Cursor ${info.version} 暂未适配（没有锚点清单），已拒绝修改`, restored: false };
  // 没有记录但文件已带补丁：不能把补丁后的文件当原版备份
  if (await installPatched(o.installRoot, domRelatives(anchors))) {
    return { ok: false, error: '安装文件已带汉化补丁但没有汉化记录，请重装 Cursor 后再汉化', restored: false };
  }
  const files = [...new Set([...filesToBackup(anchors), ...(anchors.dom?.relatives ?? [])])];
  for (const f of files) {
    try { await fs.access(path.join(o.installRoot, f), fs.constants.W_OK); }
    catch { return { ok: false, error: `没有写权限：${f}（Linux 下需要管理员权限）`, restored: false }; }
  }
  const conflicts = await findConflicts(o.extensionsDir);
  if (conflicts.length) log(`⚠ 检测到可能冲突的汉化扩展：${conflicts.join(', ')}，建议先禁用`);

  const dict = await loadDict(o.dictPath);
  const patterns = await loadPatterns(o.patternsPath);
  const backupDir = path.join(o.dataDir, 'backups', info.version);
  await createBackup({ installRoot: o.installRoot, files, backupDir });
  log(`已备份 ${files.length} 个文件 → ${backupDir}`);

  const undo = { langpack: false, prevLocale: undefined };
  try {
    const vsix = o.vsixPath ?? (await downloadLangpack({ version: langpackVersionFor(info.vscodeVersion), cacheDir: path.join(o.dataDir, 'cache') }));
    const lp = await ensureLanguagePack({ cliPath: o.cliPath, extensionsDir: o.extensionsDir, userDataDir: o.userDataDir, vsixPath: vsix });
    undo.langpack = lp.installed;
    log(lp.installed ? `已安装语言包：${lp.extensionPath}` : `语言包已存在：${lp.extensionPath}`);

    undo.prevLocale = await setLocale({ argvPath: o.argvPath, locale: 'zh-cn' });
    log(`已设置 locale=zh-cn：${o.argvPath}`);

    const p = await applyPatch({ installRoot: o.installRoot, anchors, dict });
    log(`静态补丁：替换 ${p.replaced} 处，模板片段 ${p.fragmentsReplaced} 处；未命中 ${p.missing.length} 条`);

    const n = await applyNls({ installRoot: o.installRoot, anchors, dict });
    if (anchors.nls) {
      const cleared = await clearNlsCache({ userDataDir: o.userDataDir, commit: info.commit });
      log(`NLS 文案：替换 ${n.replaced} 条；未命中 ${n.missing.length} 条；已清理译文缓存 ${cleared.length} 处`);
    }

    const domTargets = anchors.dom?.relatives ?? [anchors.files[0].relative];
    for (const relative of domTargets) await injectDomRuntime({ installRoot: o.installRoot, relative, dict, patterns });
    const { checksumsUpdated } = await updateChecksums({ installRoot: o.installRoot, anchors, relatives: [...new Set([...p.patched, ...domTargets])] });
    log(`DOM 补漏已注入；已更新校验：${checksumsUpdated.join(', ') || '无'}`);

    const carry = state.carry;
    await writeState(o.dataDir, {
      localized: true, version: info.version, installRoot: o.installRoot, backupDir, at: new Date().toISOString(),
      installedLangpack: undo.langpack || !!carry?.installedLangpack,
      prevLocale: carry && undo.prevLocale === 'zh-cn' ? carry.prevLocale : undo.prevLocale, replaced: p.replaced, missing: p.missing,
      perFile: p.perFile, fragmentsReplaced: p.fragmentsReplaced, nlsReplaced: n.replaced, nlsMissing: n.missing, commit: info.commit,
    });
    log('完成，请重启 Cursor');
    return { ok: true, replaced: p.replaced, perFile: p.perFile, fragmentsReplaced: p.fragmentsReplaced, perFileFragments: p.perFileFragments, missing: p.missing, nlsReplaced: n.replaced, nlsMissing: n.missing, checksumsUpdated };
  } catch (e) {
    log(`✖ 失败：${e.message}，正在回滚`);
    let restored = true;
    try { await restoreBackup({ installRoot: o.installRoot, backupDir }); await dropBackup({ backupDir }); } catch { restored = false; }
    try { if (undo.prevLocale !== undefined) await setLocale({ argvPath: o.argvPath, locale: undo.prevLocale }); } catch { restored = false; }
    try { if (undo.langpack) await uninstallLanguagePack(o); } catch { restored = false; }
    log(restored ? '已回滚' : '⚠ 回滚不完整，请检查日志');
    return { ok: false, error: e.message, restored };
  }
}

export async function revert(opts = {}) {
  const { o, info } = await resolve(opts);
  const log = o.onLog;
  const state = await readState(o.dataDir);
  if (!state.localized) return { ok: false, error: '当前未处于汉化状态' };
  if (o.isCursorRunning && (await o.isCursorRunning())) return { ok: false, error: '请先退出 Cursor 再操作' };
  const anchors = info ? await loadAnchors({ platform: o.platform, version: info.version, anchorsDir: o.anchorsDir }) : null;
  const stale = await isStale(o, info, anchors, state);
  try {
    if (stale) {
      // 安装已是原版：不能拿旧备份覆盖（可能是别的版本），只清理语言包/locale
      await retireStale(o, state, log);
    } else {
      await restoreBackup({ installRoot: state.installRoot, backupDir: state.backupDir });
      log('已按备份还原安装文件（sha256 校验通过）');
    }
    if (state.commit) await clearNlsCache({ userDataDir: o.userDataDir, commit: state.commit });
    await setLocale({ argvPath: o.argvPath, locale: state.prevLocale ?? null });
    log(`locale 已恢复为 ${state.prevLocale ?? '(默认)'}`);
    if (state.installedLangpack) { await uninstallLanguagePack(o); log('已卸载语言包'); }
    if (!stale) await dropBackup({ backupDir: state.backupDir });
    await writeState(o.dataDir, { localized: false, revertedAt: new Date().toISOString() });
    log('还原完成，请重启 Cursor');
    return { ok: true };
  } catch (e) {
    log(`✖ 还原失败：${e.message}`);
    return { ok: false, error: e.message };
  }
}
