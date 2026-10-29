// 用法：node scripts/run.mjs status|localize|revert [--close] [--no-relaunch] [--elevate=pkexec,sudo-n,manual] [--root=<安装根>]
//       macOS：[--mac-sign=adhoc|adhoc-deep|none]（默认 adhoc：改完对 Cursor.app 外层做 ad-hoc 重签名）
//       revert [--from-backup=<备份目录>]：记录丢失/误判过期但文件仍带补丁时，用该备份（默认自动找 backups/*.stale-*）恢复
//       node scripts/run.mjs extract-appimage <Cursor-*.AppImage>   （解包 AppImage 到用户目录，之后对解包副本汉化）
// 只作用于本机探测到的 Cursor。--close：Cursor 在运行时先优雅关闭，完成后按原命令行重新打开。
//       --start：localize 成功后若 Cursor 没在运行，就打开它（Windows 命令行包用）
//       --log=<文件>：输出同时追加到该文件
// Windows 命令行包可以用 Cursor.exe 自带的 Node（ELECTRON_RUN_AS_NODE=1）跑本脚本；子进程（重新打开 Cursor 等）不能继承这个变量
import fs from 'node:fs';
import path from 'node:path';
import { localize, revert, status, nextStep } from '../packages/engine/src/index.js';
import { extractAppImage } from '../packages/engine/src/appimage.js';
import { relaunchCursor } from '../packages/engine/src/process.js';

delete process.env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'status';
const flag = (n) => args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const val = (n) => flag(n)?.split('=').slice(1).join('=');
const logFile = val('log');
if (logFile) {
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch {}
  const write = (line) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`); } catch {} };
  const orig = console.log.bind(console);
  console.log = (...a) => { orig(...a); write(a.map(String).join(' ')); };
  write(`== run.mjs ${args.filter((a) => !a.startsWith('--log')).join(' ')} (node ${process.version}, ${process.versions.electron ? `electron ${process.versions.electron}` : 'node'}, ${process.platform}-${process.arch})`);
}
const onLog = (m) => console.log('  ·', m);
const opts = {
  onLog,
  closeRunning: !!flag('close'),
  relaunch: !flag('no-relaunch'),
  ...(val('elevate') ? { elevateStrategies: val('elevate').split(',') } : {}),
  ...(val('root') ? { installRoot: val('root') } : {}),
  ...(val('mac-sign') ? { macSign: val('mac-sign') } : {}),
  ...(val('from-backup') ? { fromBackup: val('from-backup') } : {}),
};
let r;
if (cmd === 'localize') r = await localize(opts);
else if (cmd === 'revert') r = await revert(opts);
else if (cmd === 'extract-appimage') {
  const file = args.filter((a) => !a.startsWith('--'))[1];
  try { r = { ok: true, ...(await extractAppImage({ appImagePath: file, log: onLog })) }; }
  catch (e) { r = { ok: false, error: e.message }; }
} else r = await status(opts);
if (r.code === 'NEED_ELEVATION') console.log(`\n需要管理员权限，请在终端执行：\n  ${r.command}\n然后重新运行：node scripts/run.mjs ${cmd}\n`);
if (r.code === 'MAC_APP_MANAGEMENT') console.log(`\n${r.error}\n系统设置：${r.settingsUrl}\n`);
console.log(JSON.stringify(r, null, 2));
if (cmd === 'localize' && r.ok && flag('start') && !r.relaunched) {
  const st = await status({});
  if (st.cursor && !st.running && process.platform === 'win32') {
    relaunchCursor({ platform: 'win32', argv: [path.join(st.cursor.root, 'Cursor.exe')] });
    console.log('已打开 Cursor');
  }
}
const doneText = cmd === 'localize' ? (r.already ? '已是最新汉化，无需重复操作' : r.refreshed ? '汉化已更新' : '汉化完成') : '已还原';
if (cmd !== 'status') console.log(r.ok === false ? `\n✖ 失败：${r.error ?? r.code}${nextStep(r.code) ? `\n  下一步：${nextStep(r.code)}` : ''}${logFile ? `\n  日志：${logFile}` : ''}` : `\n✔ ${doneText}${r.relaunched ? '，Cursor 已重新打开' : r.already ? '' : '，重启 Cursor 后生效'}`);
if (cmd === 'status') console.log(`\n${!r.cursor ? '✖ 未找到 Cursor' : r.stale ? `⚠ Cursor 已更新/重装，汉化已失效${r.supported ? '：运行“一键汉化”即可重新汉化' : `，且 Cursor ${r.cursor.version} 暂未适配（支持：${r.supportedVersions.join('、')}）`}` : r.localized ? (r.upToDate === false ? '✔ 已汉化（本工具有更新的汉化内容：再运行一次“一键汉化”即可更新）' : '✔ 已汉化') : r.supported ? '· 未汉化' : `✖ Cursor ${r.cursor.version} 暂未适配（支持：${r.supportedVersions.join('、')}）`}`);
process.exitCode = r.ok === false ? 1 : 0;
