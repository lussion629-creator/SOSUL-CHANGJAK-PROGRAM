// 쪽 보기: 편집하면서 원고를 쪽 설정(용지·여백·글자)대로 한 쪽씩 나눠 보여 준다.
// 원고 앞에 폭 없는 띄움(float) 기둥을 세워, 쪽 아래 여백~다음 쪽 위 여백 자리를 브라우저가 줄을 놓을 때 비켜 가게 한다.
// 원고 안에는 아무것도 끼워 넣지 않으므로 한글 조합 중에도 줄이 바로 다음 쪽으로 넘어간다.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
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
      props: {
        // 쪽 사이 빈칸을 건너 위아래로 옮기기: 브라우저에 맡기면 빈칸에서 맨 끝·맨 앞으로 튄다
        handleKeyDown(view, e) {
          if (!geo || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.ctrlKey || e.metaKey || e.altKey || view.composing) return false;
          return crossGap(view, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
        },
      },
    })];
  },
});

export const isPageView = () => !!app.settings.pageView;

// 위아래 화살표가 쪽 사이 빈칸(pg-gap)을 건너야 할 때만 직접 옮긴다 (그 밖에는 브라우저 기본 동작)
let goalX = null, goalAt = -1;
function crossGap(view, dir, extend) {
  const sel = view.state.selection;
  const head = sel.head;
  let c;
  try { c = view.coordsAtPos(head); } catch { return false; }
  const lh = Math.max(8, c.bottom - c.top);
  const gaps = [...document.querySelectorAll('#pvFloats .gapf')].map((g) => g.getBoundingClientRect()).filter((r) => r.height > 0);
  // 다음(이전) 줄로 갈 자리
  let y = dir > 0 ? c.bottom + lh / 2 : c.top - lh / 2;
  const hit = gaps.find((r) => (dir > 0 ? r.top < y + lh / 2 && r.bottom > c.bottom - 1 : r.bottom > y - lh / 2 && r.top < c.top + 1));
  if (!hit) { goalX = null; return false; }
  y = dir > 0 ? hit.bottom + lh / 2 : hit.top - lh / 2;
  // 같은 세로 이동이 이어지면 처음 가로 위치를 지킨다
  const x = goalAt === head && goalX != null ? goalX : c.left;
  const box = view.dom.getBoundingClientRect();
  const left = Math.min(Math.max(x, box.left + 1), box.right - 1);
  let found = view.posAtCoords({ left, top: y });
  // 위로 갈 때: 쪽 마지막 줄 아래에 남는 빈 자리가 있으므로, 띄움 위쪽 줄에 닿을 때까지 조금씩 올라가 본다
  for (let i = 0; dir < 0 && found && i < 8; i++) {
    let b;
    try { b = view.coordsAtPos(found.pos).bottom; } catch { break; }
    if (b <= hit.top + 1) break;
    y -= lh / 2;
    found = view.posAtCoords({ left, top: y });
  }
  if (!found) return false;
  const pos = found.pos;
  if (pos === head) return false;
  const $a = extend ? sel.$anchor : view.state.doc.resolve(pos);
  const tr = view.state.tr.setSelection(TextSelection.between($a, view.state.doc.resolve(pos)));
  view.dispatch(tr.scrollIntoView());
  goalX = x; goalAt = pos;
  return true;
}

// 교정 여백(교정 모드)·주석 여백이 생길 수 있으면 그 폭 (ui.js symRails와 같은 기준: 넓으면 양쪽 대칭)
function railReserve(w) {
  // 교정 여백은 글을 쓰는 동안 수시로 생겼다 없어지므로 교정 모드면 늘 자리를 둔다. 주석 여백은 주석이 있을 때만(자주 바뀌지 않음)
  const proof = app.settings.proof !== false && app.settings.proofRail !== false;
  const anno = document.body.classList.contains('has-anno-rail');
  if (!proof && !anno) return 0;
  if (w >= 1120) return 536;
  return w >= 860 ? 268 : 0;
}

let geo = null; // 지금 쪽 크기 (px)
let last = '';
export function applyPageView() {
  const paper = $('#paper');
  // 퇴고 모드에서는 원고 칸이 옆 창으로 옮겨 가므로 쪽 나눔 빈칸을 넣지 않는다
  const on = isPageView() && !!app.project && !document.body.classList.contains('revising');
  paper.classList.toggle('pv', on);
  document.body.classList.toggle('pageview', on);
  $('#pvZoom') && ($('#pvZoom').hidden = !on);
  if (!on) {
    geo = null; last = '';
    $('#sheets')?.remove();
    paper.style.cssText = '';
    $('#pvFloats')?.remove();
    return;
  }
  const L = layoutOf();
  const ps = $('#paperScroll'), pcs = getComputedStyle(ps);
  // 폭 맞춤: 교정·주석 여백이 나타났다 사라져도 쪽 크기가 바뀌지 않게, 여백이 생길 수 있으면 늘 그 자리를 빼 두고 잰다
  const avail = Math.max(240, ps.clientWidth - Math.max(parseFloat(pcs.paddingLeft) + parseFloat(pcs.paddingRight), railReserve(ps.clientWidth)));
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
  s.setProperty('--pv-z', String(z));
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
  cancelAnimationFrame(raf);
  // 0: 이번 화면을 그리기 전에 바로 (쪽 수·띄움 기둥만 고치므로 가볍다)
  if (!delay) { raf = requestAnimationFrame(relayout); return; }
  timer = setTimeout(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(relayout); }, delay);
}

