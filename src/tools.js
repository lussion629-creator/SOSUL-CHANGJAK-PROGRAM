// 글쓰기 도구: 원고 다듬기(문장부호·띄어쓰기 일괄 정리), 인물 등장 지도, 장 나누기, 장 목표 분량
import * as S from './store.js';
import { app, saveNow, openChapter, addChapter, renderBinder, saveSettings } from './app.js';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
export { chapterGoalHtml } from './goal.js';
import { DOMSerializer } from '@tiptap/pm/model';
import { parseHtml } from './sanitize.js';
import { htmlToText, fmt } from './stats.js';
import { $, h, toast, dialog } from './ui.js';

// ---------- 원고 다듬기 ----------
// 규칙마다 (글, 앞 글자) → 바뀐 글. 따옴표는 앞 글자를 봐서 여는/닫는 모양을 정한다
const RULES = [
  { id: 'ellipsis', label: '말줄임표 통일', hint: '... · 。。。 · ⋯ → 고른 모양', on: true },
  { id: 'quotes', label: '곧은 따옴표를 둥근 따옴표로', hint: '"말" \'생각\' → “말” ‘생각’', on: true },
  { id: 'spaces', label: '여러 칸 띄어쓰기를 한 칸으로', hint: '두 칸 이상 빈칸 → 한 칸, 보이지 않는 특수 빈칸 → 보통 빈칸', on: true },
  { id: 'punctSpace', label: '문장부호 앞 빈칸 지우기', hint: '“가자 .” → “가자.”', on: true },
  { id: 'dash', label: '줄표 통일', hint: '-- · ― → —', on: false },
  { id: 'trim', label: '문단·줄 앞뒤 빈칸 지우기', hint: '문단과 줄(Shift+Enter) 처음·끝의 빈칸. 들여쓰기는 쪽 설정이 맡아요', on: true },
];
// 빈칸으로 볼 글자: 보통 빈칸·탭과, 스페이스바·붙여넣기·한글/Word 파일에서 들어오는 보이지 않는 빈칸들
// (줄 바꿈 없는 빈칸 U+00A0, 여러 폭 빈칸 U+2000~200B, 좁은 빈칸 U+202F, 수학 빈칸 U+205F, BOM U+FEFF). 전각 빈칸(U+3000)은 앞뒤 지우기에서만 빈칸으로 본다
const SP = ' \t\u00a0\u2000-\u200b\u202f\u205f\ufeff';
const TRIM_HEAD = new RegExp(`^[${SP}\u3000]+`);
const TRIM_TAIL = new RegExp(`[${SP}\u3000]+$`);
const MULTI = new RegExp(`[${SP}]{2,}`, 'g');
const ODD = new RegExp(`[\u00a0\u2000-\u200a\u202f\u205f]`, 'g'); // 하나만 있는 특수 빈칸
const ZW = /[\u200b\ufeff]/g; // 폭 없는 빈칸
const BEFORE_PUNCT = new RegExp(`[${SP}]+([.,!?;:…”’」』)\\]])`, 'g');
function makeFixer(opt) {
  const ell = opt.ellipsisForm || '…';
  return (text, prev = '') => {
    let t = text;
    if (opt.ellipsis) t = t.replace(/\.{3,}|。{3,}|…{1,2}|⋯+/g, (m) => (m === ell ? m : ell));
    if (opt.dash) t = t.replace(/(?<!-)--(?!-)|―|‒/g, '—');
    if (opt.spaces) t = t.replace(ZW, '').replace(MULTI, ' ').replace(ODD, ' ').replace(/　{2,}/g, '　');
    if (opt.punctSpace) t = t.replace(BEFORE_PUNCT, '$1');
    if (opt.quotes) {
      let out = '', p = prev;
      for (const ch of t) {
        if (ch === '"' || ch === "'") {
          const open = !p || /[\s(\[{“‘「『—-]/.test(p);
          out += ch === '"' ? (open ? '“' : '”') : (open ? '‘' : '’');
        } else out += ch;
        p = ch;
      }
      t = out;
    }
    return t;
  };
}
// 문단(블록) 하나의 글자 노드들에 규칙 적용. texts의 null은 줄 바꿈(Shift+Enter)이다.
// 앞뒤 빈칸은 문단의 처음·끝과 줄 바꿈 앞뒤에서 지운다. 빈칸만 있는 글자 노드가 이어져도 다 지운다.
function fixBlockTexts(texts, fix, opt) {
  let prev = '';
  const out = texts.map((t) => {
    if (t == null) { prev = '\n'; return null; }
    const n = fix(t, prev);
    prev = n.slice(-1) || prev;
    return n;
  });
  if (opt.trim) {
    // 줄마다: 앞쪽은 글자가 나올 때까지, 뒤쪽은 뒤에서부터 글자가 나올 때까지 빈칸을 지운다
    let i = 0;
    while (i < out.length) {
      let j = i;
      while (j < out.length && out[j] != null) j++;
      for (let k = i; k < j; k++) { out[k] = out[k].replace(TRIM_HEAD, ''); if (out[k]) break; }
      for (let k = j - 1; k >= i; k--) { out[k] = out[k].replace(TRIM_TAIL, ''); if (out[k]) break; }
      i = j + 1;
    }
  }
  return out;
}

function countChanges(html, fix, opt) {
  const body = parseHtml(html);
  let n = 0;
  for (const blk of body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li')) {
    if (blk.querySelector('p')) continue;
    const nodes = textNodes(blk, true);
    // 고칠 곳 수는 표시하기와 같은 셈으로 (글자 노드 수가 아니라 실제 자리 수)
    n += tidySpots(nodes.map((x) => (x.nodeType === 3 ? x.textContent : '￼')).join(''), opt).length;
    const next = fixBlockTexts(nodes.map((x) => (x.nodeType === 3 ? x.textContent : null)), fix, opt);
    nodes.forEach((x, i) => { if (x.nodeType === 3 && x.textContent !== next[i]) x.textContent = next[i]; });
  }
  return { n, html: body.innerHTML };
}
function textNodes(el, withBr = false) {
  const out = [];
  const w = el.ownerDocument.createTreeWalker(el, withBr ? NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT : NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const c = w.currentNode; if (c.nodeType === 3 || c.nodeName === 'BR') out.push(c); }
  return out;
}

// 지금 장: 편집기 안에서 바꿔야 서식·주석이 그대로 남고 실행 취소도 된다
function fixInEditor(fix, opt) {
  const ed = app.editor;
  const { state } = ed;
  const edits = [];
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const parts = [];
    node.forEach((child, off) => { if (child.isText) parts.push({ child, from: pos + 1 + off }); else if (child.type.name === 'hardBreak') parts.push({ br: true }); });
    const next = fixBlockTexts(parts.map((p) => (p.br ? null : p.child.text)), fix, opt);
    parts.forEach((p, i) => { if (!p.br && next[i] !== p.child.text) edits.push({ from: p.from, to: p.from + p.child.nodeSize, text: next[i], marks: p.child.marks }); });
    return false;
  });
  if (!edits.length) return 0;
  const tr = state.tr;
  for (const e of edits.reverse()) {
    if (e.text) tr.replaceWith(e.from, e.to, state.schema.text(e.text, e.marks));
    else tr.delete(e.from, e.to);
  }
  ed.view.dispatch(tr);
  return edits.length;
}

export async function showTidy() {
  await saveNow();
  const r = await dialog({
    title: '원고 다듬기',
    body: `<p class="hint" style="margin:0">문장부호와 띄어쓰기를 한꺼번에 정리해요. 바꾸기 전 상태는 버전 기록에 남아서 언제든 되돌릴 수 있어요.</p>
      <div class="tidy-rules">${RULES.map((x) => `<label class="check"><input type="checkbox" name="${x.id}" ${tidyOpt()[x.id] ? 'checked' : ''}> <span>${x.label} <small class="hint">${h(x.hint)}</small></span></label>`).join('')}</div>
      <label class="field"><span>말줄임표 모양</span><select name="ellipsisForm">${[['…', '… (가운데 점 셋, 한 글자)'], ['……', '…… (가운데 점 여섯)'], ['...', '... (마침표 셋)']].map(([v, l]) => `<option value="${v}" ${tidyOpt().ellipsisForm === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="check tidy-mark-on"><input type="checkbox" name="mark" ${isTidyMark() ? 'checked' : ''}> <span><b>고치지 않고 원고에 표시만 하기</b> <small class="hint">위에서 고른 규칙에 걸리는 곳에 노란 점선을 그어 둬요. 눌러 보면 어떻게 바뀌는지 나오고, 그 자리만 고칠 수도 있어요. 퇴고 메뉴에서 켜고 꺼요.</small></span></label>
      <label class="field"><span>범위</span><select name="scope"><option value="cur">이 장</option><option value="all">작품 전체 (${app.project.order.length}개 장)</option></select></label>
      <p class="hint tidy-count" aria-live="polite" style="margin:0"></p>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '표시만 하기', value: 'mark' }, { label: '다듬기', value: 'ok', primary: true }],
    onOpen: (f) => {
      const upd = () => {
        const opt = readTidy(f), fix = makeFixer(opt);
        const ids = f.scope.value === 'cur' ? [app.cur] : app.project.order;
        let n = 0, chs = 0;
        for (const id of ids) {
          const html = id === app.cur ? app.editor.getHTML() : app.chapters.get(id).html;
          const c = countChanges(html, fix, opt).n;
          n += c; if (c) chs++;
        }
        f.querySelector('.tidy-count').textContent = n ? `${chs}개 장에서 ${fmt(n)}곳을 고칩니다.` : '고칠 곳이 없어요.';
      };
      f.addEventListener('change', upd);
      upd();
    },
  });
  if (r.value === 'close') return;
  // 고른 규칙은 다음에도 그대로 (표시만 하기도 이 규칙을 쓴다)
  app.settings.tidy = readTidy(r.form);
  if (r.value === 'mark' || r.form.mark.checked !== isTidyMark()) setTidyMark(r.value === 'mark' ? true : r.form.mark.checked);
  else saveSettings(), refreshTidyMarks();
  if (r.value === 'mark') return;
  const opt = readTidy(r.form), fix = makeFixer(opt);
  const ids = r.form.scope.value === 'cur' ? [app.cur] : app.project.order;
  let total = 0;
  for (const id of ids) {
    const c = app.chapters.get(id);
    if (id === app.cur) {
      const before = { ...c, html: app.editor.getHTML() };
      if (!countChanges(before.html, fix, opt).n) continue;
      await S.addSnapshot(before, 'safety', '원고 다듬기 전');
      total += fixInEditor(fix, opt);
      await saveNow();
    } else {
      const res = countChanges(c.html, fix, opt);
      if (!res.n) continue;
      await S.addSnapshot(c, 'safety', '원고 다듬기 전');
      c.html = res.html; c._count = null; c._paras = undefined; c.updated = Date.now();
      await S.putChapter(c);
      app.states.delete(id);
      total += res.n;
    }
  }
  toast(total ? `${fmt(total)}곳을 다듬었어요. 이전 상태는 버전 기록에 있어요.` : '고칠 곳이 없었어요.', 3000);
}
function readTidy(f) {
  const o = Object.fromEntries(RULES.map((x) => [x.id, f[x.id].checked]));
  o.ellipsisForm = f.ellipsisForm.value;
  return o;
}

