// 유의어 사전: 인터넷·AI 없이 앱 안에서 찾는 국어사전 겸 유의어 사전.
// 데이터: 국립국어원 우리말샘·한국어기초사전(CC BY-SA 2.0 KR)을 tools/build-dict.py로 고쳐 만든 public/dict/2607/
//  - s/000~511.json: { w: {낱말: {e: [표제어…], x: {낱말 단위 모음}}}, c: {활용형: 기본형} } (낱말을 crc32로 나눈 조각)
//  - words.txt: 표제어 목록(자동 완성·기본형 찾기), cats.json: 기초사전 의미 갈래 → 낱말
// 뜻풀이·예문·유의어(사전에 오른 비슷한말 + 뜻풀이로 이은 말)·반의어·상위어·하위어·같은 갈래 말, 책갈피·최근 찾은 말, 낱말 맞히기.
import { app, saveSettings } from './app.js';
import { applyPageView, isPageView } from './pageview.js';
import { $, h, toast } from './ui.js';

const BASE = './dict/2607/';
const NSH = 512;
const isOpen = () => !!app.settings.thOpen;
// 유의어(AI) 창과 겹치지 않게: 유의어 창이 열려 있으면 그 반대쪽, 아니면 정한 쪽(기본 오른쪽)
function side() {
  if (app.settings.synOpen) return app.settings.synSide === 'left' ? 'right' : 'left';
  return app.settings.thSide === 'left' ? 'left' : 'right';
}

// ---------- 데이터 ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(s) {
  let c = 0xffffffff;
  for (const b of new TextEncoder().encode(s)) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const shards = new Map(); // 번호 → Promise<조각>
