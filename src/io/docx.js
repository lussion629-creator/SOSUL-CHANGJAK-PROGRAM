// Word(.docx) 열기·저장
import mammoth from 'mammoth/mammoth.browser.js';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak, Footer, PageNumber, LineRuleType,
} from 'docx';
import { htmlToBlocks } from './model.js';

export async function readDocx(arrayBuffer) {
  const res = await mammoth.convertToHtml({ arrayBuffer }, {
    styleMap: ['u => u', 'strike => s'],
    includeDefaultStyleMap: true,
  });
  return htmlToBlocks(res.value);
}

const ALIGN = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };

function runsToDocx(runs = [], base = {}) {
  const out = [];
  for (const r of runs) {
    if (r.br) { out.push(new TextRun({ break: 1 })); continue; }
    if (!r.text) continue;
    out.push(new TextRun({
      text: r.text,
      bold: r.bold || base.bold,
      italics: r.italic,
      underline: r.underline ? {} : undefined,
      strike: r.strike,
      color: r.color ? r.color.replace('#', '') : undefined,
      highlight: r.highlight ? 'yellow' : undefined,
      font: r.font || undefined,
      size: r.size ? Math.round(r.size * 2) : base.size,
    }));
  }
  return out;
}

/**
 * @param {{title:string, author?:string, chapters:{title:string, html:string}[]}} book
 * @param {{font?:string, size?:number, indent?:boolean, lineHeight?:number, titlePage?:boolean, chapterTitles?:boolean}} opt
 */
export async function writeDocx(book, opt = {}) {
  const font = opt.font || '바탕';
  const size = Math.round((opt.size || 10) * 2);
  const line = Math.round(240 * (opt.lineHeight || 1.6));
  const children = [];

  if (opt.titlePage) {
    children.push(new Paragraph({ spacing: { before: 4000 } }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: book.title, bold: true, size: 48 })] }));
    if (book.author) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400 }, children: [new TextRun({ text: book.author, size: 28 })] }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  book.chapters.forEach((ch, i) => {
    if (i > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    if (opt.chapterTitles !== false && ch.title) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 400 }, children: [new TextRun({ text: ch.title })] }));
    }
    for (const b of htmlToBlocks(ch.html)) {
      if (b.type === 'hr') { children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 }, children: [new TextRun('*')] })); continue; }
      if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') {
        const lv = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3 }[b.type];
        children.push(new Paragraph({ heading: lv, alignment: ALIGN[b.align], children: runsToDocx(b.runs) }));
        continue;
      }
      children.push(new Paragraph({
        alignment: ALIGN[b.align] || AlignmentType.JUSTIFIED,
        indent: b.type === 'quote' ? { left: 720 } : (opt.indent && !b.align ? { firstLine: size * 10 } : undefined),
        bullet: b.type === 'li' && !b.ordered ? { level: 0 } : undefined,
        spacing: { line, lineRule: LineRuleType.AUTO, after: opt.paraSpacing ? 120 : 0 },
        children: runsToDocx(b.runs),
      }));
    }
  });

  const doc = new Document({
    creator: book.author || '',
    title: book.title,
    styles: {
      default: { document: { run: { font: { ascii: font, eastAsia: font, hAnsi: font }, size } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, font: { eastAsia: font, ascii: font } }, paragraph: { spacing: { before: 240, after: 240 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true }, paragraph: { spacing: { before: 200, after: 200 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true }, paragraph: { spacing: { before: 160, after: 160 } } },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1701, bottom: 1440, left: 1440, right: 1440 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT] })] })] }) },
      children,
    }],
  });
  return Packer.toBlob(doc);
}
