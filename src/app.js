// 앱 상태와 핵심 동작: 작품·장 불러오기, 5초 자동 저장, 버전 기록, 원고 목록, 통계
import * as S from './store.js';
import * as G from './gdrive.js';
import * as SV from './syncserver.js';
import { applyTheme, migrateTheme } from './themecolor.js';
import { createEditor, activeState, docParagraphs } from './editor.js';
import { EditorState } from '@tiptap/pm/state';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { countHtml, countText, fmt } from './stats.js';
import { parseHtml, sanitizeHtml } from './sanitize.js';
import { chapterGoalHtml } from './goal.js';
import { layoutOf, textCss, bodyBox, mm2px } from './layout.js';
import { editAmounts, netAmounts, summarize, summaryLine, where, esc } from './diff.js';
import { $, $$, h, toast, toastAction, hms, hm, dayLabel, dialog, confirmDlg, promptDlg } from './ui.js';

const DEFAULTS = {
  font: "'Gowun Batang', 'Nanum Myeongjo', Batang, serif", size: 17, lineHeight: 1.9, width: 720,
  indent: true, paraSpacing: 0, theme: 'auto', bgColor: '', bgColors: [], inkMode: 'auto', hlMode: 'auto', smartQuotes: true, typewriter: false, dimFocus: true,
  snapshotMinutes: 3, autoSaveSeconds: 5, driveClientId: '', syncTarget: 'drive', syncAsked: false, syncServer: '', autoSync: true, syncMinutes: 5, author: '',
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
  hooks: { afterSave: [], afterOpen: [], clips: [] },
};

// ---------- 설정 ----------
export function loadSettings() {
  try { Object.assign(app.settings, JSON.parse(localStorage.getItem('nw-settings') || '{}')); } catch { /* 무시 */ }
  // 1.0.4: 복사·붙여넣기는 쓴·지운 양에서 빼는 것으로 한 번 되돌린다 (그 뒤로는 '오늘 쓴 양'에서 고른 대로)
  if (!app.settings.clipV) { app.settings.countPaste = false; app.settings.clipV = 1; }
  migrateTheme(app.settings);
  // 1.0.15: 앞뒤 빈칸 지우기를 기본으로 켠다 (예전에 꺼진 채로 저장된 것도 한 번 켠다)
  if (!app.settings.tidyV) { if (app.settings.tidy) app.settings.tidy.trim = true; app.settings.tidyV = 1; }
  applySettings();
}
export function saveSettings() {
  try { localStorage.setItem('nw-settings', JSON.stringify(app.settings)); localStorage.setItem('nw-theme', app.settings.theme); } catch { /* 무시 */ }
  applySettings();
}
// 원고 글자를 쪽 설정(글꼴·크기·줄 간격·자간·들여쓰기·문단 간격·정렬·줄 나눔·본문 폭)대로 그릴지
export const followsLayout = () => app.settings.followLayout !== false && !!app.project;
export const screenZoom = () => (app.settings.edZoom || 130) / 100;
export function applySettings() {
  const s = app.settings, r = document.documentElement.style;
  if (followsLayout()) {
    // 쪽 보기가 아니어도 쪽 설정과 같은 글자·같은 줄 바꿈으로 (화면 배율만 키워서)
    const L = layoutOf(), z = screenZoom(), t = textCss(L, z);
    r.setProperty('--ed-font', t.fontFamily);
    r.setProperty('--ed-size', t.fontSize);
    r.setProperty('--ed-line', t.lineHeight);
    r.setProperty('--ed-width', `calc(${(mm2px(bodyBox(L).w) * z).toFixed(1)}px + 160px)`);
    r.setProperty('--ed-indent', t.textIndent);
    r.setProperty('--ed-para', t.paraAfter);
    r.setProperty('--ed-ls', t.letterSpacing);
    r.setProperty('--ed-align', t.textAlign);
    r.setProperty('--ed-break', t.wordBreak);
    r.setProperty('--pv-z', String(z));
  } else {
    r.setProperty('--ed-font', s.font);
    r.setProperty('--ed-size', s.size + 'px');
    r.setProperty('--ed-line', s.lineHeight);
    r.setProperty('--ed-width', s.width + 'px');
    r.setProperty('--ed-indent', s.indent ? '1em' : '0');
    r.setProperty('--ed-para', s.paraSpacing + 'em');
    for (const k of ['--ed-ls', '--ed-align', '--ed-break', '--pv-z']) r.removeProperty(k);
  }
  applyTheme(s);
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
  // 붙여넣기·끌어 놓기·잘라내기: 들어오고 나간 글자를 세어 쓴·지운 양에서 빼고, 내용은 클립보드 기록에 남긴다
  app.editor.on('transaction', ({ transaction: tr }) => {
    const ev = tr.getMeta('uiEvent');
    if (!['paste', 'drop', 'cut'].includes(ev) || !tr.docChanged) return;
    let ins = '', del = '';
    tr.steps.forEach((st, i) => {
      if (!st.slice) return; // 글자를 바꾸는 단계만 (꾸밈 단계 제외)
      const d = tr.docs[i];
      if (d && st.to > st.from) del += (del ? '\n' : '') + d.textBetween(st.from, st.to, '\n', '');
      if (st.slice.content.size) ins += (ins ? '\n' : '') + st.slice.content.textBetween(0, st.slice.content.size, '\n', '');
    });
    app.pastePending = (app.pastePending || 0) + nsp(ins);
    app.cutPending = (app.cutPending || 0) + nsp(del);
    if (ev === 'cut') { if (del.trim()) logClip('cut', del); }
    else if (ins.trim()) logClip(ev === 'drop' && del && nsp(del) === nsp(ins) ? 'move' : ev, ins, del);
  });
  // 복사: 편집기가 받기 전에 고른 글자를 읽어 둔다
  $('#editorHost').addEventListener('copy', () => {
    const { from, to } = app.editor.state.selection;
    const t = from === to ? '' : app.editor.state.doc.textBetween(from, to, '\n', '');
    if (t.trim()) logClip('copy', t);
  }, true);
}

