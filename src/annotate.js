// 본문 주석: 글자에 색인·교정 제안·인용·의도를 달고, 여백(왼쪽·오른쪽)과 '자료'에서 모아 본다.
// 글자에는 주석 아이디만 표시(anno 표시)하고, 내용은 자료(notes)에 type='index'|'fix'|'cite'|'intent'로 저장한다.
// 그래서 백업·드라이브 동기화·버전 기록에 함께 실려 가고, 다른 사람이 같은 작품 파일을 열어 교정 제안을 남길 수 있다.
import * as S from './store.js';
import { app, saveNow, openChapter, saveSettings } from './app.js';
import { parseHtml } from './sanitize.js';
import { isPageView, applyPageView } from './pageview.js';
import { $, h, toast, dialog, confirmDlg, ago } from './ui.js';

export const KINDS = {
  index: { name: '색인', hint: '찾아보기에 올릴 낱말·이름' },
  fix: { name: '교정 제안', hint: '이렇게 고치면 어떨지 제안' },
  cite: { name: '인용', hint: '무엇을 인용했는지 (출처)' },
  intent: { name: '의도', hint: '이 대목으로 무엇을 의도했는지' },
};
export const isAnno = (n) => !!KINDS[n?.type];
const STATUS = { done: '반영함', rejected: '거절함' };

// ---------- 문서 안에서 주석 자리 찾기 ----------
export function annoRanges(doc = app.editor.state.doc) {
  const out = new Map();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      if (m.type.name !== 'anno') continue;
      const r = out.get(m.attrs.id);
      if (r) { r.from = Math.min(r.from, pos); r.to = Math.max(r.to, pos + node.nodeSize); } else out.set(m.attrs.id, { from: pos, to: pos + node.nodeSize, kind: m.attrs.kind, mark: m });
    }
  });
  return out;
}
const textOf = (r) => app.editor.state.doc.textBetween(r.from, r.to, ' ');
// 장 HTML에 이 주석이 남아 있는가
const htmlHas = (html, id) => (html || '').includes(`data-anno="${id}"`);
export function chapterOfAnno(n, curHtml = app.cur ? app.editor.getHTML() : '') {
  if (app.cur && htmlHas(curHtml, n.id)) return app.cur;
  for (const id of app.project.order) if (id !== app.cur && htmlHas(app.chapters.get(id)?.html, n.id)) return id;
  return null;
}

let notes = new Map(); // id → note (지금 작품의 주석)
export async function loadAnnos() {
  notes = new Map((await S.notesOf(app.project.id)).filter(isAnno).map((n) => [n.id, n]));
  return notes;
}
export const annoNote = (id) => notes.get(id);

// ---------- 주석 달기·고치기 ----------
const who = () => app.settings.reviewer || app.settings.author || '';
function formBody(n, quote) {
  const k = n.type;
  const kinds = Object.entries(KINDS).map(([v, x]) => `<label class="chip-radio"><input type="radio" name="kind" value="${v}" ${v === k ? 'checked' : ''}><span>${x.name}</span></label>`).join('');
  return `<div class="anno-quote">“${h(quote.length > 160 ? quote.slice(0, 160) + '…' : quote)}”</div>
    <div class="chip-row" role="radiogroup" aria-label="주석 종류">${kinds}</div>
    <div data-show="index"><label class="field"><span>색인어 (찾아보기에 올릴 말)</span><input name="term" value="${h(n.name || quote.slice(0, 40))}"></label></div>
    <div data-show="fix"><label class="field"><span>이렇게 고치면 어떨까요</span><textarea name="fix" rows="3">${h(n.fix ?? quote)}</textarea></label></div>
    <div data-show="cite"><label class="field"><span>출처 (작품·지은이·쪽, 노래, 성경 구절 등)</span><input name="source" value="${h(n.source || '')}" placeholder="예: 김소월, 「진달래꽃」, 1925"></label></div>
    <label class="field"><span data-label>${{ index: '덧붙일 말 (선택)', fix: '까닭 (선택)', cite: '인용한 까닭·원문과 다른 점 (선택)', intent: '이 대목으로 의도한 것' }[k]}</span><textarea name="body" rows="4">${h(n.body || '')}</textarea></label>
    <label class="field"><span>남긴 사람</span><input name="author" value="${h(n.author ?? who())}" placeholder="이름 (교정해 주는 사람이면 그 사람 이름)"></label>`;
}
function bindForm(f) {
  const upd = () => {
    const k = f.kind.value;
    f.querySelectorAll('[data-show]').forEach((d) => { d.hidden = d.dataset.show !== k; });
    f.querySelector('[data-label]').textContent = { index: '덧붙일 말 (선택)', fix: '까닭 (선택)', cite: '인용한 까닭·원문과 다른 점 (선택)', intent: '이 대목으로 의도한 것' }[k];
  };
  f.addEventListener('change', upd);
  upd();
}
function readForm(f, n) {
  n.type = f.kind.value;
  n.body = f.body.value.trim();
  n.author = f.author.value.trim();
  if (n.type === 'index') n.name = f.term.value.trim() || n.quote.slice(0, 40);
  else n.name = n.quote.slice(0, 40);
  if (n.type === 'fix') n.fix = f.fix.value; else delete n.fix;
  if (n.type === 'cite') n.source = f.source.value.trim(); else delete n.source;
  if (n.author && n.author !== who()) { app.settings.reviewer = n.author; saveSettings(); }
  else if (n.author && !app.settings.reviewer) { app.settings.reviewer = n.author; saveSettings(); }
}

