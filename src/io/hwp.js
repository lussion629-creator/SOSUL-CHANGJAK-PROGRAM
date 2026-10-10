// 한글 97 이후의 바이너리 .hwp(HWP 5.x) 읽기 — 본문 글자만 가져온다.
// .hwp 저장은 공개된 쓰기 도구가 없어 지원하지 않는다(대신 .hwpx로 저장하면 한글에서 그대로 열린다).
import CFB from 'cfb';
import { inflateRaw, inflate } from 'pako';

const PARA_HEADER = 66; // HWPTAG_BEGIN(16) + 50
const PARA_TEXT = 67;

export function readHwp(arrayBuffer) {
  const cfb = CFB.read(new Uint8Array(arrayBuffer), { type: 'array' });
  const header = CFB.find(cfb, 'FileHeader');
  if (!header) throw new Error('HWP 파일이 아닙니다.');
  const head = Uint8Array.from(header.content.slice(0, 40));
  const sig = new TextDecoder('ascii').decode(head.slice(0, 17));
  if (!sig.startsWith('HWP Document File')) throw new Error('HWP 5.0 형식이 아닙니다. (한글 97 이전 파일은 열 수 없습니다)');
  const flags = head[36] | (head[37] << 8);
  const compressed = !!(flags & 1);
  if (flags & 2) throw new Error('암호가 걸린 HWP 파일은 열 수 없습니다.');
  if (flags & 4) throw new Error('배포용 문서는 열 수 없습니다. 한글에서 hwpx나 docx로 저장한 뒤 열어 주세요.');

  const sections = cfb.FullPaths
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => /BodyText\/Section\d+$/.test(p))
    .sort((a, b) => +a.p.match(/(\d+)$/)[1] - +b.p.match(/(\d+)$/)[1]);

  const paras = [];
  for (const { i } of sections) {
    let data = cfb.FileIndex[i].content;
    data = Uint8Array.from(data);
    if (compressed) {
      try { data = inflateRaw(data); } catch { data = inflate(data); }
    }
    readRecords(data, paras);
  }
  while (paras.length && !paras[0].trim()) paras.shift();
  return paras;
}

function readRecords(buf, out) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  let pending = false; // 글자 없는 빈 문단(PARA_HEADER만 있고 PARA_TEXT가 없음)
  while (pos + 4 <= buf.length) {
    const h = dv.getUint32(pos, true);
    pos += 4;
    const tag = h & 0x3ff;
    let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) { size = dv.getUint32(pos, true); pos += 4; }
    if (tag === PARA_HEADER) { if (pending) out.push(''); pending = true; }
    if (tag === PARA_TEXT) { out.push(decodeParaText(buf.subarray(pos, pos + size))); pending = false; }
    pos += size;
  }
  if (pending) out.push('');
}

// 문단 글자: UTF-16LE. 0~31 사이는 제어 문자이며 종류에 따라 1칸 또는 8칸을 차지한다.
function decodeParaText(b) {
  let s = '';
  for (let i = 0; i + 1 < b.length;) {
    const c = b[i] | (b[i + 1] << 8);
    if (c >= 32) { s += String.fromCharCode(c); i += 2; continue; }
    if (c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31)) {
      if (c === 10) s += '\n';
      if (c === 30 || c === 31) s += ' '; // 묶음 빈칸, 고정폭 빈칸
      i += 2;
      continue;
    }
    if (c === 9) s += '\t';
    i += 16; // 인라인·확장 제어 문자(8 WCHAR)
  }
  return s.replace(/\r/g, '');
}
