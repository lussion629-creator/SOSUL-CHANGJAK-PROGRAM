// 유의어 창: 원고 옆(왼쪽·오른쪽)에 붙여 두면 커서가 있는 낱말이나 고른 글자의 유의어를
// 고른 AI(GPT·Claude·Gemini)에게 바로 물어 보여 준다. 누르면 그 낱말을 바꾼다.
import { app, saveSettings } from './app.js';
import { PROVIDERS, aiKey, modelOf, askJSON, showAiSettings, savedModels, modelChoices, lightFirst } from './ai.js';
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
// word: 낱말 하나의 유의어 · phrase: 고른 구절의 낱말을 모두 바꿔 통째로 새로 쓰기 ('치킨의 미학' → '통닭의 아름다움')
const mode = () => (app.settings.synMode === 'phrase' ? 'phrase' : 'word');
const side = () => (app.settings.synSide === 'left' ? 'left' : 'right');
export function synProvider() {
  const p = app.settings.synProvider;
  if (PROVIDERS[p]) return p;
  return ORDER.find((x) => aiKey(x) && modelOf(x)) || app.settings.ai?.provider || 'openai';
}

// 유의어에 쓸 모델: 유의어 창에서 따로 고를 수 있다 (안 고르면 설정 → AI 글 모델의 모델)
export const synModel = (p = synProvider()) => app.settings.synModels?.[p] || modelOf(p);
function synMissing(p) {
  if (!aiKey(p)) return `${PROVIDERS[p].short} API 키가 없어요. 아래 단추로 넣어 주세요.`;
  if (!synModel(p)) return `${PROVIDERS[p].short} 모델을 골라 주세요. 위 모델 칸에서 ‘목록 불러오기’를 누르면 고를 수 있어요.`;
  return '';
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

const PHRASE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { word: { type: 'STRING' }, note: { type: 'STRING' } }, required: ['word'] } },
  },
  required: ['items'],
};
const phrasePrompt = (text, sentence) => `너는 한국어 소설가 곁에서 표현을 바꿔 써 주는 글벗이다.
아래 문장 속 [대상] 구절을, 구절을 이루는 낱말 하나하나를 모두 다른 말로 바꿔 통째로 새로 써라.
예: '치킨의 미학' → '통닭의 아름다움', '닭튀김이 지닌 멋' / '조용히 걸었다' → '나직이 거닐었다'

문장: «${sentence}»
대상: «${text}»

- items: 대상 자리에 그대로 넣을 수 있는 바꿔 쓴 구절 8~12개. 뜻은 지키고, 원래 낱말(실질 형태소)은 되도록 하나도 남기지 마라.
  조사·어미·시제·높임은 문장에 맞춘다. 문맥에 가장 잘 맞는 것부터. 고유어로 푼 것·한자어로 바꾼 것·비유적인 것을 고루. 대상과 같은 것은 빼라.
- note: 원래 구절과 느낌이 어떻게 다른지 12자 이내 (예: '더 예스러움', '구어적'). 같으면 비워 둔다.
JSON으로만 답하라.`;

