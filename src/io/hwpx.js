// 한글(.hwpx) 열기·저장
// HWPX는 ZIP 안에 OWPML(XML) 문서가 들어 있는 개방형 형식이다.
// 저장용 기본 틀은 python-hwpx(Apache-2.0)의 Skeleton.hwpx를 바탕으로 한다.
import JSZip from 'jszip';
import headerXml from '../hwpx-template/header.xml?raw';
import sectionXml from '../hwpx-template/section0.xml?raw';
import contentHpf from '../hwpx-template/content.hpf?raw';
import containerXml from '../hwpx-template/container.xml?raw';
import containerRdf from '../hwpx-template/container.rdf?raw';
import manifestXml from '../hwpx-template/manifest.xml?raw';
import versionXml from '../hwpx-template/version.xml?raw';
import settingsXml from '../hwpx-template/settings.xml?raw';
import { htmlToBlocks } from './model.js';

// ---------- 읽기 ----------
export async function readHwpx(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const names = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  if (!names.length) throw new Error('HWPX 본문(section)을 찾지 못했습니다.');

  // 글자 모양(굵게·기울임 등)과 문단 모양(정렬) 정보
  const charPr = {}, paraPr = {}, styles = {};
  const hf = zip.file('Contents/header.xml');
  if (hf) {
    const h = new DOMParser().parseFromString(await hf.async('string'), 'application/xml');
    for (const c of h.getElementsByTagNameNS('*', 'charPr')) {
      const u = byLocal(c, 'underline');
      const s = byLocal(c, 'strikeout');
      charPr[c.getAttribute('id')] = {
        bold: !!byLocal(c, 'bold'), italic: !!byLocal(c, 'italic'),
        underline: u && u.getAttribute('type') && u.getAttribute('type') !== 'NONE',
        strike: s && s.getAttribute('shape') && s.getAttribute('shape') !== 'NONE',
        color: c.getAttribute('textColor') && c.getAttribute('textColor') !== '#000000' ? c.getAttribute('textColor') : undefined,
        size: +c.getAttribute('height') / 100,
      };
    }
    for (const p of h.getElementsByTagNameNS('*', 'paraPr')) {
      const a = byLocal(p, 'align');
      const hz = a?.getAttribute('horizontal');
      paraPr[p.getAttribute('id')] = { align: hz === 'CENTER' ? 'center' : hz === 'RIGHT' ? 'right' : undefined };
    }
    for (const s of h.getElementsByTagNameNS('*', 'style')) styles[s.getAttribute('id')] = s.getAttribute('name') || '';
  }

  const blocks = [];
  for (const n of names) {
    const doc = new DOMParser().parseFromString(await zip.file(n).async('string'), 'application/xml');
    const walk = (el) => {
      for (const c of el.children) {
        if (c.localName === 'p') readPara(c);
        else walk(c);
      }
    };
    const readPara = (p) => {
      const runs = [];
      const nested = [];
      for (const run of p.children) {
        if (run.localName !== 'run') continue;
        const f = charPr[run.getAttribute('charPrIDRef')] || {};
        for (const item of run.children) {
          if (item.localName === 't') {
            for (const t of item.childNodes) {
              if (t.nodeType === 3) runs.push({ text: t.textContent, bold: f.bold, italic: f.italic, underline: f.underline, strike: f.strike, color: f.color });
              else if (t.localName === 'lineBreak') runs.push({ text: '', br: true });
              else if (t.localName === 'tab') runs.push({ text: '\t' });
            }
          } else if (item.localName !== 'secPr' && item.localName !== 'ctrl') {
            nested.push(item); // 표·글상자 안의 문단
          }
        }
      }
      const style = styles[p.getAttribute('styleIDRef')] || '';
      const m = style.match(/^개요\s*(\d)/);
      const type = m && +m[1] <= 3 ? `h${m[1]}` : 'p';
      const pp = paraPr[p.getAttribute('paraPrIDRef')] || {};
      const txt = runs.map((r) => r.text || '').join('').trim();
      // 새 쪽에서 시작하는 짧은 굵은 문단은 장 제목으로 본다
      const isTitle = type === 'p' && p.getAttribute('pageBreak') === '1' && txt && txt.length <= 60 && runs.filter((r) => r.text?.trim()).every((r) => r.bold);
      if (runs.some((r) => r.text || r.br) || (!nested.length)) blocks.push({ type: isTitle ? 'h1' : type, align: isTitle ? undefined : pp.align, runs: isTitle ? runs.map((r) => ({ ...r, bold: false })) : runs });
      for (const n2 of nested) walk(n2);
    };
    walk(doc.documentElement);
  }
  // 앞뒤의 빈 문단 정리
  while (blocks.length && !blocks[0].runs.some((r) => r.text?.trim())) blocks.shift();
  return blocks;
}

