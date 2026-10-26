// 작품 목록, 파일 열기/내보내기, 자료실, 목표, 퇴고 도우미, 타이머, 설정, 드라이브, 찾기, 집중 모드, 코르크보드
import * as S from './store.js';
import * as G from './gdrive.js';
import * as SV from './syncserver.js';
import {
  app, saveNow, openProject, openChapter, addChapter, renderBinder, saveSettings, applySettings, updateCounts,
  todayWritten, addOf, renderGoal, syncNow, refreshSyncPill, setSyncState, usingServer, isOffline, syncTarget, bundleForSync, STATUS, projectTotal, beforeImport, rescueFile,
} from './app.js';
import { openFile, exportBook, download, withDate, OPEN_ACCEPT } from './io/index.js';
import { countHtml, fmt, htmlToText, repeatedWords, habitWords, longSentences, dialogueRatio, sentences } from './stats.js';
import { setSearch, gotoMatch, findMatches } from './editor.js';
import { getHTMLFromFragment } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { $, $$, h, toast, toastAction, dialog, confirmDlg, promptDlg, ago, fullTime } from './ui.js';
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
    ${isOffline() ? '' : `<button data-act="syncImport"><span>${usingServer() ? '개인 서버' : '구글 드라이브'}에서 불러오기…</span></button>`}
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
      const data = S.checkBundle(r.data); // 잘못된 백업이면 아무것도 바꾸기 전에 멈춘다
      const exists = await S.getProject(data.project.id);
      let mode = 'restore';
      if (exists) {
        const c = await dialog({
          title: '백업 불러오기',
          body: `<p>“${h(exists.title)}” 작품이 이미 있습니다.</p>
            <p><b>백업 상태로 되돌리기</b>: 장 구성·순서·자료를 백업과 똑같이 맞춥니다. 백업에 없는 장·자료는 빠지지만, 되돌리기 전 작품 전체가 휴지통에 ‘덮어쓰기 전’으로 남아 도구 → 실수 되돌리기·복구에서 되살릴 수 있어요.</p>
            <p><b>사본으로 불러오기</b>: 지금 작품은 그대로 두고 백업을 새 작품으로 엽니다.</p>`,
          buttons: [{ label: '취소', value: 'close' }, { label: '사본으로 불러오기', value: 'copy' }, { label: '백업 상태로 되돌리기', value: 'restore', primary: true }],
        });
        if (c.value !== 'copy' && c.value !== 'restore') return;
        mode = c.value;
      }
      if (!(await beforeImport())) return;
      const p = await S.importBundle(r.data, { mode });
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
  // 표지·장 제목·장마다 새 쪽: 처음에는 끄고, 고른 것은 다음에도 그대로
  const ex = { titlePage: false, chapterTitles: false, chapterBreak: true, ...(app.settings.exportOpts || {}) };
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
      <label class="field"><span>파일 이름에 날짜</span><select name="nameDate">
        <option value="off">붙이지 않기</option>
        <option value="date" ${app.settings.nameDate === 'date' ? 'selected' : ''}>날짜 붙이기 (예: 제목 ${S.today()}.docx)</option>
        <option value="time" ${app.settings.nameDate === 'time' ? 'selected' : ''}>날짜와 시각 붙이기 (예: 제목 ${S.today()} 1430.docx)</option>
      </select></label>
      <label class="field"><span>범위</span><select name="range"><option value="all">작품 전체 (${app.project.order.length}개 장)</option><option value="cur">지금 장만</option></select></label>
      <div class="ps-sum"><span>쪽 설정</span><b>${h(layoutSummary())}</b><button type="button" class="small" data-open-setup>바꾸기</button></div>
      <label class="check"><input type="checkbox" name="titlePage" ${ex.titlePage ? 'checked' : ''}> 표지 (작품 제목·지은이)</label>
      <label class="check"><input type="checkbox" name="chapterTitles" ${ex.chapterTitles ? 'checked' : ''}> 장 제목 넣기 (‘1장’ 같은 장 이름)</label>
      <label class="check"><input type="checkbox" name="chapterBreak" ${ex.chapterBreak ? 'checked' : ''}> 장마다 새 쪽에서 시작</label>
      <label class="check"><input type="checkbox" name="annos" checked> 본문 주석(교정 제안·인용·의도·색인)을 Word 메모로 넣기 <small class="hint">(.docx만)</small></label>
      <label class="field"><span>지은이 (표지에 표시)</span><input name="author" value="${h(app.settings.author)}" placeholder="필명"></label>
      ${drive ? '<label class="check"><input type="checkbox" name="toDrive"> 구글 드라이브에도 저장 (Word는 Google 문서로 변환)</label>' : '<p class="hint" style="margin:0">구글 드라이브에 연결하면 내보낸 파일을 드라이브에도 바로 넣을 수 있어요.</p>'}
      <p class="hint" style="margin:0">.doc는 Word와 한글이 그대로 여는 RTF 방식으로 저장됩니다. .hwp(옛 한글 형식)로 저장하는 기능은 공개된 방법이 없어 .hwpx로 저장합니다. 한글에서 .hwpx를 연 뒤 ‘다른 이름으로 저장’하면 .hwp로 바꿀 수 있어요.</p>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '내보내기', value: 'ok', primary: true }],
    // 쪽 설정을 열고 돌아오면 내보내기 창의 입력값은 그대로, 쪽 설정 요약만 새로
    onOpen: (f) => f.querySelector('[data-open-setup]').addEventListener('click', async () => { await showPageSetup(); const b = f.querySelector('.ps-sum b'); if (b) b.textContent = layoutSummary(); }),
  });
  if (r.value !== 'ok') return;
  const f = r.form;
  app.settings.author = f.author.value.trim();
  app.settings.exportOpts = { titlePage: f.titlePage.checked, chapterTitles: f.chapterTitles.checked, chapterBreak: f.chapterBreak.checked };
  app.settings.nameDate = f.nameDate.value;
  saveSettings();
  const book = bookOf(f.range.value);
  if (f.annos.checked && f.fmt.value === 'docx') book.annos = await annosForExport();
  const L = layoutOf();
  const opt = { layout: { ...L, fontName: fontName(L.font) }, size: L.size, lineHeight: L.line / 100, titlePage: f.titlePage.checked, chapterTitles: f.chapterTitles.checked, chapterBreak: f.chapterBreak.checked, indent: L.indent > 0 };
  if (f.fmt.value === 'pdf') return printBook(book, opt);
  try {
    const out = await exportBook(f.fmt.value, book, opt);
    out.name = withDate(out.name, app.settings.nameDate);
    download(out.blob, out.name);
    if (f.toDrive?.checked) {
      if (!G.status().connected) await G.connect(); // 직접 고른 일이므로 필요하면 연결 창을 연다
      const res = await G.uploadFile(out.blob, out.name, { asGoogleDoc: f.fmt.value === 'docx' });
      toast(`드라이브에도 저장했어요.${res.webViewLink ? '' : ''}`);
    } else toast(`${out.name} 파일을 만들었어요.`);
  } catch (e) { console.error(e); toast('내보내지 못했습니다: ' + e.message, 6000); }
}