// ---------- 클립보드 기록 ----------
const nsp = (t) => (t || '').replace(/\s/g, '').length;
const CLIP_MAX = 50000; // 한 번에 남기는 글자 (아주 긴 붙여넣기는 앞부분만)
// 일일 기록을 읽고 쓰는 일은 한 줄로 세워 서로 덮어쓰지 않게 한다
let dailyQ = Promise.resolve();
function inDaily(fn) { const p = dailyQ.then(fn); dailyQ = p.catch(() => {}); return p; }
async function dailyRec() {
  const total = projectTotal();
  const d = S.today();
  let rec = await S.getDaily(app.project.id, d);
  if (!rec) { rec = { key: `${app.project.id}|${d}`, projectId: app.project.id, date: d, start: total, end: total }; dropOldBases(); }
  return rec;
}
// 클립보드 기록 지우기: t를 주면 그 하나, 안 주면 그날 것 모두
export function removeClips(date, t = null) {
  return inDaily(async () => {
    const rec = await S.getDaily(app.project.id, date);
    if (!rec?.clips) return;
    rec.clips = t == null ? [] : rec.clips.filter((e) => e.t !== t);
    await S.putDaily(rec);
    if (date === S.today()) app.todayRec = rec;
  });
}
export function logClip(k, text, replaced = '') {
  if (!app.project || !app.cur) return;
  const ch = app.cur, title = app.chapters.get(ch)?.title || '';
  return inDaily(async () => {
    const rec = await dailyRec();
    const e = { t: Date.now(), k, ch, title, n: nsp(text), text: text.slice(0, CLIP_MAX) };
    if (text.length > CLIP_MAX) e.cut = true;
    if (replaced && k !== 'move') { e.rep = replaced.slice(0, CLIP_MAX); e.repN = nsp(replaced); }
    (rec.clips ??= []).push(e);
    await S.putDaily(rec);
    app.todayRec = rec;
    app.hooks.clips?.forEach((f) => f());
  }).catch(() => {});
}

