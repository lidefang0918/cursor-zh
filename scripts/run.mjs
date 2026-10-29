// 用法：node scripts/run.mjs status|localize|revert   （只作用于本机探测到的 Cursor）
import { localize, revert, status } from '../packages/engine/src/index.js';

const cmd = process.argv[2] ?? 'status';
const onLog = (m) => console.log('  ·', m);
const r = cmd === 'localize' ? await localize({ onLog }) : cmd === 'revert' ? await revert({ onLog }) : await status();
console.log(JSON.stringify(r, null, 2));
process.exitCode = r.ok === false ? 1 : 0;