export async function addAnnotation(kind = 'intent') {
  const ed = app.editor;
  const { from, to, empty } = ed.state.selection;
  if (empty) { toast('주석을 달 글자를 먼저 고르세요.'); return; }
  const quote = ed.state.doc.textBetween(from, to, ' ').trim();
  if (!quote) { toast('주석을 달 글자를 먼저 고르세요.'); return; }
  const n = { id: S.uid(), projectId: app.project.id, type: kind, quote, chapterId: app.cur, time: Date.now(), fields: {}, body: '' };
  const r = await dialog({
    title: '주석 달기',
    body: formBody(n, quote),
    buttons: [{ label: '취소', value: 'close' }, { label: '달기', value: 'ok', primary: true }],
    onOpen: (f) => { bindForm(f); (kind === 'fix' ? f.fix : kind === 'index' ? f.term : f.body).focus(); },
  });
  if (r.value !== 'ok') return;
  readForm(r.form, n);
  await S.putNote(n);
  notes.set(n.id, n);
  ed.chain().focus().setTextSelection({ from, to }).setMark('anno', { id: n.id, kind: n.type }).setTextSelection(to).run();
  await saveNow();
  renderRail();
  refreshNotesTab();
  toast(`${KINDS[n.type].name} 주석을 달았어요.`, 1600);
}

