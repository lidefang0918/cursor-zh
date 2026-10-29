import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

export async function downloadLangpack({ version, cacheDir }) {
  const dest = path.join(cacheDir, `${LANGPACK_ID}-${version}.vsix`);
  try { await fs.access(dest); return dest; } catch {}
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