// ---------- 원고 다듬기: 고치지 않고 표시만 ----------
// 다듬기 규칙에 걸리는 곳에 노란 점선을 긋는다. 문단 노드마다 결과를 기억해 바뀐 문단만 다시 본다.
export const tidyOpt = () => ({ ...Object.fromEntries(RULES.map((x) => [x.id, x.on])), ellipsisForm: '…', ...(app.settings.tidy || {}) });
export const isTidyMark = () => !!app.settings.tidyMark;
const RULE_NAME = Object.fromEntries(RULES.map((x) => [x.id, x.label]));
// 문단 글 → 바꿀 곳 [{i, len, rep, rule}]
export function tidySpots(text, opt = tidyOpt()) {
  const out = [];
  const add = (rule, re, fn) => { for (const m of text.matchAll(re)) { const to = fn(m); if (to != null && to !== m[0]) out.push({ i: m.index, len: m[0].length, rep: to, rule }); } };
  const ell = opt.ellipsisForm || '…';
  if (opt.ellipsis) add('ellipsis', /\.{3,}|。{3,}|…{1,2}|⋯+/g, (m) => (m[0] === ell ? null : ell));
  if (opt.dash) add('dash', /(?<!-)--(?!-)|―|‒/g, () => '—');
  if (opt.spaces) {
    add('spaces', new RegExp(`(?<=[^${SP}\u3000￼])[${SP}]{2,}`, 'g'), () => ' ');
    add('spaces', new RegExp(`(?<=[^${SP}\u3000￼])[\u00a0\u2000-\u200a\u202f\u205f](?=[^${SP}\u3000￼])`, 'g'), () => ' ');
    add('spaces', /[\u200b\ufeff]/g, () => '');
    add('spaces', /(?<=\S)　{2,}/g, () => '　');
  }
  if (opt.punctSpace) add('punctSpace', new RegExp(`[${SP}]+(?=[.,!?;:…”’」』)\\]])`, 'g'), () => '');
  if (opt.quotes) add('quotes', /["']/g, (m) => { const p = text[m.index - 1]; const open = !p || /[\s(\[{“‘「『—-]/.test(p); return m[0] === '"' ? (open ? '“' : '”') : (open ? '‘' : '’'); });
  if (opt.trim) { add('trim', new RegExp(`(?:^|(?<=￼))[${SP}\u3000]+`, 'g'), () => ''); add('trim', new RegExp(`[${SP}\u3000]+(?=￼|$)`, 'g'), () => ''); }
  out.sort((a, b) => a.i - b.i || b.len - a.len);
  return out.filter((x, k) => !out.slice(0, k).some((y) => x.i < y.i + y.len && y.i < x.i + x.len));
}
const tmKey = new PluginKey('tidyMarks');
let tmMemo = new WeakMap(), tmSig = '';
const vis = (t) => (t === '' ? '(지움)' : t.replace(/[\s\u200b\ufeff]/g, '') ? t : `빈칸 ${t.length}칸`);
function tidyDeco(doc) {
  const opt = tidyOpt();
  const sig = JSON.stringify(opt);
  if (sig !== tmSig) { tmMemo = new WeakMap(); tmSig = sig; }
  const decos = [];
  let n = 0;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let list = tmMemo.get(node);
    if (!list) { list = tidySpots(node.textBetween(0, node.content.size, null, '￼'), opt); tmMemo.set(node, list); }
    for (const x of list) {
      n++;
      decos.push(Decoration.inline(pos + 1 + x.i, pos + 1 + x.i + x.len, { class: 'tm', title: `${RULE_NAME[x.rule]}: ${vis(text(node, x))} → ${vis(x.rep)} (눌러서 고치기)` }, { spot: { ...x, from: pos + 1 + x.i, to: pos + 1 + x.i + x.len } }));
    }
    return false;
  });
  return { deco: DecorationSet.create(doc, decos), n };
}
const text = (node, x) => node.textBetween(0, node.content.size, null, '￼').slice(x.i, x.i + x.len);
const tmPlugin = new Plugin({
  key: tmKey,
  state: {
    init: () => ({ deco: DecorationSet.empty, n: 0 }),
    apply(tr, prev, _o, state) {
      const meta = tr.getMeta(tmKey);
      if (!isTidyMark()) return prev.n || prev.deco !== DecorationSet.empty ? { deco: DecorationSet.empty, n: 0 } : prev;
      if (meta) return tidyDeco(state.doc);
      if (!tr.docChanged) return prev;
      return { deco: prev.deco.map(tr.mapping, tr.doc), n: prev.n }; // 쓰는 동안은 위치만 따라가고 잠깐 멈추면 다시
    },
  },
  props: {
    decorations: (state) => tmKey.getState(state).deco,
    handleClick(view, pos, e) {
      if (!isTidyMark()) return false;
      const hit = tmKey.getState(view.state).deco.find(pos, pos).find((d) => d.from <= pos && pos <= d.to);
      if (!hit) { closeTmPop(); return false; }
      setTimeout(() => openTmPop(view, hit.spec.spot, hit.from, hit.to), 0);
      return false;
    },
  },
  view(view) {
    let t = null;
    const kick = () => { clearTimeout(t); t = setTimeout(() => { if (view.composing) { kick(); return; } if (isTidyMark()) view.dispatch(view.state.tr.setMeta(tmKey, 1).setMeta('addToHistory', false)); }, 500); };
    return { update(v, p) { if (v.state.doc !== p.doc && isTidyMark()) kick(); }, destroy() { clearTimeout(t); } };
  },
});
export function refreshTidyMarks() {
  const ed = app.editor;
  if (!ed) return;
  ed.view.dispatch(ed.state.tr.setMeta(tmKey, 1).setMeta('addToHistory', false));
  const st = $('#stTidy');
  if (st) {
    const n = tmKey.getState(ed.state).n;
    st.hidden = !isTidyMark();
    st.textContent = n ? `다듬을 곳 ${fmt(n)}` : '다듬을 곳 없음';
    st.classList.toggle('has', n > 0);
  }
}
export function setTidyMark(on, quiet = false) {
  app.settings.tidyMark = on;
  saveSettings();
  closeTmPop();
  refreshTidyMarks();
  document.querySelectorAll('[data-act=tidyMark]').forEach((b) => b.classList.toggle('on', on));
  if (!quiet) toast(on ? `원고 다듬기 규칙에 걸리는 곳을 노란 점선으로 표시해요 (${fmt(tmKey.getState(app.editor.state).n)}곳). 고치지는 않아요.` : '원고 다듬기 표시를 껐어요.');
}
export const toggleTidyMark = () => setTidyMark(!isTidyMark());
let tmPop = null;
function closeTmPop() { tmPop?.remove(); tmPop = null; }
function openTmPop(view, x, from, to) {
  closeTmPop();
  const word = view.state.doc.textBetween(from, to, '\n', '￼');
  tmPop = document.createElement('div');
  tmPop.className = 'proof-pop tm-pop';
  tmPop.innerHTML = `<div class="pp-k" style="color:var(--tm)">원고 다듬기 · ${h(RULE_NAME[x.rule])}</div>
    <div class="pc-fix"><del>${h(vis(word))}</del> → <ins>${h(vis(x.rep))}</ins></div>
    <div class="pp-to"><button type="button" class="primary" data-a="fix">이것만 고치기</button><button type="button" data-a="all">다듬기 창…</button></div>
    <div class="pp-more"><button type="button" data-a="off">표시 끄기</button></div>`;
  document.body.append(tmPop);
  const r = view.coordsAtPos(from);
  const w = tmPop.offsetWidth, hh = tmPop.offsetHeight;
  Object.assign(tmPop.style, { left: Math.max(8, Math.min(innerWidth - w - 8, r.left - 12)) + 'px', top: Math.max(8, r.bottom + 8 + hh > innerHeight - 8 ? r.top - hh - 8 : r.bottom + 8) + 'px' });
  tmPop.addEventListener('mousedown', (e) => e.preventDefault());
  tmPop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'fix') {
      const st = view.state;
      if (st.doc.textBetween(from, to, '\n', '￼') === word) view.dispatch(x.rep ? st.tr.insertText(x.rep, from, to) : st.tr.delete(from, to));
      refreshTidyMarks();
    }
    if (b.dataset.a === 'all') showTidy();
    if (b.dataset.a === 'off') setTidyMark(false);
    closeTmPop();
    app.editor.commands.focus();
  });
}
export function bindTidyMarks() {
  app.editor.registerPlugin(tmPlugin);
  app.editor.on('transaction', ({ transaction }) => {
    if (transaction.getMeta(tmKey)) {
      const st = $('#stTidy'), n = tmKey.getState(app.editor.state).n;
      if (st) { st.hidden = !isTidyMark(); st.textContent = n ? `다듬을 곳 ${fmt(n)}` : '다듬을 곳 없음'; st.classList.toggle('has', n > 0); }
    }
  });
  app.hooks.afterOpen.push(() => setTimeout(refreshTidyMarks, 0));
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTmPop(); });
  addEventListener('mousedown', (e) => { if (tmPop && !tmPop.contains(e.target) && !e.target.closest?.('.tm')) closeTmPop(); }, true);
  $('#stTidy')?.addEventListener('click', () => showTidy());
  document.querySelectorAll('[data-act=tidyMark]').forEach((b) => b.classList.toggle('on', isTidyMark()));
  refreshTidyMarks();
}

