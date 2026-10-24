// 데스크톱 앱(Windows·macOS): 앱 화면을 이 컴퓨터 안의 작은 서버로 띄운다.
// 주소가 늘 http://localhost:47615 로 같아서 원고(IndexedDB)가 그대로 남고, 구글 로그인도 이 주소를 승인하면 된다.
const { app, BrowserWindow, shell, ipcMain, dialog, session, Menu } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { CSP } = require('./csp.cjs');
const updater = require('./updater.cjs');

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
const allowClose = new WeakSet(); // 저장을 마쳤거나 사용자가 '그래도 닫기'를 고른 창
let ready = false; // 앱 화면이 다 떴는지
let quitting = false; // 업데이트 설치로 끄는 중 (저장은 이미 마침)
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

// 앱 화면에 원고 저장을 시키고 결과를 받는다: 'ok' 저장됨 · 'fail' 기기에 못 씀 · 'timeout' 시간 안에 답이 없음 · 'error' 화면이 응답하지 않음
// 시간 제한은 '저장됨'이 아니다. 결과는 한 번만 정해지고 타이머는 바로 치운다.
const WAIT = { close: 8000, update: 15000 }; // 저장 답을 기다리는 시간 (ms)
function askSave(w, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => finish('timeout'), ms);
    if (!w || w.isDestroyed()) { finish('ok'); return; }
    w.webContents.executeJavaScript('window.__saveBeforeClose ? window.__saveBeforeClose() : true')
      .then((ok) => finish(ok === false ? 'fail' : 'ok'), () => finish('error'));
  });
}
// 저장 실패를 앱 화면에 알려 '다시 시도 / 복구 파일 / 그래도 닫기'를 고르게 한다
const tellBlocked = (w, what) => { if (w && !w.isDestroyed()) w.webContents.executeJavaScript(`window.__closeBlocked && window.__closeBlocked(${JSON.stringify(what)})`).catch(() => {}); };
// 답이 없을 때(화면이 멈춤 등): 기다릴지, 저장하지 않고 진행할지 묻는다
async function askWhenSilent(w, goLabel) {
  if (!w || w.isDestroyed()) return true;
  const { response } = await dialog.showMessageBox(w, {
    type: 'warning', buttons: ['기다리기', goLabel, '취소'], defaultId: 0, cancelId: 2,
    message: '원고 저장이 아직 끝나지 않았어요.',
    detail: '조금 더 기다리면 저장을 마칠 수 있어요. 지금 진행하면 마지막으로 저장한 뒤에 쓴 글을 잃을 수 있습니다.',
  });
  return response === 0 ? 'wait' : response === 1;
}

