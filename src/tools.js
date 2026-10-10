// 글쓰기 도구: 원고 다듬기(문장부호·띄어쓰기 일괄 정리), 인물 등장 지도, 장 나누기, 장 목표 분량
import * as S from './store.js';
import { app, saveNow, openChapter, addChapter, renderBinder } from './app.js';
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
  { id: 'spaces', label: '여러 칸 띄어쓰기를 한 칸으로', hint: '두 칸 이상 빈칸 → 한 칸', on: true },
  { id: 'punctSpace', label: '문장부호 앞 빈칸 지우기', hint: '“가자 .” → “가자.”', on: true },
  { id: 'dash', label: '줄표 통일', hint: '-- · ― → —', on: false },
  { id: 'trim', label: '문단 앞뒤 빈칸 지우기', hint: '들여쓰기는 쪽 설정이 맡아요', on: false },
];
function makeFixer(opt) {
  const ell = opt.ellipsisForm || '…';
  return (text, prev = '') => {
    let t = text;
    if (opt.ellipsis) t = t.replace(/\.{3,}|。{3,}|…{1,2}|⋯+/g, (m) => (m === ell ? m : ell));
    if (opt.dash) t = t.replace(/(?<!-)--(?!-)|―|‒/g, '—');
    if (opt.spaces) t = t.replace(/ {2,}/g, ' ').replace(/　{2,}/g, '　');
    if (opt.punctSpace) t = t.replace(/ +([.,!?;:…”’」』)\]])/g, '$1');
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
// 문단(블록) 하나의 글자 노드들에 규칙 적용: [{node, text, newText}]
function fixBlockTexts(texts, fix, opt) {
  let prev = '';
  const out = texts.map((t, i) => {
    let n = fix(t, prev);
    if (opt.trim) {
      if (i === 0) n = n.replace(/^[ 　\t]+/, '');
      if (i === texts.length - 1) n = n.replace(/[ 　\t]+$/, '');
    }
    prev = n.slice(-1) || prev;
    return n;
  });
  return out;
}

function countChanges(html, fix, opt) {
  const body = parseHtml(html);
  let n = 0;
  for (const blk of body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li')) {
    if (blk.querySelector('p')) continue;
    const nodes = textNodes(blk);
    const next = fixBlockTexts(nodes.map((x) => x.textContent), fix, opt);
    nodes.forEach((x, i) => { if (x.textContent !== next[i]) { n++; x.textContent = next[i]; } });
  }
  return { n, html: body.innerHTML };
}
function textNodes(el) {
  const out = [];
  const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) out.push(w.currentNode);
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
    node.forEach((child, off) => { if (child.isText) parts.push({ child, from: pos + 1 + off }); });
    const next = fixBlockTexts(parts.map((p) => p.child.text), fix, opt);
    parts.forEach((p, i) => { if (next[i] !== p.child.text) edits.push({ from: p.from, to: p.from + p.child.nodeSize, text: next[i], marks: p.child.marks }); });
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
      <div class="tidy-rules">${RULES.map((x) => `<label class="check"><input type="checkbox" name="${x.id}" ${x.on ? 'checked' : ''}> <span>${x.label} <small class="hint">${h(x.hint)}</small></span></label>`).join('')}</div>
      <label class="field"><span>말줄임표 모양</span><select name="ellipsisForm"><option value="…">… (가운데 점 셋, 한 글자)</option><option value="……">…… (가운데 점 여섯)</option><option value="...">... (마침표 셋)</option></select></label>
      <label class="field"><span>범위</span><select name="scope"><option value="cur">이 장</option><option value="all">작품 전체 (${app.project.order.length}개 장)</option></select></label>
      <p class="hint tidy-count" aria-live="polite" style="margin:0"></p>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '다듬기', value: 'ok', primary: true }],
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
  if (r.value !== 'ok') return;
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
