// 실수 되돌리기: 크게 지우면 그 전 원고를 자동으로 보관하고, 한곳에서 되돌리기·휴지통·드라이브 백업을 고를 수 있게 한다
import { DOMSerializer } from '@tiptap/pm/model';
import { undoDepth, isHistoryTransaction } from '@tiptap/pm/history';
import * as S from './store.js';
import * as G from './gdrive.js';
import { app, saveNow, openProject, openChapter, renderBinder, renderHistory, restoreSnapshot, isTabOpen } from './app.js';
import { $, h, toast, toastAction, dialog, confirmDlg, hm, dayLabel, ago } from './ui.js';
import { countHtml, fmt } from './stats.js';

const BIG = 200; // 한 번에 이만큼(글자) 넘게 사라지면 지우기 전 원고를 보관한다
let lastSafety = 0;

function htmlOf(doc) {
  const div = document.createElement('div');
  div.appendChild(DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content));
  return div.innerHTML;
}

export function bindSafety() {
  app.editor.on('transaction', ({ editor, transaction: tr }) => {
    // 실행 취소·다시 하기로 바뀐 것은 사용자가 되돌린 것이므로 건드리지 않는다
    if (!tr.docChanged || tr.getMeta('preventUpdate') || tr.getMeta('addToHistory') === false || isHistoryTransaction(tr) || !app.cur) return;
    const before = tr.before.content.size, after = tr.doc.content.size;
    const lost = before - after;
    if (lost < BIG && !(before > 400 && after < before * 0.5)) return;
    if (Date.now() - lastSafety < 4000) return;
    lastSafety = Date.now();
    const ch = app.chapters.get(app.cur);
    const html = htmlOf(tr.before);
    const docAfter = tr.doc;
    S.addSnapshot({ ...ch, html }, 'safety', '크게 지우기 전 (자동 보관)').then((snap) => {
      if (isTabOpen('history')) renderHistory();
      toastAction(`글 ${fmt(Math.max(lost, 0))}자 정도가 지워졌어요. 지우기 전 원고를 기록에 보관했어요.`, '되돌리기', async () => {
        // 그 뒤로 더 고친 게 없으면 실행 취소, 있으면 보관한 버전으로
        if (editor.state.doc.eq(docAfter)) editor.commands.undo();
        else await restoreSnapshot(snap);
      });
    });
  });
}

// 크게 바꾸기 전에 지금 원고를 남겨 둔다 (모두 바꾸기 등)
export async function safetyPoint(label) {
  await saveNow({ snapshot: false });
  const ch = app.chapters.get(app.cur);
  if (!ch) return null;
  ch.html = app.editor.getHTML();
  return S.addSnapshot(ch, 'safety', label);
}

export async function restoreFromTrash(id) {
  try {
    const r = await S.restoreTrash(id);
    if (r.project) {
      await openProject(r.project.id);
      toast(`“${r.project.title}” 작품을 되살렸어요.`);
      return;
    }
    const ch = r.chapter;
    let p = await S.getProject(ch.projectId);
    if (!p) { toast('그 장이 있던 작품이 없어 지금 작품에 넣었어요.'); p = app.project; ch.projectId = p.id; await S.putChapter(ch); }
    if (!p.order.includes(ch.id)) p.order.splice(Math.min(r.index, p.order.length), 0, ch.id);
    await S.putProject(p);
    app.states.delete(ch.id);
    if (p.id === app.project.id) { app.project.order = p.order; app.chapters.set(ch.id, ch); renderBinder(); await openChapter(ch.id); }
    else await openProject(p.id);
    toast(`“${ch.title}” 장을 되살렸어요.`);
  } catch (e) { toast(e.message, 6000); }
}