export async function editAnno(id) {
  await loadAnnos();
  const n = notes.get(id);
  if (!n) return;
  const live = annoRanges().get(id);
  const chId = live ? app.cur : chapterOfAnno(n);
  const where = chId ? app.chapters.get(chId)?.title : null;
  const r = await dialog({
    title: `${KINDS[n.type].name} 주석`,
    body: `${formBody(n, n.quote || '')}
      <p class="hint" style="margin:0">${where ? `‘${h(where)}’에 있어요. <a href="#" data-go>본문에서 보기</a>` : n.status ? `${STATUS[n.status]} (${ago(n.resolved || n.updated)})` : '본문에서 이 글자가 지워졌어요.'}${n.time ? ` · ${ago(n.time)} 남김` : ''}</p>`,
    buttons: [{ label: '주석 지우기', value: 'delete', left: true }, { label: '취소', value: 'close' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f, dlg) => {
      bindForm(f);
      f.querySelector('[data-go]')?.addEventListener('click', (e) => { e.preventDefault(); dlg.close('close'); gotoAnno(id); });
    },
  });
  if (r.value === 'delete') { await removeAnno(id); return; }
  if (r.value !== 'ok') return;
  const oldKind = n.type;
  readForm(r.form, n);
  await S.putNote(n);
  if (oldKind !== n.type) await setMarkKind(id, n.type);
  renderRail();
  refreshNotesTab();
}

// 장 HTML에서 주석 표시를 바꾸거나 걷어 낸다 (다른 장에 있을 때)
async function editChapterHtml(chId, fn) {
  const c = app.chapters.get(chId);
  if (!c) return;
  const body = parseHtml(c.html);
  fn(body);
  c.html = body.innerHTML; c._count = null; c._paras = undefined; c.updated = Date.now();
  await S.putChapter(c);
  app.states.delete(chId);
}
async function setMarkKind(id, kind) {
  const r = annoRanges().get(id);
  if (r) {
    const type = app.editor.schema.marks.anno;
    app.editor.view.dispatch(app.editor.state.tr.removeMark(r.from, r.to, r.mark).addMark(r.from, r.to, type.create({ id, kind })));
    return;
  }
  const chId = chapterOfAnno(notes.get(id));
  if (chId) await editChapterHtml(chId, (b) => b.querySelectorAll(`[data-anno="${id}"]`).forEach((el) => { el.dataset.kind = kind; el.className = `anno k-${kind}`; }));
}
async function unmark(id) {
  const r = annoRanges().get(id);
  if (r) { app.editor.view.dispatch(app.editor.state.tr.removeMark(r.from, r.to, r.mark)); await saveNow(); return; }
  const chId = chapterOfAnno(notes.get(id) || { id });
  if (chId) await editChapterHtml(chId, (b) => b.querySelectorAll(`[data-anno="${id}"]`).forEach((el) => el.replaceWith(...el.childNodes)));
}

export async function removeAnno(id, ask = true) {
  const n = notes.get(id);
  if (ask && !(await confirmDlg('주석 지우기', `이 ${h(KINDS[n?.type]?.name || '주석')}을(를) 지울까요? 본문 글자는 그대로 남아요.`, '지우기', true))) return;
  await unmark(id);
  await S.deleteNote(id);
  notes.delete(id);
  renderRail();
  refreshNotesTab();
}

// 교정 제안 반영: 고른 글자를 제안한 글로 바꾼다 (실행 취소로 되돌릴 수 있음)
export async function acceptFix(id) {
  const n = notes.get(id);
  const r = annoRanges().get(id);
  if (!n || !r) return;
  const ed = app.editor;
  const tr = ed.state.tr;
  // 이 주석 표시만 빼고 첫 글자의 서식(겹친 다른 주석 포함)을 이어받는다
  const marks = (ed.state.doc.nodeAt(r.from)?.marks || []).filter((m) => !(m.type.name === 'anno' && m.attrs.id === id));
  const fix = (n.fix || '').replace(/\s*\n\s*/g, ' ');
  if (fix) tr.replaceWith(r.from, r.to, ed.schema.text(fix, marks)); else tr.delete(r.from, r.to);
  ed.view.dispatch(tr);
  n.status = 'done'; n.resolved = Date.now();
  await S.putNote(n);
  await saveNow();
  renderRail();
  refreshNotesTab();
  toast('제안을 반영했어요. Ctrl+Z로 되돌릴 수 있어요.', 2400);
}
export async function rejectFix(id) {
  const n = notes.get(id);
  if (!n) return;
  await unmark(id);
  n.status = 'rejected'; n.resolved = Date.now();
  await S.putNote(n);
  renderRail();
  refreshNotesTab();
}

export async function gotoAnno(id) {
  const n = notes.get(id) || (await loadAnnos()).get(id);
  if (!n) return;
  if (!annoRanges().get(id)) {
    const chId = chapterOfAnno(n);
    if (!chId) { toast('본문에서 이 글자가 지워졌어요.'); return; }
    await openChapter(chId);
  }
  const r = annoRanges().get(id);
  if (!r) return;
  app.editor.chain().focus().setTextSelection({ from: r.from, to: r.to }).scrollIntoView().run();
  hot(id);
}

// ---------- 여백 카드 ----------
let rail, hotStyle;
const side = () => app.settings.annoSide || 'right';
function hot(id) {
  hotStyle.textContent = id ? `.ProseMirror .anno[data-anno="${id}"] { box-shadow: 0 2px 0 0 currentColor; background: var(--anno-hot); }` : '';
  rail?.querySelectorAll('.anno-card').forEach((c) => c.classList.toggle('hot', c.dataset.id === id));
  board?.querySelectorAll('.sticky').forEach((c) => c.classList.toggle('hot', c.dataset.id === id));
}
function cardHtml(n) {
  const k = n.type;
  let body = '';
  if (k === 'fix') body = `<div class="ac-fix"><del>${h(n.quote || '')}</del> <span aria-hidden="true">→</span> <ins>${h(n.fix || '(지우기)')}</ins></div>`;
  if (k === 'index') body = `<div class="ac-term">색인어 <b>${h(n.name || '')}</b></div>`;
  if (k === 'cite') body = `<div class="ac-src">${n.source ? h(n.source) : '<i>출처를 적어 두세요</i>'}</div>`;
  if (n.body) body += `<div class="ac-text">${h(n.body)}</div>`;
  const acts = k === 'fix'
    ? '<button type="button" data-a="accept">반영</button><button type="button" data-a="reject">거절</button><button type="button" data-a="edit">고치기</button>'
    : '<button type="button" data-a="edit">고치기</button><button type="button" data-a="delete">지우기</button>';
  return `<div class="anno-card k-${k}" data-id="${n.id}" tabindex="0">
    <div class="ac-head"><span class="ac-kind">${KINDS[k].name}</span><span class="ac-who">${h(n.author || '')}${n.time ? ` · ${ago(n.time)}` : ''}</span></div>
    ${body}<div class="ac-acts">${acts}</div></div>`;
}

let railTimer;
export function scheduleRail(delay = 200) { clearTimeout(railTimer); railTimer = setTimeout(renderRail, delay); }
export function renderRail() { drawRail(); renderStickies(); }
function drawRail() {
  if (!rail || !app.editor) return;
  const scroll = $('#paperScroll');
  const ranges = annoRanges();
  const list = [...ranges].map(([id, r]) => ({ id, r, n: notes.get(id) })).filter((x) => x.n);
  // 반영·거절한 뒤 Ctrl+Z로 되돌려 표시가 돌아오면 다시 '열린' 주석으로
  for (const x of list) if (x.n.status) { delete x.n.status; delete x.n.resolved; S.putNote(x.n); }
  const on = side() !== 'off' && list.length > 0 && !document.body.classList.contains('focus');
  const wide = scroll.clientWidth >= 860;
  const was = document.body.classList.contains('has-anno-rail');
  document.body.classList.toggle('has-anno-rail', on && wide);
  // 여백이 생기거나 없어지면 쪽 보기 크기를 다시 맞춘다
  if (was !== (on && wide) && isPageView()) { applyPageView(); setTimeout(renderRail, 60); }
  document.body.classList.toggle('anno-left', side() === 'left');
  document.body.classList.toggle('anno-off', side() === 'off');
  if (!on || !wide) { rail.hidden = true; rail.innerHTML = ''; return; }
  rail.hidden = false;
  const paper = $('#paper');
  const base = scroll.getBoundingClientRect().top - scroll.scrollTop;
  const pr = paper.getBoundingClientRect(), sr = scroll.getBoundingClientRect();
  const W = 232;
  rail.style.width = W + 'px';
  rail.style.left = (side() === 'left' ? Math.max(8, pr.left - sr.left - W - 20) : pr.right - sr.left + 20) + scroll.scrollLeft + 'px';
  const view = app.editor.view;
  const items = list.map((x) => {
    let top = 0;
    try { top = view.coordsAtPos(x.r.from).top - base; } catch { /* 화면 밖 */ }
    return { ...x, top };
  }).sort((a, b) => a.top - b.top);
  rail.innerHTML = items.map((x) => cardHtml(x.n)).join('');
  // 겹치지 않게 아래로 민다
  let y = 0;
  [...rail.children].forEach((el, i) => {
    const t = Math.max(items[i].top, y);
    el.style.top = t + 'px';
    y = t + el.offsetHeight + 8;
  });
}

// ---------- 포스트잇 ----------
// 여백 카드와 따로, 원고 종이 가장자리에 붙인 쪽지처럼 보여 준다. 끌어서 옮기고, 접어 둘 수 있다.
let board;
const STW = 168;
const tilt = (id) => { let x = 0; for (const c of id) x = (x * 31 + c.charCodeAt(0)) % 997; return ((x % 7) - 3) * 0.6; };
function stickyHtml(n) {
  const k = n.type;
  let main = '';
  if (k === 'fix') main = `<div class="st-fix"><del>${h(n.quote || '')}</del> → <ins>${h(n.fix || '(지우기)')}</ins></div>`;
  if (k === 'index') main = `<div class="st-term">${h(n.name || '')}</div>`;
  if (k === 'cite') main = `<div class="st-src">${n.source ? h(n.source) : '<i>출처를 적어 두세요</i>'}</div>`;
  if (n.body) main += `<div class="st-text">${h(n.body)}</div>`;
  if (n.author) main += `<div class="st-who">${h(n.author)}</div>`;
  return `<div class="sticky k-${k}${n.pinFold ? ' fold' : ''}" data-id="${n.id}" tabindex="0" style="--tilt:${tilt(n.id)}deg" title="끌어서 옮기기 · 두 번 누르면 고치기">
    <div class="st-head"><span>${KINDS[k].name}</span><button type="button" data-s="fold" aria-label="${n.pinFold ? '펴기' : '접기'}">${n.pinFold ? '+' : '−'}</button></div>
    <div class="st-body">${main}</div></div>`;
}
export function renderStickies() {
  if (!board || !app.editor) return;
  const on = !!app.settings.annoSticky && !document.body.classList.contains('focus');
  const ranges = on ? annoRanges() : new Map();
  const list = [...ranges].map(([id, r]) => ({ id, r, n: notes.get(id) })).filter((x) => x.n);
  if (!list.length) { board.hidden = true; board.innerHTML = ''; return; }
  board.hidden = false;
  const scroll = $('#paperScroll'), paper = $('#paper');
  const sr = scroll.getBoundingClientRect(), pr = paper.getBoundingClientRect();
  const base = sr.top - scroll.scrollTop;
  // 오른쪽 여백 카드가 있으면 종이 왼쪽 가장자리에, 아니면 오른쪽 가장자리에 반쯤 걸쳐 붙인다
  const leftEdge = document.body.classList.contains('has-anno-rail') && side() === 'right';
  let x0 = leftEdge ? pr.left - sr.left - STW * 0.55 : pr.right - sr.left - STW * 0.45;
  x0 = Math.max(4, Math.min(x0, scroll.clientWidth - STW - 4)) + scroll.scrollLeft;
  const view = app.editor.view;
  const items = list.map((x) => {
    let top = 0;
    try { top = view.coordsAtPos(x.r.from).top - base - 6; } catch { /* 화면 밖 */ }
    return { ...x, top };
  }).sort((a, b) => a.top - b.top);
  board.innerHTML = items.map((x) => stickyHtml(x.n)).join('');
  let y = 0;
  [...board.children].forEach((el, i) => {
    const it = items[i], p = it.n.pin;
    const t = Math.max(it.top, y);
    el.dataset.x = x0; el.dataset.y = t;
    el.style.left = Math.max(scroll.scrollLeft + 2, Math.min(x0 + (p?.dx || 0), scroll.scrollLeft + scroll.clientWidth - STW - 2)) + 'px';
    el.style.top = t + (p?.dy || 0) + 'px';
    if (!p) y = t + el.offsetHeight + 6; // 옮기지 않은 쪽지끼리는 겹치지 않게
  });
}
export function setAnnoSticky(on) { app.settings.annoSticky = on; saveSettings(); renderRail(); }
function bindStickies() {
  let drag = null;
  board.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.sticky');
    if (!el || e.button !== 0 || e.target.closest('button')) return;
    drag = { el, sx: e.clientX, sy: e.clientY, l: parseFloat(el.style.left), t: parseFloat(el.style.top), moved: false };
    el.setPointerCapture(e.pointerId);
  });
  board.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    drag.el.classList.add('dragging');
    const sc = $('#paperScroll');
    drag.el.style.left = Math.max(sc.scrollLeft + 2, Math.min(drag.l + dx, sc.scrollLeft + sc.clientWidth - STW - 2)) + 'px';
    drag.el.style.top = drag.t + dy + 'px';
  });
  const end = async () => {
    if (!drag) return;
    const { el, moved } = drag;
    drag = null;
    el.classList.remove('dragging');
    const n = notes.get(el.dataset.id);
    if (!n) return;
    if (!moved) { gotoAnno(n.id); return; }
    n.pin = { dx: Math.round(parseFloat(el.style.left) - el.dataset.x), dy: Math.round(parseFloat(el.style.top) - el.dataset.y) };
    await S.putNote(n);
  };
  board.addEventListener('pointerup', end);
  board.addEventListener('pointercancel', end);
  board.addEventListener('dblclick', (e) => { const el = e.target.closest('.sticky'); if (el && !e.target.closest('button')) editAnno(el.dataset.id); });
  board.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-s="fold"]');
    if (!b) return;
    const n = notes.get(b.closest('.sticky').dataset.id);
    if (!n) return;
    n.pinFold = !n.pinFold;
    if (!n.pinFold) delete n.pinFold;
    await S.putNote(n);
    renderStickies();
  });
  board.addEventListener('contextmenu', async (e) => {
    const el = e.target.closest('.sticky');
    if (!el) return;
    e.preventDefault();
    const n = notes.get(el.dataset.id);
    if (!n?.pin) return;
    delete n.pin; // 오른쪽 단추: 처음 자리로
    await S.putNote(n);
    renderStickies();
  });
  board.addEventListener('mouseover', (e) => { const c = e.target.closest('.sticky'); if (c) hot(c.dataset.id); });
  board.addEventListener('mouseleave', () => hot(null));
}

