import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const run = promisify(execFile);
export const LANGPACK_ID = 'ms-ceintl.vscode-language-pack-zh-hans';
const CONFLICT_PATTERNS = [/cursor-language-pack/i, /language-pack-zh/i, /chinese/i];

// 语言包的 engines.vscode 要求 ^<maj>.<min>.0；选和 Cursor 内核 vscodeVersion 同 minor 的版本
export function langpackVersionFor(vscodeVersion) {
  const [maj, min] = String(vscodeVersion).split('.');
  return `${maj}.${min}.0`;
}

export function langpackUrl(version) {
  return `https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-zh-hans/${version}/file/MS-CEINTL.vscode-language-pack-zh-hans-${version}.vsix`;
}

// vendorDir：离线分发包里随附的 vsix（<vendorDir>/<id>-<version>.vsix），有就直接用，不联网
export async function downloadLangpack({ version, cacheDir, vendorDir }) {
  const name = `${LANGPACK_ID}-${version}.vsix`;
  const dest = path.join(cacheDir, name);
  try { await fs.access(dest); return dest; } catch {}
  // 随附的 vsix 先拷到缓存目录再用：打包后它在 app.asar 里，Cursor 命令行（外部进程）读不到 asar 内路径
  if (vendorDir) {
    let buf = null;
    try { buf = await fs.readFile(path.join(vendorDir, name)); } catch {}
    if (buf) { await fs.mkdir(cacheDir, { recursive: true }); await fs.writeFile(dest, buf); return dest; }
  }
  const res = await fetch(langpackUrl(version));
  if (!res.ok) throw new Error(`下载语言包失败 ${version}: HTTP ${res.status}`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function listDirs(dir) {
  try { return (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
}

export async function findInstalledLangpack(extensionsDir) {
  const hit = (await listDirs(extensionsDir)).find((n) => n.toLowerCase().startsWith(`${LANGPACK_ID}-`));
  if (!hit) return null;
  // 卸载后目录可能残留（Cursor 下次启动才清理），以 extensions.json 的登记为准
  let registry;
  try { registry = JSON.parse(await fs.readFile(path.join(extensionsDir, 'extensions.json'), 'utf8')); } catch { return path.join(extensionsDir, hit); }
  const entry = registry.find((e) => e.identifier?.id?.toLowerCase() === LANGPACK_ID);
  return entry ? path.join(extensionsDir, entry.relativeLocation ?? hit) : null;
}

// 社区汉化包与官方包同时启用会冲突；只报告，由上层决定
export async function findConflicts(extensionsDir) {
  return (await listDirs(extensionsDir)).filter(
    (n) => !n.toLowerCase().startsWith(`${LANGPACK_ID}-`) && CONFLICT_PATTERNS.some((re) => re.test(n)),
  );
}

const cliArgs = ({ extensionsDir, userDataDir }) => [
  '--extensions-dir', extensionsDir, ...(userDataDir ? ['--user-data-dir', userDataDir] : []),
];

// cliPath：Linux 是 <root>/bin/cursor；Windows/macOS 是 {cmd: Cursor 主程序, args: [out/cli.js], env: {ELECTRON_RUN_AS_NODE: '1'}}
function runCli(cliPath, args, opts) {
  if (typeof cliPath === 'string') return run(cliPath, args, opts);
  return run(cliPath.cmd, [...(cliPath.args ?? []), ...args], { ...opts, env: { ...process.env, ...(cliPath.env ?? {}) } });
}

// 用 Cursor 自带 CLI 安装 VSIX：会正确写 extensions.json，比手工解压稳
export async function ensureLanguagePack({ cliPath, extensionsDir, userDataDir, vsixPath }) {
  const existing = await findInstalledLangpack(extensionsDir);
  if (existing) return { installed: false, extensionPath: existing };
  await runCli(cliPath, ['--install-extension', vsixPath, ...cliArgs({ extensionsDir, userDataDir })], { timeout: 120000 });
  const extensionPath = await findInstalledLangpack(extensionsDir);
  if (!extensionPath) throw new Error('语言包安装后未在 extensions 目录找到');
  return { installed: true, extensionPath };
}

// Cursor 主进程启动时只读 <userData>/languagepacks.json 决定用哪个语言包；这份清单由共享进程在
// "启动后"才按已装扩展重建。所以 CLI 刚装完语言包时清单里还没有 zh-cn，第一次重启仍是英文
// （原生菜单等 NLS 文案全英文），要再重启一次才生效。这里照 VS Code LanguagePacksCache 的格式自己登记：
// key = languageId，hash = md5(各扩展 uuid||id + version)，translations[id] = <扩展目录>/<path>。
export async function registerLanguagePack({ userDataDir, extensionPath }) {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, 'package.json'), 'utf8'));
  const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  const file = path.join(userDataDir, 'languagepacks.json');
  let packs = {};
  try { packs = JSON.parse(await fs.readFile(file, 'utf8')) ?? {}; } catch {}
  const locales = [];
  for (const loc of manifest.contributes?.localizations ?? []) {
    if (!loc.languageId || !Array.isArray(loc.translations)) continue;
    const key = loc.languageId.toLowerCase();
    const pack = packs[key] ?? { hash: '', extensions: [], translations: {}, label: loc.localizedLanguageName ?? loc.languageName };
    const exts = (pack.extensions ?? []).filter((e) => e.extensionIdentifier?.id?.toLowerCase() !== id);
    exts.push({ extensionIdentifier: { id }, version: manifest.version });
    pack.extensions = exts;
    pack.translations ??= {};
    for (const t of loc.translations) pack.translations[t.id] = path.join(extensionPath, t.path);
    const md5 = crypto.createHash('md5');
    for (const e of exts) md5.update(e.extensionIdentifier.uuid || e.extensionIdentifier.id).update(e.version);
    pack.hash = md5.digest('hex');
    packs[key] = pack;
    locales.push(key);
  }
  if (!locales.length) throw new Error(`语言包没有 localizations 声明：${extensionPath}`);
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(packs));
  return { file, locales };
}

