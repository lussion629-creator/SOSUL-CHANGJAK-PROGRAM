// 작품 목록, 파일 열기/내보내기, 자료실, 목표, 퇴고 도우미, 타이머, 설정, 드라이브, 찾기, 집중 모드, 코르크보드
import * as S from './store.js';
import * as G from './gdrive.js';
import {
  app, saveNow, openProject, openChapter, addChapter, renderBinder, saveSettings, applySettings, updateCounts,
  todayWritten, renderGoal, syncNow, refreshSyncPill, bundleForSync, STATUS, projectTotal,
} from './app.js';
import { openFile, exportBook, download, OPEN_ACCEPT } from './io/index.js';
import { countHtml, fmt, htmlToText, repeatedWords, habitWords, longSentences, dialogueRatio, sentences } from './stats.js';
import { setSearch, gotoMatch, findMatches } from './editor.js';
import { $, $$, h, toast, dialog, confirmDlg, promptDlg, ago, fullTime } from './ui.js';

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
          if (await confirmDlg('작품 삭제', `“${h(p.title)}”의 모든 장·자료·버전 기록을 이 기기에서 지웁니다. 되돌릴 수 없어요. (드라이브에 올린 백업은 남습니다)`, '삭제', true)) {
            await S.deleteProject(p.id);
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
  else if (r.value === 'drive') driveImport();
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
      const exists = await S.getProject(r.data.project.id);
      const p = await S.importBundle(r.data, { keepIds: !exists || await confirmDlg('백업 불러오기', '같은 작품이 이미 있습니다. 덮어쓸까요? (지금 내용은 버전 기록에 남습니다) “취소”를 누르면 사본으로 불러옵니다.', '덮어쓰기') });
      await openProject(p.id);
      toast('백업을 불러왔어요.');
      return;
    }
    const p = await S.createProject(r.title, r.chapters.length ? r.chapters : [{ title: '1장', html: '' }]);
    await openProject(p.id);
    toast(`“${f.name}”을(를) 새 작품으로 열었어요. (${r.chapters.length}개 장)`);
  } catch (e) {
    console.error(e);
    toast('파일을 열지 못했습니다: ' + e.message, 6000);
  }
}

export async function importChapter() {
  const f = await pickFile(OPEN_ACCEPT.replace(',.novel.json,.json', ''));
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
      <div class="row2">
        <label class="field"><span>글자 크기 (pt)</span><input name="size" type="number" min="8" max="20" step="0.5" value="10.5"></label>
        <label class="field"><span>줄 간격 (배)</span><input name="line" type="number" min="1" max="3" step="0.1" value="1.6"></label>
      </div>
      <label class="check"><input type="checkbox" name="titlePage" checked> 표지 (제목·지은이)</label>
      <label class="check"><input type="checkbox" name="chapterTitles" checked> 장 제목 넣기 (장마다 새 쪽)</label>
      <label class="check"><input type="checkbox" name="indent" ${app.settings.indent ? 'checked' : ''}> 문단 첫 줄 들여쓰기</label>
      <label class="field"><span>지은이 (표지에 표시)</span><input name="author" value="${h(app.settings.author)}" placeholder="필명"></label>
      ${drive ? '<label class="check"><input type="checkbox" name="toDrive"> 구글 드라이브에도 저장 (Word는 Google 문서로 변환)</label>' : '<p class="hint" style="margin:0">구글 드라이브에 연결하면 내보낸 파일을 드라이브에도 바로 넣을 수 있어요.</p>'}
      <p class="hint" style="margin:0">.doc는 Word와 한글이 그대로 여는 RTF 방식으로 저장됩니다. .hwp(옛 한글 형식)로 저장하는 기능은 공개된 방법이 없어 .hwpx로 저장합니다. 한글에서 .hwpx를 연 뒤 ‘다른 이름으로 저장’하면 .hwp로 바꿀 수 있어요.</p>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '내보내기', value: 'ok', primary: true }],
  });
  if (r.value !== 'ok') return;
  const f = r.form;
  app.settings.author = f.author.value.trim();
  saveSettings();
  const book = bookOf(f.range.value);
  const opt = { size: +f.size.value || 10.5, lineHeight: +f.line.value || 1.6, titlePage: f.titlePage.checked, chapterTitles: f.chapterTitles.checked, indent: f.indent.checked };
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

