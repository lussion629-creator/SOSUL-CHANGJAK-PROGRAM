// 데스크톱 앱(Windows·macOS): 앱 화면을 이 컴퓨터 안의 작은 서버로 띄운다.
// 주소가 늘 http://localhost:47615 로 같아서 원고(IndexedDB)가 그대로 남고, 구글 로그인도 이 주소를 승인하면 된다.
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 47615;
const ROOT = path.join(__dirname, '..', 'dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.rdf': 'application/xml', '.hpf': 'application/xml',
};

// 구글 로그인이 막히지 않게 일반 크롬처럼 보이게 한다
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|novel-writer|소설 워드프로세서)\/\S+/g, '');

let win = null;
let ready = false; // 앱 화면이 다 떴는지
const pending = []; // 창이 준비되기 전에 들어온 파일

function serve() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    });
    srv.once('error', reject);
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// 실행할 때 넘겨받은 파일(“연결 프로그램”으로 열기 등)
const filesIn = (argv) => argv.slice(1).filter((a) => !a.startsWith('-') && a !== '.' && fs.existsSync(a) && fs.statSync(a).isFile());

function sendFile(p) {
  if (!win || !ready) { pending.push(p); return; }
  const data = fs.readFileSync(p);
  win.webContents.send('open-file', { name: path.basename(p), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
}

// 앱 화면이 시작을 마치고 파일 받을 준비가 되면 알려 온다
ipcMain.on('renderer-ready', () => { ready = true; pending.splice(0).forEach(sendFile); });

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 360, minHeight: 480,
    title: '소설 워드프로세서',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f6f1ea',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://localhost:${PORT}/`);

  // 구글 로그인 창은 앱 안에서, 그 밖의 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/accounts\.google\.com\//.test(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true } };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) { e.preventDefault(); shell.openExternal(url); }
  });

  // 닫기 전에 원고를 저장한다
  let saved = false;
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (saved) return;
    e.preventDefault();
    const done = () => { saved = true; win.close(); };
    win.webContents.executeJavaScript('window.__saveBeforeClose ? window.__saveBeforeClose() : null').then(done, done);
    setTimeout(done, 3000);
  });
  win.webContents.on('did-start-loading', () => { ready = false; });

  win.on('closed', () => { win = null; ready = false; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    filesIn(argv).forEach(sendFile);
  });
  app.on('open-file', (e, p) => { e.preventDefault(); sendFile(p); }); // macOS
  pending.push(...filesIn(process.argv));

  app.whenReady().then(async () => {
    try { await serve(); } catch (e) {
      dialog.showErrorBox('소설 워드프로세서', `앱을 시작하지 못했습니다. (${PORT}번 포트를 다른 프로그램이 쓰고 있어요)\n${e.message}`);
      app.quit();
      return;
    }
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