let tbRaf;
function syncToolbar() {
  cancelAnimationFrame(tbRaf);
  tbRaf = requestAnimationFrame(() => {
    const a = activeState(app.editor);
    $$('#toolbar [data-cmd]').forEach((b) => b.classList.toggle('on', !!a[b.dataset.cmd]));
    $('#blockType').value = a.block;
    $('#fontFamily').value = [...$('#fontFamily').options].some((o) => o.value === a.font) ? a.font : '';
    app.hooks.toolbar?.();
    // 고른 글자 수 (상태 표시줄)
    const { from, to } = app.editor.state.selection;
    const st = $('#stSel');
    if (st) {
      const t = from === to ? '' : app.editor.state.doc.textBetween(from, to, '\n');
      st.hidden = !t;
      if (t) st.textContent = `고른 글자 ${fmt(t.length)}자 (공백 제외 ${fmt(t.replace(/\s/g, '').length)})`;
    }
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
// 원고 본문(장)과 작품 정보는 반드시 기기에 써야 하는 것, 버전 기록·일일 통계는 덧붙는 기록으로 나눈다.
// 본문을 쓰지 못한 장은 app.unsaved에 남겨 두고(메모리의 ch.html이 최신본) 다시 쓸 때까지 계속 시도한다.
// saveNow()는 본문이 모두 기기에 저장되면 true, 아니면 false를 돌려준다.
let saving = null;
let retryTimer = null;
app.unsaved = new Set(); // 기기에 아직 못 쓴 장 id
app.projUnsaved = false; // 작품 정보(장 순서 등)를 못 씀
app.saveError = null;
export const hasUnsaved = () => app.dirty || app.unsaved.size > 0 || app.projUnsaved;
// 장 전환 등으로 상태 표시를 새로 칠할 때: 못 쓴 것이 남아 있으면 '저장됨'으로 덮지 않는다
export function refreshSaveState() {
  if (app.unsaved.size || app.projUnsaved) setSaveState('err', '저장 실패 · 다시 시도 중');
  else if (app.dirty) setSaveState('dirty', '입력 중…');
  else setSaveState('ok', '저장됨');
}
export async function saveNow({ snapshot = true, track = true } = {}) {
  clearTimeout(app.saveTimer);
  while (saving) await saving;
  if (!hasUnsaved() || !app.project) return true;
  let ok = true;
  saving = (async () => {
    const proj = app.project;
    let cur = null, amounts = null, oldParas = null, newParas = null;
    if (app.dirty && app.cur) {
      cur = app.chapters.get(app.cur);
      newParas = docParagraphs(app.editor.state.doc).map((p) => p.text);
      oldParas = cur._paras ?? htmlParagraphs(cur.html);
      if (track) {
        try { amounts = editAmounts(oldParas, newParas); } catch { /* 계산 실패는 기록만 건너뜀 */ }
      }
      // 이 시점의 원고를 찍어 둔다. 쓰는 동안 더 입력하면 onEdit가 dirty를 다시 켠다.
      cur._paras = newParas;
      cur.html = app.editor.getHTML();
      cur.updated = Date.now();
      app.dirty = false;
      app.unsaved.add(cur.id);
    }
    // 1) 본문: 못 쓴 장을 모두 쓴다
    for (const id of [...app.unsaved]) {
      const c = app.chapters.get(id);
      if (!c || c.projectId !== proj.id) { app.unsaved.delete(id); continue; }
      try { await S.putChapter(c); app.unsaved.delete(id); (app.syncPendingIds ??= new Set()).add(id); } catch (e) { ok = false; app.saveError = e; }
    }
    if (cur && app.unsaved.has(cur.id)) cur._paras = oldParas; // 다음 시도에서 쓴 양을 다시 센다
    // 2) 작품 정보 (장 순서·마지막 장)
    if (ok) {
      try {
        proj.updated = Date.now();
        if (cur) proj.lastChapter = cur.id;
        await S.putProject(proj);
        app.projUnsaved = false;
      } catch (e) { ok = false; app.projUnsaved = true; app.saveError = e; }
    }
    if (!ok) {
      setSaveState('err', '저장 실패 · 다시 시도 중');
      if (!retryTimer) toast('원고를 이 기기에 저장하지 못했습니다: ' + (app.saveError?.message || app.saveError) + ' — 저장 공간을 확인해 주세요. 계속 다시 시도합니다.', 8000);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { retryTimer = null; saveNow(); }, 15e3);
      return;
    }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; toast('밀려 있던 원고를 저장했어요.'); }
    app.saveError = null;
    // 3) 덧붙는 기록: 실패해도 본문은 저장된 것이므로 따로 알린다
    let extraFail = null;
    if (cur) {
      try { if (snapshot) await maybeSnapshot(cur); } catch (e) { extraFail = e; }
      try { await updateDaily(amounts, cur.id, oldParas, newParas); } catch (e) { extraFail = e; }
    }
    if (app.dirty) setSaveState('dirty', '입력 중…');
    else if (extraFail) { setSaveState('warn', `저장됨 ${hms(Date.now())} · 기록 일부 실패`); console.warn(extraFail); }
    else setSaveState('ok', `저장됨 ${hms(Date.now())}`);
    if (app.project === proj) renderBinderCounts();
    app.hooks.afterSave.forEach((f) => f());
    scheduleSync();
  })();
  try { await saving; } finally { saving = null; }
  return ok && !app.unsaved.size && !app.projUnsaved;
}

// 저장에 실패한 채 장·작품을 바꾸거나 닫으려 할 때: 다시 시도 / 복구 파일 / 그대로 진행 / 취소
// lose: 진행하면 저장 못 한 글이 사라지는 경우(작품 바꾸기·닫기·가져오기). 장 바꾸기는 메모리에 남아 계속 다시 시도한다.
export async function ensureSaved(what = '계속하기', { lose = true } = {}) {
  for (;;) {
    if (await saveNow()) return true;
    const names = [...app.unsaved].map((id) => app.chapters.get(id)?.title).filter(Boolean);
    const r = await dialog({
      title: '원고를 저장하지 못했어요',
      body: `<p>이 기기에 원고를 쓰지 못했습니다${app.saveError ? ` (${h(app.saveError.message || app.saveError)})` : ''}.${names.length ? ` 저장되지 않은 장: <b>${names.map(h).join(', ')}</b>` : ''}</p>
        <p>${lose ? `이대로 ${h(what)}하면 <b>저장되지 않은 글을 잃습니다.</b>` : `${h(what)}해도 저장되지 않은 글은 앱을 켜 둔 동안 남아 있고 계속 다시 저장을 시도합니다. 앱을 끄면 사라집니다.`}</p>
        <p class="hint">디스크 공간을 비운 뒤 ‘다시 시도’를 누르거나, 먼저 ‘복구 파일 받기’로 지금 원고를 파일로 받아 두세요.</p>`,
      buttons: [{ label: '취소', value: 'close' }, { label: lose ? '저장하지 않고 진행' : `그대로 ${what}`, value: 'go' }, { label: '복구 파일 받기', value: 'rescue' }, { label: '다시 시도', value: 'retry', primary: true }],
    });
    if (r.value === 'retry') continue;
    if (r.value === 'rescue') { await rescueFile(); continue; }
    if (r.value === 'go') {
      if (lose) { app.unsaved.clear(); app.projUnsaved = false; app.dirty = false; clearTimeout(retryTimer); retryTimer = null; }
      return true;
    }
    return false;
  }
}

// 메모리에 있는 지금 원고 전체를 백업 파일(.novel.json)로 내려받는다. 기기 저장소를 거치지 않는다.
export async function rescueFile() {
  if (!app.project) return;
  if (app.dirty && app.cur) { const c = app.chapters.get(app.cur); c.html = app.editor.getHTML(); }
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
  // 자료·버전 기록은 기기에서 읽을 수 있으면 함께 담고, 장 본문은 메모리의 최신본으로 바꿔 넣는다
  let base = null;
  try { base = S.packBundle(await S.exportBundle(app.project.id)); } catch { /* 읽기도 안 되면 장만 */ }
  const b = { format: 'novel-writer', version: 2, notes: [], snapshots: [], daily: [], ...(base || {}), exported: Date.now(), rescue: true, project: strip(app.project), chapters: [...app.chapters.values()].map(strip) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }));
  a.download = `${app.project.title} 복구 ${S.today()}.novel.json`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60e3);
  toast('지금 원고를 복구 파일로 받았어요. 파일 → 열기로 다시 불러올 수 있어요.', 6000);
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
function updateDaily(...a) { return inDaily(() => writeDaily(...a)); }
async function writeDaily(amounts, chId, oldParas, newParas) {
  const total = projectTotal();
  const rec = await dailyRec();
  rec.end = total;
  if (newParas) await updateNet(rec, chId, oldParas, newParas);
  if (amounts) {
    // 붙여넣은 글자는 쓴 양(add)에 넣되 따로(paste) 적고, 넘치는 만큼은 고친 양에서 뺀다 (고른 글자 위에 붙여넣기).
    // 잘라내기·붙여넣기로 없어진 글자는 지운 양에서 빼서 따로(cut) 적는다. 붙여넣고 바로 되돌린 경우 등을 생각해 이번 변화량을 넘지 않게.
    const pasted = app.pastePending || 0, cut = app.cutPending || 0;
    const pa = Math.min(pasted, amounts.add), pr = Math.min(pasted - pa, amounts.rev), cd = Math.min(cut, amounts.del);
    const a = { add: amounts.add, rev: amounts.rev - pr, del: amounts.del - cd, paste: pa, pasteRev: pr, cut };
    rec.byCh ??= {};
    const c = (rec.byCh[chId] ??= { add: 0, rev: 0, del: 0 });
    for (const k of Object.keys(a)) { rec[k] = (rec[k] || 0) + a[k]; c[k] = (c[k] || 0) + a[k]; }
  }
  app.pastePending = 0;
  app.cutPending = 0;
  rec.written = Math.max(rec.written || 0, total - rec.start);
  await S.putDaily(rec);
  app.todayRec = rec;
  renderGoal();
}