// 원고를 저장하고 끌 준비 (업데이트 설치 전). 저장하지 못하면 false: 설치를 미룬다
async function saveForQuit() {
  const w = win;
  for (;;) {
    const res = await askSave(w, WAIT.update);
    if (res === 'ok') { quitting = true; return true; }
    if (res === 'fail') { tellBlocked(w, 'update'); return false; }
    const a = await askWhenSilent(w, '저장하지 않고 다시 시작');
    if (a === 'wait') continue;
    if (a === true) { quitting = true; return true; }
    return false;
  }
}
// ---------- 이 컴퓨터를 동기화 서버로 (같은 집·사무실의 다른 컴퓨터가 붙는다) ----------
// server/server.mjs를 이 앱의 Node로 따로 띄운다. 작품은 사용자 폴더(userData/sync-server)에 둔다.
const HOST_PORT = 8787;
let hostProc = null, hostErr = '';
const hostDir = () => path.join(app.getPath('userData'), 'sync-server');
const hostCfg = () => path.join(app.getPath('userData'), 'host-server.json');
const hostWanted = () => { try { return JSON.parse(fs.readFileSync(hostCfg(), 'utf8')).on === true; } catch { return false; } };
function startHost() {
  if (hostProc) return;
  fs.mkdirSync(hostDir(), { recursive: true });
  const script = path.join(__dirname, '..', 'server', 'server.mjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  hostErr = '';
  hostProc = spawn(process.execPath, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(HOST_PORT), HOST: '0.0.0.0', DATA_DIR: hostDir(), APP_DIR: ROOT },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  hostProc.stderr.on('data', (d) => { hostErr = (hostErr + d).slice(-400); });
  hostProc.on('exit', (code) => { hostProc = null; if (code && !hostErr) hostErr = `서버가 멈췄어요 (${code}). ${HOST_PORT}번 포트를 다른 프로그램이 쓰고 있을 수 있어요.`; });
}
function stopHost() { if (hostProc) { hostProc.kill(); hostProc = null; } }
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
async function hostInfo() {
  let code = '';
  for (let i = 0; i < 30 && hostProc && !code; i++) {
    try { code = fs.readFileSync(path.join(hostDir(), 'access-code.txt'), 'utf8').trim(); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return { on: !!hostProc, port: HOST_PORT, code, urls: lanIps().map((ip) => `http://${ip}:${HOST_PORT}`), local: `http://localhost:${HOST_PORT}`, error: hostErr, name: os.hostname() };
}
ipcMain.handle('host-server', async (e, on) => {
  if (!isApp(e.senderFrame?.url)) return null;
  if (on === true || on === false) {
    try { fs.writeFileSync(hostCfg(), JSON.stringify({ on })); } catch { /* 다음 실행에는 꺼짐 */ }
    if (on) startHost(); else stopHost();
    if (on) await new Promise((r) => setTimeout(r, 600)); // 켜지는 동안
  }
  return hostInfo();
});
ipcMain.handle('device-info', (e) => (isApp(e.senderFrame?.url) ? { name: os.hostname(), platform: process.platform } : null));
app.on('will-quit', stopHost);

// 앱 화면의 '업데이트 확인' 메뉴
ipcMain.handle('check-update', (e) => (isApp(e.senderFrame?.url) ? updater.check(true) : null));
ipcMain.handle('app-version', (e) => (isApp(e.senderFrame?.url) ? app.getVersion() : null));

// 저장에 실패한 뒤 사용자가 앱 화면에서 '저장하지 않고 진행'을 고름
ipcMain.on('force-close', (e, what) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w !== win || !isApp(e.senderFrame?.url)) return;
  if (what === 'update') { quitting = true; updater.installNow(); return; }
  allowClose.add(w);
  w.close();
});

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
    if (/^https:\/\/accounts\.google\.com\//.test(url)) {
      // 이미 허락한 계정의 조용한 재연결(prompt=none)은 창을 보이지 않게 연다
      const silent = /[?&]prompt=none(&|$)/.test(url);
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, show: !silent, skipTaskbar: silent } };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url); // file:, 프로그램 실행 주소 등은 열지 않는다
    return { action: 'deny' };
  });
  // 숨은 재연결 창이 어떤 까닭으로 남아 있으면 30초 뒤 닫는다
  win.webContents.on('did-create-window', (child, { url }) => {
    if (!/[?&]prompt=none(&|$)/.test(url || '')) return;
    setTimeout(() => { if (!child.isDestroyed()) child.close(); }, 30e3);
    // 숨은 창이 로그인·계정 고르기 화면으로 가면 사람이 할 일이 남은 것: 바로 닫아 앱이 ‘눌러서 다시 연결’을 보이게 한다
    child.webContents.on('did-navigate', (ev, to) => {
      if (/\/(signin|ServiceLogin|AccountChooser|accountchooser|v3\/signin|consent)/i.test(to) && !child.isDestroyed()) child.close();
    });
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isApp(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });

  // 닫기 전에 원고를 저장한다. 닫기 시도는 한 번에 하나만(겹친 요청은 합친다),
  // 늦게 도착한 결과는 이 창(w)에만 적용하고 이미 없어진 창이면 아무것도 하지 않는다.
  const w = win;
  let closing = false;
  w.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  w.on('close', (e) => {
    if (allowClose.has(w) || quitting) return;
    e.preventDefault();
    if (closing) return;
    closing = true;
    (async () => {
      for (;;) {
        const res = await askSave(w, WAIT.close);
        if (w.isDestroyed()) return;
        if (res === 'ok') break;
        if (res === 'fail') { tellBlocked(w, 'close'); return; }
        const a = await askWhenSilent(w, '저장하지 않고 닫기');
        if (a === 'wait') continue;
        if (a === true) break;
        return;
      }
      if (!w.isDestroyed()) { allowClose.add(w); w.close(); }
    })().finally(() => { closing = false; });
  });
  w.webContents.on('did-start-loading', () => { if (win === w) ready = false; });

  w.on('closed', () => { if (win === w) { win = null; ready = false; } });
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
    // 유의어 사전(워드시스터즈)을 원고 옆 창(iframe)에 띄울 수 있게: 그 사이트 화면이 '다른 사이트 안에 넣지 마' 머리말을 보내도
    // 이 앱 화면 안에서는 띄운다. 그 사이트의 화면(subFrame)에만, 그리고 앱 화면이 부모일 때만 적용한다.
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['https://wordsisters.com/*', 'https://*.wordsisters.com/*'] }, (d, cb) => {
      if (d.resourceType !== 'subFrame' || !isApp(d.frame?.parent?.url || d.referrer || '')) return cb({});
      const headers = {};
      for (const [k, v] of Object.entries(d.responseHeaders || {})) {
        const key = k.toLowerCase();
        if (key === 'x-frame-options') continue;
        if (key === 'content-security-policy') {
          const kept = v.map((x) => x.split(';').filter((p) => !/^\s*frame-ancestors\b/i.test(p)).join(';')).filter((x) => x.trim());
          if (kept.length) headers[k] = kept;
          continue;
        }
        headers[k] = v;
      }
      cb({ responseHeaders: headers });
    });
    // 숨은 기본 메뉴의 단축키(Ctrl+R 새로 고침, Ctrl+0·±확대, Ctrl+W 닫기 등)가 앱의 단축키 설정보다 먼저 먹지 않게 없앤다.
    // 맥은 복사·붙여넣기(⌘C·⌘V)가 '편집' 메뉴에 달려 있어 앱·편집 메뉴만 남긴다.
    if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    else Menu.setApplicationMenu(null);
    if (hostWanted()) startHost();
    createWindow();
    updater.start({ getWin: () => win, beforeQuit: saveForQuit });
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

// 시험용 (tests/electron-close.test.cjs)
if (process.env.NW_TEST) module.exports = { createWindow, saveForQuit, WAIT, getWin: () => win };