// ---------- 인물 등장 지도 ----------
// 자료의 인물·장소·사물 이름(과 '다른 이름')이 장마다 몇 번 나오는지
export async function showAppearances() {
  await saveNow();
  const notes = (await S.notesOf(app.project.id)).filter((n) => ['character', 'place', 'item'].includes(n.type) && n.name?.trim());
  if (!notes.length) { toast('자료에 인물·장소·사물을 먼저 넣어 주세요.'); return; }
  const order = app.project.order;
  const texts = order.map((id) => htmlToText(id === app.cur ? app.editor.getHTML() : app.chapters.get(id).html));
  const names = (n) => [n.name, ...String(n.fields?.['다른 이름'] || '').split(/[,，、]/)].map((x) => x.trim()).filter(Boolean);
  const count = (t, ws) => ws.reduce((a, w) => a + (t.split(w).length - 1), 0);
  const kinds = { character: '인물', place: '장소', item: '사물' };
  const rows = notes.map((n) => ({ n, c: texts.map((t) => count(t, names(n))) })).sort((a, b) => (a.n.type > b.n.type ? 1 : a.n.type < b.n.type ? -1 : b.c.reduce((x, y) => x + y, 0) - a.c.reduce((x, y) => x + y, 0)));
  const max = Math.max(1, ...rows.flatMap((r) => r.c));
  const cell = (v, ci, ri) => `<td class="${v ? 'hit' : ''}" style="--a:${v ? 0.15 + 0.85 * v / max : 0}" ${v ? `data-ch="${order[ci]}" data-who="${ri}"` : ''} title="${v ? `${v}번` : '안 나옴'}">${v || ''}</td>`;
  await dialog({
    title: '인물 등장 지도',
    wide: true,
    body: `<p class="hint" style="margin:0">자료의 이름과 ‘다른 이름’이 장마다 몇 번 나오는지 보여 줘요. 칸을 누르면 그 장에서 위치를 표시해요. 오래 안 나온 인물을 찾을 때 좋아요.</p>
      <div class="appear-wrap"><table class="appear"><thead><tr><th></th>${order.map((id, i) => `<th title="${h(app.chapters.get(id).title)}">${i + 1}</th>`).join('')}<th>합</th></tr></thead>
      <tbody>${rows.map((r, ri) => `<tr><th><small>${kinds[r.n.type]}</small> ${h(r.n.name)}</th>${r.c.map((v, ci) => cell(v, ci, ri)).join('')}<td class="sum">${r.c.reduce((a, b) => a + b, 0)}</td></tr>`).join('')}</tbody></table></div>`,
    buttons: [{ label: '닫기', value: 'close', primary: true }],
    onOpen: (f, dlg) => f.addEventListener('click', async (e) => {
      const td = e.target.closest('td[data-ch]');
      if (!td) return;
      dlg.close('close');
      await openChapter(td.dataset.ch);
      const { setSearch, gotoMatch } = await import('./editor.js');
      const ws = names(rows[+td.dataset.who].n);
      const m = setSearch(app.editor, ws[0], { cls: 'word-hit' });
      if (m[0]) gotoMatch(app.editor, m[0]);
      toast(`“${ws[0]}” ${m.length}곳을 표시했어요. Esc로 지웁니다.`);
    }),
  });
}