function byLocal(el, name) {
  for (const c of el.getElementsByTagNameNS('*', name)) return c;
  return null;
}

// ---------- 쓰기 ----------
const X = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * @param {{title:string, author?:string, chapters:{title:string, html:string}[]}} book
 * @param {{indent?:boolean, lineHeight?:number, size?:number, chapterTitles?:boolean}} opt
 */
export async function writeHwpx(book, opt = {}) {
  let header = headerXml;
  const L = opt.layout; // 쪽 설정 (용지·여백·글자·문단·쪽 번호)
  if (L) Object.assign(opt, { size: L.size, lineHeight: L.line / 100 });
  const baseSize = Math.round((opt.size || 10) * 100);
  const HU = 7200 / 25.4;
  // 글꼴 목록: 쓰는 글꼴을 모든 언어 목록에 더한다 (언어마다 번호가 다를 수 있다)
  const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
  const faces = {};
  for (const m of header.matchAll(/<hh:fontface lang="(\w+)" fontCnt="(\d+)">([\s\S]*?)<\/hh:fontface>/g)) {
    faces[m[1]] = { names: [...m[3].matchAll(/face="([^"]*)"/g)].map((x) => x[1]), extra: [] };
  }
  const fontMap = new Map();
  const addFont = (face) => {
    if (fontMap.has(face)) return fontMap.get(face);
    const ref = {};
    for (const lang of Object.keys(faces)) {
      const f = faces[lang];
      let i = f.names.indexOf(X(face));
      if (i < 0) {
        i = f.names.length;
        f.names.push(X(face));
        f.extra.push(`<hh:font id="${i}" face="${X(face)}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_UNKNOWN" weight="5" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/></hh:font>`);
      }
      ref[lang] = i;
    }
    fontMap.set(face, ref);
    return ref;
  };
  const fontRef = (ref) => `<hh:fontRef ${LANGS.map((l) => `${l.toLowerCase()}="${ref[l] ?? 0}"`).join(' ')}/>`;
  const spacingXml = (v) => `<hh:spacing ${LANGS.map((l) => `${l.toLowerCase()}="${v}"`).join(' ')}/>`;
  const baseFont = L?.fontName ? addFont(L.fontName) : null;

  // 글자 모양 추가: 굵게/기울임/밑줄/취소선/색/크기 조합마다 하나씩
  let charTpl = header.match(/<hh:charPr id="0"[\s\S]*?<\/hh:charPr>/)[0];
  if (baseFont) charTpl = charTpl.replace(/<hh:fontRef [^>]*\/>/, fontRef(baseFont));
  if (L?.spacing) charTpl = charTpl.replace(/<hh:spacing [^>]*\/>/, spacingXml(L.spacing));
  let charCount = +header.match(/<hh:charProperties itemCnt="(\d+)"/)[1];
  const charMap = new Map();
  const extraChars = [];
  const charId = (f = {}, size = baseSize) => {
    if (f.size && size === baseSize) size = Math.round(f.size * 100); // 글자마다 정한 크기 (pt)
    const key = JSON.stringify([!!f.bold, !!f.italic, !!f.underline, !!f.strike, f.color || '', size, f.font || '', f.spacing ?? '']);
    if (charMap.has(key)) return charMap.get(key);
    const id = charCount++;
    let x = charTpl.replace('id="0"', `id="${id}"`).replace('height="1000"', `height="${size}"`);
    if (f.font) x = x.replace(/<hh:fontRef [^>]*\/>/, fontRef(addFont(f.font)));
    if (f.spacing != null) x = x.replace(/<hh:spacing [^>]*\/>/, spacingXml(Math.max(-50, Math.min(50, Math.round(f.spacing)))));
    if (f.color) x = x.replace('textColor="#000000"', `textColor="${f.color}"`);
    let deco = '';
    if (f.italic) deco += '<hh:italic/>';
    if (f.bold) deco += '<hh:bold/>';
    x = x.replace('<hh:underline', `${deco}<hh:underline`);
    if (f.underline) x = x.replace('<hh:underline type="NONE"', '<hh:underline type="BOTTOM"');
    if (f.strike) x = x.replace('<hh:strikeout shape="NONE"', '<hh:strikeout shape="SOLID"');
    extraChars.push(x);
    charMap.set(key, id);
    return id;
  };

  // 문단 모양 추가: 정렬·첫 줄 들여쓰기·줄 간격 조합
  let paraTpl = header.match(/<hh:paraPr id="0"[\s\S]*?<\/hh:paraPr>/)[0];
  // 한글 줄 나눔: 어절(KEEP_WORD) 또는 글자(BREAK_WORD)
  paraTpl = paraTpl.replace(/breakNonLatinWord="\w+"/, `breakNonLatinWord="${L?.breakWord === 'char' ? 'BREAK_WORD' : 'KEEP_WORD'}"`);

  let paraCount = +header.match(/<hh:paraProperties itemCnt="(\d+)"/)[1];
  const paraMap = new Map();
  const extraParas = [];
  const lineSp = Math.round((opt.lineHeight || 1.6) * 100);
  // pf: 문단마다 '단락' 창에서 정한 값 {indL, indR, first, line, before, after, brk}
  const paraId = (align = 'JUSTIFY', indent = 0, left = 0, before = 0, pf = null) => {
    const em = (v) => Math.round(v * baseSize);
    let right = 0, after = null, line = lineSp, brk = null;
    if (pf) {
      if (pf.indL != null) left += em(pf.indL);
      if (pf.indR != null) right = em(pf.indR);
      if (pf.first != null) indent = em(pf.first); // 음수면 내어쓰기
      if (pf.line != null) line = Math.round(pf.line);
      if (pf.before != null) before = Math.round(pf.before * 100);
      if (pf.after != null) after = Math.round(pf.after * 100);
      if (pf.brk) brk = pf.brk === 'char' ? 'BREAK_WORD' : 'KEEP_WORD';
    }
    const key = [align, indent, left, before, right, after, line, brk].join();
    if (paraMap.has(key)) return paraMap.get(key);
    const id = paraCount++;
    if (after == null) after = L?.paraAfter ? Math.round(L.paraAfter * 100) : 0;
    // 한글 규칙: hp:case(글자 단위 지원)에는 그대로, hp:default에는 두 배 값을 넣는다
    const margins = (k) => (m) => m
      .replace('<hc:intent value="0"', `<hc:intent value="${indent * k}"`)
      .replace('<hc:left value="0"', `<hc:left value="${left * k}"`)
      .replace('<hc:right value="0"', `<hc:right value="${right * k}"`)
      .replace('<hc:prev value="0"', `<hc:prev value="${before * k}"`)
      .replace('<hc:next value="0"', `<hc:next value="${after * k}"`);
    let x = paraTpl.replace('id="0"', `id="${id}"`)
      .replace('horizontal="JUSTIFY"', `horizontal="${align}"`)
      .replace(/<hp:case[\s\S]*?<\/hp:case>/, margins(1))
      .replace(/<hp:default>[\s\S]*?<\/hp:default>/, margins(2))
      .replaceAll('type="PERCENT" value="160"', `type="PERCENT" value="${line}"`);
    if (brk) x = x.replace(/breakNonLatinWord="\w+"/, `breakNonLatinWord="${brk}"`);
    extraParas.push(x);
    paraMap.set(key, id);
    return id;
  };

  const ALIGN = { center: 'CENTER', right: 'RIGHT', justify: 'JUSTIFY', left: 'LEFT' };
  const BODY = L?.align === 'left' ? 'LEFT' : 'JUSTIFY';
  const indentUnit = L ? Math.round(L.indent * baseSize) : opt.indent ? baseSize * 2 : 0; // 첫 줄 들여쓰기 (HWPUNIT)
  let pid = 1;
  const paras = [];
  const para = (runs, { pPr, bigSize, bold, pageBreak } = {}) => {
    let inner = '';
    for (const r of runs) {
      if (r.br) { inner += `<hp:run charPrIDRef="${charId({}, bigSize || baseSize)}"><hp:t><hp:lineBreak/></hp:t></hp:run>`; continue; }
      if (!r.text) continue;
      const parts = r.text.split('\t').map(X).join('<hp:tab/>');
      inner += `<hp:run charPrIDRef="${charId({ ...r, bold: r.bold || bold }, bigSize || baseSize)}"><hp:t>${parts}</hp:t></hp:run>`;
    }
    if (!inner) inner = `<hp:run charPrIDRef="${charId({}, bigSize || baseSize)}"><hp:t/></hp:run>`;
    paras.push(`<hp:p id="${pid++}" paraPrIDRef="${pPr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${inner}</hp:p>`);
  };

  let first = true;
  if (opt.titlePage) {
    para([{ text: book.title }], { pPr: paraId('CENTER', 0, 0, 20000), bigSize: 2400, bold: true });
    if (book.author) para([{ text: book.author }], { pPr: paraId('CENTER', 0, 0, 2000), bigSize: 1400 });
    first = false;
  }
  for (const ch of book.chapters) {
    const pageBreak = !first;
    first = false;
    let brk = pageBreak;
    if (opt.chapterTitles !== false && ch.title) {
      para([{ text: ch.title }], { pPr: paraId('JUSTIFY', 0, 0, 0), bigSize: 1600, bold: true, pageBreak: brk });
      para([], { pPr: paraId(BODY) });
      brk = false;
    }
    for (const b of htmlToBlocks(ch.html)) {
      if (b.type === 'hr') { para([{ text: '*' }], { pPr: paraId('CENTER'), pageBreak: brk }); brk = false; continue; }
      const head = { h1: 1600, h2: 1400, h3: 1200 }[b.type];
      if (head) { para(b.runs, { pPr: paraId(ALIGN[b.align] || 'JUSTIFY', 0, 0, 0, b.pf), bigSize: head, bold: true, pageBreak: brk }); brk = false; continue; }
      const left = b.type === 'quote' ? 2000 : 0;
      const runs = b.type === 'li' ? [{ text: b.ordered ? '' : '• ' }, ...b.runs] : b.runs;
      para(runs, { pPr: paraId(ALIGN[b.align] || BODY, b.align === 'center' || b.align === 'right' ? 0 : indentUnit, left, 0, b.pf), pageBreak: brk });
      brk = false;
    }
  }

  header = header.replace(/<hh:fontface lang="(\w+)" fontCnt="(\d+)">([\s\S]*?)<\/hh:fontface>/g, (m, lang, cnt, inner) => {
    const f = faces[lang];
    return f?.extra.length ? `<hh:fontface lang="${lang}" fontCnt="${+cnt + f.extra.length}">${inner}${f.extra.join('')}</hh:fontface>` : m;
  });
  header = header
    .replace(/<hh:charProperties itemCnt="\d+">/, `<hh:charProperties itemCnt="${charCount}">`)
    .replace('</hh:charProperties>', extraChars.join('') + '</hh:charProperties>')
    .replace(/<hh:paraProperties itemCnt="\d+">/, `<hh:paraProperties itemCnt="${paraCount}">`)
    .replace('</hh:paraProperties>', extraParas.join('') + '</hh:paraProperties>');

  // 첫 문단(구역 설정 포함)은 그대로 두고 그 뒤에 본문 문단을 붙인다
  let section = sectionXml.replace('</hs:sec>', paras.join('') + '</hs:sec>');
  if (L) {
    const u = (mm) => Math.round(mm * HU);
    const land = L.w > L.h;
    section = section
      .replace(/<hp:pagePr [^>]*>/, `<hp:pagePr landscape="${land ? 'NARROWLY' : 'WIDELY'}" width="${u(land ? L.h : L.w)}" height="${u(land ? L.w : L.h)}" gutterType="${L.mirror ? 'LEFT_RIGHT' : 'LEFT_ONLY'}">`)
      .replace(/<hp:margin [^>]*\/>/, `<hp:margin header="${u(L.mh)}" footer="${u(L.mf)}" gutter="0" left="${u(L.ml)}" right="${u(L.mr)}" top="${u(L.mt)}" bottom="${u(L.mb)}"/>`)
      .replace(/(<hp:startNum [^>]*page=")\d+"/, `$1${L.numStart > 1 ? L.numStart : 0}"`);
    const pos = { outside: 'OUTSIDE_BOTTOM', center: 'BOTTOM_CENTER', right: 'BOTTOM_RIGHT', left: 'BOTTOM_LEFT' }[L.num];
    if (pos) section = section.replace('<hp:run charPrIDRef="0"><hp:t/></hp:run>', `<hp:run charPrIDRef="0"><hp:ctrl><hp:pageNum pos="${pos}" formatType="DIGIT" sideChar=""/></hp:ctrl><hp:t/></hp:run>`);
  }
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const hpf = contentHpf
    .replace('<opf:title/>', `<opf:title>${X(book.title || '')}</opf:title>`)
    .replaceAll('synthetic-fixture-author', X(book.author || ''))
    .replace(/CreatedDate" content="text">[^<]*/, `CreatedDate" content="text">${now}`)
    .replace(/ModifiedDate" content="text">[^<]*/, `ModifiedDate" content="text">${now}`)
    .replace(/name="date" content="text">[^<]*/, 'name="date" content="text">');

  const zip = new JSZip();
  const put = (n, d, o = {}) => zip.file(n, d, { createFolders: false, ...o });
  put('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  put('version.xml', versionXml);
  put('Contents/header.xml', header);
  put('Contents/section0.xml', section);
  put('Contents/content.hpf', hpf);
  put('Preview/PrvText.txt', book.chapters.map((c) => c.title).join('\r\n').slice(0, 1000));
  put('settings.xml', settingsXml);
  put('META-INF/container.xml', containerXml);
  put('META-INF/container.rdf', containerRdf);
  put('META-INF/manifest.xml', manifestXml);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/hwp+zip', compression: 'DEFLATE' });
}
