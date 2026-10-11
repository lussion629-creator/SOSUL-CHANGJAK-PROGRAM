#!/usr/bin/env node
// 소설 워드프로세서 동기화 서버
// - 데스크톱·노트북·휴대폰 어디서든 같은 작품을 이어 쓰도록 작품 묶음(압축한 백업 파일)을 보관한다.
// - 작품마다 파일 하나를 두고 덮어쓰며, 덮어쓰기 전 판은 history/ 에 몇 개 남겨 둔다.
// - 접속 암호(SYNC_CODE) 하나로 들어온다. 비워 두면 처음 켤 때 만들어 data/access-code.txt 에 적어 둔다.
// - 빌드한 앱 화면(dist)이 있으면 같은 주소에서 앱도 열어 준다. 다른 프로그램은 필요 없다(Node 18 이상).
//
// 환경 변수: PORT(기본 8787), HOST(기본 0.0.0.0), DATA_DIR(기본 ./data), SYNC_CODE, APP_DIR(기본 ../dist), MAX_MB(기본 300), KEEP(기본 10)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const APP = path.resolve(process.env.APP_DIR || path.join(HERE, '..', 'dist'));
const MAX = (+process.env.MAX_MB || 300) * 1024 * 1024;
const KEEP = Math.max(0, +(process.env.KEEP ?? 10));
const VERSION = '1';

const PROJ = path.join(DATA, 'projects');
const HIST = path.join(DATA, 'history');
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(HIST, { recursive: true });

// ---------- 접속 암호 ----------
function loadCode() {
  if (process.env.SYNC_CODE) return process.env.SYNC_CODE.trim();
  const f = path.join(DATA, 'access-code.txt');
  try { const c = fs.readFileSync(f, 'utf8').trim(); if (c) return c; } catch { /* 처음 */ }
  const c = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(f, c + '\n', { mode: 0o600 });
  return c;
}
const CODE = loadCode();
if (CODE.length < 8) { console.error('SYNC_CODE는 8자 이상으로 정해 주세요.'); process.exit(1); }
const CODE_HASH = crypto.createHash('sha256').update(CODE).digest();
const okCode = (s) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(s)).digest(), CODE_HASH);

// 암호를 자꾸 틀리는 곳은 잠시 막는다 (10분에 10번)
const fails = new Map();
const ipOf = (req) => req.socket.remoteAddress || '';
function blocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > 10 * 60e3) { fails.delete(ip); return false; }
  return f.n >= 10;
}
function failed(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.since > 10 * 60e3) fails.set(ip, { n: 1, since: Date.now() });
  else f.n++;
}

// ---------- 작품 파일 ----------
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const fileOf = (id) => path.join(PROJ, id + '.bin');
const metaOf = (id) => path.join(PROJ, id + '.json');
async function readMeta(id) {
  try { return JSON.parse(await fsp.readFile(metaOf(id), 'utf8')); } catch { return null; }
}
async function writeAtomic(file, data) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
// 같은 작품에 동시에 올리면 차례로 처리한다
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}
async function keepHistory(id, meta) {
  if (!KEEP || !meta) return;
  const dir = path.join(HIST, id);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = meta.modifiedTime.replace(/[:.]/g, '-');
  try { await fsp.copyFile(fileOf(id), path.join(dir, stamp + '.bin')); } catch { return; }
  const old = (await fsp.readdir(dir)).filter((f) => f.endsWith('.bin')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) await fsp.rm(path.join(dir, f), { force: true });
}

// ---------- 응답 ----------
const CORS = {
  // 쿠키가 아니라 접속 암호로 들어오므로 어느 주소의 앱(웹·데스크톱)에서든 부를 수 있게 둔다
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Name, X-Base-Time',
  'Access-Control-Expose-Headers': 'X-Modified-Time, X-Name',
  'Access-Control-Max-Age': '600',
};
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = body == null ? '' : isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}
const err = (res, status, message, extra) => send(res, status, { error: message, ...extra });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = +req.headers['content-length'];
    if (len > MAX) { reject(Object.assign(new Error('too large'), { status: 413 })); return; }
    const parts = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