// ---------- 커서 자리에서 장 나누기 ----------
export async function splitChapterAtCursor() {
  const ed = app.editor;
  let { $from } = ed.state.selection;
  if ($from.depth < 1) return;
  // 문단 가운데면 먼저 문단을 나눈다
  if ($from.parentOffset > 0 && $from.parentOffset < $from.parent.content.size) { ed.commands.splitBlock(); $from = ed.state.selection.$from; }
  const idx = $from.index(0) + ($from.parentOffset > 0 && $from.parentOffset === $from.parent.content.size ? 1 : 0);
  const doc = ed.state.doc;
  if (idx <= 0 || idx >= doc.childCount) { toast('장 처음이나 끝에서는 나눌 수 없어요. 나눌 문단 앞에 커서를 두세요.'); return; }
  const c = app.chapters.get(app.cur);
  await S.addSnapshot({ ...c, html: ed.getHTML() }, 'safety', '장 나누기 전');
  const ser = DOMSerializer.fromSchema(ed.schema);
  const div = document.createElement('div');
  const frag = [];
  doc.forEach((n, _o, i) => { if (i >= idx) frag.push(n); });
  frag.forEach((n) => div.appendChild(ser.serializeNode(n)));
  const rest = div.innerHTML;
  // 지금 장에서는 뒤쪽을 지운다
  let at = 0;
  doc.forEach((n, o, i) => { if (i === idx) at = o; });
  ed.view.dispatch(ed.state.tr.delete(at, doc.content.size));
  app.dirty = true;
  await saveNow();
  c._count = null;
  await addChapter(`${c.title} (나눔)`, rest, app.cur);
  toast('커서 자리에서 장을 나눴어요. 나누기 전 상태는 버전 기록에 있어요.');
}

// ---------- 장 목표 분량 ----------
export function bindChapterGoal() {
  const input = $('#chapterGoal');
  if (!input) return;
  app.hooks.afterOpen.push(() => { input.value = app.chapters.get(app.cur)?.goal || ''; });
  input.addEventListener('change', async () => {
    const c = app.chapters.get(app.cur);
    c.goal = Math.max(0, Math.round(+input.value || 0)) || undefined;
    await S.putChapter(c);
    renderBinder();
  });
}
