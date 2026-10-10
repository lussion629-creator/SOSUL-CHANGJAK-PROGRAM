// 편집기 (TipTap/ProseMirror)
import { Editor, Extension, Mark } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style';
import { Placeholder, Focus } from '@tiptap/extensions';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { PageBreaks } from './pageview.js';

// ---------- 본문 주석 (색인·교정 제안·인용·의도) ----------
// 글자에 주석 아이디만 달아 두고, 내용은 '자료'(notes)에 저장한다
export const ANNO_KINDS = ['index', 'fix', 'cite', 'intent'];
const Anno = Mark.create({
  name: 'anno',
  inclusive: false,
  excludes: '', // 주석끼리 겹칠 수 있게
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-anno'), renderHTML: (a) => ({ 'data-anno': a.id }) },
      kind: {
        default: 'intent',
        parseHTML: (el) => (ANNO_KINDS.includes(el.getAttribute('data-kind')) ? el.getAttribute('data-kind') : 'intent'),
        renderHTML: (a) => ({ 'data-kind': a.kind, class: `anno k-${a.kind}` }),
      },
    };
  },
  parseHTML() { return [{ tag: 'span[data-anno]', priority: 60, getAttrs: (el) => (/^[\w-]{1,64}$/.test(el.getAttribute('data-anno') || '') ? null : false) }]; },
  renderHTML({ HTMLAttributes }) { return ['span', HTMLAttributes, 0]; },
  addProseMirrorPlugins() {
    // 붙여 넣은 글에는 주석을 따라 붙이지 않는다 (같은 주석이 두 군데 생기지 않게)
    const strip = (frag, type) => {
      const out = [];
      frag.forEach((n) => {
        if (n.isText) out.push(type.isInSet(n.marks) ? n.mark(n.marks.filter((m) => m.type !== type)) : n);
        else out.push(n.copy(strip(n.content, type)));
      });
      return Fragment.fromArray(out);
    };
    return [new Plugin({ props: { transformPasted: (slice, view) => new Slice(strip(slice.content, view.state.schema.marks.anno), slice.openStart, slice.openEnd) } })];
  },
});

// ---------- 찾기 강조 ----------
const searchKey = new PluginKey('search');
const Search = Extension.create({
  name: 'search',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: searchKey,
      state: {
        init: () => ({ query: '', cls: 'search-hit', current: -1, deco: DecorationSet.empty }),
        apply(tr, prev) {
          const meta = tr.getMeta(searchKey);
          const next = meta ? { ...prev, ...meta } : prev;
          if (!meta && !tr.docChanged) return prev;
          const matches = findMatches(tr.doc, next.query);
          const deco = DecorationSet.create(tr.doc, matches.map((m, i) =>
            Decoration.inline(m.from, m.to, { class: next.cls + (i === next.current ? ' cur' : '') })));
          return { ...next, deco, matches };
        },
      },
      props: { decorations(state) { return searchKey.getState(state).deco; } },
    })];
  },
});

export function findMatches(doc, query) {
  const out = [];
  if (!query) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, null, '￼');
    let i = text.indexOf(query);
    while (i !== -1) {
      out.push({ from: pos + 1 + i, to: pos + 1 + i + query.length });
      i = text.indexOf(query, i + query.length);
    }
    return false;
  });
  return out;
}

export function setSearch(editor, query, { cls = 'search-hit', current = -1 } = {}) {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query, cls, current }));
  return searchKey.getState(editor.state).matches || [];
}

export function gotoMatch(editor, m) {
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, m.from, m.to)));
  scrollToPos(editor, m.from);
}

export function scrollToPos(editor, pos) {
  try {
    const coords = editor.view.coordsAtPos(pos);
    const sc = editor.view.dom.closest('.paper-scroll, .pane-body');
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    sc.scrollTo({ top: sc.scrollTop + coords.top - r.top - r.height / 3, behavior: 'smooth' });
  } catch { /* 위치 계산 실패는 무시 */ }
}

// ---------- 퇴고 표시: 편집 중에도 더해진 곳(초록)·빠진 곳(빨강)을 보여 준다 ----------
const diffKey = new PluginKey('diffMarks');
const DiffMarks = Extension.create({
  name: 'diffMarks',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: diffKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const meta = tr.getMeta(diffKey);
          if (meta) return DecorationSet.create(tr.doc, meta);
          return set.map(tr.mapping, tr.doc);
        },
      },
      props: { decorations(state) { return diffKey.getState(state); } },
    })];
  },
});

