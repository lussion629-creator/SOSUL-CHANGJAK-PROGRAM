// 동기화 서버 (직접 띄운 server/server.mjs)
// - 구글 드라이브 동기화(gdrive.js)와 같은 모양으로 쓴다: 작품마다 파일 하나를 서버에 두고 덮어쓴다.
// - 서버 주소는 설정에, 접속 암호는 이 기기에만 둔다(백업·동기화 파일에 들어가지 않음).

const CODE_KEY = 'nw-sync-code';
let base = '';
let code = '';
let lastErr = '';
const listeners = new Set();

export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(status()));

export class SyncError extends Error {
  constructor(message, { status = 0, current = null } = {}) { super(message); this.status = status; this.current = current; this.conflict = status === 409; }
}

/** 사람이 넣은 주소를 다듬는다: 끝 / 와 /api 를 떼고, 앞에 주소 방식이 없으면 붙인다 */
export function normUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s) ? 'http://' : 'https://') + s;
  try {
    const url = new URL(s);
    return (url.origin + url.pathname).replace(/\/+$/, '').replace(/\/api$/, '');
  } catch { return ''; }
}

export function savedCode() {
  try { return localStorage.getItem(CODE_KEY) || sessionStorage.getItem(CODE_KEY) || ''; } catch { return ''; }
}
export function saveCode(c, remember = true) {
  try {
    localStorage.removeItem(CODE_KEY); sessionStorage.removeItem(CODE_KEY);
    if (c) (remember ? localStorage : sessionStorage).setItem(CODE_KEY, c);
  } catch { /* 저장소 사용 불가 */ }
}

export function configure(url) {
  base = normUrl(url);
  code = savedCode();
  lastErr = '';
  emit();
}
export function status() {
  const configured = !!base && !!code;
  return { configured, connected: configured, hadToken: configured, url: base, error: lastErr };
}
export function disconnect() { saveCode(''); code = ''; emit(); }

async function call(path, init = {}, { url = base, key = code } = {}) {
  if (!url) throw new SyncError('먼저 동기화 서버 주소를 넣어 주세요.');
  if (!key) throw new SyncError('먼저 접속 암호를 넣어 주세요.');
  let res;
  try {
    res = await fetch(url + '/api' + path, { ...init, cache: 'no-store', headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) } });
  } catch {
    const mixed = location.protocol === 'https:' && url.startsWith('http:');
    throw new SyncError(mixed
      ? '이 화면(https)에서는 http 주소의 서버에 붙을 수 없어요. 데스크톱 앱을 쓰거나, 서버 주소로 앱을 열어 주세요.'
      : '서버에 닿지 못했어요. 주소와 인터넷 연결, 서버가 켜져 있는지 확인해 주세요.');
  }
  if (!res.ok) {
    let j = {};
    try { j = await res.json(); } catch { /* 본문 없음 */ }
    const msg = res.status === 401 ? '접속 암호가 맞지 않아요.' : j.error || `서버 오류 ${res.status}`;
    if (res.status !== 409 && res.status !== 404) { lastErr = msg; emit(); }
    throw new SyncError(msg, { status: res.status, current: j.current || null });
  }
  if (lastErr) { lastErr = ''; emit(); }
  return res;
}

/** 주소와 암호가 맞는지 확인 (저장 전에 시험할 수 있게 값을 따로 받는다) */
export async function test(url, key) {
  const u = normUrl(url);
  if (!u) throw new SyncError('서버 주소가 올바르지 않아요.');
  const r = await call('/ping', {}, { url: u, key });
  const j = await r.json();
  if (!j.ok) throw new SyncError('동기화 서버가 아닌 것 같아요.');
  return j;
}

/** 앱을 서버 주소로 열었으면 그 주소를 알려 준다 */
export async function sameOriginServer() {
  try {
    const r = await fetch('./api/hello', { cache: 'no-store' });
    if (r.ok && (await r.json()).app === 'novel-sync') return normUrl(new URL('.', location.href).href);
  } catch { /* 아님 */ }
  return '';
}

/** 작품 올리기. baseTime: 이 기기가 마지막으로 맞춘 서버 시각(없으면 새로 올림). 반환: {id, modifiedTime, size} */
export async function pushBundle(bundle, blob, { baseTime } = {}) {
  const pid = bundle.project.id;
  return (await call(`/projects/${encodeURIComponent(pid)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Name': encodeURIComponent(bundle.project.title || '작품'), 'X-Base-Time': baseTime || '' },
    body: blob,
  })).json();
}

export async function remoteInfo(projectId) {
  try { return await (await call(`/projects/${encodeURIComponent(projectId)}/info`)).json(); } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function listBundles() { return (await call('/projects')).json(); }

export async function pullBundle(id, read) {
  return read(await (await call(`/projects/${encodeURIComponent(id)}`)).arrayBuffer());
}