export function printBook(book = bookOf('all'), opt = { titlePage: true, chapterTitles: true, size: 10.5, lineHeight: 1.7 }) {
  let area = $('#printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  area.innerHTML = (opt.titlePage ? `<section class="title-page"><h1 style="font-size:26pt">${h(book.title)}</h1><p style="font-size:13pt">${h(book.author || '')}</p></section>` : '') +
    book.chapters.map((c) => `<section>${opt.chapterTitles ? `<h1 class="ch">${h(c.title)}</h1>` : ''}<div class="prose" style="font-size:${opt.size}pt;line-height:${opt.lineHeight}">${c.html}</div></section>`).join('');
  setTimeout(() => window.print(), 50);
}

export async function downloadBackup() {
  await saveNow();
  const b = await S.exportBundle(app.project.id);
  download(new Blob([JSON.stringify(b)], { type: 'application/json' }), `${app.project.title}.novel.json`);
  toast('작품 전체(자료·버전 기록 포함)를 백업 파일로 받았어요.');
}

// ---------- 자료실 ----------
const NOTE_TYPES = {
  character: { name: '인물', fields: ['나이·성별', '역할', '외모', '성격', '말투', '목표·동기', '비밀·약점', '관계'] },
  place: { name: '장소', fields: ['위치', '분위기·감각', '처음 등장', '의미'] },
  world: { name: '설정·세계관', fields: ['분류', '규칙', '역사'] },
  item: { name: '사물·용어', fields: ['설명', '등장'] },
  plot: { name: '플롯·복선', fields: ['심은 곳', '거둘 곳', '상태'] },
  memo: { name: '메모', fields: [] },
};

let notesCache = [];
export async function renderNotes() {
  notesCache = await S.notesOf(app.project.id);
  const f = $('#noteFilter').value, q = $('#noteSearch').value.trim();
  const list = notesCache
    .filter((n) => f === 'all' || n.type === f)
    .filter((n) => !q || (n.name + ' ' + n.body + ' ' + Object.values(n.fields || {}).join(' ')).includes(q))
    .sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name, 'ko'));
  $('#noteList').innerHTML = list.map((n) => `<li data-note="${n.id}"><div><span class="k">${NOTE_TYPES[n.type]?.name || ''}</span><b>${h(n.name || '(이름 없음)')}</b></div>
    <div class="d">${h((n.fields?.['역할'] || n.body || '').slice(0, 60))}</div></li>`).join('') || '<p class="hint">인물, 장소, 설정, 복선을 정리해 두세요.</p>';
}