// ---------- API ----------
async function api(req, res, parts) {
  // 앱이 이 서버가 맞는지 알아보는 곳 (암호 없이)
  if (parts[0] === 'hello' && parts.length === 1) return send(res, 200, { app: 'novel-sync', version: VERSION });

  const ip = ipOf(req);
  if (blocked(ip)) return err(res, 429, '접속 암호를 여러 번 틀렸어요. 10분 뒤 다시 해 주세요.');
  const auth = req.headers.authorization || '';
  const code = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!code || !okCode(code)) { failed(ip); return err(res, 401, '접속 암호가 맞지 않아요.'); }
  fails.delete(ip);

  if (parts[0] === 'ping' && parts.length === 1) return send(res, 200, { ok: true, version: VERSION, time: new Date().toISOString() });

  if (parts[0] !== 'projects') return err(res, 404, '없는 주소예요.');

  if (parts.length === 1) {
    if (req.method !== 'GET') return err(res, 405, '지원하지 않는 요청이에요.');
    const out = [];
    for (const f of await fsp.readdir(PROJ)) {
      if (!f.endsWith('.json')) continue;
      const m = await readMeta(f.slice(0, -5));
      if (m) out.push(m);
    }
    out.sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1));
    return send(res, 200, out);
  }

  const id = parts[1];
  if (!ID.test(id)) return err(res, 400, '작품 번호가 올바르지 않아요.');

  if (parts.length === 3 && parts[2] === 'info' && req.method === 'GET') {
    const m = await readMeta(id);
    return m ? send(res, 200, m) : err(res, 404, '서버에 이 작품이 없어요.');
  }
  if (parts.length !== 2) return err(res, 404, '없는 주소예요.');

  if (req.method === 'GET') {
    const m = await readMeta(id);
    if (!m) return err(res, 404, '서버에 이 작품이 없어요.');
    const data = await fsp.readFile(fileOf(id));
    return send(res, 200, data, { 'X-Modified-Time': m.modifiedTime, 'X-Name': encodeURIComponent(m.name) });
  }

  if (req.method === 'PUT') {
    const data = await readBody(req);
    if (!data.length) return err(res, 400, '보낸 내용이 비어 있어요.');
    let name = '작품';
    try { name = decodeURIComponent(req.headers['x-name'] || '') || name; } catch { /* 그대로 */ }
    name = name.replace(/[\u0000-\u001f]/g, '').slice(0, 200);
    const base = req.headers['x-base-time'] || '';
    return withLock(id, async () => {
      const cur = await readMeta(id);
      // 다른 기기가 그사이 먼저 올렸으면 덮어쓰지 않는다 (앱이 받아서 합친 뒤 다시 올린다)
      if (cur && base !== '*' && base !== cur.modifiedTime) return err(res, 409, '다른 기기에서 먼저 올렸어요.', { current: cur });
      await keepHistory(id, cur);
      let t = new Date();
      if (cur && t.toISOString() <= cur.modifiedTime) t = new Date(Date.parse(cur.modifiedTime) + 1);
      const meta = { id, name, modifiedTime: t.toISOString(), size: data.length };
      await writeAtomic(fileOf(id), data);
      await writeAtomic(metaOf(id), JSON.stringify(meta));
      return send(res, 200, meta);
    });
  }

  if (req.method === 'DELETE') {
    return withLock(id, async () => {
      const cur = await readMeta(id);
      if (!cur) return err(res, 404, '서버에 이 작품이 없어요.');
      await keepHistory(id, cur);
      await fsp.rm(fileOf(id), { force: true });
      await fsp.rm(metaOf(id), { force: true });
      return send(res, 200, { ok: true });
    });
  }
  return err(res, 405, '지원하지 않는 요청이에요.');
}

// ---------- 앱 화면 (dist가 있을 때) ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.ico': 'image/x-icon', '.mjs.map': 'application/json', '.map': 'application/json',
};
const hasApp = fs.existsSync(path.join(APP, 'index.html'));
async function serveApp(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return err(res, 400, 'bad path'); }
  let file = path.join(APP, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (file !== APP && !file.startsWith(APP + path.sep)) return err(res, 403, 'forbidden');
  try { if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html'); } catch { file = path.join(APP, 'index.html'); }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': file.endsWith('index.html') || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { err(res, 404, 'not found'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        // 공개 주소의 웹 앱이 집 안 서버(NAS 등)를 부를 때 크롬이 묻는 허락
        return send(res, 204, null, req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {});
      }
      return await api(req, res, url.pathname.slice(5).split('/').filter(Boolean));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return err(res, 405, 'method');
    if (!hasApp) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('소설 워드프로세서 동기화 서버가 켜져 있어요. 앱의 설정 → 저장 방식 → 개인 서버에 이 주소를 넣어 주세요.\n');
    }
    return await serveApp(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) err(res, e.status || 500, e.status === 413 ? '파일이 너무 커요.' : '서버 오류');
  }
});
server.requestTimeout = 10 * 60e3;
server.listen(PORT, HOST, () => {
  console.log(`소설 워드프로세서 동기화 서버: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`작품 보관 폴더: ${DATA}`);
  console.log(hasApp ? `앱 화면도 같은 주소에서 열려요 (${APP})` : '앱 화면 폴더(dist)가 없어 동기화만 해요.');
  console.log(process.env.SYNC_CODE ? '접속 암호: SYNC_CODE 환경 변수에 넣은 값' : `접속 암호: ${CODE}  (${path.join(DATA, 'access-code.txt')})`);
});
