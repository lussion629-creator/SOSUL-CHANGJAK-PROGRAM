// 구글 드라이브 동기화
// - 사용자의 드라이브에 "소설 워드프로세서" 폴더를 만들고, 작품마다 백업 파일(제목.novel.json.gz) 하나를 두고 덮어쓴다.
// - 권한은 drive.file: 이 앱이 만든 파일만 볼 수 있다(드라이브의 다른 파일에는 접근하지 않음).
// - 원고를 Word 파일이나 Google 문서로 드라이브에 따로 저장할 수도 있다.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = '소설 워드프로세서';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let clientId = '';
let token = null; // {access_token, expires_at}
let folderId = null;
const listeners = new Set();
// 로그인 표(1시간짜리)는 이 기기에만 둔다: 앱을 다시 켜거나 업데이트해도 남도록 localStorage에.
// 한 번 연결을 허락했다는 표시(gd-linked)도 남겨, 표가 끝나면 창 없이 조용히 새 표를 받는다.
const TOKEN_LS = 'gd-token', LINK_LS = 'gd-linked';
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 저장소 사용 불가 */ } },
};
const linkedTo = () => { const v = ls.get(LINK_LS); return !!v && (v === '1' || v === clientId); };

export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(status()));

export function status() {
  const connected = !!token && token.expires_at > Date.now() + 60e3;
  return { configured: !!clientId, connected, hadToken: !!clientId && (!!token || linkedTo()), linked: !!clientId && linkedTo() };
}

export function configure(id) {
  const next = (id || '').trim();
  if (next !== clientId) { folderId = null; token = null; }
  clientId = next;
  try {
    // 예전 판은 sessionStorage에 두었다: 옮겨 온다
    const raw = ls.get(TOKEN_LS) || sessionStorage.getItem(TOKEN_LS);
    const saved = JSON.parse(raw || 'null');
    if (saved && saved.expires_at > Date.now() + 60e3 && (!saved.cid || saved.cid === clientId)) token = saved;
    if (saved && !ls.get(LINK_LS) && clientId) ls.set(LINK_LS, clientId);
    sessionStorage.removeItem(TOKEN_LS);
  } catch { /* 저장소 사용 불가 */ }
  if (token) { ls.set(TOKEN_LS, JSON.stringify(token)); planRefresh(); }
  emit();
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res;
    s.onerror = () => rej(new Error('구글 로그인 스크립트를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'));
    document.head.appendChild(s);
  });
}

// 구글 로그인 창으로 표를 받는다. silent: 이미 허락한 계정이면 창을 띄우지 않고(데스크톱은 숨은 창) 바로 받는다
let connecting = null;
export function connect({ silent = false } = {}) {
  if (!clientId) return Promise.reject(new Error('먼저 설정에서 Google OAuth 클라이언트 ID를 넣어 주세요.'));
  if (connecting) return connecting;
  connecting = (async () => {
    await loadGis();
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (e) => { if (done) return; done = true; clearTimeout(t); reject(Object.assign(e, { silent })); };
      const t = setTimeout(() => fail(new Error('구글 연결 창이 응답하지 않아요.')), silent ? 25e3 : 10 * 60e3);
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (r) => {
          if (r.error) { fail(new Error(r.error_description || r.error)); return; }
          if (done) return;
          done = true; clearTimeout(t);
          token = { access_token: r.access_token, expires_at: Date.now() + (r.expires_in - 30) * 1000, cid: clientId };
          ls.set(TOKEN_LS, JSON.stringify(token));
          ls.set(LINK_LS, clientId);
          planRefresh();
          emit();
          resolve(token);
        },
        error_callback: (e) => fail(new Error(e?.type === 'popup_failed_to_open' ? '구글 연결 창이 막혔어요.' : e?.message || '구글 연결 창이 닫혔습니다.')),
      });
      // 처음 연결할 때만 동의 화면을 보이고, 그 뒤로는 묻지 않는다
      tc.requestAccessToken({ prompt: silent ? 'none' : linkedTo() ? '' : 'consent' });
    });
  })().finally(() => { connecting = null; });
  return connecting;
}

// 표가 끝나기 전에 새로 받는다. 데스크톱 앱은 창이 보이지 않게 받고,
// 브라우저는 창을 사용자가 누를 때만 열 수 있어서 다음 클릭·키 입력 때 조용히 받는다.
let refreshT = null, gestureHooked = false;
function planRefresh() {
  clearTimeout(refreshT);
  if (!token || !window.desktop) return;
  const wait = Math.max(30e3, token.expires_at - Date.now() - 5 * 60e3);
  refreshT = setTimeout(() => { autoConnect().catch(() => {}); }, wait);
}
function onGesture() {
  if (gestureHooked) return;
  gestureHooked = true;
  const go = () => {
    removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true);
    gestureHooked = false;
    if (status().linked && !status().connected) connect({ silent: true }).catch(() => emit());
  };
  addEventListener('pointerdown', go, true); addEventListener('keydown', go, true);
}
/** 예전에 연결을 허락했으면 창 없이 다시 연결한다. 못 하면 false (그때는 ☁ 표시를 한 번 누르면 된다) */
export async function autoConnect() {
  const st = status();
  if (!st.configured || !st.linked) return false;
  if (st.connected) return true;
  try { await connect({ silent: true }); return true; } catch {
    if (!window.desktop) onGesture(); // 브라우저: 다음에 누를 때 다시 해 본다
    emit();
    return false;
  }
}

