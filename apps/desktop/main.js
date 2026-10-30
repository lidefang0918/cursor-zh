import { app, BrowserWindow, ipcMain, clipboard, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// 直接按相对路径引用引擎（打包时整个仓库结构原样进 app.asar）
import { localize, revert, status, extractAppImage, nextStep } from '../../packages/engine/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let win;
let busy = false;

// 界面日志同时追加到 <appData>/cursor-zh-localizer/gui.log（Windows：%APPDATA%\cursor-zh-localizer\gui.log），方便测试时回传
const logFile = path.join(app.getPath('appData'), 'cursor-zh-localizer', 'gui.log');
function fileLog(line) {
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`); } catch {}
}
function send(msg) {
  win?.webContents.send('log', msg);
  console.log(msg);
  fileLog(String(msg));
}

// 同一时间只跑一个操作；结果序列化成普通对象再回传
async function exclusive(fn) {
  if (busy) return { ok: false, code: 'BUSY', error: '已有操作在进行中' };
  busy = true;
  try { const r = JSON.parse(JSON.stringify(await fn())); if (r && r.ok === false && !r.next) r.next = nextStep(r.code); r.logFile = logFile; fileLog(`结果 ${JSON.stringify(r)}`); return r; }
  catch (e) { fileLog(`异常 ${e.stack || e.message}`); return { ok: false, code: 'EXCEPTION', error: e.message, next: nextStep('EXCEPTION'), logFile }; }
  finally { busy = false; }
}

// CZL_ROOT：指定安装目录（高级用法/测试用），界面里选的安装优先
const rootOf = (o = {}) => o.installRoot || process.env.CZL_ROOT || null;
const pick = (o = {}) => ({
  onLog: send,
  ...(rootOf(o) ? { installRoot: rootOf(o) } : {}),
  closeRunning: !!o.closeRunning,
  online: !process.env.CZL_OFFLINE, // 在线词典；CZL_OFFLINE=1 只用自带词典
});

ipcMain.handle('getStatus', async (_e, o = {}) => JSON.parse(JSON.stringify(await status({ online: !process.env.CZL_OFFLINE, ...(rootOf(o) ? { installRoot: rootOf(o) } : {}) }))));
ipcMain.handle('localize', (_e, o) => exclusive(() => localize(pick(o))));
ipcMain.handle('revert', (_e, o) => exclusive(() => revert(pick(o))));
ipcMain.handle('extractAppImage', (_e, appImagePath) => exclusive(async () => ({ ok: true, ...(await extractAppImage({ appImagePath, log: send })) })));
ipcMain.handle('showLog', () => { fileLog('打开日志'); shell.showItemInFolder(logFile); return logFile; });
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text)); return true; });

app.whenReady().then(() => {
  fileLog(`启动 v${app.getVersion()} ${process.platform}-${process.arch} electron ${process.versions.electron}`);
  win = new BrowserWindow({
    width: 820, height: 860, minHeight: 600, title: 'Cursor 一键汉化',
    icon: path.join(here, 'build', 'icon.png'),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(here, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
