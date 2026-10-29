const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engine', {
  platform: process.platform,
  getStatus: (o) => ipcRenderer.invoke('getStatus', o),
  localize: (o) => ipcRenderer.invoke('localize', o),
  revert: (o) => ipcRenderer.invoke('revert', o),
  extractAppImage: (p) => ipcRenderer.invoke('extractAppImage', p),
  copy: (t) => ipcRenderer.invoke('copy', t),
  showLog: () => ipcRenderer.invoke('showLog'),
  onLog: (cb) => ipcRenderer.on('log', (_e, msg) => cb(msg)),
});
