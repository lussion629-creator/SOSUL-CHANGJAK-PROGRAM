// 글자 수·원고지 매수·문장 분석 등 원고 통계
import { parseHtml } from './sanitize.js';

// HTML → 문단 배열 (일반 텍스트)
export function htmlToParagraphs(html) {
  const div = parseHtml(html); // 실행되지 않는 별도 문서에서 읽는다
  const out = [];
  const blocks = div.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote > p, hr');
  if (!blocks.length) {
    const t = div.textContent.trim();
    return t ? t.split(/\n+/) : [];
  }
  blocks.forEach((b) => {
    if (b.tagName === 'HR') { out.push('* * *'); return; }
    if (b.tagName === 'LI' && b.querySelector('p')) return; // li 안의 p가 따로 잡힘
    if (b.tagName === 'P' && b.parentElement.tagName === 'BLOCKQUOTE' && false) return;
    out.push(b.textContent.replace(/ /g, ' '));
  });
  return out;
}

export function htmlToText(html) { return htmlToParagraphs(html).join('\n'); }

export function countText(paragraphs) {
  let withSpace = 0, noSpace = 0, words = 0, manuscriptLines = 0;
  for (const p of paragraphs) {
    const t = p.replace(/\s+$/, '');
    withSpace += t.length;
    noSpace += t.replace(/\s/g, '').length;
    const w = t.trim().split(/\s+/).filter(Boolean);
    words += w.length;
    // 원고지(20자×10줄): 문단 첫 칸 들여쓰기 1칸 + 글자 수를 20칸 줄로 나눈다
    if (t.trim()) manuscriptLines += Math.ceil((t.trim().length + 1) / 20);
  }
  return {
    withSpace, noSpace, words,
    paragraphs: paragraphs.filter((p) => p.trim()).length,
    manuscript: Math.ceil(manuscriptLines / 10), // 200자 원고지 매수
    a4: Math.max(0, Math.round((withSpace / 1800) * 10) / 10), // 신국판·A4 10pt 기준 약 1,800자/쪽 (대략)
  };
}

export function countHtml(html) { return countText(htmlToParagraphs(html)); }

export const fmt = (n) => (n || 0).toLocaleString('ko-KR');

// 문장 나누기
export function sentences(text) {
  return text.split(/(?<=[.!?。…”"’'])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// 반복어 분석: 한국어 조사를 떼어 내고 자주 쓰인 낱말을 센다
const JOSA = /(으로써|으로서|에게서|이라고|라고|에서|에게|께서|으로|부터|까지|조차|마저|처럼|보다|하고|이나|이랑|은|는|이|가|을|를|에|의|도|만|와|과|로|랑|나|요)$/;
const STOP = new Set(['그','그리고','하지만','그런데','그러나','그래서','이','저','것','수','등','더','안','못','좀','또','왜','뭐','다','잘','너무','아주','정말','그냥','나','너','내','네','우리','그녀','그는','있었다','했다','있다','없다','했다.','것이다','같은','했던','하는','있는','없는']);
export function repeatedWords(text, top = 40) {
  const freq = new Map();
  for (let w of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    if (w.length > 2) w = w.replace(JOSA, '');
    if (w.length < 2 || STOP.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, top);
}

// 습관어(부사·접속어) 사용 빈도: 퇴고할 때 줄이면 좋은 말들
const HABIT = ['그리고','그런데','하지만','그러나','그래서','그러자','그때','갑자기','문득','천천히','조용히','살짝','정말','너무','아주','매우','조금','약간','마치','듯이','것이다','것 같았다','수 있었다','하는 것','있었다'];
export function habitWords(text) {
  return HABIT.map((w) => [w, (text.match(new RegExp(w, 'g')) || []).length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
}

// 긴 문장
export function longSentences(text, limit = 120) {
  return sentences(text).filter((s) => s.length >= limit).sort((a, b) => b.length - a.length);
}

// 대사 비율 (따옴표로 묶인 부분)
export function dialogueRatio(text) {
  const total = text.replace(/\s/g, '').length || 1;
  const dialog = (text.match(/[“"「『][^”"」』]*[”"」』]/g) || []).join('').replace(/\s/g, '').length;
  return Math.round((dialog / total) * 100);
}
