// 쪽 보기: 편집하면서 원고를 쪽 설정(용지·여백·글자)대로 한 쪽씩 나눠 보여 준다.
// 줄마다 위치를 재서, 쪽 끝에 닿는 줄 앞에 빈 칸(다음 쪽까지의 거리)을 끼워 넣는 방식이다.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { app, saveSettings } from './app.js';
import { layoutOf, bodyBox, mm2px, pt2px, textCss, numSide } from './layout.js';
import { $ } from './ui.js';

const GAP = 24; // 쪽 사이 간격 (px)
const key = new PluginKey('pageBreaks');

export const PageBreaks = Extension.create({
  name: 'pageBreaks',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const meta = tr.getMeta(key);
          if (meta) return DecorationSet.create(tr.doc, meta);
          return set.map(tr.mapping, tr.doc);
        },
      },
      props: { decorations(state) { return key.getState(state); } },
    })];
  },
});

function gapWidget(pos, h, block) {
  return Decoration.widget(pos, () => {
    const el = document.createElement(block ? 'div' : 'span');
    el.className = 'pg-gap' + (block ? ' block' : '');
    el.contentEditable = 'false';
    el.style.height = h + 'px';
    el.dataset.h = h;
    return el;
  }, { side: -1, ignoreSelection: true, key: `g${pos}-${block ? 1 : 0}-${Math.round(h * 2)}` });
}

export const isPageView = () => !!app.settings.pageView;

let geo = null; // 지금 쪽 크기 (px)
let last = '';
export function applyPageView() {
  const paper = $('#paper');
  const on = isPageView() && !!app.project;
  paper.classList.toggle('pv', on);
  document.body.classList.toggle('pageview', on);
  $('#pvZoom') && ($('#pvZoom').hidden = !on);
  if (!on) {
    geo = null; last = '';
    $('#sheets')?.remove();
    paper.style.cssText = '';
    if (key.getState(app.editor.state)?.find().length) app.editor.view.dispatch(app.editor.state.tr.setMeta(key, []).setMeta('addToHistory', false));
    return;
  }
  const L = layoutOf();
  const avail = Math.max(240, $('#paperScroll').clientWidth - 32);
  const W = mm2px(L.w);
  const z = app.settings.pvZoom === 'fit' || !app.settings.pvZoom ? Math.min(1.35, avail / W) : +app.settings.pvZoom / 100;
  const t = textCss(L, z);
  const box = bodyBox(L);
  const lh = pt2px(L.size) * z * L.line / 100;
  const half = (lh - pt2px(L.size) * z) / 2; // 줄 위아래 반쪽 여백
  geo = {
    z, W: W * z, H: mm2px(L.h) * z, top: mm2px(box.top) * z, bodyH: mm2px(box.h) * z, half, L,
  };
  geo.pitch = geo.H + GAP;
  const s = paper.style;
  s.setProperty('--pv-w', geo.W + 'px');
  s.setProperty('--pv-h', geo.H + 'px');
  s.setProperty('--pv-ml', mm2px(L.ml) * z + 'px');
  s.setProperty('--pv-mr', mm2px(L.mr) * z + 'px');
  s.setProperty('--pv-mb', mm2px(L.mb) * z + 'px');
  s.setProperty('--pv-pad', geo.top - half + 'px');
  s.setProperty('--pv-font', t.fontFamily);
  s.setProperty('--pv-size', t.fontSize);
  s.setProperty('--pv-line', t.lineHeight);
  s.setProperty('--pv-ls', t.letterSpacing);
  s.setProperty('--pv-indent', t.textIndent);
  s.setProperty('--pv-para', t.paraAfter);
  s.setProperty('--pv-align', t.textAlign);
  s.setProperty('--pv-break', t.wordBreak);
  if (!$('#sheets')) paper.insertAdjacentHTML('afterbegin', '<div id="sheets" aria-hidden="true"></div>');
  last = '';
  schedule();
}

let timer, raf;
export function schedule(delay = 250) {
  if (!geo) return;
  clearTimeout(timer);
  timer = setTimeout(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(relayout); }, delay);
}

// 문단 안의 글자 노드들
function textNodes(el) {
  const out = [];
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (tw.nextNode()) if (tw.currentNode.textContent.length) out.push(tw.currentNode);
  return out;
}

// 문단 하나의 줄들: [{top, bottom}] (화면 좌표)
function linesOf(nodes, range) {
  const rects = [];
  for (const n of nodes) {
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.height > 0) rects.push(r);
  }
  rects.sort((a, b) => a.top - b.top);
  const lines = [];
  for (const r of rects) {
    const l = lines[lines.length - 1];
    if (l && r.top < l.bottom - 1 && r.bottom > l.top + 1) { l.top = Math.min(l.top, r.top); l.bottom = Math.max(l.bottom, r.bottom); }
    else lines.push({ top: r.top, bottom: r.bottom });
  }
  return lines;
}

