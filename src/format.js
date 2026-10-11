// 서식: 글꼴 창·단락 창 (Word처럼), 마우스 오른쪽 메뉴, 0.5pt 단위 글자 크기
import { app } from './app.js';
import { FONTS } from './fonts.js';
import { layoutOf } from './layout.js';
import { isPageView } from './pageview.js';
import { PARA_KEYS, runCommand, HL_COLORS, TEXT_COLORS, hlColor, setHlColor, hexOf } from './editor.js';
import { saveSettings } from './app.js';
import { keyOf, pretty } from './keys.js';
const kb = (id) => pretty(keyOf(id));
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

// ---------- 자간 (글자 사이 간격: 한글 방식 %, Word 방식 pt) ----------
// 고른 글자에 적용한다. 아무것도 고르지 않았으면 커서가 있는 문단 전체에 적용한다
// (한 줄 넘친 문단을 살짝 좁혀 줄을 맞출 때 쓰기 좋게).
const clampLs = (n) => Math.max(-50, Math.min(50, Math.round(n)));
const isPt = (v) => typeof v === 'string' && /pt$/.test(v);
const fmtLsPt = (n) => `${Math.round(Math.max(-20, Math.min(20, n)) * 10) / 10}pt`;
// 입력 값 → 저장 값: '0.5pt' → '0.5pt'(Word 방식), '-3' 또는 '-3%' → -3(한글 방식)
export function parseSpacing(s) {
  s = String(s ?? '').trim().replace(/\s+/g, '');
  if (!s) return null;
  if (/pt$/i.test(s)) { const n = parseFloat(s); return Number.isFinite(n) ? fmtLsPt(n) : undefined; }
  const n = parseFloat(s.replace(/%$/, ''));
  return Number.isFinite(n) ? clampLs(n) : undefined;
}
export function currentSpacing() {
  const v = app.editor.getAttributes('textStyle').letterSpacing;
  if (v != null) return v;
  const el = app.editor.view.domAtPos(app.editor.state.selection.from).node;
  const node = el.nodeType === 1 ? el : el.parentElement;
  const cs = getComputedStyle(node);
  const px = parseFloat(cs.letterSpacing);
  return Number.isFinite(px) && parseFloat(cs.fontSize) ? Math.round(px / parseFloat(cs.fontSize) * 100) : 0;
}
function spacingRange() {
  const { state } = app.editor;
  const { from, to, empty, $from } = state.selection;
  if (!empty) return { from, to, whole: false };
  return { from: $from.start(), to: $from.end(), whole: true };
}
export function setSpacing(v) {
  const ed = app.editor;
  const r = spacingRange();
  if (r.from === r.to) { toast('자간을 바꿀 글자가 없어요.'); return; }
  const val = v === '' || v == null ? null : isPt(v) ? v : clampLs(+v);
  const sel = ed.state.selection;
  ed.chain().focus().setTextSelection({ from: r.from, to: r.to }).setMark('textStyle', { letterSpacing: val }).removeEmptyTextStyle()
    .setTextSelection({ from: sel.from, to: sel.to }).run();
  showSpacingInBox();
}
export function stepSpacing(d) {
  const r = spacingRange();
  const ed = app.editor;
  // 문단 전체일 때는 문단 첫 글자의 자간을 기준으로
  const base = r.whole ? (ed.state.doc.nodeAt(r.from)?.marks.find((m) => m.type.name === 'textStyle')?.attrs.letterSpacing ?? currentSpacing()) : currentSpacing();
  // pt로 정해 둔 글자는 0.1pt씩, 나머지는 1%씩
  const n = isPt(base) ? fmtLsPt(parseFloat(base) + d / 10) : clampLs(base + d);
  setSpacing(n);
  toast(`${r.whole ? '이 문단' : '고른 글자'} 자간 ${isPt(n) ? n : n + '%'}`, 1200);
}
export function showSpacingInBox() {
  const box = $('#letterSpacing');
  if (!box || document.activeElement === box) return;
  const v = app.editor.getAttributes('textStyle').letterSpacing;
  box.value = v == null ? '' : String(v);
  const c = currentSpacing();
  box.placeholder = String(isPt(c) ? c : c);
  box.title = '자간: 숫자만 넣으면 % (한글 방식), 0.5pt처럼 넣으면 pt (Word 방식)';
}