// 좁은 화면: 주석 글자를 누르면 카드를 띄운다
function popCard(id, x, y) {
  const n = notes.get(id);
  if (!n) return;
  let pop = $('#annoPop');
  if (!pop) { pop = document.createElement('div'); pop.id = 'annoPop'; pop.className = 'anno-pop'; document.body.appendChild(pop); bindCardActions(pop); }
  pop.innerHTML = cardHtml(n);
  pop.hidden = false;
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(x - r.width / 2, innerWidth - r.width - 8)) + 'px';
  pop.style.top = (y + r.height + 16 > innerHeight ? y - r.height - 12 : y + 18) + 'px';
}
function bindCardActions(host) {
  host.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  host.addEventListener('click', (e) => {
    const card = e.target.closest('.anno-card');
    if (!card) return;
    const id = card.dataset.id;
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (host.id === 'annoPop' && a) host.hidden = true;
    if (a === 'accept') acceptFix(id);
    else if (a === 'reject') rejectFix(id);
    else if (a === 'edit') editAnno(id);
    else if (a === 'delete') removeAnno(id);
    else gotoAnno(id);
  });
  host.addEventListener('mouseover', (e) => { const c = e.target.closest('.anno-card'); if (c) hot(c.dataset.id); });
  host.addEventListener('mouseleave', () => hot(null));
}

