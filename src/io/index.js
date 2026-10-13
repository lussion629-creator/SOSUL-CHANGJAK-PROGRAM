// 파일 열기·내보내기 진입점
import { readDocx, writeDocx } from './docx.js';
import { readHwpx, writeHwpx } from './hwpx.js';
import { readHwp } from './hwp.js';
import { readDoc, readRtf, writeRtf } from './doc.js';
import { readPdf } from './pdf.js';
import { textBlocks, splitChapters, blocksToHtml, htmlToBlocks } from './model.js';
import { htmlToParagraphs } from '../stats.js';

export const OPEN_ACCEPT = '.docx,.doc,.hwpx,.hwp,.pdf,.rtf,.txt,.md,.html,.htm,.novel.json,.json,.gz';

/** @returns {Promise<{kind:'book', title, chapters:{title,html}[]} | {kind:'bundle', data}>} */
export async function openFile(file, { onProgress } = {}) {
  const name = file.name;
  const base = name.replace(/\.(novel\.json(\.gz)?|[^.]+)$/i, '');
  const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
  const buf = await file.arrayBuffer();
  const asText = () => decodeText(buf);

  if (ext === 'json' || ext === 'gz') {
    const { readBundleBytes } = await import('../store.js');
    const data = await readBundleBytes(buf);
    if (data.format === 'novel-writer') return { kind: 'bundle', data };
    throw new Error('알 수 없는 JSON 파일입니다.');
  }
  let blocks;
  if (ext === 'docx') {
    const head = new Uint8Array(buf.slice(0, 2));
    blocks = head[0] === 0x50 && head[1] === 0x4b ? await readDocx(buf) : readDoc(buf); // 확장자만 docx인 옛 문서
  } else if (ext === 'doc') {
    const head = new Uint8Array(buf.slice(0, 2));
    blocks = head[0] === 0x50 && head[1] === 0x4b ? await readDocx(buf) : readDoc(buf); // 확장자만 doc인 docx
  } else if (ext === 'rtf') blocks = readRtf(buf);
  else if (ext === 'pdf') blocks = await readPdf(buf, onProgress);
  else if (ext === 'hwpx') blocks = await readHwpx(buf);
  else if (ext === 'hwp') {
    const head = new Uint8Array(buf.slice(0, 4));
    // 확장자는 hwp지만 실제로는 hwpx(zip)인 경우
    if (head[0] === 0x50 && head[1] === 0x4b) blocks = await readHwpx(buf);
    else blocks = textBlocks(readHwp(buf));
  } else if (ext === 'html' || ext === 'htm') {
    blocks = htmlToBlocks(new DOMParser().parseFromString(asText(), 'text/html').body.innerHTML);
  } else if (ext === 'md') blocks = mdToBlocks(asText());
  else blocks = txtToBlocks(asText());

  // 가운데 별표 한 줄(* / * * * / ⁂)은 장면 전환으로
  blocks = blocks.map((b) => (b.runs && /^\s*(\*\s*){1,3}$|^\s*⁂\s*$/.test(b.runs.map((r) => r.text || '').join('')) ? { type: 'hr' } : b));
  return { kind: 'book', title: base, chapters: splitChapters(blocks, base) };
}

function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('euc-kr').decode(buf); }
}

// 텍스트: 빈 줄로 문단을 나눈 글이면 빈 줄 기준, 아니면 줄마다 문단
function txtToBlocks(t) {
  t = t.replace(/\r\n?/g, '\n');
  // 문단 사이를 빈 줄로 띄운 글(빈 줄이 전체의 30% 이상)이면 빈 줄 기준, 아니면 한 줄이 한 문단
  const lines = t.split('\n');
  const blank = lines.filter((l) => !l.trim()).length;
  const paras = blank >= lines.length * 0.3 ? t.split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ')) : lines;
  return paras.map((p) => p.trim() === '***' || p.trim() === '* * *' ? { type: 'hr' } : { type: 'p', runs: [{ text: p }] });
}

function mdToBlocks(t) {
  const out = [];
  for (const line of t.replace(/\r\n?/g, '\n').split('\n')) {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) out.push({ type: `h${h[1].length}`, runs: [{ text: h[2] }] });
    else if (/^\s*(\*\s*){3,}$|^\s*-{3,}\s*$/.test(line)) out.push({ type: 'hr' });
    else if (/^>\s?/.test(line)) out.push({ type: 'quote', runs: mdInline(line.replace(/^>\s?/, '')) });
    else if (line.trim()) out.push({ type: 'p', runs: mdInline(line) });
  }
  return out;
}
function mdInline(s) {
  const runs = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    if (m[2]) runs.push({ text: m[2], bold: true });
    else if (m[3]) runs.push({ text: m[3], italic: true });
    else runs.push({ text: m[4], strike: true });
    last = re.lastIndex;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs;
}

// ---------- 내보내기 ----------
export async function exportBook(format, book, opt) {
  const safe = (book.title || '원고').replace(/[\\/:*?"<>|]/g, '_');
  if (format === 'docx') return { blob: await writeDocx(book, opt), name: `${safe}.docx` };
  if (format === 'doc') return { blob: await writeRtf(book, opt), name: `${safe}.doc` };
  if (format === 'rtf') return { blob: await writeRtf(book, opt), name: `${safe}.rtf` };
  if (format === 'hwpx') return { blob: await writeHwpx(book, opt), name: `${safe}.hwpx` };
  if (format === 'txt') {
    const body = book.chapters.map((c) => (opt.chapterTitles !== false ? c.title + '\n\n' : '') + htmlToParagraphs(c.html).map((p) => (opt.indent && p.trim() ? '　' : '') + p).join('\n')).join('\n\n\n');
    return { blob: new Blob(['﻿' + body], { type: 'text/plain;charset=utf-8' }), name: `${safe}.txt` };
  }
  if (format === 'md') {
    const body = book.chapters.map((c) => (opt.chapterTitles !== false ? `# ${c.title}\n\n` : '') + htmlToParagraphs(c.html).join('\n\n')).join('\n\n');
    return { blob: new Blob([body], { type: 'text/markdown;charset=utf-8' }), name: `${safe}.md` };
  }
  if (format === 'html') {
    const body = book.chapters.map((c) => `<section${opt.chapterBreak === false ? ' class="cont"' : ''}>${opt.chapterTitles !== false ? `<h1>${c.title}</h1>` : ''}${c.html}</section>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>${book.title}</title><style>body{font-family:serif;max-width:40em;margin:3em auto;line-height:1.8}section{page-break-after:always}section.cont{page-break-after:auto}p{margin:0;text-indent:1em}</style>${body}`;
    return { blob: new Blob([html], { type: 'text/html;charset=utf-8' }), name: `${safe}.html` };
  }
  throw new Error('지원하지 않는 형식');
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export { blocksToHtml };