/** specs: [{type:'ins', from, to}, {type:'del', pos, text, block}] */
export function setDiffMarks(editor, specs = []) {
  const max = editor.state.doc.content.size;
  const decos = [];
  for (const s of specs) {
    if (s.type === 'ins') {
      if (s.from < s.to && s.to <= max) decos.push(Decoration.inline(s.from, s.to, { class: 'ins-mark' }));
    } else if (s.pos <= max) {
      decos.push(Decoration.widget(s.pos, () => {
        const el = document.createElement(s.block ? 'div' : 'span');
        el.className = s.block ? 'del-mark block' : 'del-mark';
        el.contentEditable = 'false';
        el.textContent = s.text;
        el.title = '지운 부분';
        return el;
      }, { side: -1, ignoreSelection: true, key: 'd' + s.pos + s.text.slice(0, 10) }));
    }
  }
  editor.view.dispatch(editor.state.tr.setMeta(diffKey, decos).setMeta('addToHistory', false));
}

// 편집기 문서의 문단 목록 (비교용). 글자 위치가 문서 위치와 맞도록 줄바꿈 등은 \ufffc 한 글자로 둔다.
export function docParagraphs(doc) {
  const out = [];
  doc.descendants((n, pos) => {
    if (n.isTextblock) { out.push({ text: n.textBetween(0, n.content.size, null, '\ufffc'), pos }); return false; }
    return true;
  });
  return out;
}

// ---------- 둥근 따옴표 자동 변환 ----------
const SmartQuotes = Extension.create({
  name: 'smartQuotes',
  addOptions() { return { enabled: () => false }; },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          if (!opts.enabled() || (text !== '"' && text !== "'")) return false;
          const before = view.state.doc.textBetween(Math.max(0, from - 1), from, null, ' ');
          const open = !before || /[\s(\[{“‘「『—–-]/.test(before);
          const ch = text === '"' ? (open ? '“' : '”') : (open ? '‘' : '’');
          view.dispatch(view.state.tr.insertText(ch, from, to));
          return true;
        },
      },
    })];
  },
});

// ---------- 단락 모양 (Word의 '단락' 창): 여백·첫 줄·줄 간격·문단 위아래·줄 나눔 ----------
// 값이 null이면 기본(쪽 설정·환경 설정) 그대로. 단위: 여백·첫 줄은 글자(em), 위아래는 pt, 줄 간격은 %
const num = (name) => ({
  default: null,
  parseHTML: (el) => { const v = el.getAttribute(`data-${name}`); return v === null || v === '' ? null : +v; },
  renderHTML: () => ({}),
});
// 줄 간격 종류(Word·한글처럼): line = 비율(%) / lineType = 'fixed'(고정 값) 또는 'min'(최소), linePt = pt
export const PARA_KEYS = ['indL', 'indR', 'first', 'line', 'lineType', 'linePt', 'before', 'after', 'brk'];
const ParaFormat = Extension.create({
  name: 'paraFormat',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        indL: num('ind-l'), indR: num('ind-r'), first: num('first'), line: num('line'), before: num('before'), after: num('after'),
        brk: { default: null, parseHTML: (el) => el.getAttribute('data-brk') || null, renderHTML: () => ({}) },
        lineType: { default: null, parseHTML: (el) => (/^(fixed|min)$/.test(el.getAttribute('data-lt') || '') ? el.getAttribute('data-lt') : null), renderHTML: () => ({}) },
        linePt: num('lpt'),
        // 여러 값을 한 번에 style로 (TipTap이 style을 이어 붙인다)
        pfStyle: {
          default: null,
          parseHTML: () => null,
          renderHTML: (a) => paraAttrs(a),
        },
      },
    }];
  },
});
export function paraAttrs(a) {
  const st = [], data = {};
  const set = (k, d, css) => { if (a[k] != null) { data[`data-${d}`] = a[k]; if (css) st.push(css); } };
  set('indL', 'ind-l', `margin-left:${a.indL}em`);
  set('indR', 'ind-r', `margin-right:${a.indR}em`);
  if (a.first != null) { data['data-first'] = a.first; st.push(`text-indent:${a.first}em`); if (a.first < 0) st.push(`padding-left:${-a.first}em`); }
  if (a.lineType && a.linePt != null) {
    // 고정 값: 줄 높이를 pt로 못 박는다. 최소: 글자가 크면 그만큼 늘어난다
    data['data-lt'] = a.lineType; data['data-lpt'] = a.linePt;
    const h = `calc(${a.linePt}pt * var(--pv-z, 1))`;
    st.push(`line-height:${a.lineType === 'min' ? `max(1.2em, ${h})` : h}`);
  } else set('line', 'line', `line-height:${a.line / 100}`);
  set('before', 'before', `margin-top:${a.before}pt`);
  set('after', 'after', `margin-bottom:${a.after}pt`);
  if (a.brk) { data['data-brk'] = a.brk; st.push(`word-break:${a.brk === 'char' ? 'break-all' : 'keep-all'}`); }
  if (!st.length) return {};
  return { ...data, style: st.join(';') };
}

