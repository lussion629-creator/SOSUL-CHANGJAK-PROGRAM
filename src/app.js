// 앱 상태와 핵심 동작: 작품·장 불러오기, 5초 자동 저장, 버전 기록, 원고 목록, 통계
import * as S from './store.js';
import * as G from './gdrive.js';
import { createEditor, activeState, docParagraphs } from './editor.js';
import { EditorState } from '@tiptap/pm/state';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { countHtml, countText, fmt } from './stats.js';
import { editAmounts } from './diff.js';
import { $, $$, h, toast, hms, hm, dayLabel, dialog, confirmDlg, promptDlg } from './ui.js';

const DEFAULTS = {
  font: "'Gowun Batang', 'Nanum Myeongjo', Batang, serif", size: 17, lineHeight: 1.9, width: 720,
  indent: true, paraSpacing: 0, theme: 'auto', smartQuotes: true, typewriter: false, dimFocus: true,
  snapshotMinutes: 3, autoSaveSeconds: 5, driveClientId: '', autoSync: true, author: '',
};

export const app = {
  settings: { ...DEFAULTS },
  project: null,
  chapters: new Map(),
  cur: null, // 현재 장 id
  editor: null,
  dirty: false,
  saveTimer: null,
  syncTimer: null,
  lastSnap: new Map(), // chapterId → 마지막 버전
  states: new Map(), // chapterId → EditorState (장마다 실행 취소 기록 유지)
  hooks: { afterSave: [], afterOpen: [] },
};

// ---------- 설정 ----------
export function loadSettings() {
  try { Object.assign(app.settings, JSON.parse(localStorage.getItem('nw-settings') || '{}')); } catch { /* 무시 */ }
  applySettings();
}
export function saveSettings() {
  try { localStorage.setItem('nw-settings', JSON.stringify(app.settings)); localStorage.setItem('nw-theme', app.settings.theme); } catch { /* 무시 */ }
  applySettings();
}
export function applySettings() {
  const s = app.settings, r = document.documentElement.style;
  r.setProperty('--ed-font', s.font);
  r.setProperty('--ed-size', s.size + 'px');
  r.setProperty('--ed-line', s.lineHeight);
  r.setProperty('--ed-width', s.width + 'px');
  r.setProperty('--ed-indent', s.indent ? '1em' : '0');
  r.setProperty('--ed-para', s.paraSpacing + 'em');
  if (s.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = s.theme;
  document.body.classList.toggle('dim', !!s.dimFocus);
}
export function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  app.settings.theme = dark ? 'light' : 'dark';
  saveSettings();
}

// ---------- 편집기 ----------
export function initEditor() {
  app.editor = createEditor($('#editorHost'), {
    onUpdate: onEdit,
    onSelection: syncToolbar,
    smartQuotes: () => app.settings.smartQuotes,
    typewriter: () => app.settings.typewriter && document.body.classList.contains('focus'),
  });
}

let tbRaf;
function syncToolbar() {
  cancelAnimationFrame(tbRaf);
  tbRaf = requestAnimationFrame(() => {
    const a = activeState(app.editor);
    $$('#toolbar [data-cmd]').forEach((b) => b.classList.toggle('on', !!a[b.dataset.cmd]));
    $('#blockType').value = a.block;
    $('#fontFamily').value = [...$('#fontFamily').options].some((o) => o.value === a.font) ? a.font : '';
    $('#fontSize').value = a.size || '';
  });
}

function onEdit() {
  app.dirty = true;
  setSaveState('dirty', '입력 중…');
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => saveNow(), app.settings.autoSaveSeconds * 1000);
  scheduleCounts();
}

let countTimer;
function scheduleCounts() {
  clearTimeout(countTimer);
  countTimer = setTimeout(updateCounts, 300);
}

export function setSaveState(kind, text) {
  const el = $('#saveState');
  el.className = 'pill ' + (kind || '');
  el.textContent = text;
}

