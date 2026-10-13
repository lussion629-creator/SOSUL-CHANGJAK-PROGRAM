// 유의어 창: 원고 옆(왼쪽·오른쪽)에 붙여 두면 커서가 있는 낱말이나 고른 글자의 유의어를
// 고른 AI(GPT·Claude·Gemini)에게 바로 물어 보여 준다. 누르면 그 낱말을 바꾼다.
import { app, saveSettings } from './app.js';
import { PROVIDERS, aiKey, modelOf, askJSON, aiMissing, showAiSettings } from './ai.js';
import { applyPageView, isPageView } from './pageview.js';
import { $, h, toast } from './ui.js';

const ORDER = ['openai', 'anthropic', 'gemini'];
const cache = new Map(); // `${공급자}|${모델}|${낱말}|${문장}` → 결과
const lastByWord = new Map(); // 낱말 → 마지막 결과 (문장이 달라도 먼저 보여 준다)
let target = null; // { from, to, text, sentence }
let ctrl = null;
let timer = null;
let seq = 0;
let kept = null; // 방금 바꾼 낱말 자리: 그 자리를 고른 동안은 목록을 그대로 두어 다른 말로 또 바꿀 수 있게

const isOpen = () => !!app.settings.synOpen;
const side = () => (app.settings.synSide === 'left' ? 'left' : 'right');
export function synProvider() {
  const p = app.settings.synProvider;
  if (PROVIDERS[p]) return p;
  return ORDER.find((x) => aiKey(x) && modelOf(x)) || app.settings.ai?.provider || 'openai';
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    lemma: { type: 'STRING' },
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { word: { type: 'STRING' }, note: { type: 'STRING' } }, required: ['word'] } },
    antonyms: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['lemma', 'items'],
};
const prompt = (word, sentence) => `너는 한국어 소설가 곁에서 낱말을 골라 주는 국어사전이다.
아래 문장 속 [대상]을 바꿔 쓸 수 있는 말을 찾아라.

문장: «${sentence}»
대상: «${word}»

- lemma: 대상의 기본형 (예: '걸었다' → '걷다', '사과를' → '사과').
- items: 대상 자리에 그대로 넣을 수 있는 꼴로 적은 유의어 10~16개. 조사·어미·높임·시제를 문장에 맞춰 붙인다 (예: '사과를' → '능금을', '걸었다' → '거닐었다').
  문맥에 가장 잘 맞는 말부터. 같은 말 반복·대상 자신은 빼라. 소설 문장에 쓸 만한 고유어·한자어·비유적 표현을 고루.
- note: 대상과 뜻·느낌이 어떻게 다른지 12자 이내 (예: '더 느긋함', '문어적', '속된 말'). 같으면 비워 둔다.
- antonyms: 반대말 0~3개 (기본형).
JSON으로만 답하라.`;

// ---------- 낱말 찾기 ----------
const WORD = /[\p{L}\p{N}\p{M}'’-]/u;
function wordAt(state) {
  const { from, to, $from } = state.selection;
  const block = $from.parent;
  if (!block.isTextblock) return null;
  const start = $from.start();
  const text = block.textBetween(0, block.content.size, null, '￼');
  let a, b;
  if (from !== to) {
    if (!state.selection.$to.sameParent($from)) return null;
    a = from - start; b = to - start;
    const t = text.slice(a, b).trim();
    if (!t || t.length > 40) return null;
    // 앞뒤 빈칸은 빼고 찾는다
    a += text.slice(a, b).length - text.slice(a, b).trimStart().length;
    b = a + t.length;
  } else {
    a = b = from - start;
    while (a > 0 && WORD.test(text[a - 1])) a--;
    while (b < text.length && WORD.test(text[b])) b++;
    if (a === b) return null;
  }
  const word = text.slice(a, b);
  if (!/\p{L}/u.test(word)) return null;
  // 문장: 앞뒤 문장부호까지, 너무 길면 자른다
  let s = a, e = b;
  while (s > 0 && !/[.!?。…]\s/.test(text.slice(s - 2, s)) && a - s < 160) s--;
  while (e < text.length && !/[.!?。…]/.test(text[e - 1] || '') && e - b < 160) e++;
  return { from: start + a, to: start + b, text: word, sentence: text.slice(s, e).replace(/￼/g, ' ').trim() };
}

// ---------- 창 ----------
function build() {
  const el = document.createElement('aside');
  el.id = 'synPanel';
  el.className = 'syn-panel';
  el.setAttribute('aria-label', '유의어');
  el.innerHTML = `<div class="syn-head">
      <b>유의어</b>
      <select class="syn-prov" aria-label="AI">${ORDER.map((p) => `<option value="${p}">${PROVIDERS[p].short}</option>`).join('')}</select>
      <button type="button" class="icon-btn syn-side" title="반대쪽으로 옮기기" aria-label="반대쪽으로 옮기기">⇄</button>
      <button type="button" class="icon-btn syn-close" title="닫기" aria-label="유의어 창 닫기">✕</button>
    </div>
    <div class="syn-word" aria-live="polite"></div>
    <div class="syn-list"></div>
    <p class="syn-foot hint">커서를 낱말에 두거나 글자를 고르면 바로 찾아요. 누르면 그 말로 바꿔요.</p>`;
  $('#workspace').appendChild(el);
  el.querySelector('.syn-close').addEventListener('click', () => toggleSynonyms(false));
  el.querySelector('.syn-side').addEventListener('click', () => { app.settings.synSide = side() === 'left' ? 'right' : 'left'; saveSettings(); layout(); });
  const sel = el.querySelector('.syn-prov');
  sel.addEventListener('change', () => { app.settings.synProvider = sel.value; saveSettings(); lookup(true); });
  el.addEventListener('mousedown', (e) => { if (e.target.closest('[data-w]')) e.preventDefault(); }); // 원고의 커서·선택을 지킨다
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (b) { replaceWith(b.dataset.w); return; }
    if (e.target.closest('[data-ai-set]')) showAiSettings();
    if (e.target.closest('[data-retry]')) lookup(true);
  });
  return el;
}