// 글자 크기: 값은 '10.5pt'처럼 저장하고, 쪽 보기 배율(--pv-z)에 맞춰 그린다
const FontSizeZ = FontSize.extend({
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-fs') || el.style.fontSize || null,
          renderHTML: (a) => {
            if (!a.fontSize || !/^\d+(\.\d+)?(pt|px|em|rem|%)$/.test(a.fontSize)) return {};
            return { 'data-fs': a.fontSize, style: `font-size:calc(${a.fontSize} * var(--pv-z, 1))` };
          },
        },
      },
    }];
  },
});

// 글자 색: 어두운 화면에서도 읽히게
// - 검정에 가까운 색(다른 프로그램에서 붙여 넣은 '기본 검정')은 색이 없는 것으로 본다 → 화면 테마 글자색을 따른다
// - 그 밖의 어두운 색은 data-tc="dark"를 달아, 어두운 화면에서 밝게 섞어 보여 준다 (저장·내보내기는 원래 색 그대로)
// 아무 색 표기(#rgb, rgb(), 이름)든 #rrggbb로 (캔버스가 바꿔 준다). 알 수 없으면 null
export function hexOf(c) {
  if (!c || typeof c !== 'string') return null;
  const ctx = hexOf.ctx || (hexOf.ctx = document.createElement('canvas').getContext('2d'));
  ctx.fillStyle = '#010203';
  ctx.fillStyle = c.trim();
  const v = ctx.fillStyle;
  if (v === '#010203' && !/^#?010203$/i.test(c.trim())) return null; // 잘못된 색
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null; // 반투명 등은 버린다
}
function rgbOf(c) {
  const x = hexOf(c);
  return x ? [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)) : null;
}
const lumOf = (rgb) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
const ThemeColor = Color.extend({
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        color: {
          default: null,
          parseHTML: (el) => {
            const v = (el.style.getPropertyValue('--c') || el.style.color || '').trim();
            const hex = hexOf(v);
            if (!hex) return null;
            const rgb = rgbOf(hex);
            if (Math.max(...rgb) < 40) return null; // 검정·거의 검정 → 기본 글자색 (다크 모드에서 밝게 보이도록)
            return hex;
          },
          renderHTML: (a) => {
            const hex = hexOf(a.color);
            if (!hex) return {};
            return lumOf(rgbOf(hex)) < 0.3 ? { 'data-tc': 'dark', style: `color: ${hex}; --c: ${hex}` } : { style: `color: ${hex}` };
          },
        },
      },
    }];
  },
});

// 자간 (글자 사이 간격, % 또는 pt)
const PT_RE = /^-?\d+(\.\d+)?pt$/;
const LetterSpacing = Extension.create({
  name: 'letterSpacing',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        letterSpacing: {
          default: null,
          // 숫자면 한글 방식(글자 크기의 %), '0.5pt'처럼 글자면 Word 방식(pt)
          parseHTML: (el) => {
            const d = el.getAttribute('data-ls');
            if (d && PT_RE.test(d)) return d;
            const v = el.style.letterSpacing; if (!v) return null; const n = parseFloat(v); return v.endsWith('em') ? Math.round(n * 100) : null;
          },
          renderHTML: (a) => {
            const v = a.letterSpacing;
            if (v == null) return {};
            if (typeof v === 'string') return PT_RE.test(v) ? { 'data-ls': v, style: `letter-spacing:calc(${v} * var(--pv-z, 1))` } : {};
            return Number.isFinite(+v) ? { style: `letter-spacing:${+v / 100}em` } : {};
          },
        },
      },
    }];
  },
});