let refreshNotesTab = () => {};
export function bindAnnotations({ onNotesChange } = {}) {
  if (onNotesChange) refreshNotesTab = onNotesChange;
  const scroll = $('#paperScroll');
  rail = document.createElement('aside');
  rail.className = 'anno-rail';
  rail.id = 'annoRail';
  rail.setAttribute('aria-label', '주석');
  rail.hidden = true;
  scroll.appendChild(rail);
  board = document.createElement('div');
  board.className = 'sticky-board';
  board.id = 'stickyBoard';
  board.setAttribute('aria-label', '주석 포스트잇');
  board.hidden = true;
  scroll.appendChild(board);
  bindStickies();
  hotStyle = document.createElement('style');
  document.head.appendChild(hotStyle);
  bindCardActions(rail);
  app.editor.on('update', () => scheduleRail());
  app.editor.on('selectionUpdate', () => {
    const { $from } = app.editor.state.selection;
    const m = $from.marks().find((x) => x.type.name === 'anno');
    hot(m?.attrs.id || null);
  });
  addEventListener('resize', () => scheduleRail(100));
  app.hooks.afterOpen.push(() => scheduleRail(50));
  // 주석 글자를 누르면: 넓은 화면은 카드에 불을 켜고, 좁은 화면은 카드를 띄운다
  $('#editorHost').addEventListener('click', (e) => {
    const el = e.target.closest?.('.anno[data-anno]');
    $('#annoPop') && ($('#annoPop').hidden = true);
    if (!el) return;
    const id = el.dataset.anno;
    if (!rail.hidden) { hot(id); rail.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }); }
    else if (!board.hidden && board.querySelector(`[data-id="${id}"]`)) { hot(id); board.querySelector(`[data-id="${id}"]`).scrollIntoView({ block: 'nearest' }); }
    else popCard(id, e.clientX, e.clientY);
  });
  addEventListener('mousedown', (e) => { const p = $('#annoPop'); if (p && !p.contains(e.target) && !e.target.closest?.('.anno')) p.hidden = true; });
}
export async function annosChanged() { await loadAnnos(); renderRail(); }

