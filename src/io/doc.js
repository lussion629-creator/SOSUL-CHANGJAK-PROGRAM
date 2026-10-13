// 옛 Word(.doc, Word 97~2003) 열기·저장, 서식 있는 텍스트(.rtf) 열기·저장
// - .doc 읽기: Word 97 이후 바이너리 형식의 조각 표(piece table)를 따라 본문 글자를 꺼낸다(서식은 빠짐).
// - .doc 저장: 바이너리 .doc를 쓰는 공개 도구가 없어, Word·한글이 .doc로 그대로 여는 RTF 형식으로 저장한다.
import CFB from 'cfb';
import { htmlToBlocks } from './model.js';

// ---------- .doc 읽기 ----------
export function readDoc(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const head = new TextDecoder('latin1').decode(u8.slice(0, 16)).trimStart();
  if (head.startsWith('{\\rtf')) return readRtf(arrayBuffer); // 확장자만 .doc인 RTF
  if (head.startsWith('<')) {
    const html = new TextDecoder(sniffHtmlCharset(u8)).decode(u8);
    return htmlToBlocks(new DOMParser().parseFromString(html, 'text/html').body.innerHTML);
  }
  let cfb;
  try { cfb = CFB.read(u8, { type: 'array' }); } catch { throw new Error('Word 문서가 아닙니다.'); }
  const wd = CFB.find(cfb, 'WordDocument');
  if (!wd) throw new Error('Word 97~2003 문서가 아닙니다.');
  const w = Uint8Array.from(wd.content);
  const dv = new DataView(w.buffer);
  const ident = dv.getUint16(0, true);
  if (ident !== 0xa5ec) throw new Error('Word 6.0/95 이전 문서는 열 수 없습니다. Word에서 .docx로 저장한 뒤 열어 주세요.');
  const flags = dv.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error('암호가 걸린 Word 문서는 열 수 없습니다.');
  const table = CFB.find(cfb, flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('Word 문서의 표 정보를 찾지 못했습니다.');
  const t = Uint8Array.from(table.content);
  const tv = new DataView(t.buffer);

  // FIB에서 본문 글자 수(ccpText)와 조각 표 위치(fcClx, lcbClx)를 찾는다
  const csw = dv.getUint16(0x20, true);
  const rgLwOff = 0x22 + csw * 2;
  const cslw = dv.getUint16(rgLwOff, true);
  const ccpText = dv.getInt32(rgLwOff + 2 + 3 * 4, true);
  const fcLcbOff = rgLwOff + 2 + cslw * 4 + 2;
  const fcClx = dv.getUint32(fcLcbOff + 33 * 8, true);
  const lcbClx = dv.getUint32(fcLcbOff + 33 * 8 + 4, true);

  let pos = fcClx;
  const end = fcClx + lcbClx;
  while (pos < end && t[pos] === 0x01) pos += 3 + tv.getUint16(pos + 1, true); // Prc 건너뛰기
  if (t[pos] !== 0x02) throw new Error('Word 문서 구조를 읽지 못했습니다.');
  const lcb = tv.getUint32(pos + 1, true);
  const plc = pos + 5;
  const n = (lcb - 4) / 12;
  let text = '';
  for (let i = 0; i < n && text.length < ccpText; i++) {
    const cpStart = tv.getUint32(plc + i * 4, true);
    const cpEnd = tv.getUint32(plc + (i + 1) * 4, true);
    const pcd = plc + (n + 1) * 4 + i * 8;
    let fc = tv.getUint32(pcd + 2, true);
    const len = cpEnd - cpStart;
    if (fc & 0x40000000) {
      fc = (fc & ~0x40000000) / 2;
      text += new TextDecoder('windows-1252').decode(w.slice(fc, fc + len));
    } else {
      text += new TextDecoder('utf-16le').decode(w.slice(fc, fc + len * 2));
    }
  }
  text = text.slice(0, ccpText);
  return docTextToBlocks(text);
}

function docTextToBlocks(text) {
  // 필드: \x13 코드 \x14 결과 \x15 → 결과만 남긴다
  let out = '', depth = 0;
  const stack = [];
  for (const ch of text) {
    if (ch === '\x13') { stack.push(true); depth++; continue; } // 코드 부분 시작
    if (ch === '\x14') { if (stack.length) stack[stack.length - 1] = false; continue; } // 결과 부분
    if (ch === '\x15') { stack.pop(); depth--; continue; }
    if (stack.some((inCode) => inCode)) continue;
    out += ch;
  }
  const blocks = [];
  for (const raw of out.split(/[\r\x07]/)) {
    if (raw.includes('\x0c')) {
      const [a, ...rest] = raw.split('\x0c');
      if (a) blocks.push(para(a));
      blocks.push({ type: 'pagebreak' });
      if (rest.join('')) blocks.push(para(rest.join('')));
      continue;
    }
    blocks.push(para(raw));
  }
  while (blocks.length && isBlank(blocks[blocks.length - 1])) blocks.pop();
  return blocks.filter((b) => b.type !== 'pagebreak');
}
const isBlank = (b) => b.type === 'p' && !b.runs.some((r) => r.text?.trim());
function para(s) {
  const runs = [];
  s.replace(/[\x01\x08]/g, '').split('\x0b').forEach((part, i) => {
    if (i) runs.push({ text: '', br: true });
    if (part) runs.push({ text: part.replace(/\x1e/g, '-').replace(/\x1f/g, '').replace(/\xa0/g, ' ') });
  });
  return { type: 'p', runs };
}
function sniffHtmlCharset(u8) {
  const m = new TextDecoder('latin1').decode(u8.slice(0, 2048)).match(/charset=["']?([\w-]+)/i);
  try { new TextDecoder(m?.[1]); return m?.[1] || 'utf-8'; } catch { return 'utf-8'; }
}

// ---------- .rtf 읽기 ----------
const CP = { 949: 'euc-kr', 1252: 'windows-1252', 932: 'shift_jis', 936: 'gbk', 950: 'big5', 65001: 'utf-8', 1251: 'windows-1251' };
const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'latentstyles', 'datastore', 'themedata', 'colorschememapping', 'object', 'fldinst', 'footnote', 'pgdsctbl', 'revtbl', 'filetbl', 'bkmkstart', 'bkmkend']);

export function readRtf(arrayBuffer) {
  const src = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer));
  let codepage = 'windows-1252';
  const fonts = {}; // 글꼴 번호 → 문자 집합
  const m0 = src.match(/\\ansicpg(\d+)/);
  if (m0 && CP[m0[1]]) codepage = CP[m0[1]];
  for (const m of src.matchAll(/\\f(\d+)[^;{}]*?\\fcharset(\d+)/g)) fonts[m[1]] = +m[2];
  const charsetCp = (cs) => ({ 129: 'euc-kr', 128: 'shift_jis', 134: 'gbk', 136: 'big5', 0: 'windows-1252', 204: 'windows-1251' }[cs]);

  const blocks = [];
  let runs = [];
  let st = { b: false, i: false, ul: false, strike: false, skip: false, uc: 1, f: null };
  let pst = { align: undefined, outline: -1 };
  const stack = [];
  let bytes = [];
  let pendingSkip = 0;
  const flushBytes = () => {
    if (!bytes.length) return;
    const cp = (st.f != null && fonts[st.f] != null && charsetCp(fonts[st.f])) || codepage;
    let s;
    try { s = new TextDecoder(cp).decode(new Uint8Array(bytes)); } catch { s = String.fromCharCode(...bytes); }
    bytes = [];
    addText(s);
  };
  const addText = (s) => {
    if (st.skip || !s) return;
    const last = runs[runs.length - 1];
    const f = { bold: st.b || undefined, italic: st.i || undefined, underline: st.ul || undefined, strike: st.strike || undefined };
    if (last && !last.br && last.bold === f.bold && last.italic === f.italic && last.underline === f.underline && last.strike === f.strike) last.text += s;
    else runs.push({ text: s, ...f });
  };
  const endPara = () => {
    flushBytes();
    if (pst.outline >= 0 && !runs.some((r) => r.text?.trim())) { runs = []; return; } // 빈 제목 줄
    const type = pst.outline >= 0 && pst.outline <= 2 ? `h${pst.outline + 1}` : 'p';
    blocks.push({ type, align: pst.align, runs });
    runs = [];
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') { flushBytes(); stack.push({ ...st }); i++; if (src.startsWith('\\*', i)) { st.skip = true; } continue; }
    if (c === '}') { flushBytes(); st = stack.pop() || st; i++; continue; }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (c !== '\\') {
      if (pendingSkip > 0) { pendingSkip--; i++; continue; }
      flushBytes(); addText(c); i++; continue;
    }
    // 제어어
    const nx = src[i + 1];
    if (nx === "'") {
      const hex = parseInt(src.substr(i + 2, 2), 16);
      i += 4;
      if (pendingSkip > 0) { pendingSkip--; continue; }
      if (!st.skip) bytes.push(hex);
      continue;
    }
    if (nx === '\\' || nx === '{' || nx === '}') { flushBytes(); addText(nx); i += 2; continue; }
    if (nx === '~') { flushBytes(); addText(' '); i += 2; continue; }
    if (nx === '-' || nx === '_') { i += 2; continue; }
    if (nx === '*') { st.skip = true; i += 2; continue; }
    const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
    if (!m) { i++; continue; }
    i += m[0].length;
    const word = m[1], arg = m[2] === undefined ? null : +m[2];
    if (SKIP.has(word)) { flushBytes(); st.skip = true; continue; }
    if (st.skip) { if (word === 'u') pendingSkip = st.uc; if (word === 'bin') i += arg || 0; continue; }
    if (word !== 'u') flushBytes();
    switch (word) {
      case 'par': case 'sect': endPara(); break;
      case 'page': if (runs.length) endPara(); break;
      case 'line': runs.push({ text: '', br: true }); break;
      case 'tab': addText('\t'); break;
      case 'cell': addText(' '); break;
      case 'row': endPara(); break;
      case 'emdash': addText('—'); break;
      case 'endash': addText('–'); break;
      case 'lquote': addText('‘'); break;
      case 'rquote': addText('’'); break;
      case 'ldblquote': addText('“'); break;
      case 'rdblquote': addText('”'); break;
      case 'bullet': addText('•'); break;
      case 'u': flushBytes(); addText(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); pendingSkip = st.uc; break;
      case 'uc': st.uc = arg ?? 1; break;
      case 'b': st.b = arg !== 0; break;
      case 'i': st.i = arg !== 0; break;
      case 'ul': st.ul = arg !== 0; break;
      case 'ulnone': st.ul = false; break;
      case 'strike': st.strike = arg !== 0; break;
      case 'plain': st.b = st.i = st.ul = st.strike = false; break;
      case 'f': st.f = arg; break;
      case 'pard': pst = { align: undefined, outline: -1 }; break;
      case 'qc': pst.align = 'center'; break;
      case 'qr': pst.align = 'right'; break;
      case 'qj': pst.align = undefined; break;
      case 'outlinelevel': pst.outline = arg; break;
      case 'bin': i += arg || 0; break;
      default: break;
    }
  }
  flushBytes();
  if (runs.length) endPara();
  while (blocks.length && !blocks[blocks.length - 1].runs.some((r) => r.text?.trim())) blocks.pop();
  return blocks;
}

