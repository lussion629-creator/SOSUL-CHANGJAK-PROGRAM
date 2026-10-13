// 앱 화면에 데스크톱 기능 몇 가지만 알려 준다 (구글 로그인 창 등 다른 주소에는 아무것도 주지 않는다)
const { contextBridge, ipcRenderer } = require('electron');
if (location.origin === 'http://localhost:47615') {
  contextBridge.exposeInMainWorld('desktop', {
    platform: process.platform,
    onOpenFile: (cb) => { ipcRenderer.on('open-file', (_e, f) => cb(f)); ipcRenderer.send('renderer-ready'); },
    checkUpdate: () => ipcRenderer.invoke('check-update'),
    version: () => ipcRenderer.invoke('app-version'),
    forceClose: (what) => ipcRenderer.send('force-close', what === 'update' ? 'update' : 'close'),
  });
}
