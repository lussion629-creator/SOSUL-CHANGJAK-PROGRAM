// 서식: 글꼴 창·단락 창 (Word처럼), 마우스 오른쪽 메뉴, 0.5pt 단위 글자 크기
import { app } from './app.js';
import { FONTS } from './fonts.js';
import { layoutOf } from './layout.js';
import { isPageView } from './pageview.js';
import { PARA_KEYS, runCommand } from './editor.js';
import { $, h, toast, dialog } from './ui.js';

// ---------- 글자 크기 ----------
// 지금 커서 자리의 글자 크기 (pt)
export function currentSize() {
  const v = app.editor.getAttributes('textStyle').fontSize;
  if (v) { const n = parseFloat(v); return v.endsWith('px') ? n * 0.75 : n; }
  if (isPageView()) return layoutOf().size;
  const el = app.editor.view.domAtPos(app.editor.state.selection.from).node;
  const node = el.nodeType === 1 ? el : el.parentElement;
  return Math.round(parseFloat(getComputedStyle(node).fontSize) * 0.75 * 2) / 2 || 12;
}
const fmtPt = (n) => String(Math.round(n * 2) / 2);
export function setSize(pt) {
  pt = Math.round(+pt * 2) / 2;
  if (!pt || pt < 1 || pt > 400) { toast('글자 크기는 1~400pt 사이로 넣어 주세요.'); return; }
  runCommand(app.editor, 'size', `${fmtPt(pt)}pt`);
}
export const stepSize = (d) => setSize(currentSize() + d);
export function showSizeInBox() {
  const v = app.editor.getAttributes('textStyle').fontSize;
  const box = $('#fontSize');
  if (document.activeElement === box) return;
  box.value = v ? fmtPt(parseFloat(v) * (v.endsWith('px') ? 0.75 : 1)) : '';
  box.placeholder = v ? '크기' : fmtPt(currentSize());
}