// ---------- 저장 ----------
let saving = null;
export async function saveNow({ snapshot = true, track = true } = {}) {
  clearTimeout(app.saveTimer);
  if (saving) await saving;
  if (!app.dirty || !app.cur) return;
  saving = (async () => {
    const ch = app.chapters.get(app.cur);
    const newParas = docParagraphs(app.editor.state.doc).map((p) => p.text);
    let amounts = null;
    if (track) {
      try { amounts = editAmounts(ch._paras ?? htmlParagraphs(ch.html), newParas); } catch { /* 계산 실패는 기록만 건너뜀 */ }
    }
    ch._paras = newParas;
    ch.html = app.editor.getHTML();
    ch.updated = Date.now();
    app.dirty = false;
    try {
      await S.putChapter(ch);
      app.project.updated = Date.now();
      app.project.lastChapter = ch.id;
      await S.putProject(app.project);
      if (snapshot) await maybeSnapshot(ch);
      await updateDaily(amounts, ch.id);
      setSaveState('ok', `저장됨 ${hms(Date.now())}`);
      renderBinderCounts();
      app.hooks.afterSave.forEach((f) => f());
      scheduleSync();
    } catch (e) {
      app.dirty = true;
      setSaveState('err', '저장 실패');
      toast('저장하지 못했습니다: ' + e.message);
    }
  })();
  await saving;
  saving = null;
}

async function maybeSnapshot(ch, force = false) {
  const last = app.lastSnap.get(ch.id);
  const gap = app.settings.snapshotMinutes * 60e3;
  if (!force && last && (Date.now() - last.time < gap || last.html === ch.html)) return;
  if (last && last.html === ch.html) return;
  const s = await S.addSnapshot(ch, 'auto');
  app.lastSnap.set(ch.id, s);
  if (Math.random() < 0.1) S.pruneSnapshots(ch.id);
  if (isTabOpen('history')) renderHistory();
}

export async function manualSnapshot() {
  await saveNow({ snapshot: false });
  const label = await promptDlg('지금 버전 저장', '이 버전의 이름 (예: 1차 퇴고 전)', `${hm(Date.now())} 저장`);
  if (label === null) return;
  const ch = app.chapters.get(app.cur);
  ch.html = app.editor.getHTML();
  const s = await S.addSnapshot(ch, 'manual', label);
  app.lastSnap.set(ch.id, s);
  renderHistory();
  toast(`“${label}” 버전을 저장했어요.`);
}

// ---------- 일일 기록 ----------
export function projectTotal() {
  let n = 0;
  for (const c of app.chapters.values()) n += c.id === app.cur ? currentCount().withSpace : (c._count ??= countHtml(c.html)).withSpace;
  return n;
}
async function updateDaily(amounts, chId) {
  const total = projectTotal();
  const d = S.today();
  let rec = await S.getDaily(app.project.id, d);
  if (!rec) rec = { key: `${app.project.id}|${d}`, projectId: app.project.id, date: d, start: total, end: total };
  rec.end = total;
  if (amounts) {
    for (const k of ['add', 'rev', 'del']) rec[k] = (rec[k] || 0) + amounts[k];
    rec.byCh ??= {};
    const c = (rec.byCh[chId] ??= { add: 0, rev: 0, del: 0 });
    for (const k of ['add', 'rev', 'del']) c[k] += amounts[k];
  }
  rec.written = Math.max(rec.written || 0, total - rec.start);
  await S.putDaily(rec);
  app.todayRec = rec;
  renderGoal();
}

// ---------- 작품 열기 ----------
export async function openProject(id) {
  await saveNow();
  let p = await S.getProject(id);
  if (!p) return false;
  app.project = p;
  app.chapters.clear();
  app.states.clear();
  app.lastSnap.clear();
  const list = await S.chaptersOf(id);
  for (const c of list) app.chapters.set(c.id, c);
  // 순서 정리
  p.order = p.order.filter((x) => app.chapters.has(x));
  for (const c of list) if (!p.order.includes(c.id)) p.order.push(c.id);
  if (!p.order.length) {
    const c = S.newChapter(p.id, '1장');
    await S.putChapter(c);
    app.chapters.set(c.id, c);
    p.order.push(c.id);
  }
  await S.putProject(p);
  await S.kvSet('lastProject', id);
  $('#projectTitle').value = p.title;
  document.title = `${p.title} — 소설 워드프로세서`;
  const total = [...app.chapters.values()].reduce((n, c) => n + (c._count = countHtml(c.html)).withSpace, 0);
  const d = S.today();
  app.todayRec = await S.getDaily(p.id, d) || { key: `${p.id}|${d}`, projectId: p.id, date: d, start: total, end: total, written: 0 };
  await S.putDaily(app.todayRec);
  app.cur = null;
  renderBinder();
  await openChapter(p.lastChapter && app.chapters.has(p.lastChapter) ? p.lastChapter : p.order[0]);
  return true;
}

