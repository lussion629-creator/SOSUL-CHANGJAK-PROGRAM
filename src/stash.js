// 문장 보관함: 지우거나 잘라 낸 50자 이상의 문장·문단을 작품마다 모두 모아 둔다.
// 고른 글을 지우거나(Backspace·Delete) 잘라 내거나 그 위에 새로 쓰거나 붙여 넣은 경우,
// 그리고 한 글자씩 이어서 지운 글자가 모여 50자를 넘은 경우를 담는다. 되돌리기·장 바꾸기 같은 프로그램의 변경은 담지 않는다.
import * as S from './store.js';
import { app, isTabOpen } from './app.js';
import { $, h, toast, confirmDlg, fullTime } from './ui.js';

export const STASH_MIN = 50;
const len = (t) => (t || '').replace(/\s+/g, ' ').trim().length;

// 보관함 읽기·쓰기는 한 줄로 세워 서로 덮어쓰지 않게 한다
let q = Promise.resolve();
const inQ = (fn) => { const p = q.then(fn); q = p.catch(() => {}); return p; };

export function addToStash(text, kind, { pid = app.project?.id, ch = app.cur } = {}) {
  text = (text || '').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!pid || len(text) < STASH_MIN) return Promise.resolve(false);
  const title = app.chapters?.get(ch)?.title || '';
  return inQ(async () => {
    const list = await S.stashOf(pid);
    const same = list.find((x) => !x.gone && x.text === text);
    if (same) { same.t = Date.now(); same.kind = kind; same.ch = ch; same.title = title; }
    else list.push({ id: S.uid(), t: Date.now(), text, kind, ch, title });
    await S.putStash(pid, list);
    return true;
  }).then((r) => { if (isTabOpen('stash') && pid === app.project?.id) renderStash(); markTab(); return r; })
    .catch((e) => { console.warn(e); return false; });
}

// ---------- 지운 글 잡기 ----------
let lastKey = { t: 0, key: '' }; // 편집기에서 마지막으로 누른 키
let buf = null; // 한 글자씩 이어 지운 글: { text, at, pid, ch, t }
let bufTimer;

function flush() {
  clearTimeout(bufTimer);
  if (!buf) return;
  const b = buf; buf = null;
  if (len(b.text) >= STASH_MIN) addToStash(b.text, 'del', b);
}
// 이어서 지우기: Backspace는 앞쪽으로, Delete는 같은 자리에서 뒤쪽으로 붙는다
function collect(text, from, to, key) {
  const pid = app.project?.id, ch = app.cur;
  if (buf && (buf.pid !== pid || buf.ch !== ch)) flush();
  if (buf && key === 'Backspace' && to === buf.at) { buf.text = text + buf.text; buf.at = from; }
  else if (buf && key === 'Delete' && from === buf.at) buf.text += text;
  else { flush(); buf = { text, at: from, pid, ch }; }
  clearTimeout(bufTimer);
  bufTimer = setTimeout(flush, 4000);
}

export function initStash() {
  const host = $('#editorHost');
  host.addEventListener('keydown', (e) => { lastKey = { t: Date.now(), key: e.key }; }, true);
  // 휴대폰 자판은 keydown에 키 이름을 주지 않으니 beforeinput의 종류로 가린다
  host.addEventListener('beforeinput', (e) => {
    const it = e.inputType || '';
    const key = /^delete.*Backward$/.test(it) ? 'Backspace' : /^delete.*Forward$/.test(it) ? 'Delete' : it.startsWith('delete') ? 'Delete' : lastKey.key === 'Process' ? 'Process' : 'input';
    lastKey = { t: Date.now(), key };
  }, true);
  host.addEventListener('compositionstart', () => { lastKey = { t: Date.now(), key: 'Process' }; }, true);
  addEventListener('pagehide', flush);
  app.hooks.afterOpen.push(() => { flush(); if (isTabOpen('stash')) renderStash(); });

  app.editor.on('transaction', ({ transaction: tr }) => {
    if (!tr.docChanged) return;
    // 모으는 중인 지운 자리는 다른 변경을 따라 옮긴다
    if (!onChange(tr) && buf) buf.at = tr.mapping.map(buf.at);
  });
  // 보관함 목록 동작
  $('#stashList').addEventListener('click', onListClick);
  $('#stashSearch').addEventListener('input', renderStash);
}