// 띄움 기둥: [폭 0, 본문 높이] [폭 100%, 쪽 사이 높이] 를 번갈아 오른쪽에 쌓는다 (clear로 하나씩 아래로).
// 줄 상자가 '쪽 사이' 띄움에 조금이라도 걸리면 브라우저가 그 줄을 띄움 아래(다음 쪽 첫 줄 자리)로 옮긴다.
function setFloats(host, dom, n) {
  const { pitch, bodyH, half } = geo;
  // 줄 상자 아래 끝이 이 선을 넘으면 = 글자 아래 끝이 본문 칸을 넘으면 (줄 위아래 반쪽 여백 half)
  const unit = bodyH + 2 * half;
  const lead = dom.getBoundingClientRect().top - host.getBoundingClientRect().top;
  const sig = [n, unit, pitch, lead].join();
  if (sig === host.dataset.sig) return;
  host.dataset.sig = sig;
  let html = '';
  for (let k = 0; k < n; k++) {
    html += `<div class="spf" style="height:${k ? unit : unit + lead}px"></div><div class="gapf" style="height:${pitch - unit}px"></div>`;
  }
  host.innerHTML = html;
}
// 원고(dom) 앞 띄움 기둥(host)을 맞추며 쪽 수를 잰다. 쪽이 늘면 띄움을 하나 더 세우고 다시 잰다
function countPages(host, dom) {
  const { pitch, bodyH, half } = geo;
  const unit = bodyH + 2 * half; // 한 쪽 본문 칸에 들어가는 높이
  const G = pitch - unit; // 쪽 사이 띄움 높이
  // 원고 끝: 맨 끝 문단의 아래 끝 (끝에 붙은 숨은 표시·떠 있는 요소는 건너뛴다)
  const measure = () => {
    let el = dom.lastElementChild;
    while (el) {
      const cs = getComputedStyle(el);
      if (cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed' && cs.float === 'none' && el.getBoundingClientRect().height > 0) break;
      el = el.previousElementSibling;
    }
    return el ? el.getBoundingClientRect().bottom - dom.getBoundingClientRect().top : 0;
  };
  // 마지막 줄이 몇째 쪽 본문 칸 안에 드는가 (쪽 아래 여백까지 넘어갔으면 그다음 쪽: 띄움을 하나 더 세우면 그리로 옮겨진다)
  const pagesAt = (bottom) => (bottom <= unit + 0.5 ? 1 : Math.ceil((bottom - unit - 0.5) / pitch) + 1);
  let n = host.children.length / 2;
  setFloats(host, dom, n);
  let bottom = measure();
  let pages = pagesAt(bottom);
  if (pages - 1 !== n) {
    // 긴 장을 처음 열 때 띄움을 하나씩 늘리며 맞추면 끝나지 않으므로, 띄움 없는 높이로 쪽 수를 어림해 한 번에 세운다
    const plain = Math.max(0, bottom - Math.min(n, pages - 1) * G);
    n = Math.max(0, Math.ceil((plain - unit - 0.5) / unit));
    for (let i = 0; i < 40; i++) {
      setFloats(host, dom, n);
      bottom = measure();
      pages = pagesAt(bottom);
      if (pages - 1 === n) break;
      n = pages - 1;
    }
  }
  return n + 1;
}

function relayout() {
  if (!geo || !app.editor) return;
  const dom = app.editor.view.dom;
  let host = $('#pvFloats');
  if (!host || host.nextElementSibling !== dom) {
    host?.remove();
    host = document.createElement('div');
    host.id = 'pvFloats';
    host.className = 'pv-floats';
    host.setAttribute('aria-hidden', 'true');
    dom.before(host);
  }
  drawSheets(countPages(host, dom));
  if (numAll()) scheduleOthers();
}

// ---------- 쪽 번호를 작품 전체로 이어 매기기 ----------
// 다른 장의 쪽 수는 화면 밖 같은 크기 종이에 그 장을 놓고 같은 방식으로 잰다 (장 내용·쪽 설정이 바뀔 때만 다시)
export const numAll = () => !!app.settings.pvNumAll;
const pageCache = new Map(); // 장 id → { sig, n }
let others = { before: 0, after: 0 }; // 지금 장 앞·뒤 장들의 쪽 수
let othersTimer;
function scheduleOthers() { clearTimeout(othersTimer); othersTimer = setTimeout(measureOthers, 400); }
function pagesOf(c) {
  const sig = [geo.W, geo.H, JSON.stringify(geo.L), c.updated, c.html.length].join('|');
  const hit = pageCache.get(c.id);
  if (hit && hit.sig === sig) return hit.n;
  let box = document.getElementById('pvMeasure');
  if (!box) {
    box = document.createElement('div');
    box.id = 'pvMeasure';
    box.setAttribute('aria-hidden', 'true');
    document.body.appendChild(box);
  }
  box.className = 'paper pv';
  box.style.cssText = $('#paper').style.cssText + ';position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style';
  box.innerHTML = '<div class="pv-floats"></div><div class="ProseMirror"></div>';
  box.lastChild.innerHTML = c.html || '<p></p>';
  const n = countPages(box.firstChild, box.lastChild);
  box.innerHTML = '';
  pageCache.set(c.id, { sig, n });
  return n;
}
function measureOthers() {
  if (!geo || !numAll() || !app.project) return;
  const order = app.project.order || [];
  const at = order.indexOf(app.cur);
  let before = 0, after = 0;
  order.forEach((id, i) => {
    if (id === app.cur) return;
    const c = app.chapters.get(id);
    if (!c) return;
    const n = pagesOf(c);
    if (i < at) before += n; else after += n;
  });
  if (before !== others.before || after !== others.after) { others = { before, after }; drawn = ''; drawSheets(curPages); }
  else paintStat();
}

let drawn = '';
let curPages = 1;
function drawSheets(n) {
  const host = $('#sheets');
  if (!host) return;
  curPages = n;
  const L = geo.L;
  const off = numAll() ? others.before : 0;
  const sig = [n, geo.W, geo.H, L.num, L.numStart, L.size, off].join();
  $('#paper').style.setProperty('--pv-total', n * geo.pitch - GAP + 'px');
  if (sig === drawn && host.children.length === n) return;
  drawn = sig;
  let html = '';
  for (let k = 0; k < n; k++) {
    const no = k + (+L.numStart || 1) + off;
    const side = numSide(L, no);
    html += `<div class="sheet" style="top:${k * geo.pitch}px">${side ? `<span class="pno ${side}">${no}</span>` : ''}</div>`;
  }
  host.innerHTML = html;
  paintStat();
}
function paintStat() {
  const st = $('#pvStat');
  if (!st || !geo) return;
  const n = curPages;
  if (!numAll()) { st.textContent = `${n}쪽`; st.title = '이 장의 쪽 수'; return; }
  const a = (+geo.L.numStart || 1) + others.before;
  st.textContent = `${a}–${a + n - 1}쪽 / 전체 ${others.before + n + others.after}쪽`;
  st.title = '이 장의 쪽 번호 / 작품 전체 쪽 수';
}
export function setNumAll(on) {
  app.settings.pvNumAll = !!on;
  saveSettings();
  others = { before: 0, after: 0 };
  drawn = '';
  if (geo) { drawSheets(curPages); if (on) measureOthers(); }
  const sel = $('#pvNumSel');
  if (sel) sel.value = on ? 'all' : 'ch';
}

export function togglePageView(on = !isPageView()) {
  app.settings.pageView = on;
  saveSettings();
  applyPageView();
}
/** 쪽 보기의 지금 배율 (폭 맞춤일 때는 계산된 값) */
export const pvZoomNow = () => geo?.z || (+app.settings.pvZoom || 100) / 100;
export function setZoom(v) {
  app.settings.pvZoom = v;
  saveSettings();
  applyPageView();
  // 아래 줄 배율 칸: 목록에 없는 배율(Ctrl+휠로 맞춘 110% 등)도 보이게
  const sel = $('#pvZoomSel');
  if (sel) {
    sel.querySelector('option[data-custom]')?.remove();
    if (![...sel.options].some((o) => o.value === String(v))) sel.add(new Option(`${v}%`, String(v)), null), sel.lastElementChild.dataset.custom = '1';
    sel.value = String(v);
  }
}

export function bindPageView() {
  app.editor.on('update', () => schedule(0));
  app.editor.view.dom.addEventListener('compositionend', () => setTimeout(() => schedule(0), 0));
  addEventListener('resize', () => { if (isPageView()) applyPageView(); });
  document.fonts?.addEventListener?.('loadingdone', () => schedule(50));
  document.fonts?.ready.then(() => schedule(50));
  applyPageView();
}