// ---------- .rtf / .doc 저장 ----------
const rtfText = (s) => {
  let o = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') o += '\\' + ch;
    else if (ch === '\t') o += '\\tab ';
    else if (c < 128) o += ch;
    else if (c > 0xffff) { // 서로게이트 쌍
      const hi = Math.floor((c - 0x10000) / 0x400) + 0xd800, lo = ((c - 0x10000) % 0x400) + 0xdc00;
      o += `\\u${hi - 65536}?\\u${lo - 65536}?`;
    } else o += `\\u${c > 32767 ? c - 65536 : c}?`;
  }
  return o;
};

export async function writeRtf(book, opt = {}) {
  const size = Math.round((opt.size || 10.5) * 2);
  const sl = Math.round(240 * (opt.lineHeight || 1.6));
  const indent = opt.indent ? size * 20 : 0; // 두 글자 정도 (twip)
  const body = [];
  const runs = (rs = []) => rs.map((r) => {
    if (r.br) return '\\line ';
    if (!r.text) return '';
    let s = rtfText(r.text);
    if (r.bold) s = `\\b ${s}\\b0 `;
    if (r.italic) s = `\\i ${s}\\i0 `;
    if (r.underline) s = `\\ul ${s}\\ulnone `;
    if (r.strike) s = `\\strike ${s}\\strike0 `;
    return `{${s}}`;
  }).join('');
  const ALIGN = { center: '\\qc', right: '\\qr' };
  const p = (inner, { align, fi = indent, fs = size, extra = '' } = {}) =>
    body.push(`\\pard\\plain\\f0\\fs${fs}${align ? ALIGN[align] || '\\qj' : '\\qj'}\\fi${fi}\\sl${sl}\\slmult1${extra} ${inner}\\par`);

  if (opt.titlePage) {
    body.push(`\\pard\\plain\\f0\\qc\\sb4000\\fs48\\b ${rtfText(book.title)}\\b0\\par`);
    if (book.author) body.push(`\\pard\\plain\\f0\\qc\\sb400\\fs28 ${rtfText(book.author)}\\par`);
    body.push('\\page');
  }
  book.chapters.forEach((ch, idx) => {
    if (idx > 0 && opt.chapterBreak !== false) body.push('\\page');
    if (opt.chapterTitles !== false && ch.title) {
      body.push(`\\pard\\plain\\f0\\outlinelevel0\\sa400\\fs32\\b ${rtfText(ch.title)}\\b0\\par`);
    }
    for (const b of htmlToBlocks(ch.html)) {
      if (b.type === 'hr') { p('*', { align: 'center', fi: 0 }); continue; }
      const head = { h1: 32, h2: 28, h3: 24 }[b.type];
      if (head) { p(`\\b ${runs(b.runs)}\\b0`, { align: b.align, fi: 0, fs: head, extra: `\\outlinelevel${+b.type[1] - 1}` }); continue; }
      if (b.type === 'quote') { p(runs(b.runs), { fi: 0, extra: '\\li720' }); continue; }
      if (b.type === 'li') { p((b.ordered ? '' : '\\bullet\\tab ') + runs(b.runs), { fi: -360, extra: '\\li360' }); continue; }
      p(runs(b.runs), { align: b.align, fi: b.align === 'center' || b.align === 'right' ? 0 : indent });
    }
  });
  const font = opt.font || 'Batang';
  const rtf = `{\\rtf1\\ansi\\ansicpg949\\deff0\\uc1{\\fonttbl{\\f0\\froman\\fcharset129 ${font};}}` +
    `{\\info{\\title ${rtfText(book.title || '')}}{\\author ${rtfText(book.author || '')}}}` +
    `\\paperw11906\\paperh16838\\margl1440\\margr1440\\margt1701\\margb1440\\deflang1042\n` +
    body.join('\n') + '}';
  return new Blob([rtf], { type: 'application/rtf' });
}