// 卸载时把我们登记的条目撤掉（Cursor 下次启动也会自己重建，这里只是不留指向已删目录的路径）
export async function unregisterLanguagePack({ userDataDir }) {
  const file = path.join(userDataDir, 'languagepacks.json');
  let packs;
  try { packs = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return false; }
  let changed = false;
  for (const [key, pack] of Object.entries(packs ?? {})) {
    const exts = (pack.extensions ?? []).filter((e) => e.extensionIdentifier?.id?.toLowerCase() !== LANGPACK_ID);
    if (exts.length === (pack.extensions ?? []).length) continue;
    // 同一语言即使还有别的扩展，也整条删掉，交给 Cursor 启动时重建（translations 无法按扩展拆分）
    changed = true;
    delete packs[key];
  }
  if (changed) await fs.writeFile(file, JSON.stringify(packs));
  return changed;
}

export async function uninstallLanguagePack({ cliPath, extensionsDir, userDataDir }) {
  await runCli(cliPath, ['--uninstall-extension', LANGPACK_ID, ...cliArgs({ extensionsDir, userDataDir })], { timeout: 120000 });
}

// argv.json 是 JSONC（带注释），用行级正则改 "locale"，不破坏注释
const LOCALE_LINE = /^[ \t]*"locale"[ \t]*:[ \t]*"([^"]*)"[ \t]*,?[ \t]*\r?\n?/m;

export async function readLocale(argvPath) {
  try { return (await fs.readFile(argvPath, 'utf8')).match(LOCALE_LINE)?.[1] ?? null; }
  catch { return null; }
}

// 设置/清除 locale，返回之前的值（null 表示原来没设）
export async function setLocale({ argvPath, locale }) {
  let txt;
  try { txt = await fs.readFile(argvPath, 'utf8'); } catch { txt = null; }
  if (txt === null) {
    if (locale === null) return null;
    await fs.mkdir(path.dirname(argvPath), { recursive: true });
    await fs.writeFile(argvPath, `{\n\t"locale": "${locale}"\n}\n`);
    return null;
  }
  const prev = txt.match(LOCALE_LINE)?.[1] ?? null;
  if (prev !== null) txt = txt.replace(LOCALE_LINE, '');
  if (locale !== null) {
    const m = txt.match(/^[ \t]*\{[ \t]*\r?\n/m);
    if (!m) throw new Error(`无法解析 ${argvPath}`);
    const at = m.index + m[0].length;
    const hasKeys = /^[ \t]*"/m.test(txt.slice(at));
    txt = txt.slice(0, at) + `\t"locale": "${locale}"${hasKeys ? ',' : ''}\n` + txt.slice(at);
  }
  await fs.writeFile(argvPath, txt);
  return prev;
}