export async function openChapter(id) {
  if (app.cur === id) return;
  await saveNow();
  if (app.cur) app.states.set(app.cur, app.editor.state);
  const ch = app.chapters.get(id);
  app.cur = id;
  const cached = app.states.get(id);
  if (cached) app.editor.view.updateState(cached);
  else {
    app.editor.commands.setContent(ch.html || '', { emitUpdate: false });
    // 장을 바꿀 때 실행 취소 기록이 섞이지 않도록 새 상태로 시작
    app.editor.view.updateState(EditorState.create({ doc: app.editor.state.doc, plugins: app.editor.state.plugins }));
  }
  $('#chapterTitle').value = ch.title;
  $('#chapterSynopsis').value = ch.synopsis || '';
  $('#chapterStatus').value = ch.status || 'draft';
  const snaps = await S.snapshotsOf(id);
  app.lastSnap.set(id, snaps[0] || null);
  // 처음 여는 장이면 지금 상태를 출발점으로 남긴다
  if (!snaps.length && ch.html && ch.html !== '<p></p>') app.lastSnap.set(id, await S.addSnapshot(ch, 'auto', '처음 연 상태'));
  app.project.lastChapter = id;
  S.putProject(app.project);
  setSaveState('ok', '저장됨');
  renderBinder();
  updateCounts();
  if (isTabOpen('history')) renderHistory();
  app.hooks.afterOpen.forEach((f) => f());
  closeSidebarMobile();
}

export function currentCount() {
  const paras = docParagraphs(app.editor.state.doc).map((p) => p.text.replace(/￼/g, ''));
  return countText(paras);
}

export function updateCounts() {
  if (!app.cur) return;
  const c = currentCount();
  const ch = app.chapters.get(app.cur);
  ch._count = c;
  $('#stChars').textContent = `이 장 ${fmt(c.withSpace)}자 (공백 제외 ${fmt(c.noSpace)})`;
  $('#stManu').textContent = `원고지 ${fmt(c.manuscript)}매`;
  const total = projectTotal();
  let manu = 0;
  for (const x of app.chapters.values()) manu += (x._count || countHtml(x.html)).manuscript;
  $('#stTotal').textContent = `작품 ${fmt(total)}자 · ${fmt(manu)}매`;
  if (app.todayRec) { app.todayRec.end = total; app.todayRec.written = Math.max(app.todayRec.written || 0, total - app.todayRec.start); }
  renderGoal();
  const fc = $('.focus-count');
  if (fc) fc.textContent = `${fmt(c.withSpace)}자 · 오늘 ${fmt(todayWritten())}자`;
}

// 오늘 쓴 양: 새로 써 넣은 글자(공백 제외). 예전 기록에는 순증가분을 쓴다
export const todayWritten = () => app.todayRec?.add ?? Math.max(0, (app.todayRec?.end || 0) - (app.todayRec?.start || 0));

export function renderGoal() {
  const goal = app.project?.goalDaily || 0;
  const w = todayWritten();
  $('#goalText').textContent = goal ? `${fmt(w)} / ${fmt(goal)}자` : '목표 정하기';
  const r = app.todayRec || {};
  $('#stToday').innerHTML = `오늘 <i class="sw s-add"></i>쓴 <b>${fmt(r.add || 0)}</b> <i class="sw s-rev"></i>고친 <b>${fmt(r.rev || 0)}</b> <i class="sw s-del"></i>지운 <b>${fmt(r.del || 0)}</b>`;
  $('#goalBar').style.width = goal ? Math.min(100, (w / goal) * 100) + '%' : '0';
}

