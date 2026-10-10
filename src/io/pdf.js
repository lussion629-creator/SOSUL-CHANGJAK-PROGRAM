// PDF 열기: 글자를 꺼내 줄·문단을 복원한 뒤 편집할 수 있는 원고로 바꾼다.
// 스캔한 이미지 PDF(글자 정보가 없는 PDF)는 읽을 수 없다.
let pdfjsP;
async function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = (async () => {
      const lib = await import('pdfjs-dist');
      const { default: PdfWorker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline');
      lib.GlobalWorkerOptions.workerPort = new PdfWorker();
      return lib;
    })();
  }
  return pdfjsP;
}

export async function readPdf(arrayBuffer, onProgress) {
  const lib = await pdfjs();
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('암호가 걸린 PDF는 열 수 없습니다.');
    throw new Error('PDF를 읽지 못했습니다: ' + e.message);
  }
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress?.(n, doc.numPages);
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    pages.push(toLines(tc.items.filter((it) => 'str' in it)));
  }
  const all = pages.flat();
  if (all.reduce((a, l) => a + l.text.length, 0) < 5) throw new Error('이 PDF에는 글자 정보가 없습니다(스캔한 이미지 PDF). 글자 인식(OCR)을 거친 PDF나 원본 파일로 열어 주세요.');
  // 문서 전체에서 본문 글자 크기, 줄 간격, 왼쪽·오른쪽 여백을 잰다
  const bodyH = median(all.map((l) => l.h));
  const gaps = [];
  for (const ls of pages) for (let i = 1; i < ls.length; i++) { const g = ls[i - 1].y - ls[i].y; if (g > 0 && g < bodyH * 3) gaps.push(g); }
  const geo = {
    bodyH,
    lineGap: median(gaps.length ? gaps : [bodyH * 1.5]),
    left: percentile(all.map((l) => l.x), 0.1),
    right: percentile(all.map((l) => l.right), 0.9),
  };
  const blocks = [];
  for (const ls of pages) pageToBlocks(ls, geo, blocks);
  // 가장 큰 제목을 장 제목(제목 1)으로
  if (!blocks.some((b) => b.type === 'h1')) blocks.forEach((b) => { if (b.type === 'h2') b.type = 'h1'; });
  return blocks;
}

// 글자 조각을 같은 높이끼리 모아 줄로 만든다
function toLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str && !it.hasEOL) continue;
    const x = it.transform[4], y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 10;
    let row = rows.find((r) => Math.abs(r.y - y) < h * 0.5);
    if (!row) { row = { y, h, items: [] }; rows.push(row); }
    row.items.push({ x, w: it.width, str: it.str, h });
    row.h = Math.max(row.h, h);
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.items.sort((a, b) => a.x - b.x);
    let text = '', prevEnd = null;
    r.items.forEach((it, k) => {
      // 숫자·영문 글꼴과 한글 글꼴이 바뀌는 자리에 PDF가 끼워 넣은 좁은 빈칸은 버린다 (예: "1 번째" → "1번째")
      if (/^\s+$/.test(it.str) && it.w < it.h * 0.25) {
        const a = r.items[k - 1]?.str.slice(-1) || '', b = r.items[k + 1]?.str[0] || '';
        if ((/[0-9A-Za-z]/.test(a) && /[가-힣]/.test(b)) || (/[가-힣]/.test(a) && /[0-9A-Za-z]/.test(b))) return;
      }
      if (prevEnd !== null && it.x - prevEnd > it.h * 0.5 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      text += it.str;
      prevEnd = it.x + it.w;
    });
    return { y: r.y, h: r.h, x: r.items[0].x, right: prevEnd, text: text.replace(/\s+$/, '') };
  }).filter((l) => l.text.trim());
}

function pageToBlocks(lines, { bodyH, lineGap, left, right }, blocks) {
  // 쪽 번호·머리글처럼 보이는 줄은 뺀다 (맨 위·맨 아래의 숫자만 있는 줄)
  lines = lines.filter((l, i) => !((i === 0 || i === lines.length - 1) && /^[-–—\s]*\d{1,4}([-–—\s]|\s*(of|\/)\s*\d+)*$/.test(l.text)));
  if (!lines.length) return;

  // 앞 쪽 마지막 문단이 오른쪽 끝까지 찼고 이 쪽 첫 줄이 들여쓰기가 아니면 같은 문단이 이어지는 것
  const last = blocks[blocks.length - 1];
  const first = lines[0];
  let cur = last?._full && last.type === 'p' && first.x - left <= bodyH * 0.6 && first.h <= bodyH * 1.25 ? blocks.pop() : null;
  const close = () => { if (cur) { blocks.push(cur); cur = null; } };
  lines.forEach((l, i) => {
    const gap = i ? lines[i - 1].y - l.y : 0;
    const prev = lines[i - 1];
    const indented = l.x - left > bodyH * 0.6;
    const centered = Math.abs((l.x + l.right) / 2 - (left + right) / 2) < bodyH && l.x - left > bodyH * 2;
    const big = l.h > bodyH * 1.25;
    const prevShort = prev && prev.right < right - bodyH * 2; // 앞 줄이 오른쪽 끝까지 가지 않았으면 문단이 끝난 것
    const newPara = !cur || (i > 0 && gap > lineGap * 1.4 || indented || prevShort || big || centered || (prev && prev.h > bodyH * 1.25)) || (i === 0 && !cur);
    if (newPara) {
      close();
      cur = { type: big ? (l.h > bodyH * 1.6 ? 'h1' : 'h2') : 'p', align: centered && !big ? 'center' : undefined, runs: [{ text: l.text.trim() }] };
    } else {
      const t = cur.runs[0].text;
      // 줄 끝은 대개 띄어쓰기 자리라서 한 칸 띄워 잇는다
      const joiner = /\s$/.test(t) ? '' : ' ';
      cur.runs[0].text = t + joiner + l.text.trim();
    }
    cur._full = l.right >= right - bodyH * 2;
  });
  close();
}
const percentile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 10; };
