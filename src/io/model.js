import { fontName } from '../fonts.js';
import { parseHtml } from '../sanitize.js';
// 에디터 HTML ↔ 파일 형식 사이의 공통 중간 모델
// block: {type: 'p'|'h1'|'h2'|'h3'|'hr'|'quote'|'li'|'pagebreak', align, ordered, runs:[{text,bold,italic,underline,strike,color,highlight,font,size,br}]}

export function htmlToBlocks(html) {
  const div = parseHtml(html);
  const blocks = [];
  const walkBlock = (el, ctx = {}) => {
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        if (node.textContent.trim()) blocks.push({ type: 'p', runs: [{ text: node.textContent }] });
        continue;
      }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) blocks.push({ type: tag > 'h3' ? 'h3' : tag, align: alignOf(node), pf: pfOf(node), runs: runsOf(node) });
      else if (tag === 'p') blocks.push({ type: ctx.quote ? 'quote' : ctx.li ? 'li' : 'p', ordered: ctx.ordered, align: alignOf(node), pf: pfOf(node), runs: runsOf(node) });
      else if (tag === 'hr') blocks.push({ type: 'hr' });
      else if (tag === 'blockquote') walkBlock(node, { ...ctx, quote: true });
      else if (tag === 'ul' || tag === 'ol') walkBlock(node, { ...ctx, ordered: tag === 'ol' });
      else if (tag === 'li') {
        if (node.querySelector('p')) walkBlock(node, { ...ctx, li: true });
        else blocks.push({ type: 'li', ordered: ctx.ordered, runs: runsOf(node) });
      } else if (tag === 'div' || tag === 'section' || tag === 'article') walkBlock(node, ctx);
      else blocks.push({ type: 'p', runs: runsOf(node) });
    }
  };
  walkBlock(div);
  return blocks;
}

// 단락 모양 (편집기의 '단락' 창에서 정한 값): {indL, indR, first(글자), line(%), before, after(pt), brk}
function pfOf(el) {
  const pf = {};
  for (const [k, d] of [['indL', 'ind-l'], ['indR', 'ind-r'], ['first', 'first'], ['line', 'line'], ['before', 'before'], ['after', 'after']]) {
    const v = el.getAttribute(`data-${d}`);
    if (v !== null && v !== '' && !Number.isNaN(+v)) pf[k] = +v;
  }
  const lt = el.getAttribute('data-lt'), lpt = +el.getAttribute('data-lpt');
  if (/^(fixed|min)$/.test(lt || '') && lpt > 0) { pf.lineType = lt; pf.linePt = lpt; delete pf.line; }
  const b = el.getAttribute('data-brk');
  if (b) pf.brk = b;
  return Object.keys(pf).length ? pf : undefined;
}

function alignOf(el) {
  const a = el.style?.textAlign;
  return a === 'center' || a === 'right' || a === 'justify' || a === 'left' ? a : undefined;
}