// ---------- 타자기 스크롤: 커서 줄을 화면 가운데에 둔다 ----------
const Typewriter = Extension.create({
  name: 'typewriter',
  addOptions() { return { enabled: () => false }; },
  onSelectionUpdate() {
    if (!this.options.enabled()) return;
    const ed = this.editor;
    requestAnimationFrame(() => {
      try {
        const c = ed.view.coordsAtPos(ed.state.selection.head);
        const sc = ed.view.dom.closest('.paper-scroll');
        if (!sc) return;
        const r = sc.getBoundingClientRect();
        const target = r.top + r.height * 0.45;
        if (Math.abs(c.top - target) > 24) sc.scrollBy({ top: c.top - target, behavior: 'smooth' });
      } catch { /* 무시 */ }
    });
  },
});

export function createEditor(el, { onUpdate, onSelection, smartQuotes, typewriter }) {
  return new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false, code: false, link: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: true }),
      Anno, TextStyle, ThemeColor, FontFamily, FontSizeZ, LetterSpacing, ParaFormat,
      Placeholder.configure({ placeholder: '여기에 이야기를 시작하세요…' }),
      Focus.configure({ className: 'has-focus', mode: 'shallowest' }),
      Search,
      DiffMarks,
      PageBreaks,
      SmartQuotes.configure({ enabled: smartQuotes }),
      Typewriter.configure({ enabled: typewriter }),
    ],
    editorProps: { attributes: { spellcheck: 'true', lang: 'ko' } },
    onUpdate: ({ editor }) => onUpdate?.(editor),
    onSelectionUpdate: ({ editor }) => onSelection?.(editor),
    onTransaction: ({ editor }) => onSelection?.(editor),
  });
}

// 툴바 명령
// 형광펜 색 (환경 설정에 기억)
export const HL_COLORS = [['#fff2a8', '노랑'], ['#d6f5b8', '연두'], ['#cfe8ff', '하늘'], ['#ffd8e8', '분홍'], ['#ffdcb5', '주황'], ['#e6dcff', '보라'], ['#e2e2e2', '회색']];
let hlPick = '#fff2a8';
export const hlColor = () => hlPick;
export const setHlColor = (c) => { hlPick = c; };
export function runCommand(editor, cmd, arg) {
  const c = editor.chain().focus();
  switch (cmd) {
    case 'undo': return c.undo().run();
    case 'redo': return c.redo().run();
    case 'bold': return c.toggleBold().run();
    case 'italic': return c.toggleItalic().run();
    case 'underline': return c.toggleUnderline().run();
    case 'strike': return c.toggleStrike().run();
    case 'highlight': {
      const color = arg || hlColor();
      // 같은 색이 칠해져 있으면 지우고, 다른 색이면 그 색으로 바꾼다
      if (editor.isActive('highlight', { color })) return c.unsetHighlight().run();
      return c.setHighlight({ color }).run();
    }
    case 'unhighlight': return c.unsetHighlight().run();
    case 'left': case 'center': case 'right': case 'justify': return c.setTextAlign(cmd).run();
    case 'bullet': return c.toggleBulletList().run();
    case 'ordered': return c.toggleOrderedList().run();
    case 'scene': return c.setHorizontalRule().run();
    case 'clear': { // 서식만 지우고 본문 주석은 남긴다
      let ch = c;
      for (const name of Object.keys(editor.schema.marks)) if (name !== 'anno') ch = ch.unsetMark(name);
      return ch.unsetTextAlign().setParagraph().run();
    }
    case 'color': return c.setColor(arg).run();
    case 'font': return arg ? c.setFontFamily(arg).run() : c.unsetFontFamily().run();
    case 'size': return arg ? c.setFontSize(arg).run() : c.unsetFontSize().run();
    case 'block':
      if (arg === 'p') return c.setParagraph().run();
      if (arg === 'quote') return c.toggleBlockquote().run();
      return c.setHeading({ level: +arg[1] }).run();
  }
}

export function activeState(editor) {
  const a = (n, o) => editor.isActive(n, o);
  return {
    bold: a('bold'), italic: a('italic'), underline: a('underline'), strike: a('strike'), highlight: a('highlight'), hlColor: editor.getAttributes('highlight').color || '',
    left: a({ textAlign: 'left' }), center: a({ textAlign: 'center' }), right: a({ textAlign: 'right' }), justify: a({ textAlign: 'justify' }),
    bullet: a('bulletList'), ordered: a('orderedList'),
    block: a('heading', { level: 1 }) ? 'h1' : a('heading', { level: 2 }) ? 'h2' : a('heading', { level: 3 }) ? 'h3' : a('blockquote') ? 'quote' : 'p',
    font: editor.getAttributes('textStyle').fontFamily || '',
    size: editor.getAttributes('textStyle').fontSize || '',
  };
}