// ---------- 글꼴 창 ----------
export async function showFontDialog() {
  const ed = app.editor;
  const ts = ed.getAttributes('textStyle');
  const size = currentSize();
  const has = (m) => ed.isActive(m);
  const curColor = hexOf(ts.color) || null; // 색 고르개는 #rrggbb만 받는다
  const lsPt = isPt(ts.letterSpacing);
  const lsVal = ts.letterSpacing == null ? '' : lsPt ? parseFloat(ts.letterSpacing) : ts.letterSpacing;
  const fontOpts = [['', '기본 (쪽 설정·환경 설정 글꼴)'], ...FONTS.map((f) => [f[0], f[1]])];
  const cur = ts.fontFamily || '';
  if (cur && !fontOpts.some((f) => f[0] === cur)) fontOpts.push([cur, cur.replace(/['"]/g, '')]);
  const r = await dialog({
    title: '글꼴',
    body: `<div class="fmt-grid">
      <label class="field"><span>글꼴</span><select name="font">${fontOpts.map(([v, l]) => `<option value="${h(v)}" ${v === cur ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>
      <label class="field"><span>크기 (pt)</span><input name="size" type="number" step="0.5" min="1" max="400" value="${fmtPt(size)}"></label>
      <label class="field"><span>자간</span><span class="ls-pair"><input name="ls" type="number" step="${lsPt ? 0.1 : 1}" value="${lsVal}" placeholder="기본"><select name="lsUnit" aria-label="자간 단위"><option value="pct" ${lsPt ? '' : 'selected'}>% (한글)</option><option value="pt" ${lsPt ? 'selected' : ''}>pt (Word)</option></select></span></label>
      <div class="field fmt-color-field"><span>글자 색</span>${colorChoices(curColor)}</div>
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
        prev.style.letterSpacing = f.ls.value === '' ? '' : f.lsUnit.value === 'pt' ? `${+f.ls.value}pt` : `${+f.ls.value / 100}em`;
        f.ls.step = f.lsUnit.value === 'pt' ? 0.1 : 1;
        prev.style.color = f.color.value || '';
        prev.style.fontWeight = f.b.checked ? '700' : '';
        prev.style.fontStyle = f.i.checked ? 'italic' : '';
        prev.style.textDecoration = [f.u.checked && 'underline', f.s.checked && 'line-through'].filter(Boolean).join(' ');
      };
      f.addEventListener('input', upd);
      f.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tc]');
        if (!b) return;
        f.color.value = b.dataset.tc;
        f.querySelectorAll('[data-tc]').forEach((x) => x.classList.toggle('on', x === b));
        upd();
      });
      f.colorPick.addEventListener('input', () => { f.color.value = f.colorPick.value; f.querySelectorAll('[data-tc]').forEach((x) => x.classList.remove('on')); upd(); });
      f.colorPick.addEventListener('change', () => rememberColor(f.colorPick.value));
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
  const ls = f.ls.value === '' ? null : parseSpacing(f.ls.value + (f.lsUnit.value === 'pt' ? 'pt' : ''));
  if (ls !== (ts.letterSpacing ?? null)) attrs.letterSpacing = ls;
  const color = f.color.value || null;
  if (color !== curColor) attrs.color = color;
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
  const lineKind = a.lineType && a.linePt != null ? a.lineType : a.line != null ? 'pct' : 'default';
  const size = layoutOf().size || 10;
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
          <label class="field"><span>줄 간격</span><select name="lineKind">
            <option value="default" ${lineKind === 'default' ? 'selected' : ''}>기본 (${base.line}%)</option>
            <option value="pct" ${lineKind === 'pct' ? 'selected' : ''}>비율 (%, 글자에 따라)</option>
            <option value="fixed" ${lineKind === 'fixed' ? 'selected' : ''}>고정 값 (pt)</option>
            <option value="min" ${lineKind === 'min' ? 'selected' : ''}>최소 (pt)</option>
          </select></label>
          <label class="field"><span>값 <small data-line-unit>${lineKind === 'fixed' || lineKind === 'min' ? 'pt' : '%'}</small></span><input name="lineVal" type="number" step="${lineKind === 'fixed' || lineKind === 'min' ? 0.5 : 5}" value="${lineKind === 'fixed' || lineKind === 'min' ? a.linePt : a.line ?? base.line}"></label>
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
        // 줄 간격 종류를 바꾸면 값 칸의 단위와 값을 먼저 바꾼다 (입력한 값을 이어받아 %↔pt 환산)
        const k = f.lineKind.value, pt = k === 'fixed' || k === 'min';
        const was = f.lineVal.dataset.kind;
        if (was !== k) {
          const wasPt = was === 'fixed' || was === 'min';
          const v = +f.lineVal.value;
          if (was && pt && !wasPt) f.lineVal.value = Math.round(size * (was === 'pct' && v ? v : base.line) / 100 * 2) / 2;
          else if (was && !pt && wasPt) f.lineVal.value = Math.round(((v || size * base.line / 100) / size) * 100 / 5) * 5;
          else if (was === 'default' && pt) f.lineVal.value = Math.round(size * base.line / 100 * 2) / 2;
          else if (was === 'default') f.lineVal.value = base.line;
          f.lineVal.dataset.kind = k;
        }
        f.querySelector('[data-line-unit]').textContent = pt ? 'pt' : '%';
        f.lineVal.step = pt ? 0.5 : 5;
        f.lineVal.disabled = k === 'default';
        const x = read(f);
        p.style.textAlign = f.align.value || '';
        p.style.marginLeft = x.indL != null ? `${x.indL}em` : '';
        p.style.marginRight = x.indR != null ? `${x.indR}em` : '';
        const first = x.first ?? base.first;
        p.style.textIndent = `${first}em`;
        p.style.paddingLeft = first < 0 ? `${-first}em` : '';
        p.style.lineHeight = x.lineType ? String(Math.max(x.linePt / size, x.lineType === 'min' ? 1.2 : 0.5)) : String((x.line ?? base.line) / 100); // 미리보기: 원고 글자 크기에 대한 비율로
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

function lineOf(f) {
  const k = f.lineKind.value, v = +f.lineVal.value;
  if (k === 'pct' && v) return { line: Math.max(50, Math.min(500, Math.round(v))), lineType: null, linePt: null };
  if ((k === 'fixed' || k === 'min') && v) return { line: null, lineType: k, linePt: Math.max(1, Math.min(400, Math.round(v * 2) / 2)) };
  return { line: null, lineType: null, linePt: null };
}
function read(f) {
  const n = (el, lo, hi) => (el.value === '' ? null : Math.max(lo, Math.min(hi, +el.value)));
  const fv = Math.abs(+f.firstVal.value || 0);
  return {
    indL: n(f.indL, 0, 40), indR: n(f.indR, 0, 40),
    first: { default: null, none: 0, indent: fv, hang: -fv }[f.firstKind.value],
    ...lineOf(f), before: n(f.before, 0, 200), after: n(f.after, 0, 200),
    brk: f.brk.value || null,
  };
}

// ---------- 글자 색 ----------
const HEX6 = /^#[0-9a-f]{6}$/i;
const recentColors = () => (app.settings.tcRecent || []).filter((c) => HEX6.test(c) && !TEXT_COLORS.some(([x]) => x === c));
function rememberColor(c) {
  c = c.toLowerCase();
  if (TEXT_COLORS.some(([x]) => x === c)) return;
  app.settings.tcRecent = [c, ...(app.settings.tcRecent || []).filter((x) => x !== c)].slice(0, 7);
  saveSettings();
}
// 글꼴 창의 색 고르기: 기본 색 + 대표 색 견본 + 최근에 직접 고른 색 + 직접 고르기(RGB)
function colorChoices(cur) {
  const c = (cur || '').toLowerCase();
  const sw = (v, n) => `<button type="button" class="tc-sw ${v === c ? 'on' : ''}" data-tc="${v}" style="--sw:${v || 'transparent'}" title="${n}" aria-label="${n}">${v ? '' : '가'}</button>`;
  return `<input type="hidden" name="color" value="${h(c)}"><span class="tc-grid">${sw('', '기본 색')}${TEXT_COLORS.map(([v, n]) => sw(v, n)).join('')}${recentColors().map((v) => sw(v, v)).join('')}</span>
    <label class="tc-custom"><span>다른 색 직접 고르기 (RGB)</span><input type="color" name="colorPick" value="${HEX6.test(c) ? c : '#2e86c1'}"></label>`;
}
let popSel = null;
const keepSel = () => { const s = app.editor.state.selection; popSel = s.empty ? null : { from: s.from, to: s.to, doc: app.editor.state.doc }; };
const restoreSel = () => {
  const s = app.editor.state.selection;
  if (s.empty && popSel && popSel.doc === app.editor.state.doc) app.editor.commands.setTextSelection({ from: popSel.from, to: popSel.to });
  popSel = null;
};
export function bindTextColor() {
  const btn = $('#tcBtn'), more = $('#tcMore'), pop = $('#tcPop');
  if (!pop) return;
  let last = HEX6.test(app.settings.tcColor || '') ? app.settings.tcColor : TEXT_COLORS[0][0];
  const show = () => btn.style.setProperty('--tc-pick', last);
  show();
  const apply = (c) => {
    restoreSel();
    if (!c) { app.editor.chain().focus().unsetColor().run(); return; }
    last = c.toLowerCase(); app.settings.tcColor = last; saveSettings(); show();
    if (app.editor.state.selection.empty) toast('글자 색을 바꿨어요. 지금부터 쓰는 글자에 들어가요.', 2000);
    app.editor.chain().focus().setColor(last).run();
  };
  const draw = () => {
    const cur = (hexOf(app.editor.getAttributes('textStyle').color) || '').toLowerCase();
    const sw = (v, n) => `<button type="button" class="tc-sw ${v === cur ? 'on' : ''}" data-tc="${v}" style="--sw:${v || 'transparent'}" title="${n}" aria-label="${n}">${v ? '' : '가'}</button>`;
    pop.innerHTML = `<div class="tc-grid">${sw('', '기본 색')}${TEXT_COLORS.map(([v, n]) => sw(v, n)).join('')}</div>
      ${recentColors().length ? `<p class="hl-tip">직접 고른 색</p><div class="tc-grid">${recentColors().map((v) => sw(v, v)).join('')}</div>` : ''}
      <label class="hl-custom"><span>다른 색 직접 고르기 (RGB)</span><input type="color" value="${HEX6.test(cur) ? cur : last}" aria-label="글자 색 직접 고르기"></label>`;
  };
  const open = () => {
    keepSel();
    draw();
    const r = more.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left - 160, innerWidth - 250)) + 'px';
    pop.style.top = r.bottom + 4 + 'px';
    pop.classList.add('open');
  };
  btn.addEventListener('click', () => apply(last));
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); open(); });
  more.addEventListener('click', (e) => { e.stopPropagation(); if (pop.classList.contains('open')) pop.classList.remove('open'); else open(); });
  pop.addEventListener('mousedown', (e) => { if (e.target.type !== 'color') e.preventDefault(); });
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tc]');
    if (!b) return;
    e.stopPropagation();
    pop.classList.remove('open');
    apply(b.dataset.tc);
  });
  pop.addEventListener('change', (e) => { if (e.target.type === 'color') { pop.classList.remove('open'); rememberColor(e.target.value); apply(e.target.value); } });
  addEventListener('mousedown', (e) => { if (!pop.contains(e.target) && e.target !== more) pop.classList.remove('open'); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.classList.remove('open'); });
}

