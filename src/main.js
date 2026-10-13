import './style.css';
import * as S from './store.js';
import * as G from './gdrive.js';
import * as SV from './syncserver.js';
import {
  app, loadSettings, initEditor, openProject, openChapter, saveNow, ensureSaved, hasUnsaved, addChapter, chapterMenu, bindBinderDrag,
  renderHistory, summarizePeriod, snapshotMenu, manualSnapshot, toggleTheme, toggleSidebar, isTabOpen, refreshSyncPill, scheduleSync, syncNow, flushSync, syncBackend, renderBinder,
} from './app.js';
import { runCommand, setSearch } from './editor.js';
import { openRevision, closeRevision, isRevisionOpen, bindRevision, revisionOnChapterChange } from './revision.js';
import * as F from './features.js';
import { showStats, showToday, showClips } from './stats-view.js';
import { loadTemplates } from './layout.js';
import { bindPageView, togglePageView, applyPageView, setZoom, setNumAll } from './pageview.js';
import { showPageSetup } from './pagesetup.js';
import { toggleBook, bindBook, isBookOpen } from './bookview.js';
import { bindSafety, showRecovery, restoreFromTrash } from './safety.js';
import { showFontDialog, showParaDialog, bindContextMenu, setSize, stepSize, showSizeInBox, speak, setSpacing, stepSpacing, showSpacingInBox, parseSpacing, bindHighlight, bindTextColor } from './format.js';
import { $, $$, toast } from './ui.js';

import * as A from './annotate.js';
import { bindKeys, showKeys } from './keys.js';
import * as T from './tools.js';
import * as R from './reader.js';
import * as PF from './proof.js';
import { showAiSettings } from './ai.js';
import { toggleHelp, bindHelp } from './help.js';
import { showColors, toggleComplement } from './themecolor.js';
import { bindZoom, zoomStep } from './zoom.js';
import { bindSynonyms, toggleSynonyms } from './synonym.js';
const ACTIONS = {
  checkUpdate: () => window.desktop?.checkUpdate?.(),
  readAloud: () => R.readAloud(), readChapter: () => R.readChapter(), readExport: () => R.exportAudio(), readSettings: () => R.showReaderSettings(), readCast: () => R.showCast(),
  proof: () => PF.toggleProof(), proofList: () => PF.showProof(), aiSettings: () => showAiSettings(),
  annotate: () => A.addAnnotation(), index: () => A.showIndex(), keys: () => showKeys(), tidy: () => T.showTidy(), tidyMark: () => T.toggleTidyMark(), appear: () => T.showAppearances(),
  annoSide: () => { const nx = { right: 'left', left: 'off', off: 'right' }[app.settings.annoSide || 'right']; A.setAnnoSide(nx); toast({ right: '주석을 오른쪽 여백에 보여 줘요.', left: '주석을 왼쪽 여백에 보여 줘요.', off: '여백 주석을 숨겼어요. 주석 글자를 누르면 볼 수 있어요.' }[nx]); },
  annoSticky: () => { const on = !app.settings.annoSticky; A.setAnnoSticky(on); toast(on ? '주석을 포스트잇으로 붙여 보여 줘요. 끌어서 옮기고, 두 번 누르면 고쳐요.' : '주석 포스트잇을 뗐어요.'); },
  home: F.showHome, newProject: () => F.newProject(), open: F.openFromFile, importChapter: F.importChapter,
  export: F.showExport, print: async () => { await saveNow(); F.printBook(); }, backup: F.downloadBackup,
  revision: () => (isRevisionOpen() ? closeRevision() : openRevision()),
  focus: () => F.toggleFocus(), cork: () => { closeRevision(); F.toggleCork(); }, theme: toggleTheme, settings: F.showSettings,
  find: F.openFind, analyze: F.showAnalyze, goals: F.showGoals, stats: showStats, today: () => showToday(), clips: () => showClips(), sprint: F.showSprint, snapshot: manualSnapshot,
  pageView: () => togglePageView(), pageSetup: showPageSetup, fontDlg: () => showFontDialog(), paraDlg: () => showParaDialog(),
  recover: () => showRecovery(),
  book: () => { closeRevision(); toggleBook(undefined, isBookOpen() ? {} : { noCh: false }); },
  bookPlain: () => { closeRevision(); toggleBook(!(isBookOpen() && app.settings.bookNoCh), { noCh: true }); },
  bigger: () => stepSize(0.5), smaller: () => stepSize(-0.5),
  lsWide: () => stepSpacing(1), lsNarrow: () => stepSpacing(-1), lsReset: () => setSpacing(null), speak: () => speak(app.editor.state.doc.textBetween(app.editor.state.selection.from, app.editor.state.selection.to, ' ') || app.editor.state.selection.$from.parent.textContent),
  drive: F.showDrive, driveImport: F.driveImport, server: F.showServer, sync: F.showSync, syncImport: F.syncImport, storage: () => F.showStorage(), colors: () => showColors(), complement: () => toggleComplement(), synonyms: () => toggleSynonyms(), zoomIn: () => zoomStep(1), zoomOut: () => zoomStep(-1), zoomReset: () => zoomStep(0), help: () => toggleHelp(),
  renameProject: () => { $('#projectTitle').focus(); $('#projectTitle').select(); },
  addChapter: () => addChapter(), addNote: () => F.editNote(null),
};

