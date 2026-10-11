// 작품 목록, 파일 열기/내보내기, 자료실, 목표, 퇴고 도우미, 타이머, 설정, 드라이브, 찾기, 집중 모드, 코르크보드
import * as S from './store.js';
import * as G from './gdrive.js';
import * as SV from './syncserver.js';
import {
  app, saveNow, openProject, openChapter, addChapter, renderBinder, saveSettings, applySettings, updateCounts,
  todayWritten, addOf, renderGoal, syncNow, refreshSyncPill, setSyncState, usingServer, bundleForSync, STATUS, projectTotal, beforeImport,
} from './app.js';
import { openFile, exportBook, download, OPEN_ACCEPT } from './io/index.js';
import { countHtml, fmt, htmlToText, repeatedWords, habitWords, longSentences, dialogueRatio, sentences } from './stats.js';
import { setSearch, gotoMatch, findMatches } from './editor.js';
import { $, $$, h, toast, dialog, confirmDlg, promptDlg, ago, fullTime } from './ui.js';
import { parseHtml, sanitizeHtml } from './sanitize.js';
import { isAnno, annoListItem, editAnno, annosForExport } from './annotate.js';
import { layoutOf, fontName, textCss, readHwpxLayout, setProjectLayout } from './layout.js';
import { FONTS } from './fonts.js';
import { applyPageView } from './pageview.js';
import { showPageSetup, layoutSummary } from './pagesetup.js';

// ---------- 파일 선택 ----------
function pickFile(accept = OPEN_ACCEPT) {
  return new Promise((res) => {
    const inp = $('#fileInput');
    inp.value = '';
    inp.accept = accept;
    inp.onchange = () => res(inp.files[0] || null);
    inp.click();
  });
}

// ---------- 작품 바꾸기 (제목 옆 메뉴) ----------
export async function fillProjectMenu(m) {
  const list = (await S.listProjects()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const rows = await Promise.all(list.slice(0, 12).map(async (p) => {
    const chs = await S.chaptersOf(p.id);
    const n = chs.reduce((a, c) => a + countHtml(c.html).withSpace, 0);
    const cur = p.id === app.project?.id;
    return `<button data-act="switchTo" data-id="${p.id}" class="${cur ? 'cur' : ''}" ${cur ? 'aria-current="true"' : ''}>
      <span class="pm-t">${h(p.title)}</span><small>${cur ? '쓰는 중' : `${fmt(n)}자 · ${ago(p.updated)}`}</small></button>`;
  }));
  m.innerHTML = `<div class="pm-head">작품·글 바꾸기</div>${rows.join('')}
    ${list.length > 12 ? `<button data-act="home"><span>다른 작품 ${list.length - 12}개 더 보기…</span></button>` : ''}
    <hr><button data-act="newProject"><span>새 작품 만들기…</span><small>제목 정하기</small></button>
    <button data-act="renameProject"><span>지금 작품 제목 바꾸기</span></button>
    <button data-act="syncImport"><span>${usingServer() ? '동기화 서버' : '구글 드라이브'}에서 불러오기…</span></button>
    <button data-act="open"><span>파일 열기…</span><small>hwpx·docx·pdf…</small></button>
    <button data-act="home"><span>작품 목록 관리…</span><small>삭제</small></button>`;
}
export async function switchProject(id) {
  if (!id || id === app.project?.id) return;
  await saveNow();
  await openProject(id);
  toast(`“${app.project.title}”(으)로 바꿨어요.`);
}

// ---------- 작품 목록 ----------
export async function showHome() {
  await saveNow();
  const list = await S.listProjects();
  const rows = await Promise.all(list.map(async (p) => {
    const chs = await S.chaptersOf(p.id);
    const n = chs.reduce((a, c) => a + countHtml(c.html).withSpace, 0);
    return `<div class="proj" data-open="${p.id}"><div class="info"><b>${h(p.title)}</b><small>${chs.length}개 장 · ${fmt(n)}자 · ${ago(p.updated)} 수정</small></div>
      ${p.id === app.project?.id ? '<span class="pill ok">지금 여는 중</span>' : ''}<button class="small" data-del="${p.id}" title="삭제">삭제</button></div>`;
  }));
  const r = await dialog({
    title: '작품 목록',
    body: `<div class="proj-list">${rows.join('') || '<p class="hint">작품이 없습니다.</p>'}</div>`,
    buttons: [
      { label: '드라이브에서 불러오기', value: 'drive', left: true },
      { label: '파일 열기', value: 'open' },
      { label: '새 작품', value: 'new', primary: true },
    ],
    onOpen: (f, dlg) => {
      f.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-del]');
        if (del) {
          e.preventDefault();
          e.stopPropagation();
          const p = list.find((x) => x.id === del.dataset.del);
          dlg.close('close');
          if (await confirmDlg('작품 삭제', `“${h(p.title)}”의 모든 장·자료·버전 기록을 휴지통으로 옮깁니다. 30일 동안 보관되고, 도구 → ‘실수 되돌리기·복구’에서 되살릴 수 있어요. (드라이브에 올린 백업도 그대로 남습니다)`, '휴지통으로', true)) {
            if (p.id === app.project?.id) await saveNow();
            await S.trashProject(p.id);
            if (p.id === app.project?.id) {
              const rest = await S.listProjects();
              if (rest.length) await openProject(rest[0].id); else await newProject('새 작품');
            }
          }
          showHome();
          return;
        }
        const o = e.target.closest('[data-open]');
        if (o) { dlg.close('close'); await openProject(o.dataset.open); }
      });
    },
  });
  if (r.value === 'new') newProject();
  else if (r.value === 'open') openFromFile();
  else if (r.value === 'drive') syncImport();
}

export async function newProject(title) {
  title = title || await promptDlg('새 작품', '작품 제목', '제목 없는 작품');
  if (!title) return;
  const p = await S.createProject(title);
  await openProject(p.id);
  toast(`“${title}”을(를) 만들었어요.`);
}

export async function openFromFile(given) {
  const f = given instanceof File ? given : await pickFile();
  if (!f) return;
  try {
    const r = await openFile(f, { onProgress: (n, total) => toast(`PDF 읽는 중… ${n}/${total}쪽`, 60000) });
    if (r.kind === 'bundle') {
      await beforeImport();
      const exists = await S.getProject(r.data.project.id);
      const p = await S.importBundle(r.data, { keepIds: !exists || await confirmDlg('백업 불러오기', '같은 작품이 이미 있습니다. 덮어쓸까요? (지금 내용은 버전 기록에 남습니다) “취소”를 누르면 사본으로 불러옵니다.', '덮어쓰기') });
      await openProject(p.id);
      toast('백업을 불러왔어요.');
      return;
    }
    const p = await S.createProject(r.title, r.chapters.length ? r.chapters : [{ title: '1장', html: '' }]);
    // 한글 파일이면 그 쪽 설정(용지·여백·글자)도 가져온다. 줄은 어절 단위로 나눈다.
    if (/\.hwpx$/i.test(f.name)) {
      try {
        p.layout = { ...(await readHwpxLayout(await f.arrayBuffer())), breakWord: 'word', templateId: '', templateName: `“${f.name}”의 쪽 설정` };
        await S.putProject(p);
      } catch { /* 쪽 설정을 못 읽으면 기본 템플릿 */ }
    }
    await openProject(p.id);
    toast(`“${f.name}”을(를) 새 작품으로 열었어요. (${r.chapters.length}개 장)`);
  } catch (e) {
    console.error(e);
    toast('파일을 열지 못했습니다: ' + e.message, 6000);
  }
}