// 실수 되돌리기·복구 창
export async function showRecovery() {
  await saveNow({ snapshot: false });
  const depth = undoDepth(app.editor.state);
  const snaps = (await S.snapshotsOf(app.cur)).slice(0, 12);
  const trash = await S.trashList();
  const cur = app.chapters.get(app.cur);
  const snapRows = snaps.map((s) => {
    const n = countHtml(s.html).withSpace;
    const lb = s.kind === 'safety' ? `<b class="safe">${h(s.label || '자동 보관')}</b>` : s.label ? `<b>${h(s.label)}</b>` : s.kind === 'manual' ? '<b>직접 저장</b>' : '자동';
    return `<div class="rc-row"><div class="info"><span>${dayLabel(s.time)} ${hm(s.time)} · ${lb}</span><small>${fmt(n)}자</small></div>
      <button class="small" type="button" data-cmp="${s.id}">비교</button><button class="small" type="button" data-restore="${s.id}">이 버전으로</button></div>`;
  }).join('');
  const trashRows = trash.map((t) => `<div class="rc-row"><div class="info"><span>${t.kind === 'project' ? '작품' : '장'} · <b>${h(t.title || '제목 없음')}</b>${t.kind === 'chapter' && t.projectTitle ? ` <small>(${h(t.projectTitle)})</small>` : ''}</span><small>${ago(t.time)} 지움 · ${Math.max(0, 30 - Math.floor((Date.now() - t.time) / 864e5))}일 뒤 자동 삭제</small></div>
      <button class="small" type="button" data-untrash="${t.id}">되살리기</button><button class="small danger" type="button" data-drop="${t.id}">영구 삭제</button></div>`).join('');
  const r = await dialog({
    title: '실수 되돌리기 · 복구',
    wide: true,
    body: `<section class="rc"><h3>방금 한 일 되돌리기</h3>
        <p class="hint">Ctrl+Z로 한 단계씩 되돌리고 Ctrl+Y로 다시 할 수 있어요. 장마다 따로 기억합니다. 지금 이 장에서 <b>${depth}단계</b> 되돌릴 수 있어요.</p>
        <div class="rc-btns"><button type="button" class="small" data-undo="1" ${depth ? '' : 'disabled'}>한 단계 되돌리기</button><button type="button" class="small" data-undo="10" ${depth ? '' : 'disabled'}>열 단계 되돌리기</button></div></section>
      <section class="rc"><h3>“${h(cur?.title || '')}”의 최근 버전</h3>
        <p class="hint">손을 멈출 때마다 저장되고, 몇 분마다 버전이 쌓입니다. 한 번에 많이 지우거나 모두 바꾸기를 하면 그 직전 원고가 ‘자동 보관’으로 남아요. 어느 버전으로 돌아가도 지금 원고는 ‘되돌리기 전’으로 남습니다.</p>
        <div class="rc-list">${snapRows || '<p class="hint">아직 버전이 없습니다.</p>'}</div></section>
      <section class="rc"><h3>휴지통</h3>
        <p class="hint">지운 장과 작품은 버전 기록과 함께 30일 동안 여기 있어요.</p>
        <div class="rc-list">${trashRows || '<p class="hint">휴지통이 비어 있습니다.</p>'}</div></section>
      ${G.status().connected ? `<section class="rc"><h3>구글 드라이브 백업</h3><p class="hint">이 기기 기록이 모두 사라졌다면 드라이브에 올려 둔 파일에서 작품을 다시 받아 올 수 있어요.</p><div class="rc-btns"><button type="button" class="small" data-drive="1">드라이브에서 불러오기</button></div></section>` : ''}`,
    buttons: [{ label: '닫기', value: 'close' }],
    onOpen: (f, dlg) => {
      f.addEventListener('click', async (e) => {
        const b = e.target.closest('button[type=button]');
        if (!b) return;
        const d = b.dataset;
        if (d.undo) { for (let i = 0; i < +d.undo; i++) app.editor.commands.undo(); dlg.close('close'); toast('되돌렸어요. Ctrl+Y로 다시 할 수 있어요.'); }
        else if (d.cmp) { dlg.close('close'); app.openRevision?.(d.cmp); }
        else if (d.restore) { dlg.close('close'); await restoreSnapshot(await S.getSnapshot(d.restore)); }
        else if (d.untrash) { dlg.close('close'); await restoreFromTrash(d.untrash); }
        else if (d.drop) {
          dlg.close('close');
          if (await confirmDlg('영구 삭제', '휴지통에서 완전히 지웁니다. 이건 되돌릴 수 없어요.', '영구 삭제', true)) { await S.dropTrash(d.drop); toast('지웠어요.'); }
          showRecovery();
        } else if (d.drive) { dlg.close('close'); const { driveImport } = await import('./features.js'); driveImport(); }
      });
    },
  });
  return r;
}
