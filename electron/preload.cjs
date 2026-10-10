// 앱 화면에 데스크톱 기능 몇 가지만 알려 준다
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  onOpenFile: (cb) => { ipcRenderer.on('open-file', (_e, f) => cb(f)); ipcRenderer.send('renderer-ready'); },
});
