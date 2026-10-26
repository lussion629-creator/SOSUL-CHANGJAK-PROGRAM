// 쪽 설정(용지·여백·글자·문단·쪽 번호)과 템플릿
// 단위: 길이는 mm, 글자 크기는 pt, 자간·줄 간격은 %, 들여쓰기는 글자 수
import * as S from './store.js';
import { app, applySettings, scheduleSync } from './app.js';

export { FONTS, fontName, cssFont } from './fonts.js';
import { FONTS, fontName, cssFont } from './fonts.js';

export const PAPERS = [
  ['A4', 210, 297], ['A5 (국판)', 148, 210], ['B5', 182, 257], ['B6', 128, 182],
  ['신국판', 152, 225], ['46판', 127, 188], ['크라운판', 176, 248], ['Letter', 215.9, 279.4],
];

const BASE = { w: 148, h: 210, mt: 25, mb: 18, ml: 25, mr: 25, mh: 0, mf: 15, mirror: true, num: 'outside', numStart: 1,
  font: FONTS[0][0], size: 10, spacing: -8, line: 180, indent: 0, paraAfter: 0, align: 'justify', breakWord: 'word' };

export const BUILTIN = [
  // 올려 준 예시 한글 파일과 같은 설정, 줄은 어절 단위로 나눔
  // 예시 파일은 문단 앞 띄어쓰기로 들여 썼는데, 여기서는 첫 줄 들여쓰기 1글자로 바꿔 둔다
  { ...BASE, id: 'novel-a5', name: '소설 A5 (예시 템플릿)', builtin: true, indent: 1 },
  { ...BASE, id: 'a4', name: 'A4 원고 (한글 기본 여백)', builtin: true, w: 210, h: 297, mt: 20, mb: 15, ml: 30, mr: 30, mh: 15, mf: 15, mirror: false, num: 'center', size: 11, spacing: 0, line: 160, indent: 1 },
  { ...BASE, id: 'shinguk', name: '신국판 단행본', builtin: true, w: 152, h: 225, mt: 22, mb: 18, ml: 20, mr: 20, mh: 0, mf: 12, size: 10.5, spacing: -5, line: 170, indent: 1 },
];
export const KEYS = Object.keys(BASE);
const clean = (o) => Object.fromEntries(KEYS.map((k) => [k, o[k] ?? BASE[k]]));

let userTemplates = [];
let defaultId = 'novel-a5';
export async function loadTemplates() {
  userTemplates = (await S.kvGet('pageTemplates', [])) || [];
  defaultId = (await S.kvGet('defaultTemplate', 'novel-a5')) || 'novel-a5';
}
export const templates = () => [...BUILTIN, ...userTemplates];
export const templateById = (id) => templates().find((t) => t.id === id);
export const defaultTemplateId = () => (templateById(defaultId) ? defaultId : 'novel-a5');
export async function setDefaultTemplate(id) { defaultId = id; await S.kvSet('defaultTemplate', id); }
export async function saveTemplate(name, values) {
  const t = { ...clean(values), id: 'u' + S.uid(), name };
  userTemplates.push(t);
  await S.kvSet('pageTemplates', userTemplates);
  return t;
}
export async function deleteTemplate(id) {
  userTemplates = userTemplates.filter((t) => t.id !== id);
  await S.kvSet('pageTemplates', userTemplates);
  if (defaultId === id) await setDefaultTemplate('novel-a5');
}

// 지금 작품의 쪽 설정 (없으면 기본 템플릿)
export function layoutOf(p = app.project) {
  if (p?.layout) return { ...BASE, ...p.layout };
  const t = templateById(defaultTemplateId());
  return { ...clean(t), templateId: t.id, templateName: t.name };
}
export async function setProjectLayout(values, tpl) {
  app.project.layout = { ...clean(values), templateId: tpl?.id || '', templateName: tpl?.name || '' };
  // 바꾼 시각을 적고 동기화에 올린다: 전에는 원고를 고칠 때까지 올라가지 않아, 다른 기기에서 받아 오면 옛 쪽 설정으로 되돌아갔다
  app.project.layoutAt = app.project.updated = Date.now();
  await S.putProject(app.project);
  applySettings(); // 쪽 보기가 아닐 때도 원고 글자가 쪽 설정을 따르게
  scheduleSync();
}

// 본문이 들어가는 칸 (mm)
export const bodyBox = (L) => ({ w: L.w - L.ml - L.mr, h: L.h - L.mt - L.mh - L.mf - L.mb, top: L.mt + L.mh });
// 한 쪽에 들어가는 줄 수 (마지막 줄은 글자 높이만 있으면 된다: 한글과 같은 방식)
export function linesPerPage(L) {
  const bh = bodyBox(L).h * 72 / 25.4; // pt
  const pitch = L.size * L.line / 100;
  return Math.max(1, Math.floor((bh - L.size) / pitch) + 1);
}
export const mm2px = (mm) => mm * 96 / 25.4;
export const pt2px = (pt) => pt * 96 / 72;