function shard(k) {
  const i = crc32(k) % NSH;
  if (!shards.has(i)) {
    const p = fetch(`${BASE}s/${String(i).padStart(3, '0')}.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    p.catch(() => shards.delete(i));
    shards.set(i, p);
    if (shards.size > 60) shards.delete(shards.keys().next().value);
  }
  return shards.get(i);
}
let wordsP = null, catsP = null;
function words() {
  wordsP ||= fetch(`${BASE}words.txt`).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); }).then((t) => { const list = t.split('\n'); return { list, set: new Set(list) }; });
  wordsP.catch(() => { wordsP = null; });
  return wordsP;
}
function cats() {
  catsP ||= fetch(`${BASE}cats.json`).then((r) => r.json());
  catsP.catch(() => { catsP = null; });
  return catsP;
}
export const keyOf = (w) => String(w || '').replace(/[\s\-^]/g, '');

// ---------- 기본형 찾기 (‘사과를’ → ‘사과’, ‘기뻤다’ → ‘기쁘다’, ‘걸었다’ → ‘걷다·걸다’) ----------
const SB = 0xac00;
const dec = (ch) => { const c = ch.charCodeAt(0) - SB; return c < 0 || c > 11171 ? null : { l: Math.floor(c / 588), v: Math.floor((c % 588) / 28), t: c % 28 }; };
const com = (l, v, t = 0) => String.fromCharCode(SB + l * 588 + v * 28 + t);
const J = { none: 0, ㄴ: 4, ㄹ: 8, ㅁ: 16, ㅂ: 17, ㅅ: 19, ㅆ: 20, ㅎ: 27, ㄷ: 7 };
const V = { ㅏ: 0, ㅐ: 1, ㅑ: 2, ㅓ: 4, ㅔ: 5, ㅕ: 6, ㅗ: 8, ㅘ: 9, ㅙ: 10, ㅚ: 11, ㅜ: 13, ㅝ: 14, ㅞ: 15, ㅟ: 16, ㅡ: 18, ㅣ: 20 };
const JOSA = ['에게서', '한테서', '으로서', '으로써', '이라도', '에서는', '에게는', '에서도', '에서', '에게', '한테', '께서', '으로', '까지', '부터', '처럼', '보다', '마저', '조차', '이나', '이랑', '이라', '이며', '이고', '이다', '이야', '이에요', '예요', '을', '를', '이', '가', '은', '는', '에', '의', '와', '과', '도', '만', '로', '랑', '나', '야'];
const ENDS = ['었었다', '았었다', '었습니다', '았습니다', '였습니다', '하였다', '했었다', '습니다', '었어요', '았어요', '였어요', '겠습니다', '겠다', '었다', '았다', '였다', '었고', '았고', '었으며', '았으며', '었는데', '았는데', '었지만', '았지만', '었던', '았던', '어요', '아요', '여요', '어서', '아서', '여서', '어도', '아도', '어야', '아야', '으면서', '면서', '으면', '으며', '는데', '은데', '지만', '거나', '더니', '다가', '려고', '으려고', '도록', '는', '은', '을', '던', '면', '며', '고', '게', '지', '기', '음', '어', '아', '여', '니', '네', '다', '요', '서', '도', '야', '라', 'ㄴ', 'ㄹ', 'ㅁ', 'ㅂ니다'];
// 끝 글자 고쳐 보기: 불규칙 활용 되돌리기
function stemVariants(s) {
  const out = [s];
  if (!s) return out;
  const last = s.at(-1), pre = s.slice(0, -1), d = dec(last);
  if (!d) return out;
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };
  if (d.t === J.ㅆ) { const b = pre + com(d.l, d.v); out.push(...stemVariants(b).filter((x) => !out.includes(x))); }
  if (last === '해' || last === '했') push(pre + '하');
  if (d.t === 0) {
    if (d.v === V.ㅕ) push(pre + com(d.l, V.ㅣ));
    if (d.v === V.ㅘ) push(pre + com(d.l, V.ㅗ));
    if (d.v === V.ㅝ) push(pre + com(d.l, V.ㅜ));
    if (d.v === V.ㅙ) push(pre + com(d.l, V.ㅚ));
    if (d.v === V.ㅓ || d.v === V.ㅏ) push(pre + com(d.l, V.ㅡ)); // 기뻐 → 기쁘, 써 → 쓰
    // 더워 → 덥, 도와 → 돕
    if ((last === '워' || last === '와') && pre) { const p = dec(pre.at(-1)); if (p && p.t === 0) push(pre.slice(0, -1) + com(p.l, p.v, J.ㅂ)); }
    // 불러 → 부르, 몰라 → 모르
    if ((last === '러' || last === '라') && pre) { const p = dec(pre.at(-1)); if (p && p.t === J.ㄹ) push(pre.slice(0, -1) + com(p.l, p.v) + '르'); }
    push(pre + com(d.l, d.v, J.ㄹ)); // 사 → 살 (ㄹ 탈락: 사는 → 살다, 만드 → 만들)
    push(pre + com(d.l, d.v, J.ㅅ)); // 나 → 낫 (ㅅ 불규칙: 나아 → 낫다)
    push(pre + com(d.l, d.v, J.ㅎ)); // 그러 → 그렇
    if (d.v === V.ㅐ) { push(pre + com(d.l, V.ㅓ, J.ㅎ)); push(pre + com(d.l, V.ㅏ, J.ㅎ)); } // 그래 → 그렇, 파래 → 파랗
  } else {
    if (d.t === J.ㄹ) push(pre + com(d.l, d.v, J.ㄷ)); // 걸 → 걷 (ㄷ 불규칙)
    if ([J.ㄴ, J.ㄹ, J.ㅁ, J.ㅂ].includes(d.t)) {
      const b = pre + com(d.l, d.v);
      push(b); // 예쁜 → 예쁘, 갑 → 가
      push(b.slice(0, -1) + com(d.l, d.v, J.ㅎ)); // 파란 → 파랗
      if (d.t === J.ㄴ || d.t === J.ㅁ) push(pre + com(d.l, d.v, J.ㄹ)); // 사는 → (사) → 살, 앎 → 알
    }
  }
  return out;
}
function candidates(form) {
  const f = keyOf(form);
  const out = [];
  const push = (x) => { if (x && x.length >= 1 && !out.includes(x)) out.push(x); };
  for (const j of JOSA) if (f.endsWith(j) && f.length > j.length) push(f.slice(0, -j.length));
  // 받침으로 붙은 어미(ㄴ·ㄹ·ㅁ·ㅂ니다)는 글자를 풀어 본다
  const tails = [];
  for (const e of ENDS) {
    if (/^[ㄱ-ㅎ]/.test(e)) continue;
    if (f.endsWith(e) && f.length > e.length) tails.push(f.slice(0, -e.length));
  }
  tails.push(f);
  for (const s of tails) for (const v of stemVariants(s)) push(v + '다');
  // 이름씨 + 이다(‘하늘이었다’), 여럿(‘사람들은’)
  for (const s of [...tails, ...out.filter((x) => !x.endsWith('다'))]) {
    for (const j of ['이', '였', '이었', '였었', '이었었']) if (s.endsWith(j) && s.length > j.length) push(s.slice(0, -j.length));
    if (s.endsWith('들') && s.length > 2) push(s.slice(0, -1));
  }
  return out;
}
// 찾은 결과: { key, form, data, alt: [다른 기본형], suffix: 떼어 낸 조사 }
export async function find(form) {
  const f = keyOf(form).replace(/^[^가-힣a-zA-Z0-9]+|[^가-힣a-zA-Z0-9]+$/g, '');
  if (!f) return null;
  const sh = await shard(f);
  const exact = sh.w[f] ? f : null;
  const viaConj = !exact && sh.c[f] ? sh.c[f] : null;
  const W = await words();
  const cands = candidates(f).filter((c) => W.set.has(c) && c !== f);
  let keys = [...new Set([exact, viaConj, ...cands].filter(Boolean))];
  if (!keys.length) return { key: '', form: f, data: null, alt: [], near: near(W.list, f) };
  // 기초 낱말을 앞세운다: 원고의 ‘파란’은 ‘파란(波瀾)’보다 ‘파랗다’일 때가 많다 (활용형 그대로인 표제어가 기초 낱말이면 그것을)
  const datas = await Promise.all(keys.slice(0, 6).map(async (k) => (await shard(k)).w[k]));
  const common = (i) => (datas[i]?.x?.k ? 0 : 1);
  const order = keys.slice(0, 6).map((k, i) => i).sort((a, b) => (common(a) - common(b)) || (a - b));
  const k = keys[order[0]];
  const suffix = f.startsWith(k) ? f.slice(k.length) : '';
  return { key: k, form: f, data: datas[order[0]], alt: order.slice(1, 4).map((i) => keys[i]), suffix };
}
// 자동 완성: 앞이 같은 표제어 (가나다순)
function lowerBound(list, q) { let a = 0, b = list.length; while (a < b) { const m = (a + b) >> 1; if (list[m] < q) a = m + 1; else b = m; } return a; }
function near(list, q, n = 12) {
  const out = [];
  for (let i = lowerBound(list, q); i < list.length && out.length < n && list[i].startsWith(q); i++) out.push(list[i]);
  if (!out.length && q.length > 1) return near(list, q.slice(0, -1), n);
  return out;
}

// ---------- 지금 원고 낱말 ----------
export function currentTarget() {
  const ed = app.editor;
  if (!ed) return null;
  const { from, to, $from } = ed.state.selection;
  if (from !== to) {
    if (!ed.state.selection.$to.sameParent($from)) return null;
    const t = ed.state.doc.textBetween(from, to, ' ');
    const trimmed = t.trim();
    if (!trimmed || trimmed.length > 30) return null;
    const a = from + (t.length - t.trimStart().length);
    return { from: a, to: a + trimmed.length, text: trimmed };
  }
  const block = $from.parent;
  if (!block.isTextblock) return null;
  const text = block.textBetween(0, block.content.size, null, '￼');
  let a = $from.parentOffset, b = a;
  const W = /[\p{L}\p{N}]/u;
  while (a > 0 && W.test(text[a - 1])) a--;
  while (b < text.length && W.test(text[b])) b++;
  if (a === b) return null;
  const start = $from.start();
  return { from: start + a, to: start + b, text: text.slice(a, b) };
}

// ---------- 바꾸기: 원고의 낱말을 사전의 말로 (조사는 받침에 맞춰 고친다) ----------
const hasJong = (w) => { const d = dec(w.at(-1) || ''); return d ? d.t !== 0 : /[013678lmnr]$/i.test(w); };
const isRieul = (w) => { const d = dec(w.at(-1) || ''); return !!d && d.t === J.ㄹ; };
function fitJosa(josa, w) {
  if (!josa) return '';
  const j = hasJong(w);
  const pairs = [['으로서', '로서'], ['으로써', '로써'], ['으로', '로'], ['이랑', '랑'], ['이나', '나'], ['이라', '라'], ['이며', '며'], ['이고', '고'], ['이다', '다'], ['이야', '야'], ['이에요', '예요'], ['이라도', '라도']];
  for (const [a, b] of pairs) {
    if (josa.startsWith(a) || josa.startsWith(b)) {
      const rest = josa.slice(josa.startsWith(a) ? a.length : b.length);
      if (a === '으로' || a === '으로서' || a === '으로써') return (j && !isRieul(w) ? a : b) + rest;
      return (j ? a : b) + rest;
    }
  }
  const one = { 을: ['을', '를'], 를: ['을', '를'], 이: ['이', '가'], 가: ['이', '가'], 은: ['은', '는'], 는: ['은', '는'], 과: ['과', '와'], 와: ['과', '와'], 아: ['아', '야'], 야: ['아', '야'] };
  const o = one[josa[0]];
  return o ? (j ? o[0] : o[1]) + josa.slice(1) : josa;
}
// 바꿀 수 있는가: 기본형 그대로, 이름씨+조사, ‘…하다’ 끼리
function replacement(t, newWord) {
  if (!t || !t.key) return null;
  const nw = newWord.replace(/\s/g, ' ');
  if (t.form === t.key) return nw;
  if (t.suffix && JOSA.includes(t.suffix) && t.form === t.key + t.suffix) return nw + fitJosa(t.suffix, nw);
  if (t.key.endsWith('하다') && nw.endsWith('하다')) {
    const stem = t.key.slice(0, -2);
    const rest = t.form.slice(stem.length), d = dec(rest[0] || '');
    // 흐뭇한·흐뭇해서·흐뭇했다 → 흡족한·흡족해서·흡족했다 (‘하’·‘해’로 시작하는 꼴)
    if (t.form.startsWith(stem) && d && d.l === 18 && (d.v === V.ㅏ || d.v === V.ㅐ)) return nw.slice(0, -2) + rest;
  }
  return null;
}
function doReplace(newWord) {
  const t = view.target;
  const ed = app.editor;
  if (!t || !ed) return;
  const rep = replacement(t, newWord);
  if (!rep) return;
  const now = ed.state.doc.textBetween(t.from, t.to, ' ');
  if (now !== t.text) { toast('원고가 바뀌어서 그 자리를 찾지 못했어요. 낱말을 다시 찾아 주세요.'); view.target = null; render(); return; }
  const tr = ed.state.tr.insertText(rep, t.from, t.to);
  ed.view.dispatch(tr);
  toast(`‘${t.text}’ → ‘${rep}’ (Ctrl+Z로 되돌려요)`);
  // 바꾼 말을 다시 대상으로 (다른 말로 또 바꿀 수 있게)
  view.target = { ...t, to: t.from + rep.length, text: rep, form: keyOf(rep), key: keyOf(newWord), suffix: rep.slice(newWord.length) };
  render();
}

// ---------- 창 ----------
const view = { tab: 'look', res: null, back: [], fwd: [], target: null, loading: false, err: '' };
const recentKey = 'nw-th-recent';
const recent = () => { try { return JSON.parse(localStorage.getItem(recentKey) || '[]'); } catch { return []; } };
function addRecent(w) { try { const r = [w, ...recent().filter((x) => x !== w)].slice(0, 60); localStorage.setItem(recentKey, JSON.stringify(r)); } catch { /* 무시 */ } }
const marks = () => app.settings.thBookmarks || [];

function build() {
  const el = document.createElement('aside');
  el.id = 'thPanel';
  el.className = 'th-panel';
  el.setAttribute('aria-label', '유의어 사전');
  el.innerHTML = `<div class="syn-head">
      <button type="button" class="icon-btn th-back" title="뒤로" aria-label="뒤로">‹</button>
      <button type="button" class="icon-btn th-fwd" title="앞으로" aria-label="앞으로">›</button>
      <b>유의어 사전</b>
      <button type="button" class="icon-btn th-side" title="반대쪽으로 옮기기" aria-label="반대쪽으로 옮기기">⇄</button>
      <button type="button" class="icon-btn th-close" title="닫기" aria-label="유의어 사전 닫기">✕</button>
    </div>
    <form class="th-form" autocomplete="off">
      <input class="th-q" type="search" placeholder="낱말 찾기 (활용형도 돼요)" aria-label="찾을 낱말">
      <button type="button" class="th-cur" title="원고에서 커서가 있는 낱말(고른 글자)을 찾아요">원고 낱말</button>
      <div class="th-sug" hidden role="listbox"></div>
    </form>
    <div class="th-tabs" role="tablist">
      <button type="button" data-tab="look">찾기</button><button type="button" data-tab="marks">책갈피</button><button type="button" data-tab="recent">최근</button><button type="button" data-tab="quiz">낱말 맞히기</button>
    </div>
    <div class="th-body" aria-live="polite"></div>
    <label class="th-follow"><input type="checkbox" class="th-follow-cb"> 커서를 옮기면 그 낱말을 바로 찾기</label>`;
  $('#workspace').appendChild(el);
  el.querySelector('.th-close').addEventListener('click', () => toggleThesaurus(false));
  el.querySelector('.th-side').addEventListener('click', () => {
    if (app.settings.synOpen) app.settings.synSide = side(); // 유의어 창과 자리를 바꾼다
    else app.settings.thSide = side() === 'left' ? 'right' : 'left';
    saveSettings(); layout();
    document.dispatchEvent(new CustomEvent('nw-syn-layout'));
  });
  el.querySelector('.th-back').addEventListener('click', () => { if (!view.back.length) return; view.fwd.push(view.res?.form); go(view.back.pop(), { hist: false }); });
  el.querySelector('.th-fwd').addEventListener('click', () => { if (!view.fwd.length) return; view.back.push(view.res?.form); go(view.fwd.pop(), { hist: false }); });
  const q = el.querySelector('.th-q'), sug = el.querySelector('.th-sug');
  el.querySelector('.th-form').addEventListener('submit', (e) => { e.preventDefault(); sug.hidden = true; go(q.value); });
  let st = 0;
  q.addEventListener('input', async () => {
    const my = ++st, v = keyOf(q.value);
    if (!v) { sug.hidden = true; return; }
    try {
      const W = await words();
      if (my !== st) return;
      // 앞이 같은 말 가운데 짧은 것부터 (‘아름다’ → 아름답다·아름다움…)
      // 치는 중인 끝 글자는 받침이 붙을 수도 있다 (‘아름다’ → ‘아름답다’)
      const d = dec(v.at(-1)), pre = [v];
      if (d && d.t === 0) for (let t = 1; t < 28; t++) pre.push(v.slice(0, -1) + com(d.l, d.v, t));
      const L = [...new Set(pre.flatMap((p) => near(W.list, p, 120).filter((x) => x.startsWith(p))))].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, 12);
      sug.innerHTML = L.map((x) => `<button type="button" role="option" data-go="${h(x)}">${h(x)}</button>`).join('');
      sug.hidden = !L.length;
    } catch { sug.hidden = true; }
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { sug.hidden = true; return; }
    if (e.key === 'ArrowDown' && !sug.hidden) { e.preventDefault(); sug.querySelector('button')?.focus(); }
  });
  sug.addEventListener('keydown', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); (b.nextElementSibling || b).focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (b.previousElementSibling || q).focus(); }
    if (e.key === 'Escape') { sug.hidden = true; q.focus(); }
  });
  q.addEventListener('blur', () => setTimeout(() => { if (!sug.contains(document.activeElement)) sug.hidden = true; }, 150));
  el.querySelector('.th-cur').addEventListener('mousedown', (e) => e.preventDefault()); // 원고의 선택을 지킨다
  el.querySelector('.th-cur').addEventListener('click', () => lookupThesaurus());
  const fcb = el.querySelector('.th-follow-cb');
  fcb.checked = !!app.settings.thFollow;
  fcb.addEventListener('change', () => { app.settings.thFollow = fcb.checked; saveSettings(); if (fcb.checked) lookupThesaurus(); });
  el.addEventListener('mousedown', (e) => { if (e.target.closest('[data-rep]')) e.preventDefault(); });
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { view.tab = t.dataset.tab; if (view.tab === 'quiz' && !quiz.cur) newQuiz(); render(); return; }
    const r = e.target.closest('[data-rep]');
    if (r) { doReplace(r.dataset.rep); return; }
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); sug.hidden = true; view.tab = 'look'; go(g.dataset.go); return; }
    if (e.target.closest('[data-mark]')) { toggleMark(); return; }
    const um = e.target.closest('[data-unmark]');
    if (um) { app.settings.thBookmarks = marks().filter((x) => x !== um.dataset.unmark); saveSettings(); render(); return; }
    if (e.target.closest('[data-clear-recent]')) { try { localStorage.removeItem(recentKey); } catch { /* 무시 */ } render(); return; }
    const qa = e.target.closest('[data-quiz]');
    if (qa) quizAct(qa.dataset.quiz);
  });
  el.addEventListener('submit', (e) => { if (e.target.closest('.th-quiz-form')) { e.preventDefault(); quizAct('guess'); } });
  return el;
}

export function layout() {
  const on = isOpen() && !!app.project;
  const el = $('#thPanel') || (on ? build() : null);
  document.body.classList.toggle('th-open', on);
  document.body.classList.toggle('th-left', on && side() === 'left');
  if (!el) return;
  el.hidden = !on;
  el.classList.toggle('left', side() === 'left');
  if (isPageView()) applyPageView();
}

export function toggleThesaurus(on) {
  on = on ?? !isOpen();
  app.settings.thOpen = on; saveSettings();
  layout();
  if (on) { render(); if (!view.res) lookupThesaurus({ quiet: true }); $('#thPanel .th-q')?.focus(); }
}

// 원고 낱말(또는 주어진 낱말)을 찾는다. 창이 닫혀 있으면 연다.
export function lookupThesaurus({ word, quiet = false } = {}) {
  if (!isOpen()) { app.settings.thOpen = true; saveSettings(); layout(); }
  const t = word ? null : currentTarget();
  if (!word && !t) { if (!quiet) toast('원고에서 찾을 낱말에 커서를 두거나 글자를 골라 주세요.'); render(); return; }
  view.tab = 'look';
  go(word || t.text, { target: t });
}

let goSeq = 0;
async function go(w, { hist = true, target } = {}) {
  w = String(w || '').trim();
  if (!w) return;
  const my = ++goSeq;
  if (hist && view.res?.form && keyOf(view.res.form) !== keyOf(w)) { view.back.push(view.res.form); view.fwd = []; if (view.back.length > 50) view.back.shift(); }
  view.loading = true; view.err = '';
  const q = $('#thPanel .th-q'); if (q) q.value = w;
  render();
  try {
    const r = await find(w);
    if (my !== goSeq) return;
    view.res = r;
    // 원고에서 온 낱말이면 바꾸기 대상으로 기억한다 (사전의 말을 눌러 찾아 들어가도 대상은 그대로)
    if (target) view.target = r && r.key ? { ...target, form: r.form, key: r.key, suffix: r.suffix } : null;
    if (r?.key) addRecent(r.data?.e?.[0]?.w || r.key);
  } catch {
    if (my !== goSeq) return;
    view.res = null;
    view.err = '사전 데이터를 불러오지 못했어요. 인터넷이 끊겼거나(웹 앱은 처음 찾을 때 받아 와요) 미리보기 파일이라 사전이 들어 있지 않아요.';
  }
  view.loading = false;
  render();
}

function toggleMark() {
  const w = view.res?.data?.e?.[0]?.w;
  if (!w) return;
  const m = marks();
  app.settings.thBookmarks = m.includes(w) ? m.filter((x) => x !== w) : [w, ...m].slice(0, 500);
  saveSettings();
  render();
}

// ---------- 그리기 ----------
const POSS = { 명사: '명', 동사: '동', 형용사: '형', 부사: '부', 대명사: '대', 감탄사: '감', 관형사: '관', 의존명사: '의존', '의존 명사': '의존', 수사: '수', 조사: '조', 어미: '어미', 접사: '접사', '보조 동사': '보동', '보조 형용사': '보형' };
const REL = [['s', '비슷한말'], ['a', '반대말'], ['u', '상위어'], ['l', '하위어'], ['b', '본말'], ['j', '준말'], ['hi', '높임말'], ['lo', '낮춤말'], ['r', '참고']];
const ex = (t) => h(t).replace(/\{([^}]*)\}/g, '<mark>$1</mark>');
function chip(w, cls = '') {
  const rep = view.target && replacement(view.target, w);
  return `<span class="th-chip ${cls}"><button type="button" data-go="${h(w)}" title="‘${h(w)}’ 찾기">${h(w)}</button>${rep && keyOf(w) !== view.target.key ? `<button type="button" class="th-rep" data-rep="${h(w)}" title="원고의 ‘${h(view.target.text)}’을(를) ‘${h(rep)}’(으)로 바꾸기" aria-label="원고에서 ${h(rep)}(으)로 바꾸기">↵</button>` : ''}</span>`;
}
const chips = (L, cls) => L.map((w) => chip(w, cls)).join('');
function uniq(L) { const s = new Set(), out = []; for (const x of L) if (x && !s.has(x)) { s.add(x); out.push(x); } return out; }

function renderLook() {
  if (view.loading) return '<p class="hint th-pad">찾는 중…</p>';
  if (view.err) return `<p class="hint th-pad">${h(view.err)}</p>`;
  const r = view.res;
  if (!r) return `<div class="th-pad"><p class="hint">원고에서 낱말에 커서를 두고 <b>원고 낱말</b>(또는 ${h(kbd())})을 누르거나, 위 칸에 낱말을 쳐 보세요.</p>${recentList(8)}</div>`;
  if (!r.data) return `<div class="th-pad"><p>‘${h(r.form)}’은(는) 사전에서 찾지 못했어요.</p>${r.near?.length ? `<p class="hint">이런 말을 찾으셨나요?</p><div class="th-chips">${r.near.map((w) => `<span class="th-chip"><button type="button" data-go="${h(w)}">${h(w)}</button></span>`).join('')}</div>` : ''}</div>`;
  const es = r.data.e, x = r.data.x || {};
  const head = es[0].w;
  const S = uniq([...es.flatMap((e) => e.sn.flatMap((s) => s.s || [])), ...(x.s || []), ...(x.v || [])]).filter((w) => w !== head);
  const D = uniq([...es.flatMap((e) => e.sn.flatMap((s) => s.ds || [])), ...(x.d || [])]).filter((w) => w !== head && !S.includes(w));
  const A = uniq([...es.flatMap((e) => e.sn.flatMap((s) => s.a || [])), ...(x.a || [])]).filter((w) => w !== head);
  const marked = marks().includes(head);
  const t = view.target;
  const tgt = t && t.key === r.key
    ? `<p class="th-tgt">원고의 <b>‘${h(t.text)}’</b> ${replacement(t, head) ? '— 말 옆의 <span class="th-rep-i">↵</span>를 누르면 그 말로 바꿔요' : '— 활용형이라 바꿀 말은 직접 고쳐 주세요'}</p>` : '';
  const formNote = r.form !== r.key ? `<small class="hint">‘${h(r.form)}’의 기본형${r.alt?.length ? ` · 다른 후보: ${r.alt.map((a) => `<a href="#" data-go="${h(a)}">${h(a)}</a>`).join(', ')}` : ''}</small>` : '';
  let html = `<div class="th-word"><div class="th-title"><b>${h(head)}</b>${es.some((e) => e.hj) ? `<span class="th-hj">${h(uniq(es.map((e) => e.hj)).join(' · '))}</span>` : ''}
    <button type="button" class="icon-btn th-star ${marked ? 'on' : ''}" data-mark title="${marked ? '책갈피 빼기' : '책갈피에 넣기'}" aria-pressed="${marked}">${marked ? '★' : '☆'}</button></div>${formNote}</div>${tgt}`;
  const sec = (title, body, sub = '') => body ? `<section class="th-sec"><h4>${title}${sub ? ` <small>${sub}</small>` : ''}</h4>${body}</section>` : '';
  html += sec('유의어', S.length ? `<div class="th-chips">${chips(S)}</div>` : '', '사전에 오른 비슷한말');
  const D2 = (x.d2 || []).filter((w) => !D.includes(w) && !S.includes(w));
  const more = D2.length ? `<details class="th-more"><summary>드물게 쓰는 말 ${D2.length}개 더 보기</summary><div class="th-chips">${chips(D2, 'soft')}</div></details>` : '';
  html += sec('뜻이 비슷한 말', D.length || D2.length ? `<div class="th-chips">${chips(D.slice(0, 30), 'soft')}</div>${more}` : '', '뜻풀이로 이은 말');
  html += sec('반의어', A.length ? `<div class="th-chips">${chips(A, 'anti')}</div>` : '');
  // 뜻풀이
  let n = 0;
  const senses = es.map((e, ei) => {
    const items = e.sn.map((s) => {
      n++;
      const rel = REL.map(([k, lab]) => (s[k]?.length ? `<div class="th-rel"><span>${lab}</span>${chips(s[k], k === 'a' ? 'anti' : '')}</div>` : '')).join('');
      const ds = s.ds?.length ? `<div class="th-rel"><span>뜻 비슷</span>${chips(s.ds, 'soft')}</div>` : '';
      return `<li><div class="th-def">${s.p ? `<span class="th-pos">${h(POSS[s.p] || s.p)}</span>` : ''}${s.c ? `<span class="th-cat">「${h(s.c)}」</span>` : ''}${h(s.d)}</div>${s.e?.length ? s.e.map((t) => `<div class="th-ex">${ex(t)}</div>`).join('') : ''}${rel}${ds}</li>`;
    }).join('');
    const sub = es.length > 1 ? `<div class="th-homo">${h(e.w)}<sup>${ei + 1}</sup>${e.hj ? ` <span class="th-hj">${h(e.hj)}</span>` : ''}${e.u ? ` <small>${h(e.u)}</small>` : ''}</div>` : (e.u ? `<div class="th-homo"><small>${h(e.u)}</small></div>` : '');
    return `${sub}<ol class="th-senses">${items}</ol>`;
  }).join('');
  html += sec('뜻풀이', senses, n > 1 ? `${n}가지 뜻` : '');
  if (x.e?.length) html += sec('예문', x.e.map((t) => `<div class="th-ex">${h(t).replaceAll(h(head.slice(0, -1) || head), (m) => `<mark>${m}</mark>`)}</div>`).join(''));
  if (x.gk) html += `<section class="th-sec"><details class="th-cats" data-gk="${h(x.gk)}"><summary><h4>같은 갈래 말 <small>${h(x.g || '')}</small></h4></summary><div class="th-chips">불러오는 중…</div></details></section>`;
  html += `<p class="th-src">출처: 국립국어원 우리말샘·한국어기초사전 (CC BY-SA 2.0 KR). ‘뜻이 비슷한 말’은 뜻풀이에 쓰인 낱말을 이어 이 앱이 만든 목록이에요.</p>`;
  return html;
}
function recentList(n = 60) {
  const R = recent().slice(0, n);
  if (!R.length) return '';
  return `<h4 class="th-h4">최근 찾은 말</h4><div class="th-chips">${R.map((w) => `<span class="th-chip"><button type="button" data-go="${h(w)}">${h(w)}</button></span>`).join('')}</div>`;
}
function renderMarks() {
  const M = marks();
  if (!M.length) return '<p class="hint th-pad">책갈피가 비어 있어요. 낱말을 찾은 뒤 ☆을 누르면 여기에 모여요.</p>';
  return `<div class="th-pad"><p class="hint">${M.length}개</p><ul class="th-list">${M.map((w) => `<li><a href="#" data-go="${h(w)}">${h(w)}</a><button type="button" class="icon-btn" data-unmark="${h(w)}" title="책갈피 빼기" aria-label="${h(w)} 책갈피 빼기">✕</button></li>`).join('')}</ul></div>`;
}
function renderRecent() {
  const r = recentList();
  return r ? `<div class="th-pad">${r}<p><button type="button" class="small" data-clear-recent>최근 찾은 말 지우기</button></p></div>` : '<p class="hint th-pad">아직 찾은 낱말이 없어요.</p>';
}

// ---------- 낱말 맞히기: 뜻풀이를 보고 낱말을 맞힌다 (기초 낱말에서 고른다) ----------
const quiz = { cur: null, tries: 0, hint: 0, done: false, msg: '' };
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const choOf = (w) => [...w].map((c) => { const d = dec(c); return d ? CHO[d.l] : c; }).join('');
async function newQuiz() {
  quiz.cur = null; quiz.tries = 0; quiz.hint = 0; quiz.done = false; quiz.msg = '문제를 고르는 중…';
  render();
  try {
    const C = await cats();
    const pool = Object.values(C).flat().filter((w) => w.length >= 2 && w.length <= 5 && /^[가-힣]+$/.test(w));
    for (let i = 0; i < 20; i++) {
      const w = pool[Math.floor(Math.random() * pool.length)];
      const d = (await shard(keyOf(w))).w[keyOf(w)];
      const s = d?.e?.[0]?.sn?.find((x) => x.d && !x.d.includes(w.slice(0, -1) || w) && !/준말|본말|잘못|방언/.test(x.d));
      if (s) { quiz.cur = { w, d: s.d, p: s.p, e: (s.e?.[0] || d.x?.e?.[0] || '') }; break; }
    }
    quiz.msg = quiz.cur ? '' : '문제를 만들지 못했어요. 다시 눌러 주세요.';
  } catch { quiz.msg = '사전 데이터를 불러오지 못했어요.'; }
  render();
  $('#thPanel .th-quiz-in')?.focus();
}
function quizAct(a) {
  const c = quiz.cur;
  if (a === 'next') { newQuiz(); return; }
  if (!c) return;
  if (a === 'hint') { quiz.hint = Math.min(3, quiz.hint + 1); render(); return; }
  if (a === 'give') { quiz.done = true; quiz.msg = `정답은 ‘${c.w}’예요.`; app.settings.thQuiz = { ...(app.settings.thQuiz || {}), streak: 0 }; saveSettings(); render(); return; }
  if (a === 'guess') {
    const inp = $('#thPanel .th-quiz-in');
    const g = keyOf(inp?.value);
    if (!g || quiz.done) return;
    quiz.tries++;
    if (g === keyOf(c.w)) {
      quiz.done = true;
      const st = app.settings.thQuiz || {};
      app.settings.thQuiz = { right: (st.right || 0) + 1, streak: (st.streak || 0) + 1 };
      saveSettings();
      quiz.msg = `맞았어요! ‘${c.w}’ (${quiz.tries}번 만에)`;
    } else {
      quiz.msg = `‘${inp.value.trim()}’은(는) 아니에요.${quiz.tries >= 2 && quiz.hint < 3 ? ' 힌트를 써 보세요.' : ''}`;
      inp.select();
    }
    render();
  }
}
function renderQuiz() {
  const c = quiz.cur, st = app.settings.thQuiz || {};
  if (!c) return `<div class="th-pad"><p class="hint">${h(quiz.msg || '')}</p><button type="button" class="small" data-quiz="next">새 문제</button></div>`;
  const mask = (t) => h(t).replace(/\{([^}]*)\}/g, (m, x) => (quiz.done ? `<mark>${x}</mark>` : '○'.repeat([...x].length)));
  const hints = [];
  if (quiz.hint >= 1) hints.push(`${[...c.w].length}글자${c.p ? ` · ${h(c.p)}` : ''}`);
  if (quiz.hint >= 2) hints.push(`초성: ${h(choOf(c.w))}`);
  if (quiz.hint >= 3 && c.e) hints.push(`예문: ${mask(c.e)}`);
  return `<div class="th-pad th-quiz">
    <p class="hint">뜻풀이를 보고 낱말을 맞혀 보세요. 맞힌 수 ${st.right || 0} · 연속 ${st.streak || 0}</p>
    <div class="th-quiz-q">${h(c.d)}</div>
    ${hints.length ? `<ul class="th-quiz-hints">${hints.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
    ${quiz.done ? `<p class="th-quiz-ans"><b>${h(c.w)}</b> <a href="#" data-go="${h(c.w)}">사전에서 보기</a></p>` : `<form class="th-quiz-form"><input class="th-quiz-in" placeholder="정답" aria-label="정답"><button type="submit">맞히기</button></form>`}
    ${quiz.msg ? `<p class="th-quiz-msg">${h(quiz.msg)}</p>` : ''}
    <div class="th-quiz-btns">${quiz.done ? '' : `<button type="button" class="small" data-quiz="hint" ${quiz.hint >= 3 ? 'disabled' : ''}>힌트 (${quiz.hint}/3)</button><button type="button" class="small" data-quiz="give">정답 보기</button>`}<button type="button" class="small" data-quiz="next">다음 문제</button></div>
  </div>`;
}

const kbd = () => { try { return document.querySelector('[data-kbd="thesaurus"]')?.textContent || 'Ctrl+Shift+U'; } catch { return 'Ctrl+Shift+U'; } };
function render() {
  const el = $('#thPanel');
  if (!el || el.hidden) return;
  el.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === view.tab)));
  el.querySelector('.th-back').disabled = !view.back.length;
  el.querySelector('.th-fwd').disabled = !view.fwd.length;
  const body = el.querySelector('.th-body');
  const keepScroll = view.tab === 'look' && body.dataset.for === view.res?.form ? body.scrollTop : 0;
  body.innerHTML = view.tab === 'marks' ? renderMarks() : view.tab === 'recent' ? renderRecent() : view.tab === 'quiz' ? renderQuiz() : renderLook();
  body.dataset.for = view.res?.form || '';
  body.scrollTop = keepScroll;
  // 같은 갈래 말은 펼칠 때 불러온다
  body.querySelector('.th-cats')?.addEventListener('toggle', async (e) => {
    const d = e.currentTarget;
    if (!d.open || d.dataset.loaded) return;
    d.dataset.loaded = '1';
    try {
      const C = await cats();
      const head = view.res?.data?.e?.[0]?.w;
      const L = (C[d.dataset.gk] || []).filter((w) => w !== head);
      d.querySelector('.th-chips').innerHTML = L.length ? chips(L.slice(0, 120), 'soft') : '<span class="hint">없음</span>';
    } catch { d.querySelector('.th-chips').textContent = '불러오지 못했어요.'; }
  });
}

let followTimer = 0;
export function bindThesaurus() {
  app.hooks.afterOpen.push(() => { view.target = null; layout(); render(); });
  document.addEventListener('nw-syn-changed', () => layout());
  app.editor.on('selectionUpdate', () => {
    if (!isOpen() || !app.settings.thFollow) return;
    clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      const t = currentTarget();
      if (t && keyOf(t.text) !== keyOf(view.res?.form || '') && /[가-힣]/.test(t.text)) { view.tab = 'look'; go(t.text, { target: t, hist: false }); }
    }, 500);
  });
  layout();
  render();
}