function runsOf(el, fmt = {}) {
  const runs = [];
  for (const n of el.childNodes) {
    if (n.nodeType === 3) { if (n.textContent) runs.push({ ...fmt, text: n.textContent.replace(/ /g, ' ') }); continue; }
    if (n.nodeType !== 1) continue;
    const t = n.tagName.toLowerCase();
    if (t === 'br') { runs.push({ ...fmt, text: '', br: true }); continue; }
    const f = { ...fmt };
    if (t === 'strong' || t === 'b') f.bold = true;
    if (t === 'em' || t === 'i') f.italic = true;
    if (t === 'u') f.underline = true;
    if (t === 's' || t === 'del' || t === 'strike') f.strike = true;
    if (n.hasAttribute('data-anno')) f.anno = [...(f.anno || []), n.getAttribute('data-anno')]; // 본문 주석 (Word 메모로 내보낼 때)
    if (t === 'mark') f.highlight = toHex(n.getAttribute('data-color') || n.style.backgroundColor) || '#fff2a8';
    if (n.style) {
      if (n.style.color) f.color = toHex(n.style.color);
      if (n.style.fontFamily) f.font = fontName(n.style.fontFamily.split(',')[0].trim().replace(/"/g, "'"));
      const fs = n.getAttribute('data-fs') || (/calc/.test(n.style.fontSize) ? '' : n.style.fontSize);
      if (fs) { const pt = parseFloat(fs); if (pt) f.size = fs.endsWith('px') ? pt * 0.75 : fs.endsWith('pt') ? pt : f.size; }
      const ls = n.getAttribute('data-ls');
      if (ls && /^-?\d+(\.\d+)?pt$/.test(ls)) { f.spacingPt = parseFloat(ls); delete f.spacing; } // Word 방식 자간 (pt)
      else if (n.style.letterSpacing && n.style.letterSpacing.endsWith('em')) { f.spacing = Math.round(parseFloat(n.style.letterSpacing) * 100); delete f.spacingPt; }
      if (n.style.fontWeight === 'bold' || +n.style.fontWeight >= 600) f.bold = true;
    }
    runs.push(...runsOf(n, f));
  }
  return runs;
}

export function toHex(c) {
  if (!c) return undefined;
  if (c.startsWith('#')) return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c.slice(0, 7);
  const m = c.match(/\d+/g);
  if (!m) return undefined;
  return '#' + m.slice(0, 3).map((x) => (+x).toString(16).padStart(2, '0')).join('');
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function blocksToHtml(blocks) {
  let html = '';
  let list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const b of blocks) {
    if (b.type === 'li') {
      const want = b.ordered ? 'ol' : 'ul';
      if (list !== want) { closeList(); html += `<${want}>`; list = want; }
      html += `<li><p>${runsHtml(b.runs)}</p></li>`;
      continue;
    }
    closeList();
    const st = /^(left|center|right|justify)$/.test(b.align || '') ? ` style="text-align: ${b.align}"` : ''; // 파일 값이 그대로 HTML에 들어가지 않게
    if (b.type === 'hr' || b.type === 'pagebreak') html += '<hr>';
    else if (/^h[1-3]$/.test(b.type)) html += `<${b.type}${st}>${runsHtml(b.runs)}</${b.type}>`;
    else if (b.type === 'quote') html += `<blockquote><p${st}>${runsHtml(b.runs)}</p></blockquote>`;
    else html += `<p${st}>${runsHtml(b.runs)}</p>`;
  }
  closeList();
  return html;
}

function runsHtml(runs = []) {
  return runs.map((r) => {
    if (r.br) return '<br>';
    let s = esc(r.text || '');
    if (!s) return '';
    if (r.bold) s = `<strong>${s}</strong>`;
    if (r.italic) s = `<em>${s}</em>`;
    if (r.underline) s = `<u>${s}</u>`;
    if (r.strike) s = `<s>${s}</s>`;
    const css = [];
    if (r.color && r.color !== '#000000' && /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(r.color)) css.push(`color: ${r.color}`);
    if (css.length) s = `<span style="${css.join('; ')}">${s}</span>`;
    return s;
  }).join('');
}

export const textBlocks = (paras) => paras.map((t) => ({ type: 'p', runs: [{ text: t }] }));

// 불러온 문서를 장 단위로 나눈다: 제목1(h1)이 있으면 그 기준, 없으면 한 장
export function splitChapters(blocks, fallbackTitle) {
  const hasH1 = blocks.some((b) => b.type === 'h1');
  if (!hasH1) return [{ title: fallbackTitle, html: blocksToHtml(blocks) }];
  const out = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === 'h1') {
      cur = { title: b.runs.map((r) => r.text).join('').trim() || `${out.length + 1}장`, blocks: [] };
      out.push(cur);
    } else {
      if (!cur) { cur = { title: '머리말', blocks: [] }; out.push(cur); }
      cur.blocks.push(b);
    }
  }
  const isEmpty = (b) => b.type === 'p' && !(b.runs || []).some((r) => r.text?.trim());
  for (const c of out) { while (c.blocks.length && isEmpty(c.blocks[0])) c.blocks.shift(); }
  return out.filter((c) => c.blocks.length || c.title).map((c) => ({ title: c.title, html: blocksToHtml(c.blocks) }));
}
