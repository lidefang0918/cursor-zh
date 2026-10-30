// 给 Tauri 外壳用的引擎入口：一次调用做一个操作，stdout 只输出 JSON 行（NDJSON），外壳逐行转发给界面。
// 用法：<node 或 ELECTRON_RUN_AS_NODE=1 的 Cursor 主程序> scripts/engine-ipc.mjs <status|localize|revert|extractAppImage> [base64url(JSON 选项)]
//   选项：{ installRoot?, closeRunning?, appImagePath? }；也可以用环境变量 CZL_IPC_OPTS=<JSON>（Tauri 外壳用这个，免去命令行转义）
// 输出：{"t":"log","msg":"…"} 若干行，最后一行 {"t":"result","data":{…}}；data 的形状与 Electron 版 ipc 返回值一致
//      （失败时带 code / error / next，另带 logFile）。退出码：0 = 有结果（含业务失败），2 = 用法错误。
// 引擎自己的 console 输出一律改到 stderr，保证 stdout 每一行都是 JSON。
import fs from 'node:fs';
import path from 'node:path';
import { localize, revert, status, extractAppImage, nextStep, defaultPaths } from '../packages/engine/src/index.js';

const envOpts = process.env.CZL_IPC_OPTS;
// 引擎再起的子进程（重新打开 Cursor、Cursor 自带 CLI 等）不能继承这些
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.CZL_IPC_OPTS;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
console.log = console.info = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

const logFileOf = (dataDir = defaultPaths().dataDir) => path.join(dataDir, 'gui.log');
const logFile = process.env.CZL_GUI_LOG || logFileOf();
function fileLog(line) {
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`); } catch {}
}
const send = (msg) => { out({ t: 'log', msg: String(msg) }); fileLog(String(msg)); };

function decodeOpts(arg) {
  if (!arg && !envOpts) return {};
  const o = JSON.parse(arg ? Buffer.from(arg, 'base64url').toString('utf8') : envOpts);
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

const OPS = {
  status: (o) => status(o.installRoot ? { installRoot: o.installRoot } : {}),
  localize: (o) => localize({ onLog: send, closeRunning: !!o.closeRunning, ...(o.installRoot ? { installRoot: o.installRoot } : {}) }),
  revert: (o) => revert({ onLog: send, closeRunning: !!o.closeRunning, ...(o.installRoot ? { installRoot: o.installRoot } : {}) }),
  extractAppImage: async (o) => ({ ok: true, ...(await extractAppImage({ appImagePath: o.appImagePath, log: send })) }),
};

const [op, arg] = process.argv.slice(2);
if (!OPS[op]) { out({ t: 'result', data: { ok: false, code: 'USAGE', error: `未知操作：${op}` } }); process.exit(2); }
let r;
try {
  const o = decodeOpts(arg);
  if (op !== 'status') fileLog(`== ${op} ${JSON.stringify(o)} (node ${process.version}${process.versions.electron ? `, electron ${process.versions.electron}` : ''}, ${process.platform}-${process.arch}, exe ${process.execPath})`);
  r = JSON.parse(JSON.stringify(await OPS[op](o)));
  if (r && r.ok === false && !r.next) r.next = nextStep(r.code);
} catch (e) {
  fileLog(`异常 ${e.stack || e.message}`);
  r = { ok: false, code: 'EXCEPTION', error: e.message, next: nextStep('EXCEPTION') };
}
r.logFile = logFile;
if (op !== 'status') fileLog(`结果 ${JSON.stringify(r)}`);
out({ t: 'result', data: r });
