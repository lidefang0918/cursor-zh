// 用法：node scripts/run.mjs status|localize|revert [--close] [--no-relaunch] [--elevate=pkexec,sudo-n,manual] [--root=<安装根>]
//       node scripts/run.mjs extract-appimage <Cursor-*.AppImage>   （解包 AppImage 到用户目录，之后对解包副本汉化）
// 只作用于本机探测到的 Cursor。--close：Cursor 在运行时先优雅关闭，完成后按原命令行重新打开。
import { localize, revert, status } from '../packages/engine/src/index.js';
import { extractAppImage } from '../packages/engine/src/appimage.js';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'status';
const flag = (n) => args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const val = (n) => flag(n)?.split('=').slice(1).join('=');
const onLog = (m) => console.log('  ·', m);
const opts = {
  onLog,
  closeRunning: !!flag('close'),
  relaunch: !flag('no-relaunch'),
  ...(val('elevate') ? { elevateStrategies: val('elevate').split(',') } : {}),
  ...(val('root') ? { installRoot: val('root') } : {}),
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
console.log(JSON.stringify(r, null, 2));
process.exitCode = r.ok === false ? 1 : 0;