export function printBook(book = bookOf('all'), opt = { titlePage: false, chapterTitles: false, chapterBreak: true, ...(app.settings.exportOpts || {}) }) {
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
    book.chapters.map((c) => `<section${opt.chapterBreak === false ? ' class="cont"' : ''}>${opt.chapterTitles ? `<h1 class="ch">${h(c.title)}</h1>` : ''}<div class="prose">${sanitizeHtml(c.html)}</div></section>`).join('');
  setTimeout(() => window.print(), 50);
}

export async function downloadBackup() {
  // 기기에 저장하지 못했으면 기기 것은 옛 원고이므로, 메모리의 최신 원고로 복구 파일을 만든다
  if (!(await saveNow())) { await rescueFile(); return; }
  const b = S.packBundle(await S.exportBundle(app.project.id));
  download(new Blob([JSON.stringify(b)], { type: 'application/json' }), withDate(`${app.project.title}.novel.json`, app.settings.nameDate));
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
        <div class="field"><span>화면 색</span><button type="button" class="small" data-colors="1">${{ auto: '기기 설정 따르기', light: '라이트', dark: '다크' }[s.theme] || h(s.bgColors.find((c) => c.color === s.bgColor)?.name || s.bgColor || '내 색')} · 바꾸기…</button></div>
        <label class="field"><span>자동 버전 간격 (분)</span><select name="snapshotMinutes">${[1, 3, 5, 10, 30].map((m) => `<option ${m === s.snapshotMinutes ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>저장하는 파일 이름에 날짜 (내보내기·백업·음성 파일)</span><select name="nameDate">${[['off', '붙이지 않기'], ['date', `날짜 붙이기 (예: 제목 ${S.today()}.docx)`], ['time', `날짜와 시각 붙이기 (예: 제목 ${S.today()} 1430.docx)`]].map(([v, l]) => `<option value="${v}" ${(s.nameDate || 'off') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="smartQuotes" ${s.smartQuotes ? 'checked' : ''}> 따옴표 자동 변환 (" → “ ”)</label>
      <label class="check"><input type="checkbox" name="typewriter" ${s.typewriter ? 'checked' : ''}> 집중 모드에서 타자기 스크롤 (쓰는 줄을 화면 가운데에)</label>
      <label class="check"><input type="checkbox" name="dimFocus" ${s.dimFocus ? 'checked' : ''}> 집중 모드에서 지금 문단만 밝게</label>
      <p class="hint" style="margin:0">자동 저장: 손을 멈추고 5초 뒤 이 기기에 저장됩니다. 버전 기록은 위 간격마다 쌓이고, 3일이 지난 자동 버전은 1시간에 하나, 30일이 지나면 하루에 하나만 남깁니다(직접 저장한 버전은 그대로).</p>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f) => {
      f.querySelector('[data-colors]')?.addEventListener('click', async () => { f.requestSubmit(f.querySelector('button[value=close]')); const { showColors } = await import('./themecolor.js'); setTimeout(showColors, 0); });
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
    snapshotMinutes: +f.snapshotMinutes.value, indent: f.indent.checked, smartQuotes: f.smartQuotes.checked,
    typewriter: f.typewriter.checked, dimFocus: f.dimFocus.checked, nameDate: f.nameDate.value,
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
      ? [{ label: '연결 끊기', value: 'off', left: true }, { label: '저장 방식 바꾸기…', value: 'choose', left: true }, { label: '드라이브에서 불러오기', value: 'import' }, { label: '지금 동기화', value: 'sync', primary: true }]
      : [{ label: '저장 방식 바꾸기…', value: 'choose', left: true }, { label: '닫기', value: 'close' }, { label: '저장하고 연결', value: 'connect', primary: true }],
  });
  if (r.value === 'close') return;
  if (r.value === 'choose') { showStorage(); return; }
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
  else if (r.value === 'off') { G.disconnect(); useTarget('off'); toast('연결을 끊었어요. 이제 이 기기에만 저장합니다. 드라이브의 파일은 그대로 남아요.'); }
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
    if (!(await beforeImport())) return;
    const p = await S.importBundle(b);
    const f = files.find((x) => x.id === r.value);
    p.syncedAt = f.modifiedTime;
    await S.putProject(p);
    await openProject(p.id);
    toast(`“${p.title}”을(를) 불러왔어요.`);
  } catch (e) { toast(e.message, 6000); }
}

// ---------- 동기화: 구글 드라이브 / 동기화 서버 중 고른 곳 ----------
export function useTarget(t) {
  if (app.settings.syncTarget === t) return;
  app.settings.syncTarget = t;
  saveSettings();
  setSyncState('', '');
  refreshSyncPill();
}
export const showSync = () => {
  if (isOffline()) return showStorage();
  if (usingServer()) return showServer();
  // 드라이브 연결이 끝난 상태에서 ☁ 표시를 누르면 (사용자가 누른 것이므로) 바로 다시 연결해 동기화한다
  const st = G.status();
  if (st.configured && st.hadToken && !st.connected) {
    // 눌러서 다시 연결: 창 없는 연결은 이미 실패한 뒤이므로, 계정을 고를 수 있는 구글 창을 바로 연다
    // (로그인이 살아 있으면 창이 잠깐 떴다 닫히고, 아니면 계정 고르기·로그인 화면이 보인다)
    return G.connect().then(() => syncNow(), (e) => toast('다시 연결하지 못했어요. ' + e.message, 7000));
  }
  return showDrive();
};
export const syncImport = () => (isOffline() ? showStorage() : usingServer() ? serverImport() : driveImport());

// ---------- 저장 방식 고르기: 처음 켤 때 한 번 묻고, 설정 → 저장 방식에서 언제든 바꾼다 ----------
const STORAGE = [
  { v: 'off', icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>', t: '오프라인 (이 기기에만)', d: '원고를 이 기기에만 저장해요. 인터넷이 없어도 되고 아무 데도 보내지 않아요. 옮길 때는 작품 백업 파일을 써요.' },
  { v: 'server', icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/></svg>', t: '개인 서버', d: '내가 띄운 동기화 서버(내 컴퓨터·NAS·클라우드)에 맞춰 두고 데스크톱·노트북 어디서든 이어 써요. 서버 주소와 접속 암호가 필요해요.' },
  { v: 'drive', icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18z"/></svg>', t: '구글 드라이브', d: '내 구글 드라이브에 작품을 올려 두고 다른 기기에서 이어 써요. 처음 한 번 구글 클라우드에서 클라이언트 ID를 만들어야 해요.' },
];
export async function showStorage({ first = false } = {}) {
  // 처음 묻는 거라면, 이미 연결해 둔 곳을 미리 골라 둔다
  const cur = !first ? syncTarget() : SV.status().configured ? 'server' : G.status().configured ? 'drive' : 'off';
  const r = await dialog({
    title: first ? '원고를 어디에 저장할까요?' : '저장 방식',
    wide: true,
    body: `<p style="margin:0;line-height:1.6">${first ? '처음 한 번만 물어볼게요. ' : ''}어느 쪽을 골라도 원고는 늘 이 기기에 먼저 저장돼요. 나중에 <b>설정 → 저장 방식</b>이나 오른쪽 위 저장 표시를 눌러 언제든 바꿀 수 있어요.</p>
      <div class="st-opts" role="radiogroup" aria-label="저장 방식">${STORAGE.map((o) => `<label class="st-opt"><input type="radio" name="target" value="${o.v}" ${o.v === cur ? 'checked' : ''}><span class="st-ic" aria-hidden="true">${o.icon}</span><span class="st-tx"><b>${o.t}</b><small>${o.d}</small></span></label>`).join('')}</div>`,
    buttons: first ? [{ label: '다음', value: 'ok', primary: true }] : [{ label: '취소', value: 'close' }, { label: '다음', value: 'ok', primary: true }],
  });
  if (first) { app.settings.syncAsked = true; saveSettings(); }
  if (r.value !== 'ok') { if (first) useTarget('off'); refreshSyncPill(); return; }
  const t = r.form.target.value;
  if (t === 'off') {
    const was = syncTarget();
    useTarget('off');
    if (!first && was !== 'off') toast('이제 이 기기에만 저장해요. 서버·드라이브에 올려 둔 작품은 그대로 남아요.');
    else if (first) toast('이 기기에만 저장해요. 설정 → 저장 방식에서 언제든 바꿀 수 있어요.', 5000);
    return;
  }
  // 서버·드라이브는 연결이 되면 그쪽으로 바뀐다. 이미 연결돼 있으면 바로 바꾼다.
  const S2 = t === 'server' ? SV : G;
  if (S2.status().connected) { useTarget(t); syncNow({ quiet: true }); }
  else if (first && !S2.status().configured) useTarget('off'); // 연결을 마치기 전까지는 이 기기에만
  if (t === 'server') await showServer(); else await showDrive();
}

// ---------- 동기화 서버 ----------
export async function showServer() {
  const st = SV.status();
  const on = usingServer() && st.configured;
  const here = st.url ? '' : await SV.sameOriginServer(); // 앱을 서버 주소로 열었으면 그 주소를 미리 넣는다
  const url = st.url || here || app.settings.syncServer || '';
  const last = app.project.srvSyncedAt;
  const r = await dialog({
    title: '개인 서버 연결',
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
      ? [{ label: '연결 끊기', value: 'off', left: true }, { label: '저장 방식 바꾸기…', value: 'choose', left: true }, { label: '서버에서 불러오기', value: 'import' }, { label: '지금 동기화', value: 'sync', primary: true }]
      : [{ label: '저장 방식 바꾸기…', value: 'choose', left: true }, { label: '닫기', value: 'close' }, { label: '저장하고 연결', value: 'connect', primary: true }],
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
  if (r.value === 'choose') { showStorage(); return; }
  const f = r.form;
  const nextUrl = SV.normUrl(f.url.value);
  const typed = f.code.value.trim();
  app.settings.syncServer = nextUrl;
  app.settings.autoSync = f.auto.checked;
  app.settings.syncMinutes = +f.every.value || 5;
  saveSettings();
  if (r.value === 'off') {
    SV.disconnect();
    useTarget('off');
    toast('서버 연결을 끊었어요. 이제 이 기기에만 저장합니다. 서버의 작품은 그대로 남아요.');
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
      title: '개인 서버에서 불러오기',
      body: `<div class="proj-list">${files.map((f) => `<button class="proj" value="${h(f.id)}"><div class="info"><b>${h(f.name)}</b><small>${fullTime(Date.parse(f.modifiedTime))} 저장 · ${fmt(Math.max(1, Math.round((+f.size || 0) / 1024)))}KB${here.has(f.id) ? ' · 이 기기에도 있음' : ''}</small></div></button>`).join('') || '<p class="hint">서버에 올린 작품이 아직 없습니다.</p>'}</div>`,
      buttons: [{ label: '닫기', value: 'close' }],
    });
    if (!r.value || r.value === 'close') return;
    const f = files.find((x) => x.id === r.value);
    const b = await SV.pullBundle(r.value, S.readBundleBytes);
    if (!(await beforeImport())) return;
    const p = await S.importBundle(b);
    p.srvSyncedAt = f.modifiedTime;
    await S.putProject(p);
    await openProject(p.id);
    toast(`“${p.title}”을(를) 불러왔어요.`);
  } catch (e) { toast(e.message, 6000); }
}

// ---------- 찾기 / 바꾸기 ----------
// 찾기·바꾸기는 모든 장에서 같은 방식(문서 모델)으로 한다: 굵게·색 등 서식 경계를 넘는 낱말도 찾고,
// 바꿀 말은 늘 글자 그대로 넣는다(HTML로 해석하지 않는다). 바꾼 글자는 앞 글자의 서식을 따른다.
const fs = { matches: [], i: -1, global: null };
const docOf = (html) => PMDOMParser.fromSchema(app.editor.schema).parse(parseHtml(html || ''));
// 장마다 찾은 개수 (‘모든 장’): 작품 장 순서대로 [{id, n}]
function globalCounts(q) {
  return app.project.order.map((id) => ({ id, n: id === app.cur ? findMatches(app.editor.state.doc, q).length : findMatches(docOf(app.chapters.get(id).html), q).length }));
}
export function openFind() {
  const bar = $('#findbar');
  bar.hidden = false;
  const sel = app.editor.state.doc.textBetween(app.editor.state.selection.from, app.editor.state.selection.to, ' ');
  if (sel && sel.length < 60) $('#findInput').value = sel;
  $('#findInput').focus();
  $('#findInput').select();
  refreshUndoBtn();
  runFind();
}
export function closeFind() { $('#findbar').hidden = true; setSearch(app.editor, ''); }
export async function runFind(move = 0) {
  const q = $('#findInput').value;
  const all = q && $('#findAllChapters').checked;
  fs.matches = setSearch(app.editor, q, { current: -1 });
  fs.global = all ? globalCounts(q) : null;
  const total = fs.global ? fs.global.reduce((a, c) => a + c.n, 0) : fs.matches.length;
  if (!total) { fs.i = -1; $('#findCount').textContent = q ? '0' : ''; return; }
  // 지금 장에 없거나 끝을 넘으면 장 순서를 따라 다음(이전) 장으로 (끝에서는 처음으로 돈다)
  if (all && move && (!fs.matches.length || (move > 0 && fs.i >= fs.matches.length - 1) || (move < 0 && fs.i <= 0))) {
    const order = fs.global, k = order.findIndex((c) => c.id === app.cur);
    for (let step = 1; step <= order.length; step++) {
      const c = order[(k + move * step + order.length * 2) % order.length];
      if (!c.n) continue;
      if (c.id !== app.cur && !(await openChapter(c.id))) return; // 저장 실패로 머무름
      fs.matches = setSearch(app.editor, q, { current: -1 });
      fs.i = move > 0 ? 0 : fs.matches.length - 1;
      return showMatch(q, true);
    }
  }
  if (!fs.matches.length) { fs.i = -1; showCount(); return; }
  const head = app.editor.state.selection.from;
  if (fs.i < 0 || fs.i >= fs.matches.length) fs.i = Math.max(0, fs.matches.findIndex((m) => m.from >= head));
  fs.i = (fs.i + move + fs.matches.length) % fs.matches.length;
  showMatch(q, !!move);
}
function showMatch(q, go) {
  fs.matches = setSearch(app.editor, q, { current: fs.i });
  showCount();
  // 찾을 말을 치면 바로 그 자리(커서 뒤 첫 결과)로 간다: 표시만 하고 선택을 두면 Enter가 그다음으로 건너뛰어 엉뚱한 곳으로 갔다
  if (fs.matches[fs.i]) gotoMatch(app.editor, fs.matches[fs.i]);
}
// 표시: 전체 기준 지금/총수 (‘모든 장’이면 장 순서로 센 번호)
function showCount() {
  if (!fs.global) { $('#findCount').textContent = fs.matches.length ? `${fs.i + 1}/${fs.matches.length}` : '0'; return; }
  const total = fs.global.reduce((a, c) => a + c.n, 0);
  const before = fs.global.slice(0, fs.global.findIndex((c) => c.id === app.cur)).reduce((a, c) => a + c.n, 0);
  $('#findCount').textContent = fs.i >= 0 && fs.matches.length ? `${before + fs.i + 1}/${total}` : `0 (다른 장 ${total})`;
}

// ---------- 바꾸기 되돌리기 ----------
// 바꾸기·모두 바꾸기 한 번마다 바뀐 장의 앞뒤 원고를 기억해 두었다가 ‘되돌리기’로 되돌린다.
// 그 뒤에 손으로 고친 장은 덮어쓰지 않는다 (고친 글이 사라지지 않게). 되돌린 것도 Ctrl+Z로 다시 살릴 수 있다.
const undoStack = []; // [{ label, project, items: [{ id, before, after }] }]
const htmlOf = (doc) => getHTMLFromFragment(doc.content, app.editor.schema);
function refreshUndoBtn() {
  const b = $('#findUndo');
  const u = undoStack.at(-1);
  b.disabled = !u || u.project !== app.project?.id;
  b.title = b.disabled ? '되돌릴 바꾸기가 없어요' : `${u.label} 되돌리기`;
}
function pushUndo(label, items) {
  if (!items.length) return;
  undoStack.push({ label, project: app.project.id, items });
  if (undoStack.length > 30) undoStack.shift();
  refreshUndoBtn();
}
export async function undoReplace() {
  const u = undoStack.at(-1);
  if (!u || u.project !== app.project?.id) { toast('되돌릴 바꾸기가 없어요.'); return; }
  undoStack.pop();
  let done = 0;
  const skipped = [];
  for (const it of u.items) {
    const c = app.chapters.get(it.id);
    if (!c) continue;
    if (it.id === app.cur) {
      if (htmlOf(app.editor.state.doc) !== it.after) { skipped.push(c.title); continue; }
      const doc = docOf(it.before);
      const { state } = app.editor;
      const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
      app.editor.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(state.selection.from, tr.doc.content.size)))).setMeta('nwJump', true));
      done++;
      continue;
    }
    const cached = app.states.get(it.id);
    if ((cached ? htmlOf(cached.doc) : c.html) !== it.after) { skipped.push(c.title); continue; }
    const prev = c.html;
    try {
      c.html = it.before; c._count = null; c._paras = undefined; c.updated = Date.now();
      await S.putChapter(c);
      app.states.delete(it.id);
      done++;
    } catch (e) { c.html = prev; skipped.push(c.title); console.warn(e); }
  }
  if (u.items.length > 1) renderBinder();
  runFind(0);
  refreshUndoBtn();
  toast(skipped.length
    ? `${done ? `${u.label}을(를) 되돌렸지만 ` : ''}${skipped.join(', ')}은(는) 바꾼 뒤에 고친 곳이 있어 그대로 두었어요. 버전 기록에서 바꾸기 전 원고를 볼 수 있어요.`
    : `${u.label}을(를) 되돌렸어요.`, 6000);
}