// 지운 글을 모으는 데 썼으면 true
function onChange(tr) {
  if (!app.project || !app.cur) return;
  if (tr.getMeta('preventUpdate') || tr.getMeta('history$') || tr.getMeta('addToHistory') === false) return;
  const ev = tr.getMeta('uiEvent');
  const recent = Date.now() - lastKey.t < 600;
  if (ev !== 'cut' && ev !== 'paste' && ev !== 'drop' && !recent) return; // 사람이 손으로 한 변경만
  let del = '', ins = '', from = -1, to = -1, steps = 0;
  tr.steps.forEach((st, i) => {
    if (!st.slice || st.to == null) return;
    const d = tr.docs[i];
    if (st.to > st.from) {
      del += (del ? '\n' : '') + d.textBetween(st.from, st.to, '\n', '');
      if (!steps) { from = st.from; to = st.to; }
      steps++;
    }
    if (st.slice.content.size) ins += st.slice.content.textBetween(0, st.slice.content.size, '\n', '');
  });
  if (!del) { flush(); return; } // 새로 쓰기 시작하면 모은 것을 담는다
  if (ev === 'drop' && del.replace(/\s/g, '') === ins.replace(/\s/g, '')) return; // 끌어서 옮기기
  if (ev === 'cut') { flush(); addToStash(del, 'cut'); return; }
  const key = lastKey.key;
  const keyDel = !ev && (key === 'Backspace' || key === 'Delete') && !ins;
  // 한 글자(또는 낱말)씩 지우기는 모아 두었다가 50자가 넘으면 담는다
  if (keyDel && steps === 1 && len(del) < STASH_MIN) { collect(del, from, to, key); return true; }
  if (keyDel && steps === 1 && buf) { collect(del, from, to, key); flush(); return true; }
  flush();
  addToStash(del, ev === 'paste' || ins ? 'over' : 'del');
}

// ---------- 보관함 화면 ----------
const KIND = { cut: '잘라냄', del: '지움', over: '덮어씀' };
let shown = [];

function markTab() {
  const b = document.querySelector('.tabs [data-tab="stash"]');
  if (b && !isTabOpen('stash')) b.classList.add('new');
}

export async function renderStash() {
  const el = $('#stashList');
  if (!el || !app.project) return;
  document.querySelector('.tabs [data-tab="stash"]')?.classList.remove('new');
  const qs = ($('#stashSearch').value || '').trim();
  const all = (await S.stashOf(app.project.id)).filter((x) => !x.gone).sort((a, b) => b.t - a.t);
  shown = qs ? all.filter((x) => x.text.includes(qs) || (x.title || '').includes(qs)) : all;
  $('#stashCount').textContent = all.length ? `${all.length}개` : '';
  if (!shown.length) {
    el.innerHTML = `<li class="empty">${qs ? '찾는 문장이 없어요.' : `지우거나 잘라 낸 ${STASH_MIN}자 이상의 문장이 여기에 모여요.`}</li>`;
    return;
  }
  el.innerHTML = shown.map((x) => `<li data-id="${h(x.id)}">
    <p class="stash-text">${h(x.text).replace(/\n/g, '<br>')}</p>
    <div class="stash-meta"><span>${h(x.title || '')}${x.title ? ' · ' : ''}${KIND[x.kind] || '지움'} · ${h(fullTime(x.t))} · ${len(x.text)}자</span>
      <span class="stash-btns"><button class="small" data-do="insert" title="커서 자리에 다시 넣기">넣기</button><button class="small" data-do="copy">복사</button><button class="small" data-do="drop" title="보관함에서 지우기">×</button></span></div>
  </li>`).join('');
}

async function onListClick(e) {
  const b = e.target.closest('[data-do]');
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const x = shown.find((s) => s.id === li.dataset.id);
  if (!x) return;
  if (!b) { li.classList.toggle('open'); return; }
  if (b.dataset.do === 'copy') {
    try { await navigator.clipboard.writeText(x.text); toast('복사했어요.'); } catch { toast('복사하지 못했어요.'); }
  } else if (b.dataset.do === 'insert') {
    const paras = x.text.split(/\n+/).map((p) => `<p>${h(p)}</p>`).join('');
    app.editor.chain().focus().insertContent(x.text.includes('\n') ? paras : h(x.text)).run();
    toast('커서 자리에 넣었어요.');
  } else if (b.dataset.do === 'drop') {
    if (!(await confirmDlg('보관함에서 지우기', '이 문장을 보관함에서 지울까요?', '지우기', true))) return;
    const pid = app.project.id;
    await inQ(async () => {
      const list = await S.stashOf(pid);
      const it = list.find((s) => s.id === x.id);
      if (it) { it.gone = true; it.text = ''; it.t = Date.now(); delete it.title; }
      await S.putStash(pid, list);
    });
    renderStash();
  }
}

// 메뉴에서 열기: 왼쪽 목록을 펴고 보관함 탭으로
export function openStash() {
  const sb = $('#sidebar');
  if (document.body.classList.contains('sb-hidden') || (matchMedia('(max-width: 820px)').matches && !sb.classList.contains('open'))) document.querySelector('#btnSidebar')?.click();
  document.querySelector('.tabs [data-tab="stash"]')?.click();
}