export async function editNote(id) {
  const filter = $('#noteFilter').value;
  const n = id ? notesCache.find((x) => x.id === id) : { id: S.uid(), projectId: app.project.id, type: filter === 'all' ? 'character' : filter, name: '', fields: {}, body: '' };
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
  const written = new Map(daily.map((d) => [d.date, d.add ?? Math.max(0, (d.end || 0) - (d.start || 0))]));
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
    return `<div class="statgrid">
        <div class="stat"><b>${fmt(sents.length)}</b><span>문장</span></div>
        <div class="stat"><b>${avg}자</b><span>평균 문장 길이</span></div>
        <div class="stat"><b>${dialogueRatio(text)}%</b><span>대사 비율</span></div>
        <div class="stat"><b>${longs.length}</b><span>120자 넘는 문장</span></div>
      </div>
      <div><b>자주 쓴 낱말</b> <span class="hint">누르면 이 장에서 위치를 표시합니다</span><div class="wordtable" style="margin-top:6px">${rep.map(([w, n]) => `<button type="button" data-word="${h(w)}">${h(w)}<b>${n}</b></button>`).join('') || '<span class="hint">없음</span>'}</div></div>
      <div><b>습관처럼 쓰는 말</b> <span class="hint">부사·접속어·‘것이다’ 같은 표현</span><div class="wordtable" style="margin-top:6px">${hab.map(([w, n]) => `<button type="button" data-word="${h(w)}">${h(w)}<b>${n}</b></button>`).join('') || '<span class="hint">없음</span>'}</div></div>
      <div><b>긴 문장</b><div class="longs" style="margin-top:6px">${longs.map((s) => `<div data-sent="${h(s.slice(0, 30))}"><small>${s.length}자</small> ${h(s)}</div>`).join('') || '<span class="hint">없음</span>'}</div></div>`;
  };
  await dialog({
    title: '퇴고 도우미',
    wide: true,
    body: `<div class="seg" style="justify-self:start"><button type="button" data-scope="cur" class="on">이 장</button><button type="button" data-scope="all">작품 전체</button></div><div id="anaBody">${build()}</div>`,
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
    body: `<label class="field"><span>원고 글꼴</span><select name="font">${fonts.map(([v, l]) => `<option value="${h(v)}" ${v === s.font ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="row2">
        <label class="field"><span>글자 크기 (px)</span><input name="size" type="number" min="12" max="30" value="${s.size}"></label>
        <label class="field"><span>줄 간격</span><input name="lineHeight" type="number" min="1.2" max="3" step="0.1" value="${s.lineHeight}"></label>
        <label class="field"><span>원고 폭 (px)</span><input name="width" type="number" min="480" max="1200" step="20" value="${s.width}"></label>
        <label class="field"><span>문단 사이 간격 (줄)</span><input name="paraSpacing" type="number" min="0" max="2" step="0.25" value="${s.paraSpacing}"></label>
        <label class="field"><span>화면 테마</span><select name="theme">
          <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>기기 설정 따르기</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>밝게</option>
          <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>어둡게 (다크 모드)</option>
          <option value="sepia" ${s.theme === 'sepia' ? 'selected' : ''}>종이색</option></select></label>
        <label class="field"><span>자동 버전 간격 (분)</span><select name="snapshotMinutes">${[1, 3, 5, 10, 30].map((m) => `<option ${m === s.snapshotMinutes ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="indent" ${s.indent ? 'checked' : ''}> 문단 첫 줄 들여쓰기</label>
      <label class="check"><input type="checkbox" name="smartQuotes" ${s.smartQuotes ? 'checked' : ''}> 따옴표 자동 변환 (" → “ ”)</label>
      <label class="check"><input type="checkbox" name="typewriter" ${s.typewriter ? 'checked' : ''}> 집중 모드에서 타자기 스크롤 (쓰는 줄을 화면 가운데에)</label>
      <label class="check"><input type="checkbox" name="dimFocus" ${s.dimFocus ? 'checked' : ''}> 집중 모드에서 지금 문단만 밝게</label>
      <p class="hint" style="margin:0">자동 저장: 손을 멈추고 5초 뒤 이 기기에 저장됩니다. 버전 기록은 위 간격마다 쌓이고, 3일이 지난 자동 버전은 1시간에 하나, 30일이 지나면 하루에 하나만 남깁니다(직접 저장한 버전은 그대로).</p>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '저장', value: 'ok', primary: true }],
  });
  if (r.value !== 'ok') return;
  const f = r.form;
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
      <label class="check"><input type="checkbox" name="auto" ${app.settings.autoSync ? 'checked' : ''}> 저장할 때마다 자동으로 드라이브에 올리기 (15초 모아서)</label>`,
    buttons: st.connected
      ? [{ label: '연결 끊기', value: 'off', left: true }, { label: '드라이브에서 불러오기', value: 'import' }, { label: '지금 동기화', value: 'sync', primary: true }]
      : [{ label: '닫기', value: 'close' }, { label: '저장하고 연결', value: 'connect', primary: true }],
  });
  if (r.value === 'close') return;
  app.settings.driveClientId = r.form.cid.value.trim();
  app.settings.autoSync = r.form.auto.checked;
  saveSettings();
  G.configure(app.settings.driveClientId);
  if (r.value === 'connect') {
    if (!app.settings.driveClientId) { toast('클라이언트 ID를 넣어 주세요.'); return; }
    try { await G.connect(); toast('구글 드라이브에 연결했어요.'); await syncNow(); } catch (e) { toast('연결하지 못했습니다: ' + e.message, 7000); }
  } else if (r.value === 'sync') await syncNow();
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
      body: `<div class="proj-list">${files.map((f) => `<button class="proj" value="${f.id}"><div class="info"><b>${h(f.name.replace(/\.novel\.json$/, ''))}</b><small>${fullTime(Date.parse(f.modifiedTime))} 저장 · ${fmt(Math.round((+f.size || 0) / 1024))}KB</small></div></button>`).join('') || '<p class="hint">드라이브에 올린 작품이 아직 없습니다.</p>'}</div>`,
      buttons: [{ label: '닫기', value: 'close' }],
    });
    if (!r.value || r.value === 'close') return;
    const b = await G.pullBundle(r.value);
    const p = await S.importBundle(b);
    const f = files.find((x) => x.id === r.value);
    p.syncedAt = f.modifiedTime;
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
      const div = document.createElement('div');
      div.innerHTML = c.html;
      let k = 0;
      const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const t = w.currentNode; const parts = t.textContent.split(q); if (parts.length > 1) { k += parts.length - 1; t.textContent = parts.join(rep); } }
      if (k) {
        await S.addSnapshot(c, 'auto', `“${q}” 모두 바꾸기 전`);
        c.html = div.innerHTML; c._count = null; c.updated = Date.now();
        await S.putChapter(c);
        app.states.delete(id);
        n += k;
      }
    }
    renderBinder();
  }
  runFind();
  toast(`${n}곳을 바꿨어요.${$('#findAllChapters').checked ? ' 다른 장은 바꾸기 전 상태를 버전 기록에 남겼습니다.' : ''}`);
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