export async function replaceOne() {
  const m = fs.matches[fs.i];
  if (!m) return runFind(1);
  const q = $('#findInput').value, rep = $('#replaceInput').value;
  const before = htmlOf(app.editor.state.doc);
  // 글자 그대로 넣는다 (‘<b>배</b>’도 그 글자대로)
  app.editor.view.dispatch(putText(app.editor.state.tr, m.from, m.to, rep).setMeta('nwJump', true));
  pushUndo(`“${q}” → “${rep}” 바꾸기`, [{ id: app.cur, before, after: htmlOf(app.editor.state.doc) }]);
  await runFind(0);
  if (fs.matches.length) gotoMatch(app.editor, fs.matches[Math.min(fs.i, fs.matches.length - 1)]);
  toastAction(`1곳을 바꿨어요.`, '되돌리기', undoReplace, 6000);
}
// 찾은 자리를 글자 그대로 바꾼다. 서식·주석은 찾은 낱말의 첫 글자 것을 따른다
// (낱말 전체에 단 주석·굵게가 바꾼 뒤에도 남도록: insertText는 경계에서 앞 글자 서식을 따라 주석이 빠진다)
function putText(tr, from, to, text) {
  const first = tr.doc.nodeAt(from);
  const marks = first?.isText ? first.marks : tr.doc.resolve(from).marks();
  return text ? tr.replaceWith(from, to, tr.doc.type.schema.text(text, marks)) : tr.delete(from, to);
}
// 문서 하나에서 모두 바꾸기 (뒤에서부터 바꿔야 위치가 어긋나지 않는다)
function replaceInDoc(state, q, rep) {
  const ms = findMatches(state.doc, q).reverse();
  let tr = state.tr;
  for (const m of ms) tr = putText(tr, m.from, m.to, rep);
  return { tr, n: ms.length };
}
export async function replaceAll() {
  const q = $('#findInput').value, rep = $('#replaceInput').value;
  if (!q) return;
  const all = $('#findAllChapters').checked;
  // 바꾸기 전에 몇 곳인지 보여 주고 한 번 더 묻는다
  const counts = all ? globalCounts(q).filter((c) => c.n) : [{ id: app.cur, n: findMatches(app.editor.state.doc, q).length }].filter((c) => c.n);
  const total = counts.reduce((a, c) => a + c.n, 0);
  if (!total) { toast(`“${q}”을(를) 찾지 못했어요.`); return; }
  const where = all && counts.length > 1 ? `${counts.length}개 장에서 ` : '';
  if (!(await confirmDlg('모두 바꾸기', `${where}“${h(q)}” ${total}곳을 모두 “${h(rep)}”${rep ? '(으)로' : ' 없이(지우기)'} 바꿉니다.<br><b>정말 바꾸시겠습니까?</b><br><small class="hint">바꾼 뒤에도 찾기 창의 ‘되돌리기’로 되돌릴 수 있어요.</small>`, '바꾸기'))) return;
  let n = 0, chs = 0;
  const failed = [], items = [];
  const { safetyPoint } = await import('./safety.js');
  // 지금 장
  if (findMatches(app.editor.state.doc, q).length) {
    await safetyPoint(`“${q}” 모두 바꾸기 전`);
    const before = htmlOf(app.editor.state.doc);
    const r = replaceInDoc(app.editor.state, q, rep);
    app.editor.view.dispatch(r.tr.setMeta('nwJump', true));
    items.push({ id: app.cur, before, after: htmlOf(app.editor.state.doc) });
    n += r.n; chs++;
  }
  if (all) {
    if (!(await saveNow())) { pushUndo(`“${q}” 모두 바꾸기`, items); toast('지금 장을 저장하지 못해 다른 장은 바꾸지 않았어요. 저장 공간을 확인해 주세요.', 6000); runFind(); return; }
    for (const id of app.project.order) {
      if (id === app.cur) continue;
      const c = app.chapters.get(id);
      const st = EditorState.create({ doc: docOf(c.html), schema: app.editor.schema });
      const r = replaceInDoc(st, q, rep);
      if (!r.n) continue;
      const before = c.html;
      try {
        await S.addSnapshot(c, 'safety', `“${q}” 모두 바꾸기 전`);
        c.html = getHTMLFromFragment(r.tr.doc.content, app.editor.schema);
        c._count = null; c._paras = undefined; c.updated = Date.now();
        await S.putChapter(c);
        app.states.delete(id);
        items.push({ id, before, after: c.html });
        n += r.n; chs++;
      } catch (e) { c.html = before; failed.push(c.title); console.warn(e); }
    }
    renderBinder();
  }
  pushUndo(`“${q}” 모두 바꾸기`, items);
  runFind();
  const msg = failed.length
    ? `${chs}개 장 ${n}곳을 바꿨지만 ${failed.join(', ')}은(는) 저장하지 못해 바꾸지 않았어요.`
    : `${chs > 1 ? `${chs}개 장 ` : ''}${n}곳을 바꿨어요.`;
  toastAction(msg, '되돌리기', undoReplace, 9000);
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