export function disconnect() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null; folderId = null;
  clearTimeout(refreshT);
  ls.set(TOKEN_LS, null); ls.set(LINK_LS, null);
  try { sessionStorage.removeItem(TOKEN_LS); } catch { /* 무시 */ }
  emit();
}

// 로그인이 만료되면 구글 창을 저절로 띄우지 않는다 (자동 동기화 중에 창이 뜨지 않게).
// 사용자가 직접 '연결'·'불러오기' 등을 누를 때만 connect()로 창을 연다.
export class ReauthError extends Error { constructor() { super('구글 드라이브 연결이 끝났어요. 위쪽 ☁ 표시를 눌러 다시 연결해 주세요.'); this.reauth = true; } }
async function api(url, init = {}, retried = false) {
  if (!status().connected) {
    if (!clientId) throw new Error('드라이브가 설정되지 않았습니다.');
    // 한 번 허락했으면 조용히 새 표를 받아 본다 (데스크톱은 늘, 브라우저는 창이 막히지 않으면)
    if (!(await autoConnect())) throw new ReauthError();
  }
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token.access_token}`, ...(init.headers || {}) } });
  if (res.status === 401) {
    token = null; ls.set(TOKEN_LS, null); emit();
    if (!retried && (await autoConnect())) return api(url, init, true);
    throw new ReauthError();
  }
  if (!res.ok) throw new Error(`드라이브 오류 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

const q = (s) => encodeURIComponent(s);

async function ensureFolder() {
  if (folderId) return folderId;
  const r = await (await api(`${API}/files?q=${q(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)&spaces=drive`)).json();
  if (r.files?.length) return (folderId = r.files[0].id);
  const c = await (await api(`${API}/files?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  })).json();
  return (folderId = c.id);
}

function multipart(meta, blob) {
  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  fd.append('file', blob);
  return fd;
}

async function findByProp(key, value) {
  const r = await (await api(`${API}/files?q=${q(`appProperties has { key='${key}' and value='${value}' } and trashed=false`)}&fields=files(id,name,modifiedTime)&spaces=drive`)).json();
  return r.files?.[0] || null;
}

/** 작품 백업 올리기 (작품마다 파일 하나를 덮어쓴다). blob: 압축한 묶음. 반환: {id, modifiedTime, size} */
export async function pushBundle(bundle, blob) {
  const parent = await ensureFolder();
  const pid = bundle.project.id;
  const name = `${bundle.project.title || '작품'}.novel.json${blob.type === 'application/json' ? '' : '.gz'}`;
  const existing = await findByProp('novelProjectId', pid);
  if (existing) {
    return (await api(`${UPLOAD}/files/${existing.id}?uploadType=multipart&fields=id,modifiedTime,size`, {
      method: 'PATCH', body: multipart({ name }, blob),
    })).json();
  }
  return (await api(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime,size`, {
    method: 'POST', body: multipart({ name, parents: [parent], appProperties: { novelProjectId: pid } }, blob),
  })).json();
}

export async function remoteInfo(projectId) { return findByProp('novelProjectId', projectId); }

export async function listBundles() {
  const parent = await ensureFolder();
  const r = await (await api(`${API}/files?q=${q(`'${parent}' in parents and trashed=false and name contains '.novel.json'`)}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,size,appProperties)&spaces=drive`)).json();
  return r.files || [];
}

export async function pullBundle(fileId, read) {
  return read(await (await api(`${API}/files/${fileId}?alt=media`)).arrayBuffer());
}

/** 원고 파일(docx 등)을 드라이브 폴더에 올린다. asGoogleDoc이면 Google 문서로 변환 */
export async function uploadFile(blob, name, { asGoogleDoc = false } = {}) {
  const parent = await ensureFolder();
  const meta = { name: asGoogleDoc ? name.replace(/\.docx$/i, '') : name, parents: [parent] };
  if (asGoogleDoc) meta.mimeType = 'application/vnd.google-apps.document';
  return (await api(`${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, { method: 'POST', body: multipart(meta, blob) })).json();
}

// ---------- 등록한 기기 (드라이브 폴더의 ‘기기 목록’ 파일 하나) ----------
async function deviceFile() { return findByProp('novelDevices', '1'); }
export async function devices() {
  const f = await deviceFile();
  if (!f) return [];
  try { const d = JSON.parse(await (await api(`${API}/files/${f.id}?alt=media`)).text()); return Array.isArray(d) ? d : []; } catch (e) { if (e.reauth) throw e; return []; }
}
async function saveDevices(list) {
  const f = await deviceFile();
  const blob = new Blob([JSON.stringify(list)], { type: 'application/json' });
  if (f) return api(`${UPLOAD}/files/${f.id}?uploadType=multipart&fields=id`, { method: 'PATCH', body: multipart({}, blob) });
  const parent = await ensureFolder();
  return api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', body: multipart({ name: '기기 목록.json', parents: [parent], appProperties: { novelDevices: '1' } }, blob) });
}
export async function putDevice(dev) {
  const list = await devices();
  const now = new Date().toISOString();
  const d = { ...dev, lastSync: now, since: list.find((x) => x.id === dev.id)?.since || now };
  await saveDevices([d, ...list.filter((x) => x.id !== dev.id)].slice(0, 50));
  return d;
}
export async function removeDevice(id) { await saveDevices((await devices()).filter((x) => x.id !== id)); }
