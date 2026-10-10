// 데스크톱 앱(Windows·macOS): 앱 화면을 이 컴퓨터 안의 작은 서버로 띄운다.
// 주소가 늘 http://localhost:47615 로 같아서 원고(IndexedDB)가 그대로 남고, 구글 로그인도 이 주소를 승인하면 된다.
const { app, BrowserWindow, shell, ipcMain, dialog, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { CSP } = require('./csp.cjs');

const PORT = 47615;
const ROOT = path.join(__dirname, '..', 'dist');
const ORIGIN = `http://localhost:${PORT}`;
const isApp = (u) => { try { return new URL(u).origin === ORIGIN; } catch { return false; } }; // 주소의 출처가 정확히 이 앱인가
// 보안: 화면 파일에 붙이는 응답 머리말
const HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups', // 구글 로그인 창은 열 수 있게
  'Cache-Control': 'no-cache',
};
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
      // 이 앱 화면만 받는다: 읽기 요청만, 주소(Host)가 이 컴퓨터일 때만 (다른 사이트가 주소를 속여 들어오는 것 차단)
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      if (!/^(localhost|127\.0\.0\.1):47615$/.test(req.headers.host || '')) { res.writeHead(403).end(); return; }
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; } // dist 폴더 밖은 못 읽게
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : buf);
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
ipcMain.on('renderer-ready', (e) => {
  if (!win || e.sender !== win.webContents || !isApp(e.senderFrame?.url)) return; // 앱 화면이 보낸 것만
  ready = true;
  pending.splice(0).forEach(sendFile);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 360, minHeight: 480,
    title: '소설 워드프로세서',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#e8e3da',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://localhost:${PORT}/`);

  // 구글 로그인 창은 앱 안에서, 그 밖의 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/accounts\.google\.com\//.test(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true } };
    if (/^https?:\/\//.test(url)) shell.openExternal(url); // file:, 프로그램 실행 주소 등은 열지 않는다
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isApp(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });

  // 닫기 전에 원고를 저장한다
  let saved = false;
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (saved) return;
    e.preventDefault();
    const done = () => { saved = true; win.close(); };
    win.webContents.executeJavaScript('window.__saveBeforeClose ? window.__saveBeforeClose() : null').then(done, done);
    setTimeout(done, 8000); // 드라이브에 올리는 중이면 조금 더 기다린다
  });
  win.webContents.on('did-start-loading', () => { ready = false; });

  win.on('closed', () => { win = null; ready = false; });
}

// 앱 안에 다른 웹 화면(webview)을 끼워 넣지 못하게, 새 창의 이동도 막는다
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

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
    // 권한: 클립보드(붙여넣기)·전체 화면만 허락하고 카메라·마이크·위치·알림 등은 모두 거절
    const OK = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb, d) => cb(OK.has(perm) && isApp(d?.requestingUrl || wc.getURL())));
    session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => OK.has(perm) && isApp(origin));
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