export function setAnnoSide(v) { app.settings.annoSide = v; saveSettings(); renderRail(); }

// ---------- 색인 (찾아보기) ----------
export async function showIndex() {
  await saveNow();
  await loadAnnos();
  const terms = new Map();
  for (const n of notes.values()) {
    if (n.type !== 'index') continue;
    const chId = chapterOfAnno(n);
    if (!chId) continue;
    const key = n.name || n.quote;
    if (!terms.has(key)) terms.set(key, []);
    terms.get(key).push({ n, chId, idx: app.project.order.indexOf(chId) });
  }
  const sorted = [...terms].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
  // 가나다 묶음 (초성)
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const head = (t) => { const c = t.charCodeAt(0); if (c >= 0xac00 && c <= 0xd7a3) return CHO[Math.floor((c - 0xac00) / 588)].replace('ㄲ', 'ㄱ').replace('ㄸ', 'ㄷ').replace('ㅃ', 'ㅂ').replace('ㅆ', 'ㅅ').replace('ㅉ', 'ㅈ'); return /[a-z]/i.test(t[0]) ? t[0].toUpperCase() : '기타'; };
  let last = '', html = '';
  for (const [t, hits] of sorted) {
    const hd = head(t);
    if (hd !== last) { html += `<h4 class="ix-head">${h(hd)}</h4>`; last = hd; }
    const refs = hits.sort((a, b) => a.idx - b.idx).map((x) => `<a href="#" data-ix="${x.n.id}">${x.idx + 1}장</a>`).join(', ');
    html += `<div class="ix-row"><b>${h(t)}</b><span>${refs}</span></div>`;
  }
  const text = sorted.map(([t, hits]) => `${t}  ${[...new Set(hits.map((x) => x.idx + 1))].sort((a, b) => a - b).map((i) => i + '장').join(', ')}`).join('\n');
  await dialog({
    title: `찾아보기 (색인 ${sorted.length}개)`,
    body: sorted.length ? `<div class="ix-list">${html}</div>` : '<p class="hint">아직 색인이 없어요. 본문에서 낱말을 고르고 마우스 오른쪽 → ‘색인으로 올리기’를 누르세요.</p>',
    buttons: [...(sorted.length ? [{ label: '목록 복사', value: 'copy', left: true }] : []), { label: '닫기', value: 'close', primary: true }],
    onOpen: (f, dlg) => {
      f.addEventListener('click', (e) => {
        const a = e.target.closest('[data-ix]');
        if (a) { e.preventDefault(); dlg.close('close'); gotoAnno(a.dataset.ix); }
        const c = e.target.closest('button[value="copy"]');
        if (c) { e.preventDefault(); navigator.clipboard?.writeText(text).then(() => toast('색인 목록을 복사했어요.'), () => toast('복사하지 못했어요.')); }
      });
    },
  });
}