function layout() {
  const on = isOpen() && !!app.project;
  const el = $('#synPanel') || (on ? build() : null);
  document.body.classList.toggle('syn-open', on);
  document.body.classList.toggle('syn-left', on && side() === 'left');
  if (!el) return;
  el.hidden = !on;
  el.classList.toggle('left', side() === 'left');
  el.querySelector('.syn-prov').value = synProvider();
  if (isPageView()) applyPageView();
}

export function toggleSynonyms(on = !isOpen()) {
  app.settings.synOpen = on;
  saveSettings();
  layout();
  if (on) lookup(true);
  else { ctrl?.abort(); target = null; }
}

export function bindSynonyms() {
  app.editor.on('selectionUpdate', () => schedule());
  app.editor.on('update', () => schedule());
  app.hooks.afterOpen.push(() => { layout(); schedule(); });
  layout();
}

function schedule() {
  if (!isOpen()) return;
  clearTimeout(timer);
  // 고른 글자는 바로, 커서만 옮기면 잠깐 멈췄을 때
  const sel = app.editor.state.selection;
  timer = setTimeout(() => lookup(false), sel.empty ? 450 : 200);
}

function render(html) { const l = $('#synPanel .syn-list'); if (l) l.innerHTML = html; }
function head(t, sub = '') { const w = $('#synPanel .syn-word'); if (w) w.innerHTML = t ? `<span class="syn-t">${h(t)}</span>${sub ? `<small>${h(sub)}</small>` : ''}` : ''; }

function show(r, word) {
  head(word, r.lemma && r.lemma !== word ? `기본형 ${r.lemma}` : '');
  const items = (r.items || []).filter((x) => x?.word && x.word !== word);
  render((items.length
    ? `<div class="syn-items">${items.map((x) => `<button type="button" class="syn-item" data-w="${h(x.word)}" title="‘${h(x.word)}’(으)로 바꾸기"><span>${h(x.word)}</span>${x.note ? `<small>${h(x.note)}</small>` : ''}</button>`).join('')}</div>`
    : '<p class="hint">알맞은 유의어를 찾지 못했어요.</p>')
    + ((r.antonyms || []).length ? `<div class="syn-anto"><span>반대말</span> ${(r.antonyms || []).map((a) => `<em>${h(a)}</em>`).join(' ')}</div>` : ''));
}

async function lookup(force) {
  if (!isOpen() || !app.editor) return;
  const t = wordAt(app.editor.state);
  if (!t) { if (!target) { head(''); render('<p class="hint">낱말에 커서를 두거나 글자를 골라 보세요.</p>'); } return; }
  if (!force && kept && t.from === kept.from && t.to === kept.to && t.text === kept.text) { target = t; return; }
  kept = null;
  if (!force && target && target.text === t.text && target.sentence === t.sentence) { target = t; return; }
  target = t;
  const p = synProvider();
  const miss = aiMissing(p);
  if (miss) { head(t.text); render(`<p class="hint">${h(miss)}</p><button type="button" class="small" data-ai-set>AI 키·모델 넣기</button>`); return; }
  const key = `${p}|${modelOf(p)}|${t.text}|${t.sentence}`;
  if (cache.has(key)) { show(cache.get(key), t.text); return; }
  const prev = lastByWord.get(t.text);
  if (prev) show(prev, t.text); else { head(t.text); render('<p class="syn-wait">찾는 중…</p>'); }
  ctrl?.abort();
  ctrl = new AbortController();
  const my = ++seq;
  try {
    const r = await askJSON(prompt(t.text, t.sentence), SCHEMA, { signal: ctrl.signal, provider: p });
    cache.set(key, r);
    lastByWord.set(t.text, r);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    if (my === seq) show(r, t.text);
  } catch (e) {
    if (e.name === 'AbortError' || my !== seq) return;
    render(`<p class="hint">${h(e.message)}</p><button type="button" class="small" data-retry>다시 찾기</button>${e.fatal ? ' <button type="button" class="small" data-ai-set>AI 설정</button>' : ''}`);
  }
}

// 고른 유의어로 바꾼다: 찾을 때의 자리에 그 낱말이 그대로 있을 때만. 서식·주석은 첫 글자 것을 따른다
function replaceWith(word) {
  const t = target;
  const { state, view } = app.editor;
  if (!t || t.to > state.doc.content.size || state.doc.textBetween(t.from, t.to, null, '￼') !== t.text) { toast('원고가 바뀌어 바꿀 자리를 놓쳤어요. 다시 골라 주세요.'); return; }
  const first = state.doc.nodeAt(t.from);
  const marks = first?.isText ? first.marks : state.doc.resolve(t.from).marks();
  const tr = state.tr.replaceWith(t.from, t.to, state.schema.text(word, marks));
  view.dispatch(tr.scrollIntoView());
  // 바꾼 낱말을 고른 채로 두어 이어서 다시 고를 수 있게
  const to = t.from + word.length;
  kept = { from: t.from, to, text: word };
  target = { ...t, to, text: word };
  head(word, `← ${t.text}`);
  app.editor.chain().focus().setTextSelection({ from: t.from, to }).run();
}

export const _test = { wordAt, prompt };