async function boot() {
  loadSettings();
  if (app.settings.sidebarHidden && !matchMedia('(max-width: 820px)').matches) document.body.classList.add('sb-hidden');
  await loadTemplates();
  initEditor();
  app.openRevision = openRevision;
  app.hooks.toolbar = () => { showSizeInBox(); showSpacingInBox(); };
  G.configure(app.settings.driveClientId);
  G.onChange(refreshSyncPill);
  SV.configure(app.settings.syncServer);
  SV.onChange(refreshSyncPill);

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
        '• 설정 → 저장 방식에서 오프라인(이 기기에만) · 개인 서버 · 구글 드라이브 중 고르면, 서버나 드라이브로 데스크톱·노트북·휴대폰 사이에 작품을 이어 씁니다.\n' +
        '• 장면 전환은 ✱ 버튼, 집중 모드는 ◎ 버튼 또는 Ctrl+Shift+F.' });
      pid = p.id;
    }
  }
  await openProject(pid);
  app.hooks.afterOpen.push(() => { if (isTabOpen('notes')) F.renderNotes(); revisionOnChapterChange(); applyPageView(); A.annosChanged(); });
  bind();
  bindPageView();
  bindContextMenu();
  bindHighlight();
  bindTextColor();
  R.bindReader();
  PF.bindProof();
  bindHelp();
  bindZoom();
  bindSynonyms();
  T.bindTidyMarks();
  T.bindChapterGoal();
  A.bindAnnotations({ onNotesChange: () => { if (isTabOpen('notes')) F.renderNotes(); } });
  bindSafety();
  bindBook();
  app.restoreTrash = restoreFromTrash;
  bindRevision();
  F.bindCork();
  refreshSyncPill();
  if (syncBackend().status().connected) syncNow({ quiet: true });
  // 처음 켤 때 한 번: 원고를 어디에 저장할지 (오프라인 · 개인 서버 · 구글 드라이브)
  if (!app.settings.syncAsked) setTimeout(() => F.showStorage({ first: true }), 400);
  registerSW();
  // 다른 곳에서 넘겨받은 파일 열기: 데스크톱 앱(연결 프로그램), 설치한 웹앱(파일 연결)
  if (window.desktop?.checkUpdate) { $('#mUpdate').hidden = false; window.desktop.version().then((v) => { if (v) $('#mVersion').textContent = `지금 ${v}`; }); }
  window.desktop?.onOpenFile(({ name, data }) => F.openFromFile(new File([data], name)));
  window.launchQueue?.setConsumer(async (p) => { for (const h of p.files || []) F.openFromFile(await h.getFile()); });
  // 데스크톱 앱이 닫기·업데이트 전에 부른다. 기기에 저장했는지(true/false)를 돌려준다.
  // 원격 동기화는 기다리되 오래 걸려도 로컬 저장 결과와 섞지 않는다.
  window.__saveBeforeClose = async () => {
    const ok = await saveNow();
    if (ok) await Promise.race([Promise.resolve(flushSync()).catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
    return ok;
  };
  // 저장에 실패해 닫기·업데이트가 멈췄을 때: 다시 시도 / 복구 파일 / 그래도 진행
  window.__closeBlocked = async (what) => {
    if (await ensureSaved(what === 'update' ? '업데이트하려고 끄기' : '앱 닫기')) window.desktop?.forceClose?.(what);
  };
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
      if (!was && mb.dataset.menu === 'projects') F.fillProjectMenu(m);
      if (!was) { m.classList.add('open'); mb.classList.add('open'); }
      return;
    }
    if (open && !e.target.closest('.menu')) $$('.menu.open, .menu-btn.open').forEach((x) => x.classList.remove('open'));
    const a = e.target.closest('[data-act]');
    if (a && !a.closest('dialog')) {
      $$('.menu.open, .menu-btn.open').forEach((x) => x.classList.remove('open'));
      if (a.dataset.act === 'switchTo') F.switchProject(a.dataset.id);
      else ACTIONS[a.dataset.act]?.();
    }
  });

  // 서식 도구
  $('#toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b) runCommand(app.editor, b.dataset.cmd); });
  $('#blockType').addEventListener('change', (e) => runCommand(app.editor, 'block', e.target.value));
  $('#fontFamily').addEventListener('change', (e) => runCommand(app.editor, 'font', e.target.value));
  $('#fontSize').addEventListener('change', (e) => { if (e.target.value.trim()) setSize(e.target.value.replace(/pt$/i, '')); else runCommand(app.editor, 'size', ''); });
  $('#fontSize').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.dispatchEvent(new Event('change')); app.editor.commands.focus(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepSize(e.key === 'ArrowUp' ? 0.5 : -0.5); e.target.value = ''; showSizeInBox(); }
  });
  $('#letterSpacing').addEventListener('change', (e) => {
    const v = parseSpacing(e.target.value);
    if (v === undefined) { toast('자간은 -3 (%) 또는 0.5pt처럼 넣어 주세요.'); showSpacingInBox(); return; }
    setSpacing(v);
  });
  $('#letterSpacing').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.dispatchEvent(new Event('change')); app.editor.commands.focus(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepSpacing(e.key === 'ArrowUp' ? 1 : -1); e.target.value = ''; showSpacingInBox(); }
  });
  $$('[data-ls]').forEach((b) => { b.addEventListener('mousedown', (e) => e.preventDefault()); b.addEventListener('click', () => stepSpacing(+b.dataset.ls)); });
  $$('[data-size]').forEach((b) => { b.addEventListener('mousedown', (e) => e.preventDefault()); b.addEventListener('click', () => stepSize(+b.dataset.size)); });

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
  ['#hfYear', '#hfMonth', '#hfDay'].forEach((sel, i) => $(sel).addEventListener('change', () => {
    // 위 단계를 바꾸면 아래 단계는 처음부터
    if (i < 1) $('#hfMonth').value = '';
    if (i < 2) $('#hfDay').value = '';
    renderHistory();
  }));
  $('#histSummary').addEventListener('click', summarizePeriod);
  $('#historyList').addEventListener('click', (e) => { const x = e.target.closest('[data-snap]'); if (x) snapshotMenu(x.dataset.snap); });
  $('#noteList').addEventListener('click', (e) => { const x = e.target.closest('[data-note]'); if (x) F.editNote(x.dataset.note); });
  $('#noteFilter').addEventListener('change', F.renderNotes);
  $('#noteSearch').addEventListener('input', F.renderNotes);
  $('#btnSidebar').addEventListener('click', () => toggleSidebar());
  $('#pvZoomSel').value = app.settings.pvZoom || 'fit';
  $('#pvZoomSel').addEventListener('change', (e) => setZoom(e.target.value));
  $('#pvNumSel').value = app.settings.pvNumAll ? 'all' : 'ch';
  $('#pvNumSel').addEventListener('change', (e) => setNumAll(e.target.value === 'all'));

  // 찾기
  $('#findInput').addEventListener('input', () => F.runFind(0));
  $('#findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); F.runFind(e.shiftKey ? -1 : 1); } });
  $('#findAllChapters').addEventListener('change', () => F.runFind(0));
  $('#findbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-find]');
    if (!b) return;
    ({ prev: () => F.runFind(-1), next: () => F.runFind(1), one: F.replaceOne, all: F.replaceAll, close: F.closeFind })[b.dataset.find]();
  });

  // 단축키 (설정에서 바꿀 수 있음: keys.js)
  const chapterStep = (d) => { const o = app.project.order; const i = o.indexOf(app.cur) + d; if (i >= 0 && i < o.length) openChapter(o[i]); };
  bindKeys({
    save: () => { app.dirty = true; saveNow().then((ok) => { if (ok) toast('저장했어요.', 1500); }); },
    print: () => ACTIONS.print(),
    undo: () => runCommand(app.editor, 'undo'), redo: () => runCommand(app.editor, 'redo'),
    find: () => F.openFind(), replace: () => { F.openFind(); $('#replaceInput').focus(); },
    proof: () => PF.toggleProof(), proofList: () => PF.showProof(), aiSettings: () => showAiSettings(),
    annotate: () => A.addAnnotation(), annoSticky: () => ACTIONS.annoSticky(), scene: () => runCommand(app.editor, 'scene'), snapshot: () => manualSnapshot(),
    bold: () => runCommand(app.editor, 'bold'), italic: () => runCommand(app.editor, 'italic'), underline: () => runCommand(app.editor, 'underline'),
    strike: () => runCommand(app.editor, 'strike'), highlight: () => runCommand(app.editor, 'highlight'), clear: () => runCommand(app.editor, 'clear'),
    fontDlg: () => showFontDialog(), paraDlg: () => showParaDialog(),
    bigger: () => stepSize(0.5), smaller: () => stepSize(-0.5), lsWide: () => stepSpacing(1), lsNarrow: () => stepSpacing(-1),
    left: () => runCommand(app.editor, 'left'), center: () => runCommand(app.editor, 'center'), right: () => runCommand(app.editor, 'right'), justify: () => runCommand(app.editor, 'justify'),
    pageSetup: () => showPageSetup(), focus: () => F.toggleFocus(), sidebar: () => toggleSidebar(),
    pageView: () => ACTIONS.pageView(), book: () => ACTIONS.book(), bookPlain: () => ACTIONS.bookPlain(), revision: () => ACTIONS.revision(), theme: () => toggleTheme(),
    addChapter: () => addChapter(), prevChapter: () => chapterStep(-1), nextChapter: () => chapterStep(1),
    speak: () => ACTIONS.speak(), sprint: () => ACTIONS.sprint(), index: () => A.showIndex(), keys: () => showKeys(),
    tidy: () => T.showTidy(), tidyMark: () => T.toggleTidyMark(), appear: () => T.showAppearances(), split: () => T.splitChapterAtCursor(),
    readAloud: () => R.readAloud(), readNext: () => R.skip(1), readPrev: () => R.skip(-1), readStop: () => R.stop(), readSettings: () => R.showReaderSettings(), readCast: () => R.showCast(),
    help: () => toggleHelp(), colors: () => showColors(), complement: () => toggleComplement(), synonyms: () => toggleSynonyms(), zoomIn: () => zoomStep(1), zoomOut: () => zoomStep(-1), zoomReset: () => zoomStep(0), storage: () => F.showStorage(), server: () => F.showServer(),
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#dlg').open) return;
      if (document.body.classList.contains('focus')) F.toggleFocus(false);
      else if (!$('#findbar').hidden) F.closeFind();
      else if (isRevisionOpen()) closeRevision();
      else if (!$('#cork').hidden) F.toggleCork(false);
      else if (isBookOpen()) toggleBook(false);
      else setSearch(app.editor, '');
    }
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('focus')) F.toggleFocus(false); });

  // 창을 닫거나 다른 앱으로 갈 때 바로 저장
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow().then(flushSync); });
  window.addEventListener('pagehide', () => saveNow());
  window.addEventListener('beforeunload', (e) => { if (hasUnsaved()) { saveNow(); e.preventDefault(); } });
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
