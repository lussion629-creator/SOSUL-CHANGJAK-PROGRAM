// 전체 이어 보기: 모든 장을 한 줄로 이어서 읽는다 (글만 / 쪽 모양). 문단을 두 번 누르면 그 자리로 가서 고친다.
import { app, saveNow, openChapter } from './app.js';
import { layoutOf } from './layout.js';
import { paginate } from './paginate.js';
import { countHtml, fmt } from './stats.js';
import { $, h, toast } from './ui.js';

let mode = 'flow';
let run = 0;

export const isBookOpen = () => !$('#bookView').hidden;

export async function toggleBook(on = !isBookOpen()) {
  $('#bookView').hidden = !on;
  if (!on) { run++; return; }
  for (const id of ['#cork', '#revision']) { const el = $(id); if (el && !el.hidden && id === '#cork') el.hidden = true; }
  await saveNow();
  render();
}

function chapters() {
  return app.project.order.map((id) => app.chapters.get(id)).filter(Boolean).map((c) => ({ ...c, html: c.id === app.cur ? app.editor.getHTML() : c.html }));
}

// 장 HTML의 맨 위 블록마다 순서 번호를 붙인다 (두 번 눌러 찾아갈 때 쓴다)
function numbered(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  [...d.children].forEach((el, i) => el.setAttribute('data-pi', i));
  return d.innerHTML;
}

async function render() {
  const my = ++run;
  const body = $('#bookBody');
  const chs = chapters();
  const total = chs.reduce((a, c) => { const n = countHtml(c.html); a.w += n.withSpace; a.m += n.manuscript; return a; }, { w: 0, m: 0 });
  $('#bookToc').innerHTML = '<option value="">차례로 가기…</option>' + chs.map((c, i) => `<option value="${c.id}">${i + 1}. ${h(c.title)}</option>`).join('');
  $$seg();
  const stat = (pages) => { $('#bookStat').textContent = `${chs.length}개 장 · ${fmt(total.w)}자 · 원고지 ${fmt(total.m)}매${pages ? ` · ${fmt(pages)}쪽` : ''}`; };
  stat();
  body.className = 'book-body m-' + mode;
  if (mode === 'flow') {
    body.innerHTML = `<article class="book-flow prose">${chs.map((c, i) => `<section data-ch="${c.id}"><h2 class="book-ch"><span>${i + 1}</span>${h(c.title)}</h2>${numbered(c.html)}</section>`).join('')}</article>`;
    return;
  }
  // 쪽 모양: 장마다 새 쪽에서 시작하고 쪽 번호는 이어진다
  body.innerHTML = '<p class="hint book-wait">쪽을 나누는 중…</p>';
  const L = layoutOf();
  const wrap = document.createElement('div');
  wrap.className = 'book-pages';
  let pages = 0;
  for (let i = 0; i < chs.length; i++) {
    if (my !== run) return;
    const c = chs[i];
    const sec = document.createElement('section');
    sec.dataset.ch = c.id;
    wrap.appendChild(sec);
    if (i === 0) { body.innerHTML = ''; body.appendChild(wrap); }
    pages += paginate(`<h2 class="book-ch">${h(c.title)}</h2>${numbered(c.html)}`, sec, { layout: { ...L, numStart: (+L.numStart || 1) + pages } });
    stat(pages);
    await new Promise((r) => setTimeout(r, 0)); // 긴 원고도 화면이 멈추지 않게 장마다 쉰다
  }
  if (!chs.length) body.innerHTML = '<p class="hint">장이 없습니다.</p>';
}
function $$seg() { document.querySelectorAll('[data-book]').forEach((b) => b.classList.toggle('on', b.dataset.book === mode)); }

// 두 번 누른 문단으로 가서 고치기
async function jumpTo(chId, pi) {
  await toggleBook(false);
  await openChapter(chId);
  // 문서의 pi번째 맨 위 블록 위치 (화면의 쪽 사이 빈칸 등은 세지 않는다)
  const doc = app.editor.state.doc;
  if (pi >= doc.childCount) return;
  let pos = 0;
  for (let i = 0; i < pi; i++) pos += doc.child(i).nodeSize;
  try {
    app.editor.chain().focus().setTextSelection(Math.min(pos + 1, doc.content.size)).run();
    const el = app.editor.view.nodeDOM(pos);
    (el instanceof Element ? el : null)?.scrollIntoView({ block: 'center' });
  } catch { /* 위치를 못 찾으면 장 처음 */ }
}

export function bindBook() {
  document.querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.book; render(); }));
  $('#bookToc').addEventListener('change', (e) => {
    const sec = $(`#bookBody section[data-ch="${e.target.value}"]`);
    sec?.scrollIntoView({ block: 'start' });
    e.target.value = '';
  });
  $('#bookBody').addEventListener('dblclick', (e) => {
    const sec = e.target.closest('section[data-ch]');
    if (!sec) return;
    const b = e.target.closest('[data-pi]');
    jumpTo(sec.dataset.ch, b ? +b.dataset.pi : 0);
  });
  let hinted = false;
  $('#bookBody').addEventListener('click', () => { if (!hinted) { hinted = true; toast('문단을 두 번 누르면 그 자리로 가서 고칠 수 있어요.'); } });
}