// ---------- 형광펜 색 ----------
export function bindHighlight() {
  const pop = $('#hlPop'), more = $('#hlMore');
  if (!pop) return;
  const HEX = /^#[0-9a-f]{6}$/i;
  const pick = (c) => { setHlColor(c); $('#hlBtn').style.setProperty('--hl-pick', c); };
  pick(HEX.test(app.settings.hlColor || '') ? app.settings.hlColor : HL_COLORS[0][0]);
  const draw = () => {
    const cur = (app.editor.getAttributes('highlight').color || '').toLowerCase();
    const recent = (app.settings.hlRecent || []).filter((c) => HEX.test(c) && !HL_COLORS.some(([x]) => x === c));
    const sw = (c, n) => `<button type="button" data-hl="${c}" class="${c === cur ? 'on' : ''}" style="background:${c}" title="${n}" aria-label="${n}">${n}</button>`;
    pop.innerHTML = `<p class="hl-tip">글을 고른 채로 색을 누르면 바로 칠해요. 고른 색은 형광펜 단추에도 기억돼요.</p>
      <div class="sw-row">${HL_COLORS.map(([c, n]) => sw(c, n)).join('')}${recent.map((c) => sw(c, '')).join('')}</div>
      <label class="hl-custom"><span>직접 고르기</span><input type="color" value="${HEX.test(cur) ? cur : hlColor()}" aria-label="형광펜 색 직접 고르기"></label>
      <button type="button" data-hl="">형광펜 지우기</button>`;
  };
  const open = () => {
    keepSel();
    draw();
    const r = more.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left - 160, innerWidth - 230)) + 'px';
    pop.style.top = r.bottom + 4 + 'px';
    pop.classList.add('open');
  };
  // 색을 고르면: 단추에 기억하고, 고른 글이 있으면 바로 칠한다
  const apply = (c) => {
    restoreSel();
    c = c.toLowerCase();
    pick(c);
    app.settings.hlColor = c;
    if (!HL_COLORS.some(([x]) => x === c)) app.settings.hlRecent = [c, ...(app.settings.hlRecent || []).filter((x) => x !== c)].slice(0, 4);
    saveSettings();
    if (app.editor.state.selection.empty) { toast('형광펜 색을 바꿨어요. 글을 고르고 형광펜 단추를 누르세요.', 2400); return; }
    app.editor.chain().focus().setHighlight({ color: c }).run();
  };
  more.addEventListener('click', (e) => { e.stopPropagation(); if (pop.classList.contains('open')) pop.classList.remove('open'); else open(); });
  // 형광펜 단추를 마우스 오른쪽으로 눌러도 색 고르기가 열린다
  $('#hlBtn').addEventListener('contextmenu', (e) => { e.preventDefault(); open(); });
  pop.addEventListener('mousedown', (e) => { if (e.target.type !== 'color') e.preventDefault(); }); // 편집기의 선택을 지킨다
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-hl]');
    if (!b) return;
    e.stopPropagation();
    pop.classList.remove('open');
    if (!b.dataset.hl) { restoreSel(); runCommand(app.editor, 'unhighlight'); return; }
    apply(b.dataset.hl);
  });
  pop.addEventListener('change', (e) => { if (e.target.type === 'color') { pop.classList.remove('open'); apply(e.target.value); } });
  addEventListener('mousedown', (e) => { if (!pop.contains(e.target) && e.target !== more) pop.classList.remove('open'); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.classList.remove('open'); });
}
export const applyHighlight = (c) => { app.editor.chain().focus().setHighlight({ color: c }).run(); };

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
    const annoHere = ed().state.selection.$from.marks().find((m) => m.type.name === 'anno')?.attrs.id || '';
    menu.dataset.anno = annoHere;
    const word = sel ? (sel.length <= 20 && sel.split(/\s+/).length <= 3 ? sel : '') : wordAt();
    menu.innerHTML = `
      <button data-c="cut" ${sel ? '' : 'disabled'}><span>잘라내기</span><small>Ctrl+X</small></button>
      <button data-c="copy" ${sel ? '' : 'disabled'}><span>복사</span><small>Ctrl+C</small></button>
      <button data-c="paste"><span>붙여넣기</span><small>Ctrl+V</small></button>
      <hr>
      <button data-c="font"><span>글꼴…</span><small>${kb('fontDlg')}</small></button>
      <button data-c="para"><span>단락…</span><small>${kb('paraDlg')}</small></button>
      ${sel ? `<div class="ctx-sub"><span class="ctx-sub-l">주석</span><button data-c="a-index">색인</button><button data-c="a-fix">교정 제안</button><button data-c="a-cite">인용</button><button data-c="a-intent">의도</button></div><hr>` : ''}
      ${sel ? `<div class="ctx-sub"><span class="ctx-sub-l">형광펜</span>${HL_COLORS.map(([c, n]) => `<button data-c="hl" data-color="${c}" class="ctx-sw" style="background:${c}" title="${n}" aria-label="형광펜 ${n}"></button>`).join('')}<button data-c="hl" data-color="" title="형광펜 지우기">지우기</button></div><hr>` : ''}
      ${annoHere ? `<button data-c="a-open"><span>이 주석 보기·고치기</span></button><hr>` : ''}
      <button data-c="lsNarrow"><span>자간 좁게 (${sel ? '고른 글자' : '이 문단'})</span><small>${kb('lsNarrow')}</small></button>
      <button data-c="lsWide"><span>자간 넓게 (${sel ? '고른 글자' : '이 문단'})</span><small>${kb('lsWide')}</small></button>
      <button data-c="clear"><span>서식 지우기</span></button>
      <hr>
      ${word ? `<button data-c="dict"><span>‘${h(word.slice(0, 12))}${word.length > 12 ? '…' : ''}’ 사전에서 찾기</span><small>표준국어대사전</small></button>` : ''}
      ${sel ? `<button data-c="find"><span>원고 전체에서 찾기</span></button>` : ''}
      <button data-c="readHere"><span>${sel ? '고른 부분' : '여기부터'} AI로 읽어 주기</span><small>${kb('readAloud')}</small></button>
      <button data-c="speak"><span>${sel ? '고른 부분' : '이 문단'} 기기 목소리로 읽기</span></button>
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
    else if (c === 'hl') { if (b.dataset.color) runCommand(ed(), 'highlight', b.dataset.color); else runCommand(ed(), 'unhighlight'); }
    else if (c.startsWith('a-') && c !== 'a-open') { const { addAnnotation } = await import('./annotate.js'); addAnnotation(c.slice(2)); }
    else if (c === 'a-open') { const { editAnno } = await import('./annotate.js'); editAnno(menu.dataset.anno); }
    else if (c === 'lsNarrow' || c === 'lsWide') stepSpacing(c === 'lsWide' ? 1 : -1);
    else if (c === 'scene') runCommand(ed(), 'scene');
    else if (c === 'dict') window.open(`https://stdict.korean.go.kr/search/searchResult.do?searchKeyword=${encodeURIComponent(menu.dataset.word)}`, '_blank', 'noopener');
    else if (c === 'find') { const { openFind } = await import('./features.js'); $('#findInput').value = sel.trim(); openFind(); }
    else if (c === 'speak') speak(sel || paragraphText());
    else if (c === 'readHere') { const R = await import('./reader.js'); if (sel) { R.stop(); R.readAloud(); } else R.readFromHere(); }
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
  // 기기 안에서 읽는 목소리를 먼저 쓴다 (온라인 목소리는 원고 글을 바깥 서버로 보낼 수 있다)
  const kos = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith('ko'));
  const ko = kos.find((v) => v.localService) || kos[0];
  if (ko) u.voice = ko;
  speechSynthesis.speak(u);
  toast('읽는 중… (Esc로 멈춤)', Math.min(15000, text.length * 120));
}
addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.speechSynthesis?.speaking) speechSynthesis.cancel(); });
