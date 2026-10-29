import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localize, revert, status } from '@cursor-zh/engine';

const here = path.dirname(fileURLToPath(import.meta.url));
let win;

function send(msg) {
  win?.webContents.send('log', msg);
  console.log(msg);
}

ipcMain.handle('getStatus', () => status());
ipcMain.handle('localize', () => localize({ onLog: send }));
ipcMain.handle('revert', () => revert({ onLog: send }));

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 720, height: 520, title: 'Cursor 一键汉化',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(here, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