// ---------- 글꼴 창 ----------
export async function showFontDialog() {
  const ed = app.editor;
  const ts = ed.getAttributes('textStyle');
  const size = currentSize();
  const has = (m) => ed.isActive(m);
  const fontOpts = [['', '기본 (쪽 설정·환경 설정 글꼴)'], ...FONTS.map((f) => [f[0], f[1]])];
  const cur = ts.fontFamily || '';
  if (cur && !fontOpts.some((f) => f[0] === cur)) fontOpts.push([cur, cur.replace(/['"]/g, '')]);
  const r = await dialog({
    title: '글꼴',
    body: `<div class="fmt-grid">
      <label class="field"><span>글꼴</span><select name="font">${fontOpts.map(([v, l]) => `<option value="${h(v)}" ${v === cur ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>
      <label class="field"><span>크기 (pt)</span><input name="size" type="number" step="0.5" min="1" max="400" value="${fmtPt(size)}"></label>
      <label class="field"><span>자간 (%)</span><input name="ls" type="number" step="1" min="-50" max="50" value="${ts.letterSpacing ?? ''}" placeholder="기본"></label>
      <label class="field"><span>글자 색</span><span class="fmt-color"><input name="color" type="color" value="${h(ts.color || '#222222')}"><label class="check"><input type="checkbox" name="nocolor" ${ts.color ? '' : 'checked'}> 기본 색</label></span></label>
    </div>
    <div class="fmt-checks">
      <label class="check"><input type="checkbox" name="b" ${has('bold') ? 'checked' : ''}> <b>굵게</b></label>
      <label class="check"><input type="checkbox" name="i" ${has('italic') ? 'checked' : ''}> <i>기울임</i></label>
      <label class="check"><input type="checkbox" name="u" ${has('underline') ? 'checked' : ''}> <u>밑줄</u></label>
      <label class="check"><input type="checkbox" name="s" ${has('strike') ? 'checked' : ''}> <s>취소선</s></label>
    </div>
    <div class="fmt-prev" aria-live="polite"><span>가나다라 소설의 한 문장. AaBb 123</span></div>
    <p class="hint" style="margin:0">고른 글자에 적용됩니다. 아무것도 고르지 않았으면 지금부터 쓰는 글자에 적용돼요.</p>`,
    buttons: [{ label: '기본 글꼴로', value: 'reset', left: true }, { label: '취소', value: 'close' }, { label: '적용', value: 'ok', primary: true }],
    onOpen: (f) => {
      const prev = f.querySelector('.fmt-prev span');
      const upd = () => {
        prev.style.fontFamily = f.font.value ? `${f.font.value}, serif` : '';
        prev.style.fontSize = `${Math.min(28, +f.size.value || size) * (96 / 72)}px`;
        prev.style.letterSpacing = f.ls.value === '' ? '' : `${+f.ls.value / 100}em`;
        prev.style.color = f.nocolor.checked ? '' : f.color.value;
        prev.style.fontWeight = f.b.checked ? '700' : '';
        prev.style.fontStyle = f.i.checked ? 'italic' : '';
        prev.style.textDecoration = [f.u.checked && 'underline', f.s.checked && 'line-through'].filter(Boolean).join(' ');
      };
      f.addEventListener('input', upd);
      f.color.addEventListener('input', () => { f.nocolor.checked = false; upd(); });
      upd();
    },
  });
  if (r.value === 'reset') {
    ed.chain().focus().unsetMark('textStyle').unsetBold().unsetItalic().unsetUnderline().unsetStrike().run();
    return;
  }
  if (r.value !== 'ok') return;
  // 바꾼 칸만 적용한다 (고른 글에 섞여 있던 다른 서식은 그대로 둔다)
  const f = r.form;
  const sz = Math.round(+f.size.value * 2) / 2;
  const attrs = {};
  if (f.font.value !== cur) attrs.fontFamily = f.font.value || null;
  if (sz && sz !== size) attrs.fontSize = `${fmtPt(sz)}pt`;
  const ls = f.ls.value === '' ? null : Math.max(-50, Math.min(50, +f.ls.value));
  if (ls !== (ts.letterSpacing ?? null)) attrs.letterSpacing = ls;
  const color = f.nocolor.checked ? null : f.color.value;
  if (color !== (ts.color || null)) attrs.color = color;
  const c = ed.chain().focus();
  if (Object.keys(attrs).length) c.setMark('textStyle', attrs);
  const tog = (on, was, set, unset) => { if (on !== was) (on ? set : unset)(); };
  tog(f.b.checked, has('bold'), () => c.setBold(), () => c.unsetBold());
  tog(f.i.checked, has('italic'), () => c.setItalic(), () => c.unsetItalic());
  tog(f.u.checked, has('underline'), () => c.setUnderline(), () => c.unsetUnderline());
  tog(f.s.checked, has('strike'), () => c.setStrike(), () => c.unsetStrike());
  c.removeEmptyTextStyle().run();
}

// ---------- 단락 창 ----------
function selectedBlocks() {
  const { state } = app.editor;
  const out = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (n) => {
    if (n.type.name === 'paragraph' || n.type.name === 'heading') { out.push(n); return false; }
    return true;
  });
  return out;
}

export async function showParaDialog() {
  const blocks = selectedBlocks();
  if (!blocks.length) return;
  const a = blocks[0].attrs;
  const L = layoutOf();
  const pv = isPageView();
  const base = {
    line: pv ? L.line : Math.round((app.settings.lineHeight || 1.9) * 100),
    first: pv ? L.indent : app.settings.indent ? 1 : 0,
  };
  const firstKind = a.first == null ? 'default' : a.first === 0 ? 'none' : a.first > 0 ? 'indent' : 'hang';
  const v = (x) => (x == null ? '' : x);
  const r = await dialog({
    title: `단락${blocks.length > 1 ? ` (문단 ${blocks.length}개)` : ''}`,
    wide: true,
    body: `<div class="para-dlg">
      <div class="para-main">
        <fieldset><legend>정렬</legend>
          <label class="field"><span>맞춤</span><select name="align">
            ${[['', '기본'], ['justify', '양쪽'], ['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽']].map(([k, l]) => `<option value="${k}" ${(a.textAlign || '') === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        </fieldset>
        <fieldset><legend>여백 (글자 수)</legend><div class="fmt-grid">
          <label class="field"><span>왼쪽</span><input name="indL" type="number" step="0.5" min="0" max="40" value="${v(a.indL)}" placeholder="0"></label>
          <label class="field"><span>오른쪽</span><input name="indR" type="number" step="0.5" min="0" max="40" value="${v(a.indR)}" placeholder="0"></label>
          <label class="field"><span>첫 줄</span><select name="firstKind">
            <option value="default" ${firstKind === 'default' ? 'selected' : ''}>기본 (${base.first}글자)</option>
            <option value="none" ${firstKind === 'none' ? 'selected' : ''}>없음</option>
            <option value="indent" ${firstKind === 'indent' ? 'selected' : ''}>들여쓰기</option>
            <option value="hang" ${firstKind === 'hang' ? 'selected' : ''}>내어쓰기</option>
          </select></label>
          <label class="field"><span>첫 줄 값 (글자)</span><input name="firstVal" type="number" step="0.5" min="0" max="20" value="${a.first ? Math.abs(a.first) : 1}"></label>
        </div></fieldset>
        <fieldset><legend>간격</legend><div class="fmt-grid">
          <label class="field"><span>줄 간격 (%)</span><input name="line" type="number" step="5" min="80" max="400" value="${v(a.line)}" placeholder="기본 ${base.line}"></label>
          <label class="field"><span>문단 위 (pt)</span><input name="before" type="number" step="1" min="0" max="200" value="${v(a.before)}" placeholder="0"></label>
          <label class="field"><span>문단 아래 (pt)</span><input name="after" type="number" step="1" min="0" max="200" value="${v(a.after)}" placeholder="기본"></label>
          <label class="field"><span>줄 나눔</span><select name="brk">
            <option value="" ${!a.brk ? 'selected' : ''}>기본</option>
            <option value="word" ${a.brk === 'word' ? 'selected' : ''}>어절 단위</option>
            <option value="char" ${a.brk === 'char' ? 'selected' : ''}>글자 단위</option>
          </select></label>
        </div></fieldset>
      </div>
      <div class="para-prev" aria-hidden="true"><p class="pp-before">앞 문단입니다. 앞 문단입니다. 앞 문단입니다.</p><p class="pp-this">바꾸는 문단입니다. 바람이 불자 마른 잎들이 길 위를 굴러갔다. 그는 걸음을 멈추고 오래도록 하늘을 올려다보았다.</p><p class="pp-after">다음 문단입니다. 다음 문단입니다.</p></div>
    </div>`,
    buttons: [{ label: '모두 기본으로', value: 'reset', left: true }, { label: '취소', value: 'close' }, { label: '적용', value: 'ok', primary: true }],
    onOpen: (f) => {
      const p = f.querySelector('.pp-this');
      const upd = () => {
        const x = read(f);
        p.style.textAlign = f.align.value || '';
        p.style.marginLeft = x.indL != null ? `${x.indL}em` : '';
        p.style.marginRight = x.indR != null ? `${x.indR}em` : '';
        const first = x.first ?? base.first;
        p.style.textIndent = `${first}em`;
        p.style.paddingLeft = first < 0 ? `${-first}em` : '';
        p.style.lineHeight = String((x.line ?? base.line) / 100);
        p.style.marginTop = x.before != null ? `${x.before * 0.6}px` : '';
        p.style.marginBottom = x.after != null ? `${x.after * 0.6}px` : '';
        p.style.wordBreak = x.brk === 'char' ? 'break-all' : 'keep-all';
        f.firstVal.disabled = f.firstKind.value === 'default' || f.firstKind.value === 'none';
      };
      f.addEventListener('input', upd);
      f.addEventListener('change', upd);
      upd();
    },
  });
  const ed = app.editor;
  if (r.value === 'reset') {
    const clear = Object.fromEntries(PARA_KEYS.map((k) => [k, null]));
    ed.chain().focus().updateAttributes('paragraph', clear).updateAttributes('heading', clear).unsetTextAlign().run();
    return;
  }
  if (r.value !== 'ok') return;
  // 처음 보여 준 값에서 바꾼 칸만 적용한다 (여러 문단의 서로 다른 값은 그대로 둔다)
  const x = read(r.form);
  const changed = Object.fromEntries(Object.entries(x).filter(([k, val]) => val !== (a[k] ?? null)));
  const c = ed.chain().focus();
  if (Object.keys(changed).length) c.updateAttributes('paragraph', changed).updateAttributes('heading', changed);
  if (r.form.align.value !== (a.textAlign || '')) r.form.align.value ? c.setTextAlign(r.form.align.value) : c.unsetTextAlign();
  c.run();
}

function read(f) {
  const n = (el, lo, hi) => (el.value === '' ? null : Math.max(lo, Math.min(hi, +el.value)));
  const fv = Math.abs(+f.firstVal.value || 0);
  return {
    indL: n(f.indL, 0, 40), indR: n(f.indR, 0, 40),
    first: { default: null, none: 0, indent: fv, hang: -fv }[f.firstKind.value],
    line: n(f.line, 80, 400), before: n(f.before, 0, 200), after: n(f.after, 0, 200),
    brk: f.brk.value || null,
  };
}

// ---------- 마우스 오른쪽 메뉴 ----------
export function bindContextMenu() {
  const menu = document.createElement('div');
  menu.className = 'menu ctx-menu';
  menu.id = 'ctxMenu';
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);
  const close = () => menu.classList.remove('open');
  const ed = () => app.editor;

  app.editor.view.dom.addEventListener('contextmenu', (e) => {
    // 터치 화면(길게 누르기)에서는 기기 기본 메뉴를 그대로 쓴다
    if (!matchMedia('(pointer: fine)').matches || e.shiftKey) return;
    e.preventDefault();
    // 고른 글자 바깥을 눌렀으면 그 자리로 커서를 옮긴다 (Word와 같게)
    const { from, to } = ed().state.selection;
    const at = ed().view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (at && (at.pos < from || at.pos > to || from === to)) ed().commands.setTextSelection(at.pos);
    const sel = ed().state.doc.textBetween(ed().state.selection.from, ed().state.selection.to, ' ').trim();
    const word = sel ? (sel.length <= 20 && sel.split(/\s+/).length <= 3 ? sel : '') : wordAt();
    menu.innerHTML = `
      <button data-c="cut" ${sel ? '' : 'disabled'}><span>잘라내기</span><small>Ctrl+X</small></button>
      <button data-c="copy" ${sel ? '' : 'disabled'}><span>복사</span><small>Ctrl+C</small></button>
      <button data-c="paste"><span>붙여넣기</span><small>Ctrl+V</small></button>
      <hr>
      <button data-c="font"><span>글꼴…</span><small>Ctrl+D</small></button>
      <button data-c="para"><span>단락…</span><small>Ctrl+Shift+P</small></button>
      <button data-c="clear"><span>서식 지우기</span></button>
      <hr>
      ${word ? `<button data-c="dict"><span>‘${h(word.slice(0, 12))}${word.length > 12 ? '…' : ''}’ 사전에서 찾기</span><small>표준국어대사전</small></button>` : ''}
      ${sel ? `<button data-c="find"><span>원고 전체에서 찾기</span></button>` : ''}
      <button data-c="speak"><span>${sel ? '고른 부분' : '이 문단'} 소리 내어 읽기</span></button>
      ${sel ? `<button data-c="memo"><span>자료실에 메모로 남기기</span></button>` : ''}
      <hr>
      <button data-c="scene"><span>장면 전환 넣기 (* * *)</span></button>
      ${sel ? `<p class="ctx-count">고른 글자 ${sel.replace(/\s/g, '').length.toLocaleString()}자 (공백 포함 ${sel.length.toLocaleString()}자)</p>` : ''}`;
    menu.dataset.word = word;
    menu.classList.add('open');
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
  });
  menu.addEventListener('mousedown', (e) => e.preventDefault()); // 편집기의 선택을 지킨다
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    close();
    const c = b.dataset.c;
    const sel = ed().state.doc.textBetween(ed().state.selection.from, ed().state.selection.to, ' ');
    if (c === 'cut' || c === 'copy') { ed().commands.focus(); document.execCommand(c); }
    else if (c === 'paste') {
      try {
        const t = await navigator.clipboard.readText();
        ed().commands.focus();
        ed().view.pasteText(t); // Ctrl+V와 똑같이 붙여 넣는다 (문단이 쪼개지지 않게)
      } catch { toast('브라우저가 붙여넣기를 막았어요. Ctrl+V를 눌러 주세요.'); }
    } else if (c === 'font') showFontDialog();
    else if (c === 'para') showParaDialog();
    else if (c === 'clear') runCommand(ed(), 'clear');
    else if (c === 'scene') runCommand(ed(), 'scene');
    else if (c === 'dict') window.open(`https://stdict.korean.go.kr/search/searchResult.do?searchKeyword=${encodeURIComponent(menu.dataset.word)}`, '_blank', 'noopener');
    else if (c === 'find') { const { openFind } = await import('./features.js'); $('#findInput').value = sel.trim(); openFind(); }
    else if (c === 'speak') speak(sel || paragraphText());
    else if (c === 'memo') { const { editNote } = await import('./features.js'); editNote(null, { body: sel.trim() }); }
  });
  addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) close(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  addEventListener('blur', close);
  document.addEventListener('scroll', close, true);
}

function paragraphText() {
  const $p = app.editor.state.selection.$from;
  return $p.parent.textContent;
}
// 커서가 있는 낱말 (조사는 떼지 않고 그대로)
function wordAt() {
  const $p = app.editor.state.selection.$from;
  const t = $p.parent.textContent;
  const i = $p.parentOffset;
  const L = t.slice(0, i).match(/[\p{L}\p{N}]+$/u)?.[0] || '';
  const R = t.slice(i).match(/^[\p{L}\p{N}]+/u)?.[0] || '';
  return L + R;
}

// ---------- 소리 내어 읽기 (퇴고할 때 귀로 듣기) ----------
export function speak(text) {
  if (!('speechSynthesis' in window)) { toast('이 브라우저는 소리 내어 읽기를 지원하지 않아요.'); return; }
  speechSynthesis.cancel();
  text = (text || '').trim();
  if (!text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = app.settings.speakRate || 1;
  const ko = speechSynthesis.getVoices().find((v) => v.lang?.startsWith('ko'));
  if (ko) u.voice = ko;
  speechSynthesis.speak(u);
  toast('읽는 중… (Esc로 멈춤)', Math.min(15000, text.length * 120));
}
addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.speechSynthesis?.speaking) speechSynthesis.cancel(); });
