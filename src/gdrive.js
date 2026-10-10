// 구글 드라이브 동기화
// - 사용자의 드라이브에 "소설 워드프로세서" 폴더를 만들고, 작품마다 백업 파일(제목.novel.json)을 올린다.
// - 권한은 drive.file: 이 앱이 만든 파일만 볼 수 있다(드라이브의 다른 파일에는 접근하지 않음).
// - 원고를 Word 파일이나 Google 문서로 드라이브에 따로 저장할 수도 있다.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = '소설 워드프로세서';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let clientId = '';
let tokenClient = null;
let token = null; // {access_token, expires_at}
let folderId = null;
const listeners = new Set();

export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(status()));

export function status() {
  return { configured: !!clientId, connected: !!token && token.expires_at > Date.now() + 60e3, hadToken: !!token };
}

export function configure(id) {
  clientId = (id || '').trim();
  tokenClient = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem('gd-token') || 'null');
    if (saved && saved.expires_at > Date.now() + 60e3) token = saved;
  } catch { /* 저장소 사용 불가 */ }
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

export async function connect({ silent = false } = {}) {
  if (!clientId) throw new Error('먼저 설정에서 Google OAuth 클라이언트 ID를 넣어 주세요.');
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        token = { access_token: r.access_token, expires_at: Date.now() + (r.expires_in - 30) * 1000 };
        try { sessionStorage.setItem('gd-token', JSON.stringify(token)); } catch { /* 무시 */ }
        emit();
        resolve(token);
      },
      error_callback: (e) => reject(new Error(e?.message || '구글 연결 창이 닫혔습니다.')),
    });
    tokenClient.requestAccessToken({ prompt: silent ? '' : 'consent' });
  });
}

export function disconnect() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null; folderId = null;
  try { sessionStorage.removeItem('gd-token'); } catch { /* 무시 */ }
  emit();
}

async function api(url, init = {}) {
  if (!status().connected) {
    if (!clientId) throw new Error('드라이브가 설정되지 않았습니다.');
    await connect({ silent: true });
  }
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token.access_token}`, ...(init.headers || {}) } });
  if (res.status === 401) { token = null; emit(); throw new Error('구글 로그인이 만료되었습니다. 다시 연결해 주세요.'); }
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

/** 작품 백업 올리기. 반환: {id, modifiedTime} */
export async function pushBundle(bundle) {
  const parent = await ensureFolder();
  const pid = bundle.project.id;
  const name = `${bundle.project.title || '작품'}.novel.json`;
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  const existing = await findByProp('novelProjectId', pid);
  if (existing) {
    return (await api(`${UPLOAD}/files/${existing.id}?uploadType=multipart&fields=id,modifiedTime`, {
      method: 'PATCH', body: multipart({ name }, blob),
    })).json();
  }
  return (await api(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST', body: multipart({ name, parents: [parent], appProperties: { novelProjectId: pid } }, blob),
  })).json();
}

export async function remoteInfo(projectId) { return findByProp('novelProjectId', projectId); }

export async function listBundles() {
  const parent = await ensureFolder();
  const r = await (await api(`${API}/files?q=${q(`'${parent}' in parents and trashed=false and name contains '.novel.json'`)}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,size)&spaces=drive`)).json();
  return r.files || [];
}

export async function pullBundle(fileId) {
  return (await api(`${API}/files/${fileId}?alt=media`)).json();
}

/** 원고 파일(docx 등)을 드라이브 폴더에 올린다. asGoogleDoc이면 Google 문서로 변환 */
export async function uploadFile(blob, name, { asGoogleDoc = false } = {}) {
  const parent = await ensureFolder();
  const meta = { name: asGoogleDoc ? name.replace(/\.docx$/i, '') : name, parents: [parent] };
  if (asGoogleDoc) meta.mimeType = 'application/vnd.google-apps.document';
  return (await api(`${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, { method: 'POST', body: multipart(meta, blob) })).json();
}
