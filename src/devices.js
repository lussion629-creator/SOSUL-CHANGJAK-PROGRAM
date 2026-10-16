// 내 기기: 데스크톱·랩톱(·휴대폰)을 서로 등록해 같은 작품을 이어 쓴다.
// - 동기화할 때마다 이 기기를 동기화 장소(드라이브 폴더의 ‘기기 목록’ 또는 개인 서버)에 이름과 함께 적어 둔다.
// - ‘연결 코드’: 이미 연결한 기기에서 만든 코드를 다른 기기에 넣으면 같은 곳으로 연결하고 작품을 모두 받아 온다.
// - 데스크톱 앱은 이 컴퓨터를 동기화 서버로 켤 수 있다: 같은 집·사무실의 다른 컴퓨터가 구글 없이 바로 붙는다.
import * as S from './store.js';
import * as G from './gdrive.js';
import * as SV from './syncserver.js';
import { app, saveSettings, syncNow, refreshSyncPill, syncTarget } from './app.js';
import { useTarget } from './features.js';
import { $, h, dialog, ago } from './ui.js';

const ID_LS = 'nw-device-id';
export function deviceId() {
  try {
    let id = localStorage.getItem(ID_LS);
    if (!id) { id = 'd' + S.uid(); localStorage.setItem(ID_LS, id); }
    return id;
  } catch { return 'd-unknown'; }
}
const PLATFORM = { win32: 'Windows', darwin: 'Mac', linux: 'Linux' };
function platformLabel() {
  if (window.desktop?.platform) return PLATFORM[window.desktop.platform] || window.desktop.platform;
  const ua = navigator.userAgent;
  return /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone·iPad' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '브라우저';
}
let hostName = '';
export const deviceName = () => app.settings.deviceName || hostName || `${platformLabel()} ${window.desktop ? '컴퓨터' : '브라우저'}`;
const backend = () => (syncTarget() === 'server' ? SV : syncTarget() === 'drive' ? G : null);
const appVersion = () => (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '');

// 동기화가 끝나면 이 기기를 목록에 적는다 (10분에 한 번쯤)
let lastReg = 0;
async function register(B = backend(), force = false) {
  if (!B?.putDevice || (!force && Date.now() - lastReg < 10 * 60e3)) return null;
  lastReg = Date.now();
  return B.putDevice({ id: deviceId(), name: deviceName(), platform: platformLabel(), app: appVersion() });
}
export function bindDevices() {
  app.hooks.afterSync.push((B) => { register(B).catch(() => {}); });
  window.desktop?.deviceInfo?.().then((d) => { if (d?.name) hostName = d.name.replace(/\.local$/, ''); }).catch(() => {});
}

