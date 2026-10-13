// Word(.docx) 열기·저장
import mammoth from 'mammoth/mammoth.browser.js';
import {
  Document, Packer, Paragraph, TextRun, ShadingType, CommentRangeStart, CommentRangeEnd, CommentReference, HeadingLevel, AlignmentType, PageBreak, Footer, PageNumber, LineRuleType, PageOrientation,
} from 'docx';
import { htmlToBlocks } from './model.js';

export async function readDocx(arrayBuffer) {
  const res = await mammoth.convertToHtml({ arrayBuffer }, {
    styleMap: ['u => u', 'strike => s'],
    includeDefaultStyleMap: true,
  });
  return htmlToBlocks(res.value);
}

const ALIGN = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED, left: AlignmentType.LEFT };

// cm: 본문 주석을 Word 메모로 {num: id→번호, started: Set, last: id→마지막 자리, at: 지금 문단 자리}
function runsToDocx(runs = [], base = {}, cm = null) {
  const out = [];
  runs.forEach((r, ri) => {
    if (r.br) { out.push(new TextRun({ break: 1 })); return; }
    if (!r.text) return;
    const ids = cm ? (r.anno || []).filter((id) => cm.num.has(id)) : [];
    for (const id of ids) if (!cm.started.has(id)) { cm.started.add(id); out.push(new CommentRangeStart(cm.num.get(id))); }
    out.push(new TextRun({
      text: r.text,
      bold: r.bold || base.bold,
      italics: r.italic,
      underline: r.underline ? {} : undefined,
      strike: r.strike,
      color: r.color ? r.color.replace('#', '') : undefined,
      shading: r.highlight ? { type: ShadingType.CLEAR, color: 'auto', fill: (/^#[0-9a-f]{6}$/i.test(r.highlight) ? r.highlight : '#fff2a8').slice(1) } : undefined, // 형광펜: 고른 색 그대로
      font: r.font || undefined,
      size: r.size ? Math.round(r.size * 2) : base.size,
      characterSpacing: r.spacingPt != null ? Math.round(r.spacingPt * 20) : r.spacing != null && base.pt ? Math.round((r.size || base.pt) * r.spacing / 100 * 20) : undefined,
    }));
    for (const id of ids) {
      if (cm.last.get(id) !== `${cm.at}:${ri}`) continue;
      const n = cm.num.get(id);
      out.push(new CommentRangeEnd(n), new TextRun({ children: [new CommentReference(n)] }));
    }
  });
  return out;
}

/**
 * @param {{title:string, author?:string, chapters:{title:string, html:string}[]}} book
 * @param {{font?:string, size?:number, indent?:boolean, lineHeight?:number, titlePage?:boolean, chapterTitles?:boolean}} opt
 */
export async function writeDocx(book, opt = {}) {
  const L = opt.layout; // 쪽 설정
  const font = L?.fontName || opt.font || '바탕';
  const size = Math.round((L?.size || opt.size || 10) * 2);
  // 한글처럼 줄 간격을 글자 크기의 몇 %로: 고정 줄 높이(1/20pt)로 넣는다
  const spacing = L ? { line: Math.round(L.size * L.line / 100 * 20), lineRule: LineRuleType.EXACT, after: Math.round((L.paraAfter || 0) * 20) }
    : { line: Math.round(240 * (opt.lineHeight || 1.6)), lineRule: LineRuleType.AUTO, after: opt.paraSpacing ? 120 : 0 };
  const firstLine = L ? Math.round(L.indent * L.size * 20) : opt.indent ? size * 10 : 0;
  const bodyAlign = L?.align === 'left' ? AlignmentType.LEFT : AlignmentType.JUSTIFIED;
  const keepWord = !L || L.breakWord !== 'char'; // 한글 어절 단위 줄 나눔
  const pt = L?.size || opt.size || 10;
  const rb = { pt };
  // 문단마다 '단락' 창에서 바꾼 값(여백·첫 줄·줄 간격·위아래·줄 나눔)을 덮어쓴다
  const em = (v) => Math.round(v * pt * 20);
  const paraProps = (b, indent0, spacing0) => {
    const pf = b.pf || {};
    const indent = { ...(indent0 || {}) };
    if (pf.indL != null) indent.left = (indent.left || 0) + em(pf.indL);
    if (pf.indR != null) indent.right = em(pf.indR);
    if (pf.first != null) {
      delete indent.firstLine; delete indent.hanging;
      if (pf.first > 0) indent.firstLine = em(pf.first);
      else if (pf.first < 0) { indent.hanging = em(-pf.first); indent.left = (indent.left || 0) + em(-pf.first); }
    }
    const sp = { ...(spacing0 || {}) };
    if (pf.lineType) Object.assign(sp, { line: Math.round(pf.linePt * 20), lineRule: pf.lineType === 'min' ? LineRuleType.AT_LEAST : LineRuleType.EXACT });
    else if (pf.line != null) Object.assign(sp, L ? { line: Math.round(pt * pf.line / 100 * 20), lineRule: LineRuleType.EXACT } : { line: Math.round(240 * pf.line / 100), lineRule: LineRuleType.AUTO });
    if (pf.before != null) sp.before = Math.round(pf.before * 20);
    if (pf.after != null) sp.after = Math.round(pf.after * 20);
    return { indent: Object.keys(indent).length ? indent : undefined, spacing: Object.keys(sp).length ? sp : undefined, wordWrap: pf.brk ? pf.brk !== 'char' : keepWord };
  };
  const children = [];

  if (opt.titlePage) {
    children.push(new Paragraph({ spacing: { before: 4000 } }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: book.title, bold: true, size: 48 })] }));
    if (book.author) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400 }, children: [new TextRun({ text: book.author, size: 28 })] }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // 본문 주석 → Word 메모: 각 주석이 처음 나오는 곳에서 범위를 열고 마지막에 닫는다
  const chBlocks = book.chapters.map((ch) => htmlToBlocks(ch.html));
  const cm = book.annos ? { num: new Map(), started: new Set(), last: new Map(), at: '' } : null;
  const comments = [];
  if (cm) {
    chBlocks.forEach((bs, ci) => bs.forEach((b, bi) => (b.runs || []).forEach((r, ri) => (r.br || !r.text ? [] : r.anno || []).forEach((id) => {
      if (!book.annos[id]) return;
      if (!cm.num.has(id)) {
        const a = book.annos[id];
        cm.num.set(id, comments.length);
        comments.push({ id: comments.length, author: a.author || '지은이', initials: (a.author || '지')[0], date: new Date(a.time || Date.now()), children: a.text.split('\n').map((t) => new Paragraph({ children: [new TextRun(t)] })) });
      }
      cm.last.set(id, `${ci}.${bi}:${ri}`);
    }))));
  }
  book.chapters.forEach((ch, i) => {
    if (i > 0 && opt.chapterBreak !== false) children.push(new Paragraph({ children: [new PageBreak()] }));
    if (opt.chapterTitles !== false && ch.title) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 400 }, children: [new TextRun({ text: ch.title })] }));
    }
    chBlocks[i].forEach((b, bi) => {
      if (cm) cm.at = `${i}.${bi}`;
      if (b.type === 'hr') { children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 }, children: [new TextRun('*')] })); return; }
      if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') {
        const lv = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3 }[b.type];
        children.push(new Paragraph({ heading: lv, alignment: ALIGN[b.align], ...paraProps(b), children: runsToDocx(b.runs, rb, cm) }));
        return;
      }
      children.push(new Paragraph({
        alignment: ALIGN[b.align] || bodyAlign,
        ...paraProps(b, b.type === 'quote' ? { left: 720 } : (firstLine && b.align !== 'center' && b.align !== 'right' ? { firstLine } : undefined), spacing),
        bullet: b.type === 'li' && !b.ordered ? { level: 0 } : undefined,
        children: runsToDocx(b.runs, rb, cm),
      }));
    });
  });

  const doc = new Document({
    ...(comments.length ? { comments: { children: comments } } : {}),
    creator: book.author || '',
    title: book.title,
    styles: {
      default: { document: { run: { font: { ascii: font, eastAsia: font, hAnsi: font }, size, characterSpacing: L?.spacing ? Math.round(L.size * L.spacing / 100 * 20) : undefined } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, font: { eastAsia: font, ascii: font } }, paragraph: { spacing: { before: 240, after: 240 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true }, paragraph: { spacing: { before: 200, after: 200 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true }, paragraph: { spacing: { before: 160, after: 160 } } },
      ],
    },
    evenAndOddHeaderAndFooters: L?.num === 'outside',
    sections: [{
      properties: L ? {
        page: {
          size: { width: tw(Math.min(L.w, L.h)), height: tw(Math.max(L.w, L.h)), orientation: L.w > L.h ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
          // 한글의 머리말·꼬리말 칸은 Word에서 본문 여백에 더하고, 머리말·꼬리말 위치는 바깥 여백으로 둔다
          margin: { top: tw(L.mt + L.mh), bottom: tw(L.mb + L.mf), left: tw(L.ml), right: tw(L.mr), header: tw(L.mt), footer: tw(L.mb) },
          pageNumbers: L.numStart > 1 ? { start: L.numStart } : undefined,
        },
      } : { page: { size: { width: 11906, height: 16838 }, margin: { top: 1701, bottom: 1440, left: 1440, right: 1440 } } },
      footers: footersFor(L),
      children,
    }],
  });
  const blob = await Packer.toBlob(doc);
  if (!L?.mirror || L.ml === L.mr) return blob;
  // 맞쪽 여백: Word 설정 파일에 mirrorMargins를 넣는다
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(blob);
  const st = await zip.file('word/settings.xml').async('string');
  // 스키마 순서: mirrorMargins는 displayBackgroundShape 등 뒤, evenAndOddHeaders 등 앞
  const after = /<w:(alignBordersAndEdges|bordersDoNotSurroundHeader|bordersDoNotSurroundFooter|gutterAtTop|hideSpellingErrors|hideGrammaticalErrors|activeWritingStyle|proofState|formsDesign|attachedTemplate|linkStyles|stylePaneFormatFilter|stylePaneSortMethod|documentType|mailMerge|revisionView|trackRevisions|doNotTrackMoves|doNotTrackFormatting|documentProtection|autoFormatOverride|styleLockTheme|styleLockQFSet|defaultTabStop|autoHyphenation|consecutiveHyphenLimit|hyphenationZone|doNotHyphenateCaps|showEnvelope|summaryLength|clickAndTypeStyle|defaultTableStyle|evenAndOddHeaders|bookFoldRevPrinting|bookFoldPrinting|bookFoldPrintingSheets|drawingGridHorizontalSpacing|drawingGridVerticalSpacing|displayHorizontalDrawingGridEvery|displayVerticalDrawingGridEvery|doNotUseMarginsForDrawingGridOrigin|drawingGridHorizontalOrigin|drawingGridVerticalOrigin|doNotShadeFormData|noPunctuationKerning|characterSpacingControl|printTwoOnOne|strictFirstAndLastChars|noLineBreaksAfter|noLineBreaksBefore|savePreviewPicture|doNotValidateAgainstSchema|saveInvalidXml|ignoreMixedContent|alwaysShowPlaceholderText|doNotDemarcateInvalidXml|saveXmlDataOnly|useXSLTWhenSaving|saveThroughXslt|showXMLTags|alwaysMergeEmptyNamespace|updateFields|hdrShapeDefaults|footnotePr|endnotePr|compat|docVars|rsids|mathPr|attachedSchema|themeFontLang|clrSchemeMapping|doNotIncludeSubdocsInStats|doNotAutoCompressPictures|forceUpgrade|captions|readModeInkLockDown|smartTagType|schemaLibrary|shapeDefaults|doNotEmbedSmartTags|decimalSymbol|listSeparator)[\s/>]/;
  const m = st.match(after);
  zip.file('word/settings.xml', m ? st.slice(0, m.index) + '<w:mirrorMargins/>' + st.slice(m.index) : st.replace('</w:settings>', '<w:mirrorMargins/></w:settings>'));
  return zip.generateAsync({ type: 'blob', mimeType: blob.type });
}

const tw = (mm) => Math.round(mm * 1440 / 25.4);
function footersFor(L) {
  const num = (align) => new Footer({ children: [new Paragraph({ alignment: align, children: [new TextRun({ children: [PageNumber.CURRENT] })] })] });
  if (!L) return { default: num(AlignmentType.CENTER) };
  if (L.num === 'none') return {};
  if (L.num === 'outside') return { default: num(AlignmentType.RIGHT), even: num(AlignmentType.LEFT) };
  return { default: num({ center: AlignmentType.CENTER, right: AlignmentType.RIGHT, left: AlignmentType.LEFT }[L.num]) };
}
