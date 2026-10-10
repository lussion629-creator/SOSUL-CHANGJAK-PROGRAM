import './style.css';
import * as S from './store.js';
import * as G from './gdrive.js';
import {
  app, loadSettings, initEditor, openProject, openChapter, saveNow, addChapter, chapterMenu, bindBinderDrag,
  renderHistory, snapshotMenu, manualSnapshot, toggleTheme, toggleSidebar, isTabOpen, refreshSyncPill, scheduleSync, syncNow, renderBinder,
} from './app.js';
import { runCommand, setSearch } from './editor.js';
import { openRevision, closeRevision, isRevisionOpen, bindRevision, revisionOnChapterChange } from './revision.js';
import * as F from './features.js';
import { showStats } from './stats-view.js';
import { $, $$, toast } from './ui.js';

const ACTIONS = {
  home: F.showHome, newProject: () => F.newProject(), open: F.openFromFile, importChapter: F.importChapter,
  export: F.showExport, print: async () => { await saveNow(); F.printBook(); }, backup: F.downloadBackup,
  revision: () => (isRevisionOpen() ? closeRevision() : openRevision()),
  focus: () => F.toggleFocus(), cork: () => { closeRevision(); F.toggleCork(); }, theme: toggleTheme, settings: F.showSettings,
  find: F.openFind, analyze: F.showAnalyze, goals: F.showGoals, stats: showStats, sprint: F.showSprint, snapshot: manualSnapshot,
  drive: F.showDrive, addChapter: () => addChapter(), addNote: () => F.editNote(null),
};

async function boot() {
  loadSettings();
  initEditor();
  app.openRevision = openRevision;
  G.configure(app.settings.driveClientId);
  G.onChange(refreshSyncPill);

  // 처음 실행이면 예시 작품을 만든다
  let pid = await S.kvGet('lastProject');
  if (!pid || !(await S.getProject(pid))) {
    const list = await S.listProjects();
    if (list.length) pid = list[0].id;
    else {
      const p = await S.createProject('첫 작품', [{ title: '1장', html: '' }]);
      await S.putNote({ id: S.uid(), projectId: p.id, type: 'memo', name: '사용법', fields: {}, body:
        '• 손을 멈추면 5초 뒤 자동 저장되고, 몇 분마다 버전이 쌓입니다. 왼쪽 ‘기록’ 탭에서 날짜·시간별로 돌아갈 수 있어요.\n' +
        '• 위의 ⇆(퇴고 모드)를 누르면 이전 버전과 지금 원고를 나란히 놓고 더한 곳(초록)·뺀 곳(빨강)을 봅니다. 양쪽을 ‘페이지’(PDF처럼)와 ‘편집’으로 바꿔 볼 수 있어요.\n' +
        '• 파일 → 파일 열기로 Word(docx), 한글(hwpx, hwp) 파일을 불러오고, 내보내기로 docx·hwpx·PDF로 저장합니다.\n' +
        '• 도구 → 구글 드라이브 연결로 PC와 휴대폰 사이에 작품을 동기화합니다.\n' +
        '• 장면 전환은 ✱ 버튼, 집중 모드는 ◎ 버튼 또는 Ctrl+Shift+F.' });
      pid = p.id;
    }
  }
  await openProject(pid);
  app.hooks.afterOpen.push(() => { if (isTabOpen('notes')) F.renderNotes(); revisionOnChapterChange(); });
  bind();
  bindRevision();
  F.bindCork();
  refreshSyncPill();
  if (G.status().connected) syncNow({ quiet: true });
  registerSW();
  // 다른 곳에서 넘겨받은 파일 열기: 데스크톱 앱(연결 프로그램), 설치한 웹앱(파일 연결)
  window.desktop?.onOpenFile(({ name, data }) => F.openFromFile(new File([data], name)));
  window.launchQueue?.setConsumer(async (p) => { for (const h of p.files || []) F.openFromFile(await h.getFile()); });
  window.__saveBeforeClose = () => saveNow();
}