// 화면 위치 y에서 시작하는 줄의 첫 글자 → 문서 위치 (화면 밖에서도 되도록 글자 위치를 직접 잰다)
function lineStartPos(view, nodes, range, lineTop) {
  const lens = nodes.map((n) => n.textContent.length);
  const total = lens.reduce((a, b) => a + b, 0);
  const at = (i) => { let k = 0; while (i >= lens[k]) { i -= lens[k]; k++; } return [nodes[k], i]; };
  const topOf = (i) => {
    const [n, o] = at(i);
    range.setStart(n, o); range.setEnd(n, o + 1);
    const rs = range.getClientRects();
    return rs.length ? rs[rs.length - 1].top : -Infinity;
  };
  let lo = 0, hi = total - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (topOf(mid) >= lineTop - 1) hi = mid; else lo = mid + 1; }
  const [n, o] = at(lo);
  try { return view.posAtDOM(n, o); } catch { return null; }
}

function relayout() {
  if (!geo || !app.editor) return;
  const view = app.editor.view;
  const dom = view.dom;
  // 한글 입력(조합) 중에는 건드리지 않는다
  if (view.composing) { schedule(400); return; }
  // 끼워 둔 빈 칸을 모두 걷어 낸 상태에서 잰다 (글꼴·내용이 바뀌면 줄 시작 위치가 달라지므로)
  if (key.getState(view.state).find().length) view.dispatch(view.state.tr.setMeta(key, []).setMeta('addToHistory', false));
  const base = dom.getBoundingClientRect().top;
  const natural = (y) => y - base;
  const range = document.createRange();

  const items = []; // {pos | lazy, block, top, lh, fs}
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock && !node.isAtom) return true;
    const el = view.nodeDOM(pos);
    if (!(el instanceof HTMLElement)) return false;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const lh = parseFloat(cs.lineHeight) || fs * 1.6;
    const nodes = node.isTextblock && node.content.size ? textNodes(el) : [];
    const lines = nodes.length ? linesOf(nodes, range) : [];
    if (!lines.length) {
      const r = el.getBoundingClientRect();
      items.push({ pos, block: true, top: natural(r.top), lh: Math.max(r.height, 1), fs: Math.min(fs, r.height || fs) });
      return false;
    }
    lines.forEach((l, i) => {
      const top = natural((l.top + l.bottom) / 2 - lh / 2);
      if (i === 0) items.push({ pos, block: true, top, lh, fs });
      else items.push({ lazy: () => lineStartPos(view, nodes, range, l.top), block: false, top, lh, fs });
    });
    return false;
  });

  const { pitch, bodyH, half } = geo;
  let shift = 0, page = 0, bottom = 0;
  const specs = [];
  for (const it of items) {
    const t = it.top + shift;
    let k = Math.max(page, Math.floor((t + it.lh / 2) / pitch));
    // 글자 아래 끝이 이 쪽 본문 칸 안에 들어오는가 (한글처럼 마지막 줄은 글자 높이만 있으면 된다)
    const glyphBottom = t + (it.lh - it.fs) / 2 + it.fs;
    const firstOnPage = t <= k * pitch + 1;
    if (glyphBottom > k * pitch + half + bodyH + 0.5 && !firstOnPage) {
      // 다음 쪽 본문 첫 줄 자리: 글자 윗선이 본문 칸 위쪽에 오도록
      const target = (k + 1) * pitch + half - (it.lh - it.fs) / 2;
      const hgt = Math.max(1, Math.round((target - t) * 2) / 2);
      const pos = it.lazy ? it.lazy() : it.pos;
      if (pos != null) specs.push({ pos, block: it.block, h: hgt });
      shift += hgt;
      k += 1;
    }
    page = k;
    bottom = Math.max(bottom, it.top + shift + it.lh);
  }
  const pages = Math.max(1, Math.floor(Math.max(0, bottom - 1) / pitch) + 1);
  drawSheets(pages);

  if (!specs.length) return;
  view.dispatch(view.state.tr.setMeta(key, specs.map((s) => gapWidget(s.pos, s.h, s.block))).setMeta('addToHistory', false));
}

let drawn = '';
function drawSheets(n) {
  const host = $('#sheets');
  if (!host) return;
  const L = geo.L;
  const sig = [n, geo.W, geo.H, L.num, L.numStart, L.size].join();
  $('#paper').style.setProperty('--pv-total', n * geo.pitch - GAP + 'px');
  if (sig === drawn && host.children.length === n) return;
  drawn = sig;
  let html = '';
  for (let k = 0; k < n; k++) {
    const no = k + (+L.numStart || 1);
    const side = numSide(L, no);
    html += `<div class="sheet" style="top:${k * geo.pitch}px">${side ? `<span class="pno ${side}">${no}</span>` : ''}</div>`;
  }
  host.innerHTML = html;
  const st = $('#pvStat');
  if (st) st.textContent = `${n}쪽`;
}

export function togglePageView(on = !isPageView()) {
  app.settings.pageView = on;
  saveSettings();
  applyPageView();
}
export function setZoom(v) {
  app.settings.pvZoom = v;
  saveSettings();
  applyPageView();
}

export function bindPageView() {
  app.editor.on('update', () => schedule());
  addEventListener('resize', () => { if (isPageView()) applyPageView(); });
  document.fonts?.addEventListener?.('loadingdone', () => schedule(50));
  document.fonts?.ready.then(() => schedule(50));
  applyPageView();
}