// 쪽 번호 위치: 쪽 번호(1부터) → 'left' | 'center' | 'right' | ''
export function numSide(L, n) {
  if (L.num === 'none') return '';
  if (L.num === 'outside') return n % 2 ? 'right' : 'left'; // 홀수 쪽은 오른쪽, 짝수 쪽은 왼쪽
  return L.num;
}

// 글자·문단 모양을 CSS로 (zoom: 화면 배율)
export function textCss(L, zoom = 1) {
  return {
    fontFamily: `${L.font}, 'KoPub Batang Light', Batang, serif`,
    fontSize: pt2px(L.size) * zoom + 'px',
    lineHeight: String(L.line / 100),
    letterSpacing: L.spacing / 100 + 'em',
    textIndent: L.indent + 'em',
    paraAfter: pt2px(L.paraAfter) * zoom + 'px',
    textAlign: L.align,
    wordBreak: L.breakWord === 'word' ? 'keep-all' : 'break-all',
  };
}

// ---------- 한글(.hwpx) 파일에서 쪽 설정 읽기 ----------
const HU = 7200 / 25.4; // HWPUNIT per mm
export async function readHwpxLayout(arrayBuffer) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(arrayBuffer);
  const secName = Object.keys(zip.files).find((n) => /^Contents\/section0\.xml$/i.test(n));
  const hf = zip.file('Contents/header.xml');
  if (!secName || !hf) throw new Error('한글(hwpx) 문서의 쪽 설정을 찾지 못했습니다.');
  const sec = new DOMParser().parseFromString(await zip.file(secName).async('string'), 'application/xml');
  const head = new DOMParser().parseFromString(await hf.async('string'), 'application/xml');
  const one = (doc, name) => doc.getElementsByTagNameNS('*', name)[0];
  const all = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
  const L = { ...BASE };
  const pg = one(sec, 'pagePr');
  if (pg) {
    let w = +pg.getAttribute('width') / HU, hh = +pg.getAttribute('height') / HU;
    if (pg.getAttribute('landscape') === 'NARROWLY') [w, hh] = [hh, w];
    L.w = r1(w); L.h = r1(hh);
    L.mirror = pg.getAttribute('gutterType') === 'LEFT_RIGHT';
    const m = pg.getElementsByTagNameNS('*', 'margin')[0];
    if (m) {
      const g = (a) => r1(+m.getAttribute(a) / HU);
      Object.assign(L, { mt: g('top'), mb: g('bottom'), ml: g('left'), mr: g('right'), mh: g('header'), mf: g('footer') });
    }
  }
  const pn = one(sec, 'pageNum');
  const pos = pn?.getAttribute('pos') || '';
  L.num = !pn ? 'none' : /OUTSIDE/.test(pos) ? 'outside' : /CENTER/.test(pos) ? 'center' : /RIGHT/.test(pos) ? 'right' : /LEFT/.test(pos) ? 'left' : 'center';
  const sn = one(sec, 'startNum');
  if (sn && +sn.getAttribute('page')) L.numStart = +sn.getAttribute('page');

  // 본문에서 가장 많이 쓴 문단 모양·글자 모양을 기준으로
  const pc = new Map(), cc = new Map();
  for (const p of all(sec, 'p')) {
    const len = all(p, 't').reduce((a, t) => a + t.textContent.length, 0);
    if (!len) continue;
    const pid = p.getAttribute('paraPrIDRef');
    pc.set(pid, (pc.get(pid) || 0) + len);
    for (const r of p.children) if (r.localName === 'run') {
      const n = all(r, 't').reduce((a, t) => a + t.textContent.length, 0);
      cc.set(r.getAttribute('charPrIDRef'), (cc.get(r.getAttribute('charPrIDRef')) || 0) + n);
    }
  }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
  const para = all(head, 'paraPr').find((x) => x.getAttribute('id') === top(pc));
  const chr = all(head, 'charPr').find((x) => x.getAttribute('id') === top(cc));
  if (chr) {
    L.size = +chr.getAttribute('height') / 100 || L.size;
    const sp = chr.getElementsByTagNameNS('*', 'spacing')[0];
    if (sp) L.spacing = +sp.getAttribute('hangul') || 0;
    const fr = chr.getElementsByTagNameNS('*', 'fontRef')[0];
    const face = fr && all(head, 'fontface').find((f) => f.getAttribute('lang') === 'HANGUL');
    const font = face && [...face.children].find((f) => f.localName === 'font' && f.getAttribute('id') === fr.getAttribute('hangul'));
    if (font) L.font = cssFont(font.getAttribute('face'));
  }
  if (para) {
    const al = para.getElementsByTagNameNS('*', 'align')[0]?.getAttribute('horizontal');
    L.align = al === 'LEFT' ? 'left' : 'justify';
    const bs = para.getElementsByTagNameNS('*', 'breakSetting')[0];
    L.breakWord = bs?.getAttribute('breakNonLatinWord') === 'BREAK_WORD' ? 'char' : 'word';
    const ls = para.getElementsByTagNameNS('*', 'lineSpacing')[0];
    if (ls && ls.getAttribute('type') === 'PERCENT') L.line = +ls.getAttribute('value') || L.line;
    const ind = para.getElementsByTagNameNS('*', 'intent')[0];
    if (ind) L.indent = Math.max(0, r1(+ind.getAttribute('value') / (L.size * 100)));
    // 들여쓰기를 문단 앞 띄어쓰기로 한 문서면 첫 줄 들여쓰기 1글자로 바꾼다 (불러올 때 앞 띄어쓰기는 지워지므로)
    if (!L.indent) {
      const starts = all(sec, 'p').map((p) => all(p, 't').map((t) => t.textContent).join('')).filter((t) => t.trim().length > 20);
      if (starts.length && starts.filter((t) => /^[ \u3000]/.test(t)).length > starts.length / 2) L.indent = 1;
    }
    const next = para.getElementsByTagNameNS('*', 'next')[0];
    if (next) L.paraAfter = r1(+next.getAttribute('value') / 100);
  }
  return L;
}
const r1 = (v) => Math.round(v * 10) / 10;