export async function importChapter() {
  const f = await pickFile(OPEN_ACCEPT.replace(',.novel.json,.json,.gz', ''));
  if (!f) return;
  try {
    const r = await openFile(f, { onProgress: (n, total) => toast(`PDF 읽는 중… ${n}/${total}쪽`, 60000) });
    if (r.kind !== 'book') return;
    for (const c of r.chapters) await addChapter(c.title, c.html);
    toast(`${r.chapters.length}개 장을 넣었어요.`);
  } catch (e) { toast('파일을 열지 못했습니다: ' + e.message, 6000); }
}

// ---------- 내보내기 ----------
function bookOf(range) {
  const ids = range === 'cur' ? [app.cur] : app.project.order;
  return {
    title: range === 'cur' ? `${app.project.title} - ${app.chapters.get(app.cur).title}` : app.project.title,
    author: app.settings.author,
    chapters: ids.map((id) => app.chapters.get(id)).map((c) => ({ title: c.title, html: c.id === app.cur ? app.editor.getHTML() : c.html })),
  };
}

export async function showExport() {
  await saveNow();
  const drive = G.status().connected;
  const r = await dialog({
    title: '내보내기',
    body: `
      <label class="field"><span>형식</span><select name="fmt">
        <option value="docx">Word 문서 (.docx)</option>
        <option value="doc">Word 97-2003 문서 (.doc)</option>
        <option value="hwpx">한글 문서 (.hwpx) — 한글 2014 이상에서 열림</option>
        <option value="pdf">PDF (인쇄 창에서 ‘PDF로 저장’)</option>
        <option value="rtf">서식 있는 텍스트 (.rtf)</option>
        <option value="txt">텍스트 (.txt)</option>
        <option value="md">마크다운 (.md)</option>
        <option value="html">웹 페이지 (.html)</option>
      </select></label>
      <label class="field"><span>범위</span><select name="range"><option value="all">작품 전체 (${app.project.order.length}개 장)</option><option value="cur">지금 장만</option></select></label>
      <div class="ps-sum"><span>쪽 설정</span><b>${h(layoutSummary())}</b><button type="button" class="small" data-open-setup>바꾸기</button></div>
      <label class="check"><input type="checkbox" name="titlePage" checked> 표지 (제목·지은이)</label>
      <label class="check"><input type="checkbox" name="chapterTitles" checked> 장 제목 넣기 (장마다 새 쪽)</label>
      <label class="check"><input type="checkbox" name="annos" checked> 본문 주석(교정 제안·인용·의도·색인)을 Word 메모로 넣기 <small class="hint">(.docx만)</small></label>
      <label class="field"><span>지은이 (표지에 표시)</span><input name="author" value="${h(app.settings.author)}" placeholder="필명"></label>
      ${drive ? '<label class="check"><input type="checkbox" name="toDrive"> 구글 드라이브에도 저장 (Word는 Google 문서로 변환)</label>' : '<p class="hint" style="margin:0">구글 드라이브에 연결하면 내보낸 파일을 드라이브에도 바로 넣을 수 있어요.</p>'}
      <p class="hint" style="margin:0">.doc는 Word와 한글이 그대로 여는 RTF 방식으로 저장됩니다. .hwp(옛 한글 형식)로 저장하는 기능은 공개된 방법이 없어 .hwpx로 저장합니다. 한글에서 .hwpx를 연 뒤 ‘다른 이름으로 저장’하면 .hwp로 바꿀 수 있어요.</p>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '내보내기', value: 'ok', primary: true }],
    onOpen: (f) => f.querySelector('[data-open-setup]').addEventListener('click', () => showPageSetup()),
  });
  if (r.value !== 'ok') return;
  const f = r.form;
  app.settings.author = f.author.value.trim();
  saveSettings();
  const book = bookOf(f.range.value);
  if (f.annos.checked && f.fmt.value === 'docx') book.annos = await annosForExport();
  const L = layoutOf();
  const opt = { layout: { ...L, fontName: fontName(L.font) }, size: L.size, lineHeight: L.line / 100, titlePage: f.titlePage.checked, chapterTitles: f.chapterTitles.checked, indent: L.indent > 0 };
  if (f.fmt.value === 'pdf') return printBook(book, opt);
  try {
    const out = await exportBook(f.fmt.value, book, opt);
    download(out.blob, out.name);
    if (f.toDrive?.checked) {
      const res = await G.uploadFile(out.blob, out.name, { asGoogleDoc: f.fmt.value === 'docx' });
      toast(`드라이브에도 저장했어요.${res.webViewLink ? '' : ''}`);
    } else toast(`${out.name} 파일을 만들었어요.`);
  } catch (e) { console.error(e); toast('내보내지 못했습니다: ' + e.message, 6000); }
}

export function printBook(book = bookOf('all'), opt = { titlePage: true, chapterTitles: true }) {
  const L = layoutOf();
  const t = textCss(L);
  let area = $('#printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  // 쪽 설정대로: 용지·여백·쪽 번호(@page), 글자·문단
  const num = { outside: null, center: 'bottom-center', right: 'bottom-right', left: 'bottom-left' }[L.num];
  const numRule = (box) => `@${box} { content: counter(page); font: ${L.size}pt ${t.fontFamily}; color: #444; vertical-align: top; }`;
  const pageNum = L.num === 'none' ? '' : L.num === 'outside'
    ? `@page :right { ${numRule('bottom-right')} } @page :left { ${numRule('bottom-left')} }`
    : `@page { ${numRule(num)} }`;
  const lr = L.mirror ? `@page :left { margin-left: ${L.mr}mm; margin-right: ${L.ml}mm; }` : '';
  area.innerHTML = `<style>
    @media print {
      @page { size: ${L.w}mm ${L.h}mm; margin: ${L.mt + L.mh}mm ${L.mr}mm ${L.mb + L.mf}mm ${L.ml}mm; }
      ${lr} ${pageNum}
      ${L.numStart > 1 ? `#printArea { counter-reset: page ${L.numStart - 1}; }` : ''}
      #printArea .prose { font-family: ${t.fontFamily}; font-size: ${L.size}pt; line-height: ${t.lineHeight}; letter-spacing: ${t.letterSpacing}; text-align: ${t.textAlign}; word-break: ${t.wordBreak}; }
      #printArea .prose p { text-indent: ${L.indent}em; margin: 0 0 ${L.paraAfter}pt; }
      #printArea h1.ch { font-family: ${t.fontFamily}; }
    }</style>` +
    (opt.titlePage ? `<section class="title-page"><h1 style="font-size:26pt">${h(book.title)}</h1><p style="font-size:13pt">${h(book.author || '')}</p></section>` : '') +
    book.chapters.map((c) => `<section>${opt.chapterTitles ? `<h1 class="ch">${h(c.title)}</h1>` : ''}<div class="prose">${sanitizeHtml(c.html)}</div></section>`).join('');
  setTimeout(() => window.print(), 50);
}

export async function downloadBackup() {
  await saveNow();
  const b = S.packBundle(await S.exportBundle(app.project.id));
  download(new Blob([JSON.stringify(b)], { type: 'application/json' }), `${app.project.title}.novel.json`);
  toast('작품 전체(자료·버전 기록 포함)를 백업 파일로 받았어요.');
}

// ---------- 자료실 ----------
const NOTE_TYPES = {
  character: { name: '인물', fields: ['다른 이름', '나이·성별', '역할', '외모', '성격', '말투', '목표·동기', '비밀·약점', '관계'] },
  place: { name: '장소', fields: ['다른 이름', '위치', '분위기·감각', '처음 등장', '의미'] },
  world: { name: '설정·세계관', fields: ['분류', '규칙', '역사'] },
  item: { name: '사물·용어', fields: ['다른 이름', '설명', '등장'] },
  plot: { name: '플롯·복선', fields: ['심은 곳', '거둘 곳', '상태'] },
  memo: { name: '메모', fields: [] },
};

let notesCache = [];
export async function renderNotes() {
  notesCache = await S.notesOf(app.project.id);
  const f = $('#noteFilter').value, q = $('#noteSearch').value.trim();
  const list = notesCache
    .filter((n) => f === 'all' || n.type === f || (f === 'anno' && isAnno(n)))
    .filter((n) => !q || [n.name, n.body, n.quote, n.fix, n.source, n.author, ...Object.values(n.fields || {})].filter(Boolean).join(' ').includes(q))
    .sort((a, b) => (isAnno(a) - isAnno(b)) || (isAnno(a) && isAnno(b) ? (a.time || 0) - (b.time || 0) : (a.type + a.name).localeCompare(b.type + b.name, 'ko')));
  const curHtml = app.editor.getHTML();
  $('#noteList').innerHTML = list.map((n) => isAnno(n) ? annoListItem(n, curHtml) : `<li data-note="${n.id}"><div><span class="k">${NOTE_TYPES[n.type]?.name || ''}</span><b>${h(n.name || '(이름 없음)')}</b></div>
    <div class="d">${h((n.fields?.['역할'] || n.body || '').slice(0, 60))}</div></li>`).join('') || '<p class="hint">인물, 장소, 설정, 복선을 정리해 두세요. 본문 글자를 고르고 마우스 오른쪽을 누르면 색인·교정 제안·인용·의도 주석도 달 수 있어요.</p>';
}

export async function editNote(id, preset = {}) {
  if (id && isAnno(notesCache.find((x) => x.id === id))) { await editAnno(id); return renderNotes(); }
  const filter = NOTE_TYPES[$('#noteFilter').value] ? $('#noteFilter').value : 'all';
  const n = id ? notesCache.find((x) => x.id === id) : { id: S.uid(), projectId: app.project.id, type: preset.body ? 'memo' : filter === 'all' ? 'character' : filter, name: preset.body ? `${app.chapters.get(app.cur)?.title || ''} 메모` : '', fields: {}, body: preset.body || '' };
  const fieldsHtml = (type) => NOTE_TYPES[type].fields.map((k) => `<label class="field"><span>${k}</span><input data-f="${k}" value="${h(n.fields?.[k] || '')}"></label>`).join('');
  // 이 자료가 등장하는 장
  let where = '';
  if (n.name) {
    const hits = app.project.order.map((cid) => app.chapters.get(cid)).filter((c) => htmlToText(c.id === app.cur ? app.editor.getHTML() : c.html).includes(n.name));
    where = `<p class="hint" style="margin:0">등장하는 장: ${hits.length ? hits.map((c) => `<a href="#" data-goto="${c.id}">${h(c.title)}</a>`).join(', ') : '아직 없음'}</p>`;
  }
  const r = await dialog({
    title: id ? n.name || '자료' : '새 자료',
    body: `<div class="row2">
        <label class="field"><span>종류</span><select name="type">${Object.entries(NOTE_TYPES).map(([k, v]) => `<option value="${k}" ${k === n.type ? 'selected' : ''}>${v.name}</option>`).join('')}</select></label>
        <label class="field"><span>이름</span><input name="name" value="${h(n.name)}" required></label>
      </div>
      ${where}
      <div class="row2" id="noteFields">${fieldsHtml(n.type)}</div>
      <label class="field"><span>자세한 내용</span><textarea name="body" rows="8">${h(n.body)}</textarea></label>`,
    buttons: [...(id ? [{ label: '삭제', value: 'delete', left: true }] : []), { label: '취소', value: 'close' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f, dlg) => {
      f.type.addEventListener('change', () => { $('#noteFields', f).innerHTML = fieldsHtml(f.type.value); });
      f.addEventListener('click', (e) => {
        const g = e.target.closest('[data-goto]');
        if (g) { e.preventDefault(); dlg.close('close'); openChapter(g.dataset.goto).then(() => { const m = setSearch(app.editor, n.name, { cls: 'word-hit' }); if (m[0]) gotoMatch(app.editor, m[0]); }); }
      });
      if (!id) f.name.focus();
    },
  });
  if (r.value === 'delete') {
    if (await confirmDlg('자료 삭제', `“${h(n.name)}”을(를) 지울까요?`, '삭제', true)) await S.deleteNote(n.id);
  } else if (r.value === 'ok') {
    const f = r.form;
    n.type = f.type.value; n.name = f.name.value.trim(); n.body = f.body.value;
    n.fields = {};
    $$('[data-f]', f).forEach((i) => { if (i.value.trim()) n.fields[i.dataset.f] = i.value.trim(); });
    await S.putNote(n);
  }
  renderNotes();
}

// ---------- 목표와 기록 ----------
export async function showGoals() {
  await saveNow();
  const p = app.project;
  const daily = await S.dailyOf(p.id);
  const total = projectTotal();
  const goal = p.goalDaily || 0;
  // 연속 기록
  const written = new Map(daily.map((d) => [d.date, addOf(d)]));
  let streak = 0;
  const ok = (w) => w > 0 && (!goal || w >= goal);
  const d0 = new Date();
  if (ok(written.get(S.today(d0)) || 0)) streak++;
  for (let i = 0; i < 3650; i++) {
    d0.setDate(d0.getDate() - 1);
    if (ok(written.get(S.today(d0)) || 0)) streak++; else break;
  }
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push([S.today(d), written.get(S.today(d)) || 0]); }
  const max = Math.max(1, ...days.map((d) => d[1]), goal);
  let need = '';
  if (p.goalTotal && p.deadline) {
    const left = Math.ceil((new Date(p.deadline) - new Date(S.today())) / 864e5);
    const remain = Math.max(0, p.goalTotal - total);
    need = left > 0 ? `마감까지 ${left}일, 하루 ${fmt(Math.ceil(remain / left))}자씩 쓰면 됩니다.` : left === 0 ? '오늘이 마감일이에요.' : '마감일이 지났어요.';
  }
  let manu = 0;
  for (const c of app.chapters.values()) manu += (c._count || countHtml(c.html)).manuscript;
  const done = [...app.chapters.values()].filter((c) => c.status === 'done').length;
  const r = await dialog({
    title: '목표와 기록',
    wide: true,
    body: `<div class="statgrid">
        <div class="stat"><b>${fmt(todayWritten())}</b><span>오늘 쓴 글자 (공백 제외)</span></div>
        <div class="stat"><b>${streak}일</b><span>연속 기록${goal ? ' (목표 달성)' : ''}</span></div>
        <div class="stat"><b>${fmt(total)}</b><span>작품 전체 글자</span></div>
        <div class="stat"><b>${fmt(manu)}매</b><span>200자 원고지</span></div>
        <div class="stat"><b>${done}/${app.chapters.size}</b><span>완료한 장</span></div>
        ${p.goalTotal ? `<div class="stat"><b>${Math.min(100, Math.round(total / p.goalTotal * 100))}%</b><span>작품 목표 ${fmt(p.goalTotal)}자</span></div>` : ''}
      </div>
      <div><span class="hint" style="margin:0">최근 30일 쓴 양 · <a href="#" data-open-stats>쓴·고친·지운 양 그래프 자세히 보기</a></span><div class="chart">${days.map(([d, w]) => `<i style="height:${(w / max) * 100}%" class="${goal && w >= goal ? 'met' : ''}" data-tip="${d.slice(5)} ${fmt(w)}자"></i>`).join('')}</div></div>
      ${need ? `<p style="margin:0">${need}</p>` : ''}
      <div class="row2">
        <label class="field"><span>하루 목표 (글자)</span><input name="daily" type="number" min="0" step="100" value="${goal || ''}" placeholder="예: 3000"></label>
        <label class="field"><span>작품 목표 (글자)</span><input name="total" type="number" min="0" step="1000" value="${p.goalTotal || ''}" placeholder="예: 200000 (장편 약 1,000매)"></label>
      </div>
      <label class="field"><span>마감일</span><input name="deadline" type="date" value="${p.deadline || ''}"></label>
      <p class="hint" style="margin:0">참고: 200자 원고지로 단편 70~100매, 중편 200~500매, 장편 1,000매 이상이 흔한 기준입니다. 공모전마다 다르니 요강을 확인하세요.</p>`,
    buttons: [{ label: '닫기', value: 'close' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f, dlg) => f.addEventListener('click', (e) => {
      if (e.target.closest('[data-open-stats]')) { e.preventDefault(); dlg.close(); import('./stats-view.js').then((m) => m.showStats()); }
    }),
  });
  if (r.value === 'ok') {
    p.goalDaily = +r.form.daily.value || 0;
    p.goalTotal = +r.form.total.value || 0;
    p.deadline = r.form.deadline.value;
    await S.putProject(p);
    renderGoal();
  }
}

// ---------- 퇴고 도우미 ----------
export async function showAnalyze() {
  await saveNow();
  const scope = { v: 'cur' };
  const build = () => {
    const text = scope.v === 'cur' ? htmlToText(app.editor.getHTML()) : app.project.order.map((id) => htmlToText(app.chapters.get(id).html)).join('\n');
    const sents = sentences(text);
    const avg = sents.length ? Math.round(sents.reduce((a, s) => a + s.length, 0) / sents.length) : 0;
    const rep = repeatedWords(text, 40);
    const hab = habitWords(text);
    const longs = longSentences(text, 120).slice(0, 15);
    const words = (list) => list.map(([w, n]) => `<button type="button" data-word="${h(w)}"><span>${h(w)}</span><b>${n}</b></button>`).join('') || '<p class="ana-none">없어요.</p>';
    return `<div class="statgrid ana-stats">
        <div class="stat"><b>${fmt(sents.length)}</b><span>문장</span></div>
        <div class="stat"><b>${avg}자</b><span>평균 문장 길이</span></div>
        <div class="stat"><b>${dialogueRatio(text)}%</b><span>대사 비율</span></div>
        <div class="stat"><b>${longs.length}</b><span>120자 넘는 문장</span></div>
      </div>
      <section class="ana-sec"><header><h3>자주 쓴 낱말</h3><p>누르면 이 장에서 나온 자리를 모두 표시해요.</p></header><div class="wordtable">${words(rep)}</div></section>
      <section class="ana-sec"><header><h3>습관처럼 쓰는 말</h3><p>부사·접속어, ‘것이다’ 같은 표현이에요.</p></header><div class="wordtable">${words(hab)}</div></section>
      <section class="ana-sec"><header><h3>긴 문장</h3><p>120자 넘는 문장을 15개까지 보여 줘요. 누르면 그 문장으로 가요.</p></header><ol class="longs">${longs.map((s) => `<li data-sent="${h(s.slice(0, 30))}" tabindex="0"><span class="len">${s.length}자</span><span class="tx">${h(s)}</span></li>`).join('') || '<p class="ana-none">없어요.</p>'}</ol></section>`;
  };
  await dialog({
    title: '퇴고 도우미',
    wide: true,
    body: `<div class="ana"><div class="seg seg-lg" style="justify-self:start"><button type="button" data-scope="cur" class="on">이 장</button><button type="button" data-scope="all">작품 전체</button></div><div id="anaBody" class="ana-body">${build()}</div></div>`,
    buttons: [{ label: '표시 지우기', value: 'clear' }, { label: '닫기', value: 'close', primary: true }],
    onOpen: (f, dlg) => {
      f.addEventListener('click', (e) => {
        const s = e.target.closest('[data-scope]');
        if (s) { scope.v = s.dataset.scope; $$('[data-scope]', f).forEach((b) => b.classList.toggle('on', b === s)); $('#anaBody', f).innerHTML = build(); return; }
        const w = e.target.closest('[data-word]');
        if (w) { dlg.close('close'); const m = setSearch(app.editor, w.dataset.word, { cls: 'word-hit' }); if (m[0]) gotoMatch(app.editor, m[0]); toast(`이 장에서 “${w.dataset.word}” ${m.length}곳을 표시했어요. Esc로 지웁니다.`); return; }
        const st = e.target.closest('[data-sent]');
        if (st) { dlg.close('close'); const m = setSearch(app.editor, st.dataset.sent, { cls: 'word-hit' }); if (m[0]) gotoMatch(app.editor, m[0]); else toast('이 장에 없는 문장이에요.'); }
      });
    },
  }).then((r) => { if (r.value === 'clear') setSearch(app.editor, ''); });
}

// ---------- 글쓰기 타이머 ----------
let sprint = null;
export async function showSprint() {
  if (sprint) {
    if (await confirmDlg('타이머', '진행 중인 타이머를 멈출까요?', '멈추기')) endSprint(true);
    return;
  }
  const r = await dialog({
    title: '글쓰기 타이머',
    body: `<p class="hint" style="margin:0">정한 시간 동안 고치지 말고 앞으로만 쓰는 연습(스프린트)입니다. 끝나면 쓴 글자 수를 알려 드려요.</p>
      <label class="field"><span>시간 (분)</span><select name="m"><option>10</option><option>15</option><option selected>25</option><option>45</option><option>60</option></select></label>
      <label class="check"><input type="checkbox" name="focus" checked> 집중 모드로 시작</label>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '시작', value: 'ok', primary: true }],
  });
  if (r.value !== 'ok') return;
  const mins = +r.form.m.value;
  sprint = { end: Date.now() + mins * 60e3, start: projectTotal(), mins };
  if (r.form.focus.checked) toggleFocus(true);
  const el = $('#stSprint');
  el.hidden = false;
  sprint.timer = setInterval(() => {
    const left = Math.max(0, sprint.end - Date.now());
    const t = `⏱ ${Math.floor(left / 60e3)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
    el.textContent = t;
    const fc = $('.focus-count');
    if (fc) fc.dataset.timer = t;
    if (!left) endSprint();
  }, 500);
}
function endSprint(cancel) {
  clearInterval(sprint.timer);
  $('#stSprint').hidden = true;
  const w = projectTotal() - sprint.start;
  if (!cancel) {
    toast(`🎉 ${sprint.mins}분 동안 ${fmt(Math.max(0, w))}자를 썼어요!`, 8000);
    try { navigator.vibrate?.(200); } catch { /* 무시 */ }
  }
  sprint = null;
}

// ---------- 설정 ----------
export async function showSettings() {
  const s = app.settings;
  const L = layoutOf();
  const follow = s.followLayout !== false;
  const lfonts = FONTS.some((x) => x[0] === L.font) ? FONTS : [[L.font, fontName(L.font)], ...FONTS];
  const fonts = [
    ["'Gowun Batang', 'Nanum Myeongjo', Batang, serif", '고운바탕'],
    ["'Nanum Myeongjo', Batang, serif", '나눔명조'],
    ["'Noto Serif KR', Batang, serif", '본명조 (Noto Serif KR)'],
    ["'KoPub Batang Light', Batang, serif", 'KoPub바탕 Light'],
    ["Batang, 'AppleMyungjo', serif", '바탕 (설치된 글꼴)'],
    ["'Nanum Gothic', sans-serif", '나눔고딕'],
    ['Pretendard, sans-serif', '프리텐다드'],
  ];
  const r = await dialog({
    title: '글꼴·화면 설정',
    body: `<label class="check"><input type="checkbox" name="follow" ${follow ? 'checked' : ''}> <b>원고 글자를 쪽 설정대로</b> <small>쪽 보기가 아닐 때도 쪽 설정의 글꼴·크기·줄 간격·자간으로 쓰고, 줄도 쪽과 똑같이 바뀌어요</small></label>
      <div class="fl-on" ${follow ? '' : 'hidden'}>
        <label class="field"><span>원고 글꼴</span><select name="lfont">${lfonts.map(([v, l]) => `<option value="${h(v)}" ${v === L.font ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>
        <div class="row3">
          <label class="field"><span>글자 크기 (pt)</span><input name="lsize" type="number" min="6" max="40" step="0.5" value="${L.size}"></label>
          <label class="field"><span>줄 간격 (%)</span><input name="lline" type="number" min="100" max="400" step="5" value="${L.line}"></label>
          <label class="field"><span>자간 (%)</span><input name="lspacing" type="number" min="-50" max="50" step="1" value="${L.spacing}"></label>
          <label class="field"><span>첫 줄 들여쓰기 (글자)</span><input name="lindent" type="number" min="0" max="4" step="0.5" value="${L.indent}"></label>
          <label class="field"><span>문단 뒤 간격 (pt)</span><input name="lpara" type="number" min="0" max="40" step="1" value="${L.paraAfter}"></label>
          <label class="field"><span>화면 배율 (%)</span><input name="zoom" type="number" min="60" max="250" step="5" value="${s.edZoom || 130}"></label>
        </div>
        <p class="hint" style="margin:0">쪽 설정(${h(L.templateName || '직접 정한 설정')})과 같은 값이에요. 여기서 바꾸면 쪽 설정도 함께 바뀌어요. 용지·여백·정렬은 <a href="#" data-ps>쪽 설정</a>에서 바꿔요. 화면 배율은 화면에서만 키우는 값이라 인쇄·내보내기에는 영향이 없어요.</p>
      </div>
      <div class="fl-off" ${follow ? 'hidden' : ''}>
      <label class="field"><span>원고 글꼴</span><select name="font">${fonts.map(([v, l]) => `<option value="${h(v)}" ${v === s.font ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="row2">
        <label class="field"><span>글자 크기 (px)</span><input name="size" type="number" min="12" max="30" value="${s.size}"></label>
        <label class="field"><span>줄 간격</span><input name="lineHeight" type="number" min="1.2" max="3" step="0.1" value="${s.lineHeight}"></label>
        <label class="field"><span>원고 폭 (px)</span><input name="width" type="number" min="480" max="1200" step="20" value="${s.width}"></label>
        <label class="field"><span>문단 사이 간격 (줄)</span><input name="paraSpacing" type="number" min="0" max="2" step="0.25" value="${s.paraSpacing}"></label>
      </div>
      <label class="check"><input type="checkbox" name="indent" ${s.indent ? 'checked' : ''}> 문단 첫 줄 들여쓰기</label>
      </div>
      <div class="row2">
        <label class="field"><span>화면 테마</span><select name="theme">
          <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>기기 설정 따르기</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>밝게</option>
          <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>어둡게 (다크 모드)</option>
          <option value="sepia" ${s.theme === 'sepia' ? 'selected' : ''}>종이색</option></select></label>
        <label class="field"><span>자동 버전 간격 (분)</span><select name="snapshotMinutes">${[1, 3, 5, 10, 30].map((m) => `<option ${m === s.snapshotMinutes ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="smartQuotes" ${s.smartQuotes ? 'checked' : ''}> 따옴표 자동 변환 (" → “ ”)</label>
      <label class="check"><input type="checkbox" name="typewriter" ${s.typewriter ? 'checked' : ''}> 집중 모드에서 타자기 스크롤 (쓰는 줄을 화면 가운데에)</label>
      <label class="check"><input type="checkbox" name="dimFocus" ${s.dimFocus ? 'checked' : ''}> 집중 모드에서 지금 문단만 밝게</label>
      <p class="hint" style="margin:0">자동 저장: 손을 멈추고 5초 뒤 이 기기에 저장됩니다. 버전 기록은 위 간격마다 쌓이고, 3일이 지난 자동 버전은 1시간에 하나, 30일이 지나면 하루에 하나만 남깁니다(직접 저장한 버전은 그대로).</p>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f) => {
      f.follow.addEventListener('change', () => { f.querySelector('.fl-on').hidden = !f.follow.checked; f.querySelector('.fl-off').hidden = f.follow.checked; });
      f.querySelector('[data-ps]').addEventListener('click', (e) => { e.preventDefault(); f.requestSubmit(f.querySelector('.dlg-foot button[value=ok]')); setTimeout(() => showPageSetup(), 0); });
    },
  });
  if (r.value !== 'ok') return;
  const f = r.form;
  s.followLayout = f.follow.checked;
  if (f.follow.checked) {
    s.edZoom = Math.max(60, Math.min(250, +f.zoom.value || 130));
    const num = (x, d) => (Number.isFinite(+x.value) && x.value !== '' ? +x.value : d);
    const next = { ...L, font: f.lfont.value, size: num(f.lsize, L.size), line: num(f.lline, L.line), spacing: num(f.lspacing, L.spacing), indent: num(f.lindent, L.indent), paraAfter: num(f.lpara, L.paraAfter) };
    if (['font', 'size', 'line', 'spacing', 'indent', 'paraAfter'].some((k) => String(next[k]) !== String(L[k]))) { await setProjectLayout(next, null); applyPageView(); }
  }
  Object.assign(s, {
    font: f.font.value, size: +f.size.value, lineHeight: +f.lineHeight.value, width: +f.width.value, paraSpacing: +f.paraSpacing.value,
    theme: f.theme.value, snapshotMinutes: +f.snapshotMinutes.value, indent: f.indent.checked, smartQuotes: f.smartQuotes.checked,
    typewriter: f.typewriter.checked, dimFocus: f.dimFocus.checked,
  });
  saveSettings();
}

// ---------- 구글 드라이브 ----------
export async function showDrive() {
  const st = G.status();
  const origin = location.origin;
  const steps = `<ol class="steps">
      <li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud 콘솔</a>에서 새 프로젝트를 만듭니다.</li>
      <li><a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Drive API</a>를 ‘사용’으로 켭니다.</li>
      <li><a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener">OAuth 동의 화면</a>을 ‘외부’로 만들고, ‘대상’에서 테스트 사용자에 내 구글 계정을 넣습니다.</li>
      <li><a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">클라이언트</a>에서 ‘클라이언트 만들기 → 웹 애플리케이션’을 고르고, ‘승인된 JavaScript 원본’에 <code>${h(origin)}</code> 을 넣습니다.</li>
      <li>만들어진 <b>클라이언트 ID</b>(…apps.googleusercontent.com)를 아래에 붙여 넣습니다. 비밀번호나 ‘클라이언트 보안 비밀’은 필요 없습니다.</li>
    </ol>`;
  const r = await dialog({
    title: '구글 드라이브 연결',
    wide: true,
    body: `<p style="margin:0;line-height:1.6">연결하면 작품이 내 구글 드라이브의 <b>“소설 워드프로세서”</b> 폴더에 자동으로 백업되고, 다른 기기(PC·휴대폰)에서 같은 작품을 이어 쓸 수 있어요. 이 앱이 만든 파일만 볼 수 있는 권한(drive.file)만 씁니다.</p>
      ${st.connected ? `<p class="pill ok" style="justify-self:start">연결됨 · ${app.project.syncedAt ? '마지막 동기화 ' + fullTime(Date.parse(app.project.syncedAt)) : '아직 동기화 전'}</p>` : ''}
      <details ${st.configured ? '' : 'open'}><summary>처음 한 번: 클라이언트 ID 만들기</summary>${steps}</details>
      <label class="field"><span>Google OAuth 클라이언트 ID</span><input name="cid" value="${h(app.settings.driveClientId)}" placeholder="1234567890-xxxx.apps.googleusercontent.com"></label>
      <div class="sync-row"><label class="check"><input type="checkbox" name="auto" ${app.settings.autoSync ? 'checked' : ''}> 자동으로 드라이브에 올리기</label>
        <select name="every" aria-label="올리는 간격">${[1, 5, 10, 30].map((m) => `<option value="${m}" ${+app.settings.syncMinutes === m ? 'selected' : ''}>${m}분마다</option>`).join('')}</select></div>
      <p class="hint" style="margin:0;line-height:1.6">작품마다 드라이브에 <b>파일 하나</b>만 두고 그 파일을 덮어씁니다. 새 파일이 쌓이지 않아요. 원고는 압축하고, 버전 기록은 앞 버전과 달라진 문단만 담아 올립니다. 이 기기에서 저장(5초)은 그대로 하고, 드라이브에는 위 간격과 창을 닫거나 다른 앱으로 넘어갈 때만 올립니다.${app.project.syncedSize ? ` 지금 이 작품 파일 크기: <b>${fmt(Math.max(1, Math.round(app.project.syncedSize / 1024)))}KB</b>` : ''}</p>`,
    buttons: st.connected
      ? [{ label: '연결 끊기', value: 'off', left: true }, { label: '동기화 서버로 바꾸기', value: 'server', left: true }, { label: '드라이브에서 불러오기', value: 'import' }, { label: '지금 동기화', value: 'sync', primary: true }]
      : [{ label: '동기화 서버로 바꾸기', value: 'server', left: true }, { label: '닫기', value: 'close' }, { label: '저장하고 연결', value: 'connect', primary: true }],
  });
  if (r.value === 'close') return;
  if (r.value === 'server') { showServer(); return; }
  app.settings.driveClientId = r.form.cid.value.trim();
  app.settings.autoSync = r.form.auto.checked;
  app.settings.syncMinutes = +r.form.every.value || 5;
  saveSettings();
  G.configure(app.settings.driveClientId);
  if (r.value === 'connect') {
    if (!app.settings.driveClientId) { toast('클라이언트 ID를 넣어 주세요.'); return; }
    try { await G.connect(); useTarget('drive'); toast('구글 드라이브에 연결했어요.'); await syncNow(); } catch (e) { toast('연결하지 못했습니다: ' + e.message, 7000); }
  } else if (r.value === 'sync') { useTarget('drive'); await syncNow(); }
  else if (r.value === 'import') await driveImport();
  else if (r.value === 'off') { G.disconnect(); toast('연결을 끊었어요. 드라이브의 파일은 그대로 남습니다.'); }
  refreshSyncPill();
}

export async function driveImport() {
  if (!G.status().configured) { showDrive(); return; }
  try {
    if (!G.status().connected) await G.connect();
    const files = await G.listBundles();
    const r = await dialog({
      title: '드라이브에서 불러오기',
      body: `<div class="proj-list">${files.map((f) => `<button class="proj" value="${f.id}"><div class="info"><b>${h(f.name.replace(/\.novel\.json(\.gz)?$/, ''))}</b><small>${fullTime(Date.parse(f.modifiedTime))} 저장 · ${fmt(Math.round((+f.size || 0) / 1024))}KB</small></div></button>`).join('') || '<p class="hint">드라이브에 올린 작품이 아직 없습니다.</p>'}</div>`,
      buttons: [{ label: '닫기', value: 'close' }],
    });
    if (!r.value || r.value === 'close') return;
    const b = await G.pullBundle(r.value, S.readBundleBytes);
    await beforeImport();
    const p = await S.importBundle(b);
    const f = files.find((x) => x.id === r.value);
    p.syncedAt = f.modifiedTime;
    await S.putProject(p);
    await openProject(p.id);
    toast(`“${p.title}”을(를) 불러왔어요.`);
  } catch (e) { toast(e.message, 6000); }
}

// ---------- 동기화: 구글 드라이브 / 동기화 서버 중 고른 곳 ----------
function useTarget(t) {
  if (app.settings.syncTarget === t) return;
  app.settings.syncTarget = t;
  saveSettings();
  setSyncState('', '');
  refreshSyncPill();
}
export const showSync = () => (usingServer() ? showServer() : showDrive());
export const syncImport = () => (usingServer() ? serverImport() : driveImport());

// ---------- 동기화 서버 ----------
export async function showServer() {
  const st = SV.status();
  const on = usingServer() && st.configured;
  const here = st.url ? '' : await SV.sameOriginServer(); // 앱을 서버 주소로 열었으면 그 주소를 미리 넣는다
  const url = st.url || here || app.settings.syncServer || '';
  const last = app.project.srvSyncedAt;
  const r = await dialog({
    title: '동기화 서버 연결',
    wide: true,
    body: `<p style="margin:0;line-height:1.6">직접 띄운 <b>동기화 서버</b>에 작품을 맞춰 두고, 데스크톱·노트북·휴대폰 어디서든 같은 작품을 이어 씁니다. 서버는 내 컴퓨터·NAS·클라우드 서버 어디에 띄워도 돼요.</p>
      ${on ? `<p class="pill ${st.error ? 'err' : 'ok'}" style="justify-self:start">${st.error ? h(st.error) : `연결됨 · ${last ? '마지막 동기화 ' + fullTime(Date.parse(last)) : '아직 동기화 전'}`}</p>` : ''}
      <details ${st.configured ? '' : 'open'}><summary>서버 띄우는 법</summary>
        <ol class="steps">
          <li>Node.js가 있는 컴퓨터에서 이 프로그램 저장소를 받고 <code>npm ci && npm run build</code> 다음 <code>npm run server</code> 를 실행합니다. (Docker라면 <code>docker build -f server/Dockerfile -t novel-sync .</code> 후 <code>docker run -d -p 8787:8787 -v novel-data:/data novel-sync</code>)</li>
          <li>처음 켜면 화면에 <b>접속 암호</b>가 나오고 <code>data/access-code.txt</code> 에도 적혀요. 직접 정하려면 <code>SYNC_CODE</code> 환경 변수에 8자 이상으로 넣습니다.</li>
          <li>아래에 서버 주소(예: <code>http://192.168.0.10:8787</code>, <code>https://novel.example.com</code>)와 접속 암호를 넣습니다. 다른 기기에서는 서버 주소를 브라우저로 열어 바로 앱을 써도 돼요.</li>
        </ol>
        <p class="hint" style="margin:0">집 밖에서도 쓰려면 서버를 https 주소로 열어 주세요(공유기 포트 열기, Cloudflare Tunnel, Tailscale 등). 웹 버전(https)에서는 http 주소 서버에 붙지 못하니, 그때는 데스크톱 앱을 쓰거나 서버 주소로 앱을 여세요.</p>
      </details>
      <label class="field"><span>서버 주소</span><input name="url" value="${h(url)}" placeholder="http://192.168.0.10:8787" autocomplete="url" spellcheck="false"></label>
      <label class="field"><span>접속 암호</span><input name="code" type="password" value="" placeholder="${SV.savedCode() ? '저장되어 있음 (바꿀 때만 입력)' : '서버를 켤 때 나온 접속 암호'}" autocomplete="off" spellcheck="false"></label>
      <label class="check"><input type="checkbox" name="remember" ${sessionStorageHas() ? '' : 'checked'}> 이 기기에 접속 암호 기억하기</label>
      <div class="ai-test"><button type="button" class="small" data-a="test">연결 시험</button><span id="svOut" class="hint" aria-live="polite"></span></div>
      <div class="sync-row"><label class="check"><input type="checkbox" name="auto" ${app.settings.autoSync ? 'checked' : ''}> 자동으로 서버에 올리기</label>
        <select name="every" aria-label="올리는 간격">${[1, 5, 10, 30].map((m) => `<option value="${m}" ${+app.settings.syncMinutes === m ? 'selected' : ''}>${m}분마다</option>`).join('')}</select></div>
      <p class="hint" style="margin:0;line-height:1.6">작품마다 서버에 <b>파일 하나</b>를 두고 덮어쓰며, 서버는 덮어쓰기 전 판을 몇 개 따로 남겨 둡니다. 다른 기기에서 먼저 올렸으면 그걸 받아 온 뒤 올리고, 이 기기에서 쓰던 원고는 버전 기록에 남아요. 접속 암호는 이 기기에만 저장되고 백업·동기화 파일에 들어가지 않아요.${app.project.srvSyncedSize ? ` 지금 이 작품 파일 크기: <b>${fmt(Math.max(1, Math.round(app.project.srvSyncedSize / 1024)))}KB</b>` : ''}</p>`,
    buttons: on
      ? [{ label: '연결 끊기', value: 'off', left: true }, { label: '구글 드라이브로 바꾸기', value: 'drive', left: true }, { label: '서버에서 불러오기', value: 'import' }, { label: '지금 동기화', value: 'sync', primary: true }]
      : [{ label: '구글 드라이브로 바꾸기', value: 'drive', left: true }, { label: '닫기', value: 'close' }, { label: '저장하고 연결', value: 'connect', primary: true }],
    onOpen: (f) => {
      const out = $('#svOut');
      f.addEventListener('click', async (e) => {
        if (e.target.closest('[data-a=test]')) {
          out.textContent = '확인하는 중…';
          try { await SV.test(f.url.value, f.code.value.trim() || SV.savedCode()); out.textContent = '✓ 서버에 연결됐어요.'; } catch (err) { out.textContent = '✕ ' + err.message; }
        }
      });
    },
  });
  if (r.value === 'close') return;
  if (r.value === 'drive') { useTarget('drive'); showDrive(); return; }
  const f = r.form;
  const nextUrl = SV.normUrl(f.url.value);
  const typed = f.code.value.trim();
  app.settings.syncServer = nextUrl;
  app.settings.autoSync = f.auto.checked;
  app.settings.syncMinutes = +f.every.value || 5;
  saveSettings();
  if (r.value === 'off') {
    SV.disconnect();
    useTarget('drive');
    toast('서버 연결을 끊었어요. 서버의 작품은 그대로 남습니다.');
    refreshSyncPill();
    return;
  }
  const code = typed || SV.savedCode();
  if (code && (r.value === 'connect' || typed || f.remember.checked === sessionStorageHas())) SV.saveCode(code, f.remember.checked);
  SV.configure(nextUrl);
  if (r.value === 'connect') {
    if (!nextUrl) { toast('서버 주소를 넣어 주세요.'); return; }
    if (!code) { toast('접속 암호를 넣어 주세요.'); return; }
    try { await SV.test(nextUrl, code); } catch (e) { toast('연결하지 못했습니다: ' + e.message, 7000); refreshSyncPill(); return; }
    useTarget('server');
    toast('동기화 서버에 연결했어요.');
    await syncNow();
  } else if (r.value === 'sync') await syncNow();
  else if (r.value === 'import') await serverImport();
  refreshSyncPill();
}
function sessionStorageHas() { try { return !!sessionStorage.getItem('nw-sync-code'); } catch { return false; } }

export async function serverImport() {
  if (!SV.status().configured) { showServer(); return; }
  try {
    const files = await SV.listBundles();
    const here = new Set((await S.listProjects()).map((p) => p.id));
    const r = await dialog({
      title: '동기화 서버에서 불러오기',
      body: `<div class="proj-list">${files.map((f) => `<button class="proj" value="${h(f.id)}"><div class="info"><b>${h(f.name)}</b><small>${fullTime(Date.parse(f.modifiedTime))} 저장 · ${fmt(Math.max(1, Math.round((+f.size || 0) / 1024)))}KB${here.has(f.id) ? ' · 이 기기에도 있음' : ''}</small></div></button>`).join('') || '<p class="hint">서버에 올린 작품이 아직 없습니다.</p>'}</div>`,
      buttons: [{ label: '닫기', value: 'close' }],
    });
    if (!r.value || r.value === 'close') return;
    const f = files.find((x) => x.id === r.value);
    const b = await SV.pullBundle(r.value, S.readBundleBytes);
    await beforeImport();
    const p = await S.importBundle(b);
    p.srvSyncedAt = f.modifiedTime;
    await S.putProject(p);
    await openProject(p.id);
    toast(`“${p.title}”을(를) 불러왔어요.`);
  } catch (e) { toast(e.message, 6000); }
}

// ---------- 찾기 / 바꾸기 ----------
const fs = { matches: [], i: -1 };
export function openFind() {
  const bar = $('#findbar');
  bar.hidden = false;
  const sel = app.editor.state.doc.textBetween(app.editor.state.selection.from, app.editor.state.selection.to, ' ');
  if (sel && sel.length < 60) $('#findInput').value = sel;
  $('#findInput').focus();
  $('#findInput').select();
  runFind();
}
export function closeFind() { $('#findbar').hidden = true; setSearch(app.editor, ''); }
export function runFind(move = 0) {
  const q = $('#findInput').value;
  fs.matches = setSearch(app.editor, q, { current: -1 });
  if (!fs.matches.length) {
    fs.i = -1;
    let extra = '';
    if (q && $('#findAllChapters').checked) {
      const n = app.project.order.filter((id) => id !== app.cur).reduce((a, id) => a + (htmlToText(app.chapters.get(id).html).split(q).length - 1), 0);
      extra = n ? ` (다른 장 ${n})` : '';
    }
    $('#findCount').textContent = q ? '0' + extra : '';
    return;
  }
  const head = app.editor.state.selection.from;
  if (fs.i < 0 || fs.i >= fs.matches.length) fs.i = Math.max(0, fs.matches.findIndex((m) => m.from >= head));
  fs.i = (fs.i + move + fs.matches.length) % fs.matches.length;
  fs.matches = setSearch(app.editor, q, { current: fs.i });
  $('#findCount').textContent = `${fs.i + 1}/${fs.matches.length}`;
  if (move) gotoMatch(app.editor, fs.matches[fs.i]);
}
export async function replaceOne() {
  const m = fs.matches[fs.i];
  if (!m) return runFind(1);
  app.editor.chain().focus().insertContentAt({ from: m.from, to: m.to }, $('#replaceInput').value).run();
  runFind(0);
  if (fs.matches.length) gotoMatch(app.editor, fs.matches[Math.min(fs.i, fs.matches.length - 1)]);
}
export async function replaceAll() {
  const q = $('#findInput').value, rep = $('#replaceInput').value;
  if (!q) return;
  let n = 0;
  // 지금 장: 뒤에서부터 바꿔야 위치가 어긋나지 않는다
  const ms = findMatches(app.editor.state.doc, q).reverse();
  if (ms.length) {
    const { safetyPoint } = await import('./safety.js');
    await safetyPoint(`“${q}” 모두 바꾸기 전`);
    let tr = app.editor.state.tr;
    for (const m of ms) tr = tr.insertText(rep, m.from, m.to);
    app.editor.view.dispatch(tr);
    n += ms.length;
  }
  if ($('#findAllChapters').checked) {
    await saveNow();
    for (const id of app.project.order) {
      if (id === app.cur) continue;
      const c = app.chapters.get(id);
      const div = parseHtml(c.html);
      let k = 0;
      const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const t = w.currentNode; const parts = t.textContent.split(q); if (parts.length > 1) { k += parts.length - 1; t.textContent = parts.join(rep); } }
      if (k) {
        await S.addSnapshot(c, 'safety', `“${q}” 모두 바꾸기 전`);
        c.html = div.innerHTML; c._count = null; c._paras = undefined; c.updated = Date.now();
        await S.putChapter(c);
        app.states.delete(id);
        n += k;
      }
    }
    renderBinder();
  }
  runFind();
  toast(`${n}곳을 바꿨어요. 바꾸기 전 원고는 버전 기록에 남겼어요. (Ctrl+Z 또는 도구 → 실수 되돌리기)`, 5000);
}

// ---------- 집중 모드 ----------
export function toggleFocus(on) {
  const b = document.body;
  on = on ?? !b.classList.contains('focus');
  b.classList.toggle('focus', on);
  $('.focus-exit')?.remove();
  $('.focus-count')?.remove();
  if (on) {
    const x = document.createElement('button');
    x.className = 'small focus-exit';
    x.textContent = '집중 모드 끝내기 (Esc)';
    x.onclick = () => toggleFocus(false);
    const c = document.createElement('div');
    c.className = 'focus-count';
    b.append(x, c);
    try { document.documentElement.requestFullscreen?.(); } catch { /* 무시 */ }
    updateCounts();
    app.editor.commands.focus();
  } else if (document.fullscreenElement) document.exitFullscreen?.();
}

// ---------- 코르크보드 ----------
export function toggleCork(on) {
  const el = $('#cork');
  on = on ?? el.hidden;
  el.hidden = !on;
  if (!on) return;
  saveNow();
  const grid = $('#corkGrid');
  grid.innerHTML = app.project.order.map((id, i) => {
    const c = app.chapters.get(id);
    const n = (c._count || countHtml(c.html));
    return `<div class="card ${c.status || 'draft'}" draggable="true" data-id="${id}">
      <h3><a href="#" data-open-ch="${id}">${i + 1}. ${h(c.title)}</a></h3>
      <textarea data-syn="${id}" placeholder="줄거리를 적어 두세요">${h(c.synopsis || '')}</textarea>
      <div class="meta"><span>${STATUS[c.status] || '초고'}</span><span>${fmt(n.withSpace)}자 · ${n.manuscript}매</span></div></div>`;
  }).join('') + '<div class="card" style="align-items:center;justify-content:center;cursor:pointer;border-top-style:dashed" data-add-card>+ 새 장</div>';
}
export function bindCork() {
  const grid = $('#corkGrid');
  grid.addEventListener('input', async (e) => {
    const id = e.target.dataset.syn;
    if (!id) return;
    const c = app.chapters.get(id);
    c.synopsis = e.target.value;
    clearTimeout(c._synT);
    c._synT = setTimeout(() => { S.putChapter(c); if (id === app.cur) $('#chapterSynopsis').value = c.synopsis; }, 600);
  });
  grid.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open-ch]');
    if (o) { e.preventDefault(); toggleCork(false); openChapter(o.dataset.openCh); }
    if (e.target.closest('[data-add-card]')) { toggleCork(false); addChapter(); }
  });
  let drag = null;
  grid.addEventListener('dragstart', (e) => { drag = e.target.closest('.card')?.dataset.id; });
  grid.addEventListener('dragover', (e) => e.preventDefault());
  grid.addEventListener('drop', async (e) => {
    e.preventDefault();
    const t = e.target.closest('.card')?.dataset.id;
    if (!drag || !t || drag === t) return;
    const o = app.project.order;
    o.splice(o.indexOf(drag), 1);
    o.splice(o.indexOf(t), 0, drag);
    await S.putProject(app.project);
    renderBinder();
    toggleCork(true);
  });
}

export { applySettings };
