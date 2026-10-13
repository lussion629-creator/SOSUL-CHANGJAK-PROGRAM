// 퇴고 모드: 이전 버전과 지금 원고를 나란히 놓고, 더해진 곳·빠진 곳을 한눈에 본다
import * as S from './store.js';
import { app, saveNow, htmlParagraphs, restoreSnapshot } from './app.js';
import { compare, esc } from './diff.js';
import { layoutOf } from './layout.js';
import { paginate } from './paginate.js';
import { setDiffMarks, docParagraphs } from './editor.js';
import { countHtml, fmt } from './stats.js';
import { $, $$, h, toast, dayLabel, hm } from './ui.js';
import { toggleBook } from './bookview.js';
import { applyPageView } from './pageview.js';

const rv = { open: false, base: null, left: 'page', right: 'edit', marks: true, result: null, timer: null };

export async function openRevision(snapId) {
  await saveNow({ snapshot: false });
  const snaps = await S.snapshotsOf(app.cur);
  const cur = app.editor.getHTML();
  if (!snaps.length) {
    // 비교할 버전이 없으면 지금 상태를 기준점으로 저장해 둔다
    const ch = app.chapters.get(app.cur);
    ch.html = cur;
    snaps.push(await S.addSnapshot(ch, 'manual', '퇴고 시작'));
    toast('비교할 이전 버전이 없어 지금 상태를 “퇴고 시작” 버전으로 저장했어요. 이제 고치면 바뀐 곳이 표시됩니다.', 6000);
  }
  const sel = $('#revBase');
  sel.innerHTML = snaps.map((s) => `<option value="${s.id}">${h(dayLabel(s.time))} ${hm(s.time)}${s.label ? ' · ' + h(s.label) : s.kind === 'manual' ? ' · 직접 저장' : ''} (${fmt(countHtml(s.html).withSpace)}자)</option>`).join('');
  const def = snapId || (snaps.find((s) => s.kind === 'manual' && s.html !== cur) || snaps.find((s) => s.html !== cur) || snaps[0]).id;
  sel.value = def;
  rv.base = snaps.find((s) => s.id === def);
  rv.open = true;
  $('#revision').hidden = false;
  $('#paperScroll').hidden = true;
  $('#cork').hidden = true;
  // 전체 보기가 열려 있으면 퇴고 화면을 가리므로 닫는다 (복구 창의 '비교'가 아무 일도 안 하는 것처럼 보이던 문제)
  if (!$('#bookView').hidden) await toggleBook(false);
  document.body.classList.add('revising');
  applyPageView();
  render();
}

export function closeRevision() {
  if (!rv.open) return;
  rv.open = false;
  setDiffMarks(app.editor, []);
  $('#paper').appendChild($('#editorHost'));
  $('#revision').hidden = true;
  $('#paperScroll').hidden = false;
  document.body.classList.remove('revising');
  applyPageView();
}

export const isRevisionOpen = () => rv.open;

function rowsHtml(rows, side) {
  return rows.map((r, i) => (r[side] === null ? '' : `<p class="rowblock" data-row="${i}">${r[side] || '<br>'}</p>`)).join('');
}

function render() {
  const newParas = docParagraphs(app.editor.state.doc);
  const res = compare(htmlParagraphs(rv.base.html), newParas.map((p) => p.text));
  rv.result = res;
  const st = res.stats;
  $('#revStats').innerHTML = st.added || st.removed
    ? `<span class="p">+${fmt(st.added)}자 더함</span><span class="m">−${fmt(st.removed)}자 뺌</span><span>바뀐 문단 ${st.changedParas + st.addedParas + st.removedParas}</span>`
    : '<span>바뀐 곳 없음</span>';
  $('#revLeftTitle').textContent = `${dayLabel(rv.base.time)} ${hm(rv.base.time)}${rv.base.label ? ' · ' + rv.base.label : ''}`;
  $$('[data-left]').forEach((b) => b.classList.toggle('on', b.dataset.left === rv.left));
  $$('[data-right]').forEach((b) => b.classList.toggle('on', b.dataset.right === rv.right));

  // 왼쪽(이전 버전)
  const L = $('#revLeftBody');
  const lst = L.scrollTop;
  const leftHtml = rv.marks ? rowsHtml(res.rows, 'left') : rv.base.html;
  L.classList.toggle('nomarks', !rv.marks);
  if (rv.left === 'page') { L.innerHTML = '<div></div>'; paginate(leftHtml, L.firstChild, { header: app.chapters.get(app.cur).title, layout: layoutOf() }); }
  else L.innerHTML = `<div class="flow prose">${leftHtml}</div>`;
  L.scrollTop = lst;

  renderRight(newParas);
  renderChangeList();
}

function renderRight(newParas = docParagraphs(app.editor.state.doc)) {
  const R = $('#revRightBody');
  const host = $('#editorHost');
  if (rv.right === 'edit') {
    let flow = R.querySelector('.flow.edit');
    if (!flow) { R.innerHTML = '<div class="flow edit"></div>'; flow = R.firstChild; }
    if (host.parentElement !== flow) flow.appendChild(host);
    setDiffMarks(app.editor, rv.marks ? markSpecs(rv.result.rows, newParas) : []);
  } else {
    setDiffMarks(app.editor, []);
    $('#paper').appendChild(host);
    const st = R.scrollTop;
    R.innerHTML = '<div></div>';
    R.classList.toggle('nomarks', !rv.marks);
    paginate(rv.marks ? rowsHtml(rv.result.rows, 'right') : app.editor.getHTML(), R.firstChild, { header: app.chapters.get(app.cur).title, layout: layoutOf() });
    R.scrollTop = st;
  }
}