function bind() {
  // 메뉴
  document.addEventListener('click', (e) => {
    const mb = e.target.closest('.menu-btn');
    const open = $('.menu.open');
    if (mb) {
      const m = $('#menu-' + mb.dataset.menu);
      const was = m.classList.contains('open');
      $$('.menu.open, .menu-btn.open').forEach((x) => x.classList.remove('open'));
      if (!was) { m.classList.add('open'); mb.classList.add('open'); }
      return;
    }
    if (open && !e.target.closest('.menu')) $$('.menu.open, .menu-btn.open').forEach((x) => x.classList.remove('open'));
    const a = e.target.closest('[data-act]');
    if (a && !a.closest('dialog')) {
      $$('.menu.open, .menu-btn.open').forEach((x) => x.classList.remove('open'));
      ACTIONS[a.dataset.act]?.();
    }
  });

  // 서식 도구
  $('#toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b) runCommand(app.editor, b.dataset.cmd); });
  $('#blockType').addEventListener('change', (e) => runCommand(app.editor, 'block', e.target.value));
  $('#fontFamily').addEventListener('change', (e) => runCommand(app.editor, 'font', e.target.value));
  $('#fontSize').addEventListener('change', (e) => runCommand(app.editor, 'size', e.target.value));
  $('#textColor').addEventListener('input', (e) => { runCommand(app.editor, 'color', e.target.value); $('.color-btn span').style.borderColor = e.target.value; });

  // 제목
  $('#projectTitle').addEventListener('change', async (e) => {
    app.project.title = e.target.value.trim() || '제목 없는 작품';
    await S.putProject(app.project);
    document.title = `${app.project.title} — 소설 워드프로세서`;
    scheduleSync();
  });
  $('#chapterTitle').addEventListener('change', async (e) => {
    const c = app.chapters.get(app.cur);
    c.title = e.target.value.trim() || '제목 없는 장';
    await S.putChapter(c);
    renderBinder();
  });
  $('#chapterTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); app.editor.commands.focus('start'); } });
  $('#chapterSynopsis').addEventListener('input', (e) => {
    const c = app.chapters.get(app.cur);
    c.synopsis = e.target.value;
    clearTimeout(c._synT);
    c._synT = setTimeout(() => S.putChapter(c), 600);
  });
  $('#chapterStatus').addEventListener('change', async (e) => {
    const c = app.chapters.get(app.cur);
    c.status = e.target.value;
    await S.putChapter(c);
    renderBinder();
  });

  // 원고 목록
  $('#chapterList').addEventListener('click', (e) => {
    const m = e.target.closest('[data-more]');
    if (m) { e.stopPropagation(); chapterMenu(m.dataset.more); return; }
    const li = e.target.closest('li');
    if (li) openChapter(li.dataset.id);
  });
  bindBinderDrag();

  // 탭
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'history') renderHistory();
    if (b.dataset.tab === 'notes') F.renderNotes();
  }));
  $('#historyList').addEventListener('click', (e) => { const x = e.target.closest('[data-snap]'); if (x) snapshotMenu(x.dataset.snap); });
  $('#noteList').addEventListener('click', (e) => { const x = e.target.closest('[data-note]'); if (x) F.editNote(x.dataset.note); });
  $('#noteFilter').addEventListener('change', F.renderNotes);
  $('#noteSearch').addEventListener('input', F.renderNotes);
  $('#btnSidebar').addEventListener('click', () => toggleSidebar());

  // 찾기
  $('#findInput').addEventListener('input', () => F.runFind(0));
  $('#findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); F.runFind(e.shiftKey ? -1 : 1); } });
  $('#findAllChapters').addEventListener('change', () => F.runFind(0));
  $('#findbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-find]');
    if (!b) return;
    ({ prev: () => F.runFind(-1), next: () => F.runFind(1), one: F.replaceOne, all: F.replaceAll, close: F.closeFind })[b.dataset.find]();
  });

  // 단축키
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); app.dirty = true; saveNow().then(() => toast('저장했어요.', 1500)); }
    else if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) { e.preventDefault(); F.openFind(); }
    else if (mod && e.key.toLowerCase() === 'h') { e.preventDefault(); F.openFind(); $('#replaceInput').focus(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); F.toggleFocus(); }
    else if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); ACTIONS.print(); }
    else if (e.key === 'Escape') {
      if ($('#dlg').open) return;
      if (document.body.classList.contains('focus')) F.toggleFocus(false);
      else if (!$('#findbar').hidden) F.closeFind();
      else if (isRevisionOpen()) closeRevision();
      else if (!$('#cork').hidden) F.toggleCork(false);
      else setSearch(app.editor, '');
    }
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('focus')) F.toggleFocus(false); });

  // 창을 닫거나 다른 앱으로 갈 때 바로 저장
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { saveNow(); scheduleSync(1000); } });
  window.addEventListener('pagehide', () => saveNow());
  window.addEventListener('beforeunload', (e) => { if (app.dirty) { saveNow(); e.preventDefault(); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {});
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:' || window.desktop || import.meta.env.DEV) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', `<div style="padding:16px;background:#fdd;color:#900">앱을 시작하지 못했습니다: ${e.message}<br>이 브라우저에서 저장 공간(IndexedDB)을 쓸 수 없는 상태일 수 있어요(시크릿 창 등).</div>`);
});