// 전날(지난번) 원고 대비 순 변화: 오늘 처음 고치기 직전의 장 글을 기준으로 잡아 두고, 저장할 때마다 견준다.
// 오늘 이미 고친 장인데 기준이 없으면(이 기능 전, 다른 기기) 오늘 0시 전 마지막 버전 기록을 기준으로 쓴다.
async function updateNet(rec, chId, oldParas, newParas) {
  rec.base ??= {};
  rec.net ??= {};
  if (rec.base[chId] === undefined) {
    let base = oldParas;
    const c = rec.byCh?.[chId];
    if (c && (c.add || c.rev || c.del)) {
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const snap = (await S.snapshotsOf(chId)).find((x) => x.time < midnight.getTime());
      if (snap) base = htmlParagraphs(snap.html);
    }
    rec.base[chId] = base.join('\n');
  }
  try {
    // 클립보드로 오간 글은 견주기 전에 양쪽에서 걷어 낸다:
    // 기준 글에서는 잘라내거나(옮긴 것 포함) 붙여넣기로 덮어 없어진 글을, 지금 글에서는 붙여넣어 늘어난 글을.
    let base = rec.base[chId], cur = newParas.join('\n');
    const count = (hay, t) => hay.split(t).length - 1;
    const drop = (hay, t, last) => { const k = last ? hay.lastIndexOf(t) : hay.indexOf(t); return k < 0 ? hay : hay.slice(0, k) + hay.slice(k + t.length); };
    const clips = (rec.clips || []).filter((e) => e.ch === chId && !e.cut && e.k !== 'copy' && e.text?.trim());
    for (const e of clips) {
      if (e.k === 'cut') {
        const moved = clips.some((x) => x.t > e.t && ['paste', 'drop'].includes(x.k) && x.text === e.text);
        if (moved || count(base, e.text) > count(cur, e.text)) base = drop(base, e.text);
      } else if (e.k === 'move') base = drop(base, e.text);
      else if (e.rep?.trim() && count(base, e.rep) > count(cur, e.rep)) base = drop(base, e.rep);
    }
    for (const e of clips) if (e.k !== 'cut' && count(cur, e.text) > count(base, e.text)) cur = drop(cur, e.text, true);
    rec.net[chId] = netAmounts(base ? base.split('\n') : [], cur.split('\n'));
  } catch { /* 계산 실패는 건너뜀 */ }
}
// 기준 글은 오늘 기록에만 둔다 (지난 기록에서는 지워 백업·동기화를 가볍게)
async function dropOldBases() {
  try {
    for (const r of await S.dailyOf(app.project.id)) if (r.base && r.date !== S.today()) { delete r.base; await S.putDaily(r); }
  } catch { /* 무시 */ }
}
// 오늘의 순 변화 합계. 오늘 지운 장은 기준 글 전체를 뺀 것으로 센다
export function netToday(r = app.todayRec) {
  const out = { plus: 0, minus: 0 };
  if (!r?.base) return out;
  for (const id of Object.keys(r.base)) {
    if (!app.chapters.has(id)) { out.minus += r.base[id].replace(/\s/g, '').length; continue; }
    const n = r.net?.[id];
    if (n) { out.plus += n.plus; out.minus += n.minus; }
  }
  return out;
}

// ---------- 작품 열기 ----------
// 백업을 들여오기 직전: 쓰던 글을 저장하고, 들여온 뒤 옛 화면 내용이 덮어쓰지 않게 한다
// 저장에 실패해 사용자가 취소하면 false (가져오기를 멈춘다)
export async function beforeImport() {
  if (!(await ensureSaved('가져오기'))) return false;
  clearTimeout(app.saveTimer);
  app.dirty = false;
  return true;
}

