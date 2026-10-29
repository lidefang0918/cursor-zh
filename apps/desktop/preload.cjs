const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engine', {
  getStatus: () => ipcRenderer.invoke('getStatus'),
  localize: () => ipcRenderer.invoke('localize'),
  revert: () => ipcRenderer.invoke('revert'),
  onLog: (cb) => ipcRenderer.on('log', (_e, msg) => cb(msg)),
});