// 내보내기용: 지금 작품의 주석 {id: {kind, author, text, time}}
export async function annosForExport() {
  await loadAnnos();
  const out = {};
  for (const n of notes.values()) {
    if (n.status) continue;
    const lines = [];
    if (n.type === 'fix') lines.push(`[교정 제안] “${n.quote}” → “${n.fix || '(지우기)'}”`);
    if (n.type === 'index') lines.push(`[색인] ${n.name}`);
    if (n.type === 'cite') lines.push(`[인용] ${n.source || '출처 미상'}`);
    if (n.type === 'intent') lines.push('[의도]');
    if (n.body) lines.push(n.body);
    out[n.id] = { kind: n.type, author: n.author || '', time: n.time, text: lines.join('\n') };
  }
  return out;
}

export function annoListItem(n, curHtml) {
  const chId = chapterOfAnno(n, curHtml);
  const state = n.status ? STATUS[n.status] : chId ? app.chapters.get(chId)?.title || '' : '본문에서 지워짐';
  const main = n.type === 'index' ? n.name : `“${(n.quote || '').slice(0, 30)}${(n.quote || '').length > 30 ? '…' : ''}”`;
  const sub = n.type === 'fix' ? `→ ${n.fix || '(지우기)'}` : n.type === 'cite' ? n.source || '' : n.body || '';
  return `<li data-note="${n.id}" class="anno-li k-${n.type}${n.status || !chId ? ' dim' : ''}"><div><span class="k">${KINDS[n.type].name}</span><b>${h(main || '')}</b></div>
    <div class="d">${h(state)}${sub ? ' · ' + h(sub.slice(0, 50)) : ''}${n.author ? ' · ' + h(n.author) : ''}</div></li>`;
}
