// 용례 사전: 낱말이 실제로 어떻게 쓰이는지 문장으로 본다.
//  - 사전 용례: 국립국어원 한국어기초사전·표준국어대사전·우리말샘에서 사전이 직접 지은 예문(뜻별, 어울리는 구·문장·대화).
//    데이터는 tools/build-usage.py로 만든 public/dict/2611/u/000~511.json (낱말을 crc32로 나눈 조각, 유의어 사전과 같은 방식)
//    출판물·신문에서 인용한 예문은 자유 이용 허락이 아니어서 넣지 않았다 (사전 누리집으로 이어 준다)
//  - 내 원고: 이 작품의 모든 장에서 그 낱말(활용형·조사 붙은 꼴까지)이 쓰인 문장. 누르면 그 자리로 간다.
import { app, openChapter } from './app.js';
import { gotoMatch } from './editor.js';
import { parseHtml } from './sanitize.js';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { h, toast } from './ui.js';
import { candidates, keyOf, crc32 } from './thesaurus.js';

const BASE = './dict/2611/u/';
const NSH = 512;
const shards = new Map();
function shard(k) {
  const i = crc32(k) % NSH;
  if (!shards.has(i)) {
    const p = fetch(`${BASE}${String(i).padStart(3, '0')}.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    p.catch(() => shards.delete(i));
    shards.set(i, p);
    if (shards.size > 40) shards.delete(shards.keys().next().value);
  }
  return shards.get(i);
}
// 낱말의 사전 용례: [{ d, p, k, g, e, t }]
export async function examplesOf(key) {
  if (!key) return [];
  return (await shard(key))[key] || [];
}

// ---------- 낱말 맞추기: 글 속의 어절이 이 낱말(기본형)의 꼴인가 ----------
const SB = 0xac00;
const cho = (ch) => { const c = (ch || '').charCodeAt(0) - SB; return c < 0 || c > 11171 ? ch : Math.floor(c / 588); };
const NOUN_TAIL = /^(들)?(이|가|은|는|을|를|의|에|에서|에게|에게서|한테|한테서|께|께서|로|으로|로서|으로서|로써|으로써|와|과|랑|이랑|하고|도|만|까지|부터|처럼|보다|마저|조차|밖에|뿐|이나|나|이나마|이라도|라도|이며|며|이고|고|이다|다|였다|이었다|이야|야|이에요|예요|이지|지|인|일|임|이면|면|이니|니|이라|라|이라고|라고|이란|란|에는|에도|에서는|에서도|에게는|에게도|으로는|로는|으로도|로도|와는|과는|과도|와도|은커녕|는커녕|요)*$/;
// 어절 하나가 key의 꼴이면 true. verb: 풀이씨(동사·형용사)인지 (모르면 ‘-다’로 끝나는지로)
export function matcher(key, { verb } = {}) {
  const k = keyOf(key);
  if (!k) return () => false;
  verb = verb ?? (/다$/.test(k) && k.length >= 2);
  const c0 = cho(k[0]);
  const memo = new Map();
  // ㄷ 불규칙(걷다→걸어, 듣다→들었다)은 모음 어미 앞에서만: ‘걸’·‘걸고’·‘들’은 걷다·듣다가 아니다
  let irr = '';
  if (verb && k.length >= 2) {
    const c = k.charCodeAt(k.length - 2) - SB;
    if (c >= 0 && c <= 11171 && c % 28 === 7) irr = k.slice(0, -2) + String.fromCharCode(SB + c - 7 + 8);
  }
  return (tok) => {
    if (tok === k) return true;
    if (cho(tok[0]) !== c0) return false; // 빠른 거름: 첫 글자의 첫소리는 활용해도 같다 (걷다·걸었다, 쓰다·써서, 하다·했다)
    if (irr && tok.startsWith(irr) && cho(tok[irr.length]) !== 11) return false;
    if (!verb && tok.startsWith(k) && NOUN_TAIL.test(tok.slice(k.length))) return true;
    if (memo.has(tok)) return memo.get(tok);
    const ok = candidates(tok).includes(k);
    memo.set(tok, ok);
    return ok;
  };
}
const TOK = /[가-힣A-Za-z0-9]+/g;
// 문장 안에서 낱말의 꼴에 표시: 사전이 {중괄호}로 짚어 준 것이 있으면 그것을, 아니면 어절을 맞춰 본다
export function markIn(text, match) {
  if (/\{[^}]+\}/.test(text)) return h(text).replace(/\{([^}]*)\}/g, '<mark>$1</mark>');
  let out = '', last = 0, m;
  TOK.lastIndex = 0;
  while ((m = TOK.exec(text))) {
    if (!match(m[0])) continue;
    out += h(text.slice(last, m.index)) + `<mark>${h(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + h(text.slice(last));
}

// ---------- 내 원고에서 ----------
const docCache = new Map(); // 장 id → { html, doc }
function docOf(id) {
  if (id === app.cur && app.editor) return app.editor.state.doc;
  const st = app.states?.get(id); // 장을 옮길 때 남겨 둔 편집 상태가 있으면 그것이 열릴 원고다
  if (st) return st.doc;
  const html = app.chapters.get(id)?.html || '';
  const c = docCache.get(id);
  if (c && c.html === html) return c.doc;
  const doc = PMDOMParser.fromSchema(app.editor.schema).parse(parseHtml(html));
  docCache.set(id, { html, doc });
  if (docCache.size > 200) docCache.delete(docCache.keys().next().value);
  return doc;
}
// 문단 글에서 at 자리를 품은 문장 [시작, 끝]
function sentenceAround(text, at, len) {
  const END = /[.!?…。]+["”’』」)\]]*\s*/g;
  let s = 0, e = text.length, m;
  END.lastIndex = 0;
  while ((m = END.exec(text))) {
    const stop = m.index + m[0].length;
    if (stop <= at) s = stop;
    else if (m.index >= at + len) { e = m.index + m[0].trimEnd().length; break; }
  }
  // 너무 긴 문장은 앞뒤를 줄인다
  if (e - s > 160) { const a = Math.max(s, at - 60), b = Math.min(e, at + len + 80); return [a, b, a > s, b < e]; }
  return [s, e, false, false];
}
// 찾을 말이 띄어 쓴 구절이면 글자 그대로, 낱말이면 활용형까지
export function findInWork(key, raw, { verb } = {}) {
  const phrase = /\s/.test(String(raw || '').trim()) || !/[가-힣]/.test(key);
  const q = phrase ? String(raw || key).trim() : '';
  const match = phrase ? null : matcher(key, { verb });
  const chapters = [];
  const forms = new Map();
  let total = 0;
  for (const id of app.project?.order || []) {
    const c = app.chapters.get(id);
    if (!c) continue;
    const doc = docOf(id);
    const items = [];
    let para = -1;
    doc.descendants((node) => {
      if (!node.isTextblock) return true;
      para++;
      const text = node.textBetween(0, node.content.size, null, '￼');
      const hits = [];
      if (phrase) {
        if (q) for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) hits.push([i, q.length, q]);
      } else {
        TOK.lastIndex = 0;
        let m;
        while ((m = TOK.exec(text))) if (match(m[0])) hits.push([m.index, m[0].length, m[0]]);
      }
      for (const [off, len, form] of hits) {
        const [s, e, cutL, cutR] = sentenceAround(text, off, len);
        items.push({ para, off, len, form, pre: (cutL ? '…' : '') + text.slice(s, off), hit: text.slice(off, off + len), post: text.slice(off + len, e) + (cutR ? '…' : '') });
        forms.set(form, (forms.get(form) || 0) + 1);
      }
      total += hits.length;
      return false;
    });
    if (items.length) chapters.push({ id, title: c.title || '', items });
  }
  return { total, chapters, forms: [...forms].sort((a, b) => b[1] - a[1]) };
}
// 원고의 그 자리로 (다른 장이면 열고 나서). 그사이 원고를 고쳤으면 그 문단 둘레에서 같은 말을 찾는다
export async function jumpTo(id, para, off, len, hit) {
  if (!app.chapters.has(id)) return false;
  if (id !== app.cur && !(await openChapter(id))) return false;
  const doc = app.editor.state.doc;
  const blocks = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    blocks.push({ pos: pos + 1, text: node.textBetween(0, node.content.size, null, '￼') });
    return false;
  });
  let from = -1;
  const b = blocks[para];
  if (b && (!hit || b.text.slice(off, off + len) === hit)) from = b.pos + off;
  else if (hit) {
    // 가까운 문단부터
    for (let d = 0; d < blocks.length && from < 0; d++) {
      for (const i of d ? [para - d, para + d] : [para]) {
        const x = blocks[i]; if (!x) continue;
        const at = x.text.indexOf(hit); if (at >= 0) { from = x.pos + at; break; }
      }
    }
  }
  if (from < 0 || from + len > doc.content.size) { toast('그 문장을 찾지 못했어요. 원고가 바뀌었을 수 있어요.'); return false; }
  gotoMatch(app.editor, { from, to: from + len });
  app.editor.view.focus();
  return true;
}

// ---------- 그리기 ----------
const DICT = { k: '기초', s: '표준', o: '우리말샘' };
const DICT_FULL = { k: '한국어기초사전', s: '표준국어대사전', o: '우리말샘' };
export function renderDictExamples(groups, key, head, posName = (p) => p) {
  const match = matcher(key);
  if (!groups.length) return `<p class="hint th-pad">‘${h(head)}’의 사전 용례가 없어요. 아래 사전 누리집에서 더 찾아볼 수 있어요.</p>`;
  const n = { k: 0, s: 0, o: 0 };
  let all = 0;
  for (const g of groups) { const c = (g.g?.length || 0) + (g.e?.length || 0) + (g.t?.length || 0); n[g.k] += c; all += c; }
  const sum = Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${DICT[k]} ${v}`).join(' · ');
  let html = `<p class="us-sum">용례 <b>${all}</b>개 <small>${sum}</small></p>`;
  html += groups.map((g, i) => {
    const phr = g.g?.length ? `<div class="us-phr"><span>어울리는 표현</span>${g.g.map((x) => `<span class="us-p">${markIn(x, match)}</span>`).join('')}</div>` : '';
    const sen = (g.e || []).map((x) => `<div class="th-ex us-ex">${markIn(x, match)}</div>`).join('');
    const dia = (g.t || []).map((x) => `<div class="th-ex us-ex us-dia"><div>가: ${markIn(x[0], match)}</div><div>나: ${markIn(x[1], match)}</div></div>`).join('');
    return `<section class="us-grp"><div class="th-def"><span class="us-no">${i + 1}</span>${g.p ? `<span class="th-pos">${h(posName(g.p))}</span>` : ''}${h(g.d || '')} <small class="us-dict" title="${DICT_FULL[g.k] || ''}">${DICT[g.k] || ''}</small></div>${phr}${sen}${dia}</section>`;
  }).join('');
  return html;
}
export function renderWorkExamples(res, head, { limit = 400 } = {}) {
  if (!app.project) return '';
  if (!res.total) return `<p class="hint th-pad">이 작품에는 ‘${h(head)}’이(가) 쓰인 문장이 없어요.</p>`;
  const forms = res.forms.slice(0, 12).map(([f, c]) => `<span class="us-form">${h(f)} <small>${c}</small></span>`).join('');
  let shown = 0;
  const chs = res.chapters.map((c) => {
    const rows = c.items.map((it) => {
      if (shown++ >= limit) return '';
      return `<button type="button" class="us-hit" data-jump="${h(c.id)}|${it.para}|${it.off}|${it.len}" data-hit="${h(it.hit)}" title="이 자리로 가기"><span>${h(it.pre)}<mark>${h(it.hit)}</mark>${h(it.post)}</span></button>`;
    }).join('');
    return `<section class="us-ch"><h4>${h(c.title)}${c.id === app.cur ? ' <small>지금 장</small>' : ''} <small>${c.items.length}번</small></h4>${rows}</section>`;
  }).join('');
  return `<p class="us-sum">이 작품에서 <b>${res.total}</b>번 <small>${res.chapters.length}개 장</small></p>
    <div class="us-forms">${forms}</div>
    ${chs}${res.total > limit ? `<p class="hint">앞의 ${limit}곳만 보여요.</p>` : ''}`;
}
// 저작권 때문에 넣지 못한 문학 작품·신문 용례는 사전 누리집에서
export function moreLinks(word) {
  const q = encodeURIComponent(word);
  return `<p class="th-src">출처: 국립국어원 한국어기초사전·표준국어대사전·우리말샘 (CC BY-SA 2.0 KR). 사전이 직접 지은 예문만 담았어요.
    문학 작품·신문에서 따온 용례는 저작권 때문에 앱에 넣지 않았어요: <a href="https://stdict.korean.go.kr/search/searchResult.do?searchKeyword=${q}" target="_blank" rel="noopener">표준국어대사전 ↗</a> · <a href="https://opendict.korean.go.kr/search/searchResult?query=${q}" target="_blank" rel="noopener">우리말샘 ↗</a></p>`;
}
