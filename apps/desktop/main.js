import { app, BrowserWindow, ipcMain, clipboard } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 直接按相对路径引用引擎（打包时整个仓库结构原样进 app.asar）
import { localize, revert, status, extractAppImage } from '../../packages/engine/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let win;
let busy = false;

function send(msg) {
  win?.webContents.send('log', msg);
  console.log(msg);
}

// 同一时间只跑一个操作；结果序列化成普通对象再回传
async function exclusive(fn) {
  if (busy) return { ok: false, code: 'BUSY', error: '已有操作在进行中' };
  busy = true;
  try { return JSON.parse(JSON.stringify(await fn())); }
  catch (e) { return { ok: false, code: 'EXCEPTION', error: e.message }; }
  finally { busy = false; }
}

// CZL_ROOT：指定安装目录（高级用法/测试用），界面里选的安装优先
const rootOf = (o = {}) => o.installRoot || process.env.CZL_ROOT || null;
const pick = (o = {}) => ({
  onLog: send,
  ...(rootOf(o) ? { installRoot: rootOf(o) } : {}),
  closeRunning: !!o.closeRunning,
});

ipcMain.handle('getStatus', async (_e, o = {}) => JSON.parse(JSON.stringify(await status(rootOf(o) ? { installRoot: rootOf(o) } : {}))));
ipcMain.handle('localize', (_e, o) => exclusive(() => localize(pick(o))));
ipcMain.handle('revert', (_e, o) => exclusive(() => revert(pick(o))));
ipcMain.handle('extractAppImage', (_e, appImagePath) => exclusive(async () => ({ ok: true, ...(await extractAppImage({ appImagePath, log: send })) })));
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text)); return true; });

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 820, height: 860, minHeight: 600, title: 'Cursor 一键汉化',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(here, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
