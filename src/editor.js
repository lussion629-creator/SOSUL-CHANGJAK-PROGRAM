// 편집기 (TipTap/ProseMirror)
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style';
import { Placeholder, Focus } from '@tiptap/extensions';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { PageBreaks } from './pageview.js';

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
export const PARA_KEYS = ['indL', 'indR', 'first', 'line', 'before', 'after', 'brk'];
const ParaFormat = Extension.create({
  name: 'paraFormat',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        indL: num('ind-l'), indR: num('ind-r'), first: num('first'), line: num('line'), before: num('before'), after: num('after'),
        brk: { default: null, parseHTML: (el) => el.getAttribute('data-brk') || null, renderHTML: () => ({}) },
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
  set('line', 'line', `line-height:${a.line / 100}`);
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

// 자간 (글자 사이 간격, %)
const LetterSpacing = Extension.create({
  name: 'letterSpacing',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        letterSpacing: {
          default: null,
          parseHTML: (el) => { const v = el.style.letterSpacing; if (!v) return null; const n = parseFloat(v); return v.endsWith('em') ? Math.round(n * 100) : null; },
          renderHTML: (a) => (a.letterSpacing == null ? {} : { style: `letter-spacing:${a.letterSpacing / 100}em` }),
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
      TextStyle, Color, FontFamily, FontSizeZ, LetterSpacing, ParaFormat,
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
export function runCommand(editor, cmd, arg) {
  const c = editor.chain().focus();
  switch (cmd) {
    case 'undo': return c.undo().run();
    case 'redo': return c.redo().run();
    case 'bold': return c.toggleBold().run();
    case 'italic': return c.toggleItalic().run();
    case 'underline': return c.toggleUnderline().run();
    case 'strike': return c.toggleStrike().run();
    case 'highlight': return c.toggleHighlight({ color: '#fff2a8' }).run();
    case 'left': case 'center': case 'right': case 'justify': return c.setTextAlign(cmd).run();
    case 'bullet': return c.toggleBulletList().run();
    case 'ordered': return c.toggleOrderedList().run();
    case 'scene': return c.setHorizontalRule().run();
    case 'clear': return c.unsetAllMarks().unsetTextAlign().setParagraph().run();
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
    bold: a('bold'), italic: a('italic'), underline: a('underline'), strike: a('strike'), highlight: a('highlight'),
    left: a({ textAlign: 'left' }), center: a({ textAlign: 'center' }), right: a({ textAlign: 'right' }), justify: a({ textAlign: 'justify' }),
    bullet: a('bulletList'), ordered: a('orderedList'),
    block: a('heading', { level: 1 }) ? 'h1' : a('heading', { level: 2 }) ? 'h2' : a('heading', { level: 3 }) ? 'h3' : a('blockquote') ? 'quote' : 'p',
    font: editor.getAttributes('textStyle').fontFamily || '',
    size: editor.getAttributes('textStyle').fontSize || '',
  };
}