// ---------- 원고 목록 ----------
const STATUS = { idea: '구상', draft: '초고', revise: '퇴고 중', done: '완료' };
export function renderBinder() {
  const ol = $('#chapterList');
  ol.innerHTML = app.project.order.map((id, i) => {
    const c = app.chapters.get(id);
    const n = (c._count || countHtml(c.html)).withSpace;
    return `<li draggable="true" data-id="${id}" class="${id === app.cur ? 'on' : ''}">
      <span class="dot ${c.status || 'draft'}" title="${STATUS[c.status] || '초고'}"></span>
      <span class="t">${h(c.title || `${i + 1}장`)}</span><span class="n">${fmt(n)}</span>
      <button class="more" data-more="${id}" title="장 메뉴">⋯</button></li>`;
  }).join('');
  $('#projectCount').textContent = `${app.project.order.length}개 장`;
}
function renderBinderCounts() {
  const c = app.chapters.get(app.cur);
  const li = $(`#chapterList li[data-id="${app.cur}"] .n`);
  if (li && c._count) li.textContent = fmt(c._count.withSpace);
}

let adding = false;
export async function addChapter(title, html = '', after = app.cur) {
  if (adding) return null;
  adding = true;
  try { return await addChapterInner(title, html, after); } finally { adding = false; }
}
async function addChapterInner(title, html, after) {
  await saveNow();
  const n = app.project.order.length + 1;
  const c = S.newChapter(app.project.id, title || `${n}장`, html);
  await S.putChapter(c);
  app.chapters.set(c.id, c);
  const idx = app.project.order.indexOf(after);
  app.project.order.splice(idx < 0 ? app.project.order.length : idx + 1, 0, c.id);
  await S.putProject(app.project);
  await openChapter(c.id);
  if (!title) { $('#chapterTitle').focus(); $('#chapterTitle').select(); }
  return c;
}

export async function chapterMenu(id) {
  const c = app.chapters.get(id);
  const r = await dialog({
    title: c.title,
    body: `<div class="proj-list">
      <button class="proj" value="rename"><div class="info"><b>이름 바꾸기</b></div></button>
      <button class="proj" value="dup"><div class="info"><b>복제하기</b><small>같은 내용으로 새 장을 만듭니다</small></div></button>
      <button class="proj" value="up"><div class="info"><b>위로 옮기기</b></div></button>
      <button class="proj" value="down"><div class="info"><b>아래로 옮기기</b></div></button>
      <button class="proj" value="merge"><div class="info"><b>다음 장과 합치기</b></div></button>
      <button class="proj" value="delete"><div class="info"><b style="color:var(--del)">삭제</b><small>이 장과 버전 기록을 지웁니다</small></div></button>
    </div>`,
    buttons: [],
  });
  const order = app.project.order, i = order.indexOf(id);
  if (r.value === 'rename') {
    const t = await promptDlg('장 이름 바꾸기', '장 제목', c.title);
    if (t) { c.title = t; await S.putChapter(c); if (id === app.cur) $('#chapterTitle').value = t; }
  } else if (r.value === 'dup') {
    if (id === app.cur) await saveNow();
    await addChapter(c.title + ' (사본)', c.html, id);
  } else if (r.value === 'up' && i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; await S.putProject(app.project); }
  else if (r.value === 'down' && i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; await S.putProject(app.project); }
  else if (r.value === 'merge' && i < order.length - 1) {
    await saveNow();
    const next = app.chapters.get(order[i + 1]);
    if (await confirmDlg('장 합치기', `“${h(c.title)}” 뒤에 “${h(next.title)}”를 붙이고 “${h(next.title)}”는 지웁니다. 두 장의 지금 상태는 버전 기록에 남깁니다.`, '합치기')) {
      await S.addSnapshot(c, 'auto', '합치기 전');
      c.html = (c.html || '') + '<hr>' + (next.html || '');
      await S.putChapter(c);
      await S.deleteChapter(next.id);
      app.chapters.delete(next.id);
      order.splice(i + 1, 1);
      await S.putProject(app.project);
      app.states.delete(id);
      if (app.cur === id || app.cur === next.id) { app.cur = null; await openChapter(id); }
    }
  } else if (r.value === 'delete') {
    if (order.length === 1) { toast('마지막 남은 장은 지울 수 없어요.'); return; }
    if (await confirmDlg('장 삭제', `“${h(c.title)}”와 그 버전 기록을 지울까요? 되돌릴 수 없습니다. 먼저 내보내기로 백업할 수 있어요.`, '삭제', true)) {
      await S.deleteChapter(id);
      app.chapters.delete(id);
      order.splice(i, 1);
      await S.putProject(app.project);
      if (app.cur === id) { app.cur = null; await openChapter(order[Math.max(0, i - 1)]); }
    }
  }
  renderBinder();
}