export async function openProject(id) {
  if (!(await ensureSaved('다른 작품 열기'))) return false;
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
  applySettings(); // 작품마다 쪽 설정이 다르다
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
  if (app.cur === id) return true;
  if (!(await ensureSaved('장 옮기기', { lose: false }))) return false;
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
  S.putProject(app.project).then(() => { app.projUnsaved = false; }, () => { app.projUnsaved = true; refreshSaveState(); });
  refreshSaveState();
  renderBinder();
  updateCounts();
  if (isTabOpen('history')) renderHistory();
  app.hooks.afterOpen.forEach((f) => f());
  closeSidebarMobile();
  return true;
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

// 쓴 양: 새로 써 넣은 글자(공백 제외). 예전 기록에는 순증가분을 쓴다.
// 설정(countPaste)에 따라 붙여넣은 글자를 빼거나 넣는다 (기본: 뺀다 = 직접 친 글자만)
export const addAll = (r) => (r ? (r.add ?? Math.max(0, (r.end || 0) - (r.start || 0))) + (r.pasteRev || 0) : 0);
export const addTyped = (r) => Math.max(0, addAll(r) - (r?.paste || 0) - (r?.pasteRev || 0));
export const addOf = (r) => (app.settings.countPaste ? addAll(r) : addTyped(r));
// 지운 양: 잘라내기·붙여넣기로 없어진 글자(cut)는 따로 둔다. '붙여넣기까지 포함'을 고르면 더한다
export const delOf = (r) => (r?.del || 0) + (app.settings.countPaste ? r?.cut || 0 : 0);
export const todayWritten = () => addOf(app.todayRec);

// 오늘 기록 초기화 (이 작품). 되돌리기를 위해 이전 기록을 돌려준다
export async function resetToday() {
  await saveNow();
  return inDaily(async () => {
    const total = projectTotal();
    const d = S.today();
    const old = (await S.getDaily(app.project.id, d)) || app.todayRec;
    const rec = { key: `${app.project.id}|${d}`, projectId: app.project.id, date: d, start: total, end: total, written: 0, add: 0, rev: 0, del: 0, paste: 0, cut: 0, byCh: {}, resetAt: Date.now() };
    // 전날 대비와 클립보드 기록은 초기화와 별개
    if (old?.base) { rec.base = structuredClone(old.base); rec.net = structuredClone(old.net || {}); }
    if (old?.clips) rec.clips = structuredClone(old.clips);
    app.pastePending = 0;
    app.cutPending = 0;
    await S.putDaily(rec);
    app.todayRec = rec;
    renderGoal();
    return old ? structuredClone(old) : null;
  });
}
export function restoreToday(old) {
  if (!old) return;
  return inDaily(async () => {
    const cur = await S.getDaily(old.projectId, old.date);
    if (cur?.clips) old.clips = cur.clips; // 그사이 남은 클립보드 기록은 살린다
    await S.putDaily(old);
    app.todayRec = old;
    renderGoal();
  });
}

export function renderGoal() {
  const goal = app.project?.goalDaily || 0;
  const w = todayWritten();
  $('#goalText').textContent = goal ? `${fmt(w)} / ${fmt(goal)}자` : '목표 정하기';
  const r = app.todayRec || {};
  const all = addAll(r), typed = addTyped(r), other = app.settings.countPaste ? typed : all;
  const note = all !== typed ? ` <small>(${app.settings.countPaste ? '직접 친 것' : '붙여넣기 포함'} ${fmt(other)})</small>` : '';
  const nt = netToday(r);
  const net = r.base ? ` <span class="net" title="오늘 처음 고치기 전 원고(전날·지난번)와 견준 순 변화. 썼다가 지운 글자는 빠져요.">전날 대비 <b class="p">+${fmt(nt.plus)}</b> <b class="m">−${fmt(nt.minus)}</b></span>` : '';
  $('#stToday').innerHTML = `오늘 <i class="sw s-add"></i>쓴 <b>${fmt(addOf(r))}</b>${note} <i class="sw s-rev"></i>고친 <b>${fmt(r.rev || 0)}</b> <i class="sw s-del"></i>지운 <b>${fmt(delOf(r))}</b>${net}`;
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
      <span class="t">${h(c.title || `${i + 1}장`)}</span>${chapterGoalHtml(c, n)}<span class="n">${fmt(n)}</span>
      <button class="more" data-more="${id}" title="장 메뉴">⋯</button></li>`;
  }).join('');
  $('#projectCount').textContent = `${app.project.order.length}개 장`;
}
function renderBinderCounts() {
  const c = app.chapters.get(app.cur);
  const li = $(`#chapterList li[data-id="${app.cur}"] .n`);
  if (li && c._count) {
    li.textContent = fmt(c._count.withSpace);
    const g = li.parentElement.querySelector('.ch-goal');
    if (g) g.outerHTML = chapterGoalHtml(c, c._count.withSpace);
  }
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
  const c = S.newChapter(app.project.id, title || `${n}장`, sanitizeHtml(html));
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
      ${id === app.cur ? '<button class="proj" value="split"><div class="info"><b>커서 자리에서 장 나누기</b><small>커서가 있는 문단부터 새 장으로</small></div></button>' : ''}
      <button class="proj" value="delete"><div class="info"><b style="color:var(--del)">삭제</b><small>이 장과 버전 기록을 지웁니다</small></div></button>
    </div>`,
    buttons: [],
  });
  const order = app.project.order, i = order.indexOf(id);
  if (r.value === 'rename') {
    const t = await promptDlg('장 이름 바꾸기', '장 제목', c.title);
    if (t) { c.title = t; await S.putChapter(c); if (id === app.cur) $('#chapterTitle').value = t; }
  } else if (r.value === 'split') {
    const { splitChapterAtCursor } = await import('./tools.js');
    await splitChapterAtCursor();
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
      await S.trashChapter(next, { projectTitle: app.project.title, index: i + 1 });
      app.chapters.delete(next.id);
      app.states.delete(next.id);
      c._paras = undefined;
      order.splice(i + 1, 1);
      await S.putProject(app.project);
      app.states.delete(id);
      if (app.cur === id || app.cur === next.id) { app.cur = null; await openChapter(id); }
    }
  } else if (r.value === 'delete') {
    if (order.length === 1) { toast('마지막 남은 장은 지울 수 없어요.'); return; }
    if (await confirmDlg('장 삭제', `“${h(c.title)}”를 휴지통으로 옮길까요? 버전 기록과 함께 30일 동안 보관되고, 도구 → ‘실수 되돌리기·복구’에서 언제든 되살릴 수 있어요.`, '휴지통으로', true)) {
      if (id === app.cur) await saveNow();
      await S.trashChapter(app.chapters.get(id), { projectTitle: app.project.title, index: i });
      app.states.delete(id);
      toastAction(`“${c.title}”를 휴지통으로 옮겼어요.`, '되살리기', async () => { const t = (await S.trashList()).find((x) => x.kind === 'chapter' && x.chapter.id === id); if (t) app.restoreTrash?.(t.id); });
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

// 기록 탭: 연·월·일로 골라 보기, 버전마다 바로 앞 버전과 비교한 요약
const hf = { y: '', m: '', d: '' };
const parasCache = new Map(); // snapshot id → 문단 글자 목록
function snapParas(s) {
  if (!parasCache.has(s.id)) {
    if (parasCache.size > 400) parasCache.clear();
    const d = new DOMParser().parseFromString(s.html || '', 'text/html');
    parasCache.set(s.id, [...d.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6')].map((e) => e.textContent));
  }
  return parasCache.get(s.id);
}
// 바로 앞 버전과의 차이 요약 (한 번 계산하면 버전에 같이 저장해 둔다)
async function summaryOf(s, prev) {
  if (!prev) return null;
  if (s.sum && s.sumOf === prev.id) return s.sum;
  s.sum = summarize(snapParas(prev), snapParas(s), 40);
  s.sumOf = prev.id;
  // 그사이 지워졌을 수 있으니 다시 읽어서 있을 때만 요약을 붙여 저장한다
  try { const cur = await S.getSnapshot(s.id); if (cur) await S.updateSnapshot({ ...cur, sum: s.sum, sumOf: s.sumOf }); } catch { /* 저장 못 해도 화면에는 보인다 */ }
  return s.sum;
}
const ymd = (t) => { const d = new Date(t); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; };
const inFilter = (t) => { const [y, m, d] = ymd(t); return (!hf.y || y === +hf.y) && (!hf.m || m === +hf.m) && (!hf.d || d === +hf.d); };

function fillFilter(list) {
  const opts = (sel, vals, all, unit) => {
    const v = [...new Set(vals)].sort((a, b) => b - a);
    const cur = sel.value;
    sel.innerHTML = `<option value="">${all}</option>` + v.map((x) => `<option value="${x}">${x}${unit}</option>`).join('');
    sel.value = v.includes(+cur) ? cur : '';
  };
  const ds = list.map((s) => ymd(s.time));
  opts($('#hfYear'), ds.map((d) => d[0]), '모든 해', '년');
  hf.y = $('#hfYear').value;
  opts($('#hfMonth'), ds.filter((d) => !hf.y || d[0] === +hf.y).map((d) => d[1]), '모든 달', '월');
  hf.m = $('#hfMonth').value;
  opts($('#hfDay'), ds.filter((d) => (!hf.y || d[0] === +hf.y) && (!hf.m || d[1] === +hf.m)).map((d) => d[2]), '모든 날', '일');
  hf.d = $('#hfDay').value;
  // 일을 고르려면 달이, 달을 고르려면 해가 정해져 있어야 헷갈리지 않는다
  $('#hfMonth').disabled = !hf.y;
  $('#hfDay').disabled = !hf.m;
}

let histRun = 0;
const countCache = new Map(); // snapshot id → 글자 수
const snapCount = (s) => { if (!countCache.has(s.id)) countCache.set(s.id, countHtml(s.html).withSpace); return countCache.get(s.id); };
export async function renderHistory() {
  const run = ++histRun;
  const all = await S.snapshotsOf(app.cur);
  if (run !== histRun) return;
  const box = $('#historyList');
  fillFilter(all);
  const any = hf.y || hf.m || hf.d;
  $('#histSummary').hidden = !any;
  if (!all.length) { box.innerHTML = '<p class="hint">아직 저장된 버전이 없습니다. 글을 쓰면 자동으로 쌓여요.</p>'; return; }
  const idx = all.map((s, i) => [s, i]).filter(([s]) => inFilter(s.time));
  if (!idx.length) { box.innerHTML = '<p class="hint">고른 날짜에 저장된 버전이 없습니다.</p>'; return; }
  let html = any ? `<p class="hint hist-count">${idx.length}개 버전</p>` : '', day = '';
  for (const [s, i] of idx) {
    const d = dayLabel(s.time);
    if (d !== day) { html += `<h4>${d}</h4>`; day = d; }
    const prev = all[i + 1];
    const n = snapCount(s);
    const delta = prev ? n - snapCount(prev) : 0;
    const lb = s.kind === 'safety' ? `<b class="safe">${h(s.label || '자동 보관')}</b>` : s.label ? `<b>${h(s.label)}</b>` : s.kind === 'manual' ? '<b>직접 저장</b>' : '자동';
    const sum = prev ? (s.sum && s.sumOf === prev.id ? h(summaryLine(s.sum)) : '…') : '처음 버전';
    html += `<div class="h" data-snap="${s.id}"><div class="h-top"><span class="tm">${hm(s.time)}</span><span class="lb">${lb}</span>
      <span class="delta">${delta > 0 ? `<span class="p">+${fmt(delta)}</span>` : delta < 0 ? `<span class="m">${fmt(delta)}</span>` : ''}</span></div>
      <div class="sum" data-sum="${s.id}">${sum}</div></div>`;
  }
  box.innerHTML = html;
  // 요약은 화면이 멈추지 않게 조금씩 계산한다
  const todo = idx.filter(([s, i]) => all[i + 1] && !(s.sum && s.sumOf === all[i + 1].id));
  const idle = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 16));
  const step = (dl) => {
    if (run !== histRun) return;
    while (todo.length && dl.timeRemaining() > 2) {
      const [s, i] = todo.shift();
      summaryOf(s, all[i + 1]).then((sm) => { const el = box.querySelector(`[data-sum="${s.id}"]`); if (el) el.textContent = summaryLine(sm); });
    }
    if (todo.length) idle(step);
  };
  idle(step);
}

// 바뀐 곳 목록 (HTML)
export function placesHtml(sm, { limit = 40 } = {}) {
  if (!sm || !sm.total) return '<p class="hint">바뀐 곳이 없습니다.</p>';
  const items = sm.places.slice(0, limit).map((p) => {
    const at = `<b>${p.at}${p.n > 1 ? `~${p.at + p.n - 1}` : ''}번째 문단</b> <span class="where">${where(p.pos)} · ${p.pos}%</span>`;
    if (p.kind === 'added') return `<li class="k-add">${at} <span class="kind">${p.n > 1 ? `${p.n}문단 ` : ''}새로 씀</span><div class="snip"><ins>${esc(p.add)}</ins></div></li>`;
    if (p.kind === 'removed') return `<li class="k-del">${at} <span class="kind">${p.n > 1 ? `${p.n}문단 ` : ''}지움</span><div class="snip"><del>${esc(p.del)}</del></div></li>`;
    return `<li class="k-chg">${at} <span class="kind">고침</span>${p.edits.map((e) => `<div class="snip">${esc(e.before)}${e.del ? `<del>${esc(e.del)}</del>` : ''}${e.add ? `<ins>${esc(e.add)}</ins>` : ''}${esc(e.after)}</div>`).join('')}${p.more ? `<div class="hint">이 문단에서 ${p.more}곳 더</div>` : ''}</li>`;
  });
  const st = sm.stats;
  const bits = [st.changedParas && `문단 ${fmt(st.changedParas)}개 고침`, st.addedParas && `${fmt(st.addedParas)}문단 추가`, st.removedParas && `${fmt(st.removedParas)}문단 삭제`].filter(Boolean).join(' · ');
  return `<p class="hint" style="margin:0">${bits} · 글자 <span class="p">+${fmt(st.added)}</span> <span class="m">−${fmt(st.removed)}</span></p>
    <ol class="places">${items.join('')}</ol>${sm.total > limit ? `<p class="hint">그 밖에 ${fmt(sm.total - limit)}곳 더 바뀌었습니다. ‘지금과 비교’나 퇴고 모드에서 전부 볼 수 있어요.</p>` : ''}`;
}

// 고른 기간에 바뀐 내용 정리: 기간 바로 전 버전 → 기간의 마지막 버전
export async function summarizePeriod() {
  const all = await S.snapshotsOf(app.cur);
  const inP = all.filter((s) => inFilter(s.time));
  if (!inP.length) return;
  const last = inP[0];
  const first = inP[inP.length - 1];
  const before = all[all.indexOf(first) + 1] || first;
  const label = [hf.y && `${hf.y}년`, hf.m && `${hf.m}월`, hf.d && `${hf.d}일`].filter(Boolean).join(' ');
  const sm = summarize(snapParas(before), snapParas(last), 120);
  const r = await dialog({
    title: `${label}에 바뀐 내용`,
    wide: true,
    body: `<p class="hint" style="margin:0">${before === first ? '이 기간 첫 버전' : '이 기간 바로 전 버전'}(${dayLabel(before.time)} ${hm(before.time)})과 이 기간 마지막 버전(${dayLabel(last.time)} ${hm(last.time)})을 비교했습니다. 버전 ${inP.length}개.</p>
      <div class="sum-box">${placesHtml(sm, { limit: 120 })}</div>`,
    buttons: [{ label: '닫기', value: 'close' }, { label: '기간 전 버전과 지금 원고 나란히 보기', value: 'rev', primary: true }],
  });
  if (r.value === 'rev') app.openRevision?.(before.id);
}

export async function snapshotMenu(id) {
  const s = await S.getSnapshot(id);
  const c = countHtml(s.html);
  const all = await S.snapshotsOf(s.chapterId);
  const prev = all[all.findIndex((x) => x.id === s.id) + 1];
  const sm = prev ? await summaryOf(s, prev) : null;
  const r = await dialog({
    title: `${dayLabel(s.time)} ${hms(s.time)} 버전`,
    body: `<p class="hint" style="margin:0">${s.label ? h(s.label) + ' · ' : ''}${fmt(c.withSpace)}자 · 원고지 ${fmt(c.manuscript)}매</p>
      <details class="sum-box" open><summary>바뀐 내용 요약 <small>${prev ? `바로 앞 버전(${hm(prev.time)})과 비교` : '처음 버전'}</small></summary>${prev ? placesHtml(sm) : '<p class="hint">이 장의 첫 버전이라 비교할 앞 버전이 없습니다.</p>'}</details>
      <details class="sum-box"><summary>이 버전 원고 보기</summary><div class="prose" style="max-height:40vh;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:14px 16px;background:var(--bg)">${sanitizeHtml(s.html) || '<p class="hint">(빈 원고)</p>'}</div></details>`,
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
  if (s.chapterId !== app.cur && app.chapters.has(s.chapterId)) await openChapter(s.chapterId);
  if (!(await confirmDlg('이 버전으로 되돌리기', `지금 원고를 ${dayLabel(s.time)} ${hm(s.time)} 버전으로 바꿉니다. 지금 상태는 “되돌리기 전” 버전으로 기록에 남으니 언제든 다시 돌아올 수 있어요.`, '되돌리기'))) return false;
  if (!(await saveNow({ snapshot: false }))) { toast('지금 원고를 저장하지 못해 되돌리지 않았어요. 저장 공간을 확인해 주세요.', 6000); return false; }
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
  const el = parseHtml(html);
  const doc = PMDOMParser.fromSchema(app.editor.schema).parse(el);
  return docParagraphs(doc).map((p) => p.text);
}

// ---------- 왼쪽 목록 (넓은 화면: 접기/펴기, 휴대폰: 서랍처럼 열기) ----------
export function toggleSidebar(open) {
  if (!matchMedia('(max-width: 820px)').matches) {
    const hide = open === undefined ? !document.body.classList.contains('sb-hidden') : !open;
    document.body.classList.toggle('sb-hidden', hide);
    app.settings.sidebarHidden = hide;
    saveSettings();
    return;
  }
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

// ---------- 자동 동기화 (구글 드라이브 또는 직접 띄운 동기화 서버) ----------
// 자동 동기화: 저장할 때마다가 아니라 정해 둔 간격(기본 5분)에 한 번만 올린다.
// 바뀐 게 없으면 올리지 않고, 창을 닫거나 다른 앱으로 넘어갈 때는 바로 올린다.
// 저장 방식(settings.syncTarget): 'off' 이 기기에만(오프라인) · 'server' 개인 서버 · 'drive' 구글 드라이브.
// 작품에는 어디와 마지막으로 맞췄는지 따로 적어 둔다.
const OFF = { status: () => ({ configured: false, connected: false, hadToken: false }) };
export const syncTarget = () => (['off', 'server', 'drive'].includes(app.settings.syncTarget) ? app.settings.syncTarget : 'drive');
export const usingServer = () => syncTarget() === 'server';
export const isOffline = () => syncTarget() === 'off';
export const syncBackend = () => (isOffline() ? OFF : usingServer() ? SV : G);
const syncKey = () => (usingServer() ? 'srvSyncedAt' : 'syncedAt');
export const syncedAtOf = (p) => p?.[syncKey()];
let pushedAt = 0;
function needReconnect() {
  const st = syncBackend().status();
  if (app.settings.autoSync && st.configured && st.hadToken && !st.connected) setSyncState('err', '☁ 다시 연결해 주세요');
}
export function scheduleSync(delay) {
  app.syncPending = true;
  if (!app.settings.autoSync || !syncBackend().status().connected) { needReconnect(); return; }
  if (app.syncTimer) return; // 이미 예약됨
  const every = (+app.settings.syncMinutes || 5) * 60e3;
  const wait = delay ?? Math.max(10e3, pushedAt + every - Date.now());
  app.syncTimer = setTimeout(() => { app.syncTimer = null; if (app.syncPending) syncNow({ quiet: true }); }, wait);
}
export function flushSync() {
  if (!app.syncPending || !app.settings.autoSync) return null;
  if (!syncBackend().status().connected) { needReconnect(); return null; }
  clearTimeout(app.syncTimer); app.syncTimer = null;
  return syncNow({ quiet: true });
}

export function setSyncState(kind, text) {
  const el = $('#syncState');
  el.className = 'pill ' + (kind || '');
  el.textContent = text;
}

// 올릴 묶음: 버전 기록은 앞 버전과 달라진 문단만 담는다 (packBundle)
export async function bundleForSync(pid = app.project.id) {
  return S.packBundle(await S.exportBundle(pid));
}

// 동기화는 시작할 때 정한 작품(pid)에 대해서만 일한다. 기다리는 사이 다른 작품을 열어도
// 받은 결과·완료 표시는 그 작품(pid)에만 적고, 지금 열린 작품의 상태를 덮지 않는다.
const isOpen = (pid) => app.project?.id === pid;
// 작품 정보 고치기: 열려 있는 작품이면 메모리 객체를 고쳐 저장(다음 저장이 옛 값으로 덮지 않게), 아니면 기기의 것을
async function patchProject(pid, fn) {
  if (isOpen(pid)) { fn(app.project); await S.putProject(app.project); return app.project; }
  const p = await S.getProject(pid);
  if (!p) return null;
  fn(p);
  await S.putProject(p);
  return p;
}

// 다른 기기에서 올린 것을 받아 와 이 기기 작품에 맞춘다 (이 기기에서 쓰던 원고는 버전 기록에 남는다)
async function pullRemote(B, key, remote, pid) {
  const b = await B.pullBundle(remote.id, S.readBundleBytes);
  if (b?.project?.id !== pid) throw new Error('받은 파일이 다른 작품입니다.');
  const since = (await S.getProject(pid))?.syncLocal?.[key] || 0;
  const open = isOpen(pid);
  // 열린 작품이면: 받는 동안 쓴 글까지 저장하고(바뀌는 장은 버전으로 남는다) 그동안은 입력을 잠시 막는다
  if (open) app.editor.setEditable(false);
  try {
    if (open && !(await saveNow())) throw new Error('이 기기에 원고를 저장하지 못해 받아 오기를 멈췄어요.');
    // 이 기기에서 아직 올리지 않은 장은 다른 기기가 지웠더라도 남긴다
    const keepLocal = {};
    if (app.syncPendingIds) for (const id of app.syncPendingIds) keepLocal[id] = true;
    await S.importBundle(b, { mode: 'merge', since, keepLocal });
  } finally { if (open) app.editor.setEditable(true); }
  await patchProject(pid, (p) => { p[key] = remote.modifiedTime; });
  if (isOpen(pid)) {
    // 받은 작품 정보로 다시 연다 (저장할 것은 위에서 다 저장함)
    clearTimeout(app.saveTimer); app.dirty = false;
    app.cur = null; app.project = null;
    await openProject(pid);
    toast('다른 기기에서 고친 내용을 가져왔어요. 이 기기에서 쓰던 내용은 버전 기록에 남아 있습니다.', 6000);
  }
}

let syncing = null; // 지금 동기화 중인 작품 id
export async function syncNow({ quiet = false } = {}) {
  if (syncing || !app.project || isOffline()) return;
  const pid = app.project.id; // 이 작업의 작품: 끝날 때까지 바뀌지 않는다
  syncing = pid;
  const B = syncBackend();
  const key = syncKey();
  const server = B === SV;
  const pill = (kind, text) => { if (isOpen(pid)) setSyncState(kind, text); };
  try {
    if (!(await saveNow())) throw new Error('이 기기에 원고를 저장하지 못해 동기화를 미뤘어요.');
    pill('', '☁ 동기화 중…');
    for (let round = 0; ; round++) {
      // 다른 기기에서 더 새로 올렸으면 먼저 받아 온다
      const remote = await B.remoteInfo(pid);
      const meta = await S.getProject(pid);
      if (!meta) return; // 기다리는 사이 작품을 지움
      const mine = meta[key];
      const newer = remote && (server
        ? remote.modifiedTime !== mine // 서버 시각은 서버가 정하니 다르면 다른 기기가 올린 것
        : mine && Date.parse(remote.modifiedTime) > Date.parse(mine) + 1000);
      if (newer) await pullRemote(B, key, remote, pid);
      if (isOpen(pid) && !(await saveNow())) throw new Error('이 기기에 원고를 저장하지 못해 동기화를 미뤘어요.');
      if (isOpen(pid)) app.syncPending = false;
      const startedAt = Date.now();
      const b = await bundleForSync(pid);
      const base = (await S.getProject(pid))?.[key] || '';
      let r;
      try {
        r = await B.pushBundle(b, await S.gzip(JSON.stringify(b)), { baseTime: base });
      } catch (e) {
        // 받아 오는 사이 또 다른 기기가 올렸다: 한 번 더 받아서 맞춘다
        if (e.conflict && round < 2) continue;
        throw e;
      }
      pushedAt = Date.now();
      await patchProject(pid, (p) => {
        p[key] = r.modifiedTime;
        p.syncLocal = { ...(p.syncLocal || {}), [key]: startedAt };
        if (!server) { p.syncedSize = +r.size || 0; p.driveFileId = r.id; } else p.srvSyncedSize = +r.size || 0;
      });
      if (isOpen(pid)) app.syncPendingIds = null;
      break;
    }
    pill('ok', `☁ ${hm(Date.now())} 동기화`);
    if (!quiet && isOpen(pid)) toast(server ? '동기화 서버에 저장했어요.' : '구글 드라이브에 저장했어요.');
  } catch (e) {
    if (isOpen(pid)) app.syncPending = true;
    pill('err', '☁ 동기화 안 됨');
    if (!quiet) toast(e.message, 6000);
    console.warn(e);
  } finally { syncing = null; }
}

export function refreshSyncPill() {
  const pill = $('#syncState');
  const shown = () => /동기화 중|\d 동기화/.test(pill.textContent); // 방금 동기화한 시각은 그대로 둔다
  if (isOffline()) { pill.title = '이 기기에만 저장 (눌러서 저장 방식 바꾸기)'; setSyncState('', '⌂ 이 기기에만'); return; }
  if (usingServer()) {
    const st = SV.status();
    pill.title = '동기화 서버';
    if (!st.configured) setSyncState('', '☁ 서버 연결하기');
    else if (st.error) setSyncState('err', '☁ 동기화 안 됨');
    else if (!shown()) setSyncState('ok', '☁ 서버 연결됨');
    return;
  }
  const st = G.status();
  pill.title = '구글 드라이브';
  if (!st.configured) setSyncState('', '☁ 동기화 꺼짐');
  else if (!st.connected) setSyncState('', '☁ 드라이브 연결하기');
  else if (!shown()) setSyncState('ok', '☁ 드라이브 연결됨');
}

export { STATUS };