// ---------- 연결 코드 ----------
// NW1-<base64url(JSON)>: 드라이브 {t:'d', i: 클라이언트 ID} · 서버 {t:'s', u: [주소…], c: 접속 암호}
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
export function makeCode(info) { return 'NW1-' + b64(JSON.stringify(info)); }
export function readCode(code) {
  const m = String(code || '').trim().replace(/\s+/g, '').match(/^NW1-([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error('연결 코드 모양이 아니에요. NW1- 로 시작하는 코드를 통째로 붙여 넣어 주세요.');
  let o;
  try { o = JSON.parse(unb64(m[1])); } catch { throw new Error('연결 코드를 읽지 못했어요. 빠진 글자가 없는지 확인해 주세요.'); }
  if (o.t === 'd' && typeof o.i === 'string' && /\.apps\.googleusercontent\.com$/.test(o.i)) return { t: 'd', i: o.i };
  if (o.t === 's' && Array.isArray(o.u) && o.u.every((u) => typeof u === 'string') && typeof o.c === 'string' && o.c.length >= 8) return { t: 's', u: o.u.map(SV.normUrl).filter(Boolean), c: o.c };
  throw new Error('이 앱의 연결 코드가 아니에요.');
}
// 지금 이 기기의 연결로 코드 만들기 (서버가 이 컴퓨터면 다른 컴퓨터가 닿을 수 있는 주소로)
async function codeHere() {
  const t = syncTarget();
  if (t === 'drive' && app.settings.driveClientId) return makeCode({ t: 'd', i: app.settings.driveClientId });
  if (t === 'server' && SV.status().configured) {
    let urls = [SV.status().url];
    if (/\/\/(localhost|127\.0\.0\.1)[:/]/.test(urls[0]) && window.desktop?.hostServer) {
      const hs = await window.desktop.hostServer();
      if (hs?.urls?.length) urls = hs.urls;
    }
    return makeCode({ t: 's', u: urls, c: SV.savedCode() });
  }
  return '';
}

// 코드로 연결: 서버는 주소를 차례로 시험해 닿는 곳으로, 드라이브는 구글 로그인 한 번
async function joinWith(info, say) {
  if (info.t === 's') {
    let ok = '';
    for (const u of info.u) {
      say(`${u} 에 닿는지 확인하는 중…`);
      try { await SV.test(u, info.c); ok = u; break; } catch { /* 다음 주소 */ }
    }
    if (!ok) throw new Error('서버에 닿지 못했어요. 두 컴퓨터가 같은 와이파이(공유기)에 있는지, 서버 컴퓨터의 앱이 켜져 있는지 확인해 주세요. Windows 방화벽 창이 떴다면 ‘허용’을 눌러 주세요.');
    SV.saveCode(info.c, true);
    app.settings.syncServer = ok;
    app.settings.autoSync = true;
    saveSettings();
    SV.configure(ok);
    useTarget('server');
    return 'server';
  }
  app.settings.driveClientId = info.i;
  app.settings.autoSync = true;
  saveSettings();
  G.configure(info.i);
  say('구글 로그인 창에서 같은 계정을 골라 주세요…');
  await G.connect();
  useTarget('drive');
  return 'drive';
}

// 동기화 장소에 있는데 이 기기에는 없는 작품을 모두 받아 온다
export async function pullAll(say = () => {}) {
  const t = syncTarget();
  const B = t === 'server' ? SV : t === 'drive' ? G : null;
  if (!B) return 0;
  const here = new Set((await S.listProjects()).map((p) => p.id));
  const files = await B.listBundles();
  let n = 0;
  for (const f of files) {
    const pid = t === 'server' ? f.id : f.appProperties?.novelProjectId;
    if (pid && here.has(pid)) continue;
    say(`작품 받는 중… (${n + 1}) ${String(f.name || '').replace(/\.novel\.json(\.gz)?$/, '')}`);
    const b = await B.pullBundle(f.id, S.readBundleBytes);
    if (here.has(b?.project?.id)) continue;
    const p = await S.importBundle(b, { mode: 'merge' });
    if (t === 'server') p.srvSyncedAt = f.modifiedTime; else { p.syncedAt = f.modifiedTime; p.driveFileId = f.id; }
    await S.putProject(p);
    here.add(p.id);
    n++;
  }
  return n;
}

// ---------- 내 기기 창 ----------
export async function showDevices() {
  const t = syncTarget();
  const B = backend();
  const desk = !!window.desktop?.hostServer;
  let hs = desk ? await window.desktop.hostServer().catch(() => null) : null;
  const where = t === 'drive' ? '구글 드라이브' : t === 'server' ? `개인 서버 (${h(SV.status().url)})` : '이 기기에만 (연결 안 함)';
  const connected = !!B?.status().connected;
  const r = await dialog({
    title: '내 기기 연결',
    wide: true,
    body: `<div class="rd-set dev-set">
      <p style="margin:0;line-height:1.6">데스크톱과 랩톱처럼 내 컴퓨터끼리 같은 작품을 이어 쓰려면, 두 기기를 <b>같은 곳</b>(구글 드라이브 또는 개인 서버)에 연결하면 돼요. 이미 연결한 기기에서 <b>연결 코드</b>를 만들어 다른 기기에 넣으면 한 번에 연결되고 작품도 모두 받아 와요.</p>
      <label class="field"><span>이 기기 이름</span><input name="dname" value="${h(deviceName())}" maxlength="40" placeholder="예: 집 데스크톱, 노트북"></label>
      <p class="hint" style="margin:0">지금 저장 방식: <b>${where}</b>${B && !connected ? ' · 연결이 끊겨 있어요' : ''}</p>
      <section>
        <h3>등록된 기기</h3>
        <div id="devList" class="dev-list"><p class="hint">${B ? '불러오는 중…' : '드라이브나 개인 서버에 연결하면 여기에 기기들이 보여요.'}</p></div>
      </section>
      <section>
        <h3>다른 기기 연결하기</h3>
        <div class="dev-btns">
          <button type="button" class="small primary" data-d="make" ${B ? '' : 'disabled'}>이 기기의 연결 코드 만들기</button>
          <button type="button" class="small" data-d="join">받은 연결 코드 넣기</button>
          <button type="button" class="small" data-d="pull" ${B ? '' : 'disabled'}>이 기기에 없는 작품 모두 받아 오기</button>
        </div>
        <div id="devCode" class="dev-code" hidden><textarea readonly rows="3" aria-label="연결 코드"></textarea><button type="button" class="small" data-d="copy">복사</button>
          <p class="hint" style="margin:0">다른 기기에서 <b>설정 → 내 기기 연결 → 받은 연결 코드 넣기</b>에 붙여 넣으세요. 코드에는 접속 암호가 들어 있으니 다른 사람에게 보내지 마세요.</p></div>
        <div id="devJoin" class="dev-code" hidden><textarea name="code" rows="3" placeholder="NW1-…" aria-label="받은 연결 코드" spellcheck="false"></textarea><button type="button" class="small primary" data-d="go">연결</button></div>
        <p id="devMsg" class="hint" aria-live="polite" style="margin:0"></p>
      </section>
      ${desk ? `<section>
        <h3>이 컴퓨터를 동기화 서버로 쓰기 <small>구글 없이 · 같은 와이파이(공유기)</small></h3>
        <label class="check"><input type="checkbox" name="host" ${hs?.on ? 'checked' : ''}> 이 컴퓨터에 작품을 모아 두고, 같은 집·사무실의 다른 컴퓨터가 여기에 붙게 하기</label>
        <p class="hint" id="hostInfo" style="margin:0"></p>
      </section>` : ''}
    </div>`,
    buttons: [{ label: '닫기', value: 'close' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f) => {
      const msg = $('#devMsg');
      const say = (s) => { msg.textContent = s; };
      const drawList = async () => {
        const el = $('#devList');
        if (!B) return;
        try {
          if (connected) await register(B, true).catch(() => {});
          const list = await B.devices();
          if (list == null) { el.innerHTML = '<p class="hint">이 서버는 기기 목록을 지원하지 않는 예전 판이에요. 서버를 새 판으로 올리면 보여요.</p>'; return; }
          const me = deviceId();
          el.innerHTML = list.length ? list.map((d) => `<div class="dev-row${d.id === me ? ' me' : ''}"><b>${h(d.name)}</b><small>${h(d.platform || '')}${d.app ? ' · ' + h(d.app) : ''} · 마지막 동기화 ${h(d.lastSync ? ago(Date.parse(d.lastSync)) : '없음')}</small>${d.id === me ? '<span class="pill ok">이 기기</span>' : `<button type="button" class="small" data-d="rm" data-id="${h(d.id)}" title="목록에서 빼기" aria-label="${h(d.name)} 목록에서 빼기">✕</button>`}</div>`).join('') : '<p class="hint">아직 등록된 기기가 없어요.</p>';
        } catch (e) { el.innerHTML = `<p class="hint">${h(e.message)}</p>`; }
      };
      drawList();
      const showHost = (x) => {
        const el = $('#hostInfo');
        if (!el) return;
        if (!x?.on) { el.textContent = x?.error ? '✕ ' + x.error : '켜면 이 컴퓨터가 동기화 서버가 돼요. 이 컴퓨터는 켜 둬야 다른 컴퓨터가 맞출 수 있어요.'; return; }
        el.innerHTML = `켜져 있어요. 다른 컴퓨터는 아래 ‘연결 코드’로 붙거나, 브라우저로 ${x.urls.map((u) => `<code>${h(u)}</code>`).join(' · ') || '(네트워크 주소 없음)'} 을 열어도 돼요. Windows 방화벽 창이 뜨면 ‘허용’을 눌러 주세요.`;
      };
      showHost(hs);
      f.host?.addEventListener('change', async () => {
        say(f.host.checked ? '서버를 켜는 중…' : '서버를 끄는 중…');
        hs = await window.desktop.hostServer(f.host.checked);
        showHost(hs);
        if (hs?.on && hs.code) {
          // 이 컴퓨터도 자기 서버에 맞춘다 (지금 작품을 올려 둔다)
          SV.saveCode(hs.code, true);
          app.settings.syncServer = hs.local; app.settings.autoSync = true; saveSettings();
          SV.configure(hs.local);
          for (let i = 0; i < 20; i++) { try { await SV.test(hs.local, hs.code); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
          useTarget('server');
          await syncNow({ quiet: true });
          say('이 컴퓨터를 동기화 서버로 켜고 지금 작품을 올렸어요. 이제 ‘이 기기의 연결 코드 만들기’로 다른 컴퓨터를 연결하세요.');
          f.querySelector('[data-d=make]').disabled = false;
        } else if (!hs?.on) say(hs?.error ? '✕ ' + hs.error : '서버를 껐어요. 이 컴퓨터에 모아 둔 작품은 그대로 남아요.');
      });
      f.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-d]');
        if (!b) return;
        const act = b.dataset.d;
        if (act === 'make') {
          const code = await codeHere();
          if (!code) { say('먼저 드라이브나 개인 서버에 연결해 주세요.'); return; }
          $('#devCode').hidden = false; $('#devJoin').hidden = true;
          $('#devCode textarea').value = code; $('#devCode textarea').select();
          say('');
        } else if (act === 'copy') {
          try { await navigator.clipboard.writeText($('#devCode textarea').value); say('복사했어요.'); } catch { $('#devCode textarea').select(); say('Ctrl+C로 복사해 주세요.'); }
        } else if (act === 'join') {
          $('#devJoin').hidden = false; $('#devCode').hidden = true; f.code.focus();
        } else if (act === 'go') {
          let info;
          try { info = readCode(f.code.value); } catch (err) { say('✕ ' + err.message); return; }
          b.disabled = true;
          try {
            const kind = await joinWith(info, say);
            say('연결했어요. 작품을 받아 오는 중…');
            await syncNow({ quiet: true });
            const n = await pullAll(say);
            await register(kind === 'server' ? SV : G, true).catch(() => {});
            say(`연결했어요. ${n ? `작품 ${n}개를 받아 왔어요. 왼쪽 위 작품 목록에서 열 수 있어요.` : '받아 올 새 작품은 없었어요.'} 이제 이 기기에서 쓴 글도 자동으로 맞춰져요.`);
            refreshSyncPill();
          } catch (err) { say('✕ ' + err.message); }
          b.disabled = false;
        } else if (act === 'pull') {
          b.disabled = true;
          try { const n = await pullAll(say); say(n ? `작품 ${n}개를 받아 왔어요.` : '이 기기에 없는 작품은 없어요.'); } catch (err) { say('✕ ' + err.message); }
          b.disabled = false;
        } else if (act === 'rm') {
          try { await B.removeDevice(b.dataset.id); drawList(); } catch (err) { say('✕ ' + err.message); }
        }
      });
    },
  });
  if (r.value === 'ok' && r.form) {
    const n = r.form.dname.value.trim();
    if (n !== (app.settings.deviceName || '')) {
      app.settings.deviceName = n;
      saveSettings();
      register(backend(), true).catch(() => {});
    }
  }
  refreshSyncPill();
}