// 끌어서 순서 바꾸기
export function bindBinderDrag() {
  const ol = $('#chapterList');
  let dragId = null;
  ol.addEventListener('dragstart', (e) => { dragId = e.target.closest('li')?.dataset.id; e.dataTransfer.effectAllowed = 'move'; });
  ol.addEventListener('dragover', (e) => {
    e.preventDefault();
    $$('#chapterList li').forEach((l) => l.classList.remove('drag-over'));
    e.target.closest('li')?.classList.add('drag-over');
  });
  ol.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('li')?.dataset.id;
    if (!dragId || !target || dragId === target) return renderBinder();
    const o = app.project.order;
    o.splice(o.indexOf(dragId), 1);
    o.splice(o.indexOf(target), 0, dragId);
    await S.putProject(app.project);
    renderBinder();
  });
}

// ---------- 버전 기록 ----------
export function isTabOpen(name) { return !$(`#tab-${name}`).hidden; }

export async function renderHistory() {
  const list = await S.snapshotsOf(app.cur);
  const box = $('#historyList');
  if (!list.length) { box.innerHTML = '<p class="hint">아직 저장된 버전이 없습니다. 글을 쓰면 자동으로 쌓여요.</p>'; return; }
  let html = '', day = '';
  list.forEach((s, i) => {
    const d = dayLabel(s.time);
    if (d !== day) { html += `<h4>${d}</h4>`; day = d; }
    const prev = list[i + 1];
    const n = countHtml(s.html).withSpace;
    const delta = prev ? n - countHtml(prev.html).withSpace : 0;
    const lb = s.label ? `<b>${h(s.label)}</b>` : s.kind === 'manual' ? '<b>직접 저장</b>' : '자동';
    html += `<div class="h" data-snap="${s.id}"><span class="tm">${hm(s.time)}</span><span class="lb">${lb}</span>
      <span class="delta">${delta > 0 ? `<span class="p">+${fmt(delta)}</span>` : delta < 0 ? `<span class="m">${fmt(delta)}</span>` : ''}</span></div>`;
  });
  box.innerHTML = html;
}

export async function snapshotMenu(id) {
  const s = await S.getSnapshot(id);
  const c = countHtml(s.html);
  const r = await dialog({
    title: `${dayLabel(s.time)} ${hms(s.time)} 버전`,
    body: `<p class="hint" style="margin:0">${s.label ? h(s.label) + ' · ' : ''}${fmt(c.withSpace)}자 · 원고지 ${fmt(c.manuscript)}매</p>
      <div class="prose" style="max-height:40vh;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:14px 16px;background:var(--bg)">${s.html || '<p class="hint">(빈 원고)</p>'}</div>`,
    buttons: [
      { label: '삭제', value: 'delete', left: true },
      { label: '이름 붙이기', value: 'label' },
      { label: '되돌리기', value: 'restore' },
      { label: '지금과 비교', value: 'compare', primary: true },
    ],
    wide: true,
  });
  if (r.value === 'compare') app.openRevision?.(id);
  else if (r.value === 'restore') await restoreSnapshot(s);
  else if (r.value === 'label') {
    const t = await promptDlg('버전 이름', '이름', s.label || '');
    if (t !== null) { s.label = t; await S.updateSnapshot(s); renderHistory(); }
  } else if (r.value === 'delete') {
    if (await confirmDlg('버전 삭제', '이 버전을 기록에서 지울까요?', '삭제', true)) { await S.deleteSnapshot(id); renderHistory(); }
  }
}