// ---------- 낱말 찾기 ----------
const WORD = /[\p{L}\p{N}\p{M}'’-]/u;
function wordAt(state, max = 40) {
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
    if (!t || t.length > max) return null;
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
    <div class="syn-mrow"><span>모델</span><select class="syn-model" aria-label="AI 모델"></select></div>
    <div class="syn-modes" role="group" aria-label="찾는 방식"><button type="button" data-mode="word">낱말 유의어</button><button type="button" data-mode="phrase" title="고른 구절의 낱말을 모두 바꿔 통째로 새로 써요 (예: 치킨의 미학 → 통닭의 아름다움)">구절 통째로 바꾸기</button></div>
    <div class="syn-word" aria-live="polite"></div>
    <div class="syn-list"></div>
    <p class="syn-foot hint">커서를 낱말에 두거나 글자를 고르면 바로 찾아요. 누르면 그 말로 바꿔요.</p>`;
  $('#workspace').appendChild(el);
  el.querySelector('.syn-close').addEventListener('click', () => toggleSynonyms(false));
  el.querySelector('.syn-side').addEventListener('click', () => { app.settings.synSide = side() === 'left' ? 'right' : 'left'; saveSettings(); layout(); });
  const sel = el.querySelector('.syn-prov');
  sel.addEventListener('change', () => { app.settings.synProvider = sel.value; saveSettings(); fillModels(); lookup(true); });
  const ms = el.querySelector('.syn-model');
  ms.addEventListener('change', async () => {
    const p = synProvider(), v = ms.value;
    if (v === '__load') { await fillModels(true); return; }
    if (v === '__set') { fillModels(); await showAiSettings(); fillModels(); lookup(true); return; }
    (app.settings.synModels ||= {})[p] = v;
    saveSettings();
    lookup(true);
  });
  el.addEventListener('mousedown', (e) => { if (e.target.closest('[data-w]')) e.preventDefault(); }); // 원고의 커서·선택을 지킨다
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (b) { replaceWith(b.dataset.w); return; }
    if (e.target.closest('[data-ai-set]')) showAiSettings();
    if (e.target.closest('[data-retry]')) lookup(true);
    const m = e.target.closest('[data-mode]');
    if (m) { app.settings.synMode = m.dataset.mode; saveSettings(); paintMode(); kept = null; lookup(true); }
  });
  return el;
}

function paintMode() {
  const el = $('#synPanel');
  if (!el) return;
  el.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode())));
  el.querySelector('.syn-head b').textContent = mode() === 'phrase' ? '바꿔 쓰기' : '유의어';
  el.querySelector('.syn-foot').textContent = mode() === 'phrase'
    ? '바꿀 구절을 고르면 낱말을 모두 바꿔 새로 쓴 표현을 보여 줘요. 누르면 그 표현으로 바꿔요.'
    : '커서를 낱말에 두거나 글자를 고르면 바로 찾아요. 누르면 그 말로 바꿔요.';
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
  paintMode();
  if (on) fillModels();
  if (isPageView()) applyPageView();
  document.dispatchEvent(new CustomEvent('nw-syn-changed')); // 유의어 사전(워드시스터즈) 창이 반대쪽으로 비키게
}

// 모델 칸: 지금 모델 + 불러온 목록 + 권장 모델, 맨 끝에 '목록 불러오기'·'AI 설정'
let loading = false;
async function fillModels(refresh = false) {
  const el = $('#synPanel .syn-model');
  if (!el) return;
  const p = synProvider();
  const draw = (note = '') => {
    const cur = synModel(p);
    const ids = [...new Set([cur, ...savedModels(p), ...PROVIDERS[p].suggest].filter(Boolean))];
    el.innerHTML = (cur ? '' : '<option value="">모델을 골라 주세요</option>')
      + ids.map((id) => `<option value="${h(id)}">${h(id)}</option>`).join('')
      + `<option value="__load">${note || (aiKey(p) ? '↻ 목록 불러오기' : '↻ 목록 불러오기 (키 필요)')}</option><option value="__set">⚙ AI 설정…</option>`;
    el.value = cur || '';
  };
  draw();
  // 키가 있는데 목록이 아직 없으면 저절로 한 번 불러온다
  if (!aiKey(p) || loading || (!refresh && savedModels(p).length)) return;
  loading = true;
  draw('불러오는 중…');
  try {
    const list = await modelChoices(p, { refresh: true });
    // 아직 고른 모델이 없으면 빠르고 값싼 모델을 골라 둔다 (유의어는 빨라야 하므로)
    if (!synModel(p) && list.length) {
      (app.settings.synModels ||= {})[p] = lightFirst(list.map((id) => ({ id }))).id;
      saveSettings();
      lookup(true);
    }
    draw();
    if (refresh) toast(`${PROVIDERS[p].short} 모델 ${list.length}개를 불러왔어요.`);
  } catch (e) { draw(); toast(e.message, 5000); } finally { loading = false; }
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
  document.addEventListener('nw-syn-layout', () => layout());
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
  if (r.phrase) head(word, '통째로 바꾸기');
  const items = (r.items || []).filter((x) => x?.word && x.word !== word);
  render((items.length
    ? `<div class="syn-items">${items.map((x) => `<button type="button" class="syn-item" data-w="${h(x.word)}" title="‘${h(x.word)}’(으)로 바꾸기"><span>${h(x.word)}</span>${x.note ? `<small>${h(x.note)}</small>` : ''}</button>`).join('')}</div>`
    : `<p class="hint">${r.phrase ? '바꿔 쓸 표현을 찾지 못했어요.' : '알맞은 유의어를 찾지 못했어요.'}</p>`)
    + ((r.antonyms || []).length ? `<div class="syn-anto"><span>반대말</span> ${(r.antonyms || []).map((a) => `<em>${h(a)}</em>`).join(' ')}</div>` : ''));
}

async function lookup(force) {
  if (!isOpen() || !app.editor) return;
  const md = mode();
  const t = wordAt(app.editor.state, md === 'phrase' ? 120 : 40);
  if (!t) { if (!target) { head(''); render(`<p class="hint">${md === 'phrase' ? '바꿀 구절을 골라 보세요.' : '낱말에 커서를 두거나 글자를 골라 보세요.'}</p>`); } return; }
  t.mode = md;
  if (!force && kept && t.from === kept.from && t.to === kept.to && t.text === kept.text) { target = t; return; }
  kept = null;
  if (!force && target && target.text === t.text && target.sentence === t.sentence && target.mode === md) { target = t; return; }
  target = t;
  const p = synProvider();
  const miss = synMissing(p);
  if (miss) { head(t.text); render(`<p class="hint">${h(miss)}</p><button type="button" class="small" data-ai-set>AI 키·모델 넣기</button>`); return; }
  const model = synModel(p);
  const key = `${md}|${p}|${model}|${t.text}|${t.sentence}`;
  const wkey = `${md}|${t.text}`;
  if (cache.has(key)) { show(cache.get(key), t.text); return; }
  const prev = lastByWord.get(wkey);
  if (prev) show(prev, t.text); else { head(t.text); render('<p class="syn-wait">찾는 중…</p>'); }
  ctrl?.abort();
  ctrl = new AbortController();
  const my = ++seq;
  try {
    const r = md === 'phrase'
      ? { ...(await askJSON(phrasePrompt(t.text, t.sentence), PHRASE_SCHEMA, { signal: ctrl.signal, provider: p, model })), phrase: true }
      : await askJSON(prompt(t.text, t.sentence), SCHEMA, { signal: ctrl.signal, provider: p, model });
    cache.set(key, r);
    lastByWord.set(wkey, r);
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

export const _test = { wordAt, prompt, phrasePrompt };