function markSpecs(rows, paras) {
  const specs = [];
  const end = app.editor.state.doc.content.size;
  for (const r of rows) {
    if (r.type === 'removed') {
      const p = paras[r.ri];
      const text = r.left.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      if (text.trim()) specs.push({ type: 'del', block: true, pos: p ? p.pos : end, text });
      continue;
    }
    const p = paras[r.ri];
    if (!p) continue;
    for (const [s, e] of r.ins) specs.push({ type: 'ins', from: p.pos + 1 + s, to: p.pos + 1 + e });
    for (const d of r.dels) if (d.text.trim()) specs.push({ type: 'del', pos: p.pos + 1 + d.at, text: d.text });
  }
  return specs;
}

function renderChangeList() {
  const box = $('#revChangeList');
  if (box.hidden) return;
  const ch = rv.result.changes;
  box.innerHTML = `<h4><span>바뀐 곳 ${ch.length}개</span><button type="button" class="icon-btn" data-close-chg title="닫기">✕</button></h4>` + (ch.length ? ch.map((c, i) => `<div class="chg ${c.type}" data-chg="${i}">
      <small>${c.type === 'add' ? (c.whole ? '문단 추가' : '더함') : (c.whole ? '문단 삭제' : '뺌')}</small><span class="tx">${esc(c.text.length > 140 ? c.text.slice(0, 140) + '…' : c.text)}</span></div>`).join('')
    : '<p class="hint">바뀐 곳이 없습니다.</p>');
}

function jumpToRow(i) {
  const row = rv.result.rows[i];
  const flash = (el) => { if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); };
  flash($(`#revLeftBody [data-row="${i}"]`));
  if (rv.right === 'edit') {
    const paras = docParagraphs(app.editor.state.doc);
    const p = paras[row.ri] || paras[paras.length - 1];
    if (p) {
      const el = app.editor.view.nodeDOM(p.pos);
      if (el?.nodeType === 1) flash(el);
    }
  } else flash($(`#revRightBody [data-row="${i}"]`));
}

export function bindRevision() {
  $('#revBase').addEventListener('change', async (e) => { rv.base = await S.getSnapshot(e.target.value); render(); });
  $('#revMarks').addEventListener('change', (e) => { rv.marks = e.target.checked; render(); });
  $$('[data-left]').forEach((b) => b.addEventListener('click', () => { rv.left = b.dataset.left; render(); }));
  $$('[data-right]').forEach((b) => b.addEventListener('click', async () => { await saveNow({ snapshot: false }); rv.right = b.dataset.right; render(); }));
  $('#revChanges').addEventListener('click', () => {
    const box = $('#revChangeList');
    box.hidden = !box.hidden;
    $('#revPanes').classList.toggle('with-list', !box.hidden);
    renderChangeList();
  });
  $('#revChangeList').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-chg]')) { $('#revChangeList').hidden = true; $('#revPanes').classList.remove('with-list'); return; }
    const c = e.target.closest('[data-chg]');
    if (c) jumpToRow(rv.result.changes[+c.dataset.chg].row);
  });
  $('#revRestore').addEventListener('click', async () => { if (await restoreSnapshot(rv.base)) render(); });

  // 고치는 동안 바뀐 곳 표시를 다시 계산
  app.editor.on('update', () => {
    if (!rv.open || rv.right !== 'edit') return;
    clearTimeout(rv.timer);
    rv.timer = setTimeout(() => {
      const newParas = docParagraphs(app.editor.state.doc);
      rv.result = compare(htmlParagraphs(rv.base.html), newParas.map((p) => p.text));
      const st = rv.result.stats;
      $('#revStats').innerHTML = `<span class="p">+${fmt(st.added)}자 더함</span><span class="m">−${fmt(st.removed)}자 뺌</span><span>바뀐 문단 ${st.changedParas + st.addedParas + st.removedParas}</span>`;
      if (rv.marks) setDiffMarks(app.editor, markSpecs(rv.result.rows, newParas));
      if (rv.marks) { const L = $('#revLeftBody'); const t = L.scrollTop; if (rv.left === 'flow') { L.innerHTML = `<div class="flow prose">${rowsHtml(rv.result.rows, 'left')}</div>`; L.scrollTop = t; } }
      renderChangeList();
    }, 900);
  });

  // 함께 스크롤 (비율 기준)
  let lock = false;
  const pair = [$('#revLeftBody'), $('#revRightBody')];
  pair.forEach((a, i) => a.addEventListener('scroll', () => {
    if (lock || !$('#revSync').checked) return;
    const b = pair[1 - i];
    const r = a.scrollTop / Math.max(1, a.scrollHeight - a.clientHeight);
    lock = true;
    b.scrollTop = r * (b.scrollHeight - b.clientHeight);
    requestAnimationFrame(() => (lock = false));
  }));
  window.addEventListener('resize', () => { if (rv.open && (rv.left === 'page' || rv.right === 'page')) { clearTimeout(rv.rz); rv.rz = setTimeout(render, 300); } });
}

export function revisionOnChapterChange() { if (rv.open) openRevision(); }