export async function restoreSnapshot(s) {
  if (!(await confirmDlg('이 버전으로 되돌리기', `지금 원고를 ${dayLabel(s.time)} ${hm(s.time)} 버전으로 바꿉니다. 지금 상태는 “되돌리기 전” 버전으로 기록에 남으니 언제든 다시 돌아올 수 있어요.`, '되돌리기'))) return false;
  await saveNow({ snapshot: false });
  const ch = app.chapters.get(app.cur);
  ch.html = app.editor.getHTML();
  await S.addSnapshot(ch, 'manual', '되돌리기 전');
  app.editor.commands.setContent(s.html, { emitUpdate: false });
  app.dirty = true;
  await saveNow({ snapshot: false, track: false }); // 되돌리기는 쓴 양으로 세지 않는다
  app.lastSnap.set(ch.id, await S.addSnapshot(ch, 'auto', `${hm(s.time)} 버전으로 되돌림`));
  updateCounts();
  renderHistory();
  toast('되돌렸어요. 이전 상태는 기록에 남아 있습니다.');
  return true;
}

// HTML을 편집기 스키마로 해석해 문단 목록으로 (비교용)
export function htmlParagraphs(html) {
  const el = document.createElement('div');
  el.innerHTML = html || '';
  const doc = PMDOMParser.fromSchema(app.editor.schema).parse(el);
  return docParagraphs(doc).map((p) => p.text);
}

// ---------- 모바일 사이드바 ----------
export function toggleSidebar(open) {
  const sb = $('#sidebar');
  const on = open ?? !sb.classList.contains('open');
  sb.classList.toggle('open', on);
  $('.scrim')?.remove();
  if (on) {
    const s = document.createElement('div');
    s.className = 'scrim';
    s.onclick = () => toggleSidebar(false);
    document.body.appendChild(s);
  }
}
function closeSidebarMobile() { if (matchMedia('(max-width: 820px)').matches) toggleSidebar(false); }

// ---------- 구글 드라이브 자동 동기화 ----------
export function scheduleSync(delay = 15000) {
  if (!app.settings.autoSync || !G.status().connected) return;
  clearTimeout(app.syncTimer);
  app.syncTimer = setTimeout(() => syncNow({ quiet: true }), delay);
}

export function setSyncState(kind, text) {
  const el = $('#syncState');
  el.className = 'pill ' + (kind || '');
  el.textContent = text;
}

export async function bundleForSync() {
  const b = await S.exportBundle(app.project.id);
  // 너무 커지지 않게: 직접 저장한 버전은 전부, 자동 버전은 최근 300개만 올린다
  const manual = b.snapshots.filter((s) => s.kind === 'manual' || s.label);
  const auto = b.snapshots.filter((s) => !(s.kind === 'manual' || s.label)).sort((a, c) => c.time - a.time).slice(0, 300);
  b.snapshots = [...manual, ...auto];
  return b;
}

let syncing = false;
export async function syncNow({ quiet = false } = {}) {
  if (syncing || !app.project) return;
  syncing = true;
  try {
    await saveNow();
    setSyncState('', '☁ 동기화 중…');
    // 다른 기기에서 더 새로 올렸으면 먼저 받아 온다
    const remote = await G.remoteInfo(app.project.id);
    if (remote && app.project.syncedAt && Date.parse(remote.modifiedTime) > Date.parse(app.project.syncedAt) + 1000) {
      const b = await G.pullBundle(remote.id);
      await S.importBundle(b);
      const p = await S.getProject(app.project.id);
      p.syncedAt = remote.modifiedTime;
      await S.putProject(p);
      app.cur = null;
      await openProject(p.id);
      toast('다른 기기에서 고친 내용을 가져왔어요. 이 기기에서 쓰던 내용은 버전 기록에 남아 있습니다.', 6000);
    }
    const r = await G.pushBundle(await bundleForSync());
    app.project.syncedAt = r.modifiedTime;
    app.project.driveFileId = r.id;
    await S.putProject(app.project);
    setSyncState('ok', `☁ ${hm(Date.now())} 동기화`);
    if (!quiet) toast('구글 드라이브에 저장했어요.');
  } catch (e) {
    setSyncState('err', '☁ 동기화 안 됨');
    if (!quiet) toast(e.message, 6000);
    console.warn(e);
  } finally { syncing = false; }
}

export function refreshSyncPill() {
  const st = G.status();
  if (!st.configured) setSyncState('', '☁ 드라이브 꺼짐');
  else if (!st.connected) setSyncState('', '☁ 드라이브 연결하기');
  else if (!$('#syncState').textContent.includes('동기화')) setSyncState('ok', '☁ 연결됨');
}

export { STATUS };