// ---------- Word(.docx) 파일에서 쪽 설정 읽기 ----------
// 길이 단위: twip(1/1440인치). Word의 위·아래 여백은 '종이 끝 ~ 본문'이고 머리말·꼬리말 거리는 '종이 끝 ~ 머리말·꼬리말'이라
// 여기서는 머리말 거리 = 위 여백(mt), 그 나머지 = 머리말 칸(mh), 꼬리말 거리 = 아래 여백(mb, 쪽 번호 자리), 나머지 = 꼬리말 칸(mf)으로 옮긴다.
const TW = 1440 / 25.4; // twip per mm
export async function readDocxLayout(arrayBuffer) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(arrayBuffer);
  const xml = async (name) => { const f = zip.file(name); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
  const doc = await xml('word/document.xml');
  if (!doc) throw new Error('Word(docx) 문서가 아니거나 본문을 찾지 못했습니다.');
  const styles = await xml('word/styles.xml');
  const settings = await xml('word/settings.xml');
  const theme = await xml('word/theme/theme1.xml');
  const W = (el, name) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
  const one = (el, name) => W(el, name)[0] || null;
  const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
  const at = (el, name) => (el ? el.getAttributeNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', name) ?? el.getAttribute('w:' + name) : null);
  const num = (el, name) => { const v = at(el, name); return v == null || v === '' ? null : +v; };
  const L = { ...BASE };

  // 용지·여백: 본문 끝의 구역 설정(없으면 첫 구역)
  const body = one(doc, 'body');
  const sect = kid(body, 'sectPr') || one(doc, 'sectPr');
  const sz = kid(sect, 'pgSz'), mar = kid(sect, 'pgMar');
  if (sz) {
    let w = num(sz, 'w') / TW, hh = num(sz, 'h') / TW;
    if (at(sz, 'orient') === 'landscape' && w < hh) [w, hh] = [hh, w];
    if (w && hh) { L.w = r1(w); L.h = r1(hh); }
  }
  if (mar) {
    const g = (a) => Math.max(0, (num(mar, a) || 0) / TW);
    const top = g('top'), bottom = g('bottom'), head = g('header'), foot = g('footer'), gut = g('gutter');
    L.mt = r1(Math.min(head || top, top)); L.mh = r1(Math.max(0, top - L.mt));
    L.mb = r1(Math.min(foot || bottom, bottom)); L.mf = r1(Math.max(0, bottom - L.mb));
    L.ml = r1(g('left') + gut); L.mr = r1(g('right'));
  }
  L.mirror = !!one(settings, 'mirrorMargins');
  const pnt = kid(sect, 'pgNumType');
  if (num(pnt, 'start')) L.numStart = num(pnt, 'start');

  // 쪽 번호: 꼬리말(없으면 머리말)에 PAGE 필드가 있는지, 그 문단을 어떻게 맞췄는지
  L.num = 'none';
  const rels = await xml('word/_rels/document.xml.rels');
  const target = (id) => [...(rels?.getElementsByTagName('Relationship') || [])].find((r) => r.getAttribute('Id') === id)?.getAttribute('Target');
  const refs = [...W(sect, 'footerReference'), ...W(sect, 'headerReference')];
  for (const ref of refs) {
    const t = target(ref.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || ref.getAttribute('r:id'));
    const part = t && (await xml('word/' + t.replace(/^\/?word\//, '')));
    const p = W(part, 'p').find((x) => W(x, 'instrText').some((i) => /\bPAGE\b/.test(i.textContent)) || W(x, 'fldSimple').some((f) => /\bPAGE\b/.test(at(f, 'instr') || '')));
    if (!p) continue;
    const jc = at(one(p, 'jc'), 'val') || 'left';
    const even = refs.some((r) => at(r, 'type') === 'even');
    L.num = even && L.mirror ? 'outside' : /center/.test(jc) ? 'center' : /right|end/.test(jc) ? 'right' : 'left';
    break;
  }

  // 글자·문단: 본문에서 가장 많이 쓴 문단 스타일을 기준으로, 기본값 → 스타일(기반 스타일 포함) → 문단에 직접 준 값 순서로 덮는다
  const styleEls = W(styles, 'style');
  const styleById = (id) => styleEls.find((s) => at(s, 'styleId') === id);
  const defStyle = styleEls.find((s) => at(s, 'type') === 'paragraph' && /^(1|true)$/.test(at(s, 'default') || ''));
  const count = new Map(), sizes = new Map();
  for (const p of W(body, 'p')) {
    const len = W(p, 't').reduce((a, t) => a + t.textContent.length, 0);
    if (!len) continue;
    const id = at(one(kid(p, 'pPr'), 'pStyle'), 'val') || at(defStyle, 'styleId') || '';
    count.set(id, (count.get(id) || 0) + len);
    for (const r of W(p, 'r')) {
      const v = num(one(kid(r, 'rPr'), 'sz'), 'val');
      if (v) sizes.set(v, (sizes.get(v) || 0) + W(r, 't').reduce((a, t) => a + t.textContent.length, 0));
    }
  }
  const topKey = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
  const chain = [];
  for (let s = styleById(topKey(count)) || defStyle, n = 0; s && n < 10; s = styleById(at(one(s, 'basedOn'), 'val')), n++) chain.unshift(s);
  const dflt = one(styles, 'docDefaults');
  const rLayers = [one(one(dflt, 'rPrDefault'), 'rPr'), ...chain.map((s) => kid(s, 'rPr'))].filter(Boolean);
  const pLayers = [one(one(dflt, 'pPrDefault'), 'pPr'), ...chain.map((s) => kid(s, 'pPr'))].filter(Boolean);
  const last = (layers, name) => layers.map((l) => kid(l, name)).filter(Boolean).pop() || null;

  const szv = num(last(rLayers, 'sz'), 'val');
  const direct = topKey(sizes);
  L.size = (direct && sizes.get(direct) > 0 ? direct : szv || 21) / 2; // 반 포인트 단위
  const spc = num(last(rLayers, 'spacing'), 'val'); // 1/20pt
  L.spacing = spc ? Math.round((spc / 20 / L.size) * 100) : 0;
  const rf = last(rLayers, 'rFonts');
  let face = at(rf, 'eastAsia') || at(rf, 'ascii') || at(rf, 'hAnsi');
  const themeKey = at(rf, 'eastAsiaTheme') || at(rf, 'asciiTheme');
  if (!face && themeKey && theme) {
    const fs = one(theme, /^major/.test(themeKey) ? 'majorFont' : 'minorFont');
    face = [...(fs?.children || [])].find((c) => c.localName === 'font' && c.getAttribute('script') === 'Hang')?.getAttribute('typeface')
      || one(fs, /EastAsia/.test(themeKey) ? 'ea' : 'latin')?.getAttribute('typeface') || '';
  }
  if (face) L.font = cssFont(face);

  const jc = at(last(pLayers, 'jc'), 'val');
  L.align = /^(left|start)$/.test(jc || '') ? 'left' : 'justify';
  const ww = last(pLayers, 'wordWrap');
  L.breakWord = ww && /^(0|false|off)$/.test(at(ww, 'val') || '') ? 'char' : 'word';
  const sp = last(pLayers, 'spacing');
  const rule = at(sp, 'lineRule') || 'auto', line = num(sp, 'line');
  // Word의 '한 줄'(240)은 글자 높이의 약 1.2배로 본다
  if (line) L.line = Math.round(rule === 'auto' ? (line / 240) * 120 : (line / 20 / L.size) * 100);
  const after = num(sp, 'after'), afterLines = num(sp, 'afterLines');
  L.paraAfter = r1(afterLines != null ? (afterLines / 100) * L.size * (L.line / 100) : (after || 0) / 20);
  const ind = last(pLayers, 'ind');
  const flc = num(ind, 'firstLineChars'), fl = num(ind, 'firstLine');
  L.indent = Math.max(0, r1(flc != null ? flc / 100 : fl ? fl / 20 / L.size : 0));
  return L;
}
