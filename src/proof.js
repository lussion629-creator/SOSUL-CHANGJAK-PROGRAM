// 맞춤법·문장부호 교정: 틀리기 쉬운 곳에 물결 밑줄을 긋고, 누르면 고칠 말을 보여 준다.
// 규칙(이 기기 안에서 바로) + AI 검사(Gemini 키가 있을 때, 장 하나씩). 켜고 끌 수 있다.
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import * as S from './store.js';
import { app, saveSettings } from './app.js';
import { $, h, toast, dialog } from './ui.js';
import { askText, getKey, cfg } from './reader.js';

// ---------- 규칙 ----------
const jong = (ch) => { const c = (ch || '').charCodeAt(0) - 0xac00; return c >= 0 && c < 11172 ? c % 28 : -1; };
const RIEUL = 8; // 받침 ㄹ
// 자주 틀리는 말: [틀린 꼴(정규식 문자열), 고칠 말, 까닭]
const WORDS = [
  ['몇 ?일(?![본])', '며칠', '‘몇 일’이 아니라 ‘며칠’로 써요.'],
  ['어떻해', '어떡해', '‘어떻게 해’를 줄이면 ‘어떡해’예요.'],
  ['어떻하', '어떡하', '‘어떻게 하’를 줄이면 ‘어떡하’예요.'],
  ['왠일', '웬일', '‘어찌 된 일’은 ‘웬일’이에요.'],
  ['왠만', '웬만', '‘웬만하다’가 맞아요.'],
  ['웬지', '왠지', '‘왜인지’를 줄인 말은 ‘왠지’예요.'],
  ['금새(?![가-힣])', '금세', '‘금시에’를 줄인 말은 ‘금세’예요.'],
  ['오랫만', '오랜만', '‘오래간만’을 줄이면 ‘오랜만’이에요.'],
  ['설겆이', '설거지', ''],
  ['희안', '희한', ''],
  ['어의없', '어이없', ''],
  ['역활', '역할', ''],
  ['건내(?=[주준줬다며고는])', '건네', '‘건네다’가 맞아요.'],
  ['깨끗히', '깨끗이', '‘ㅅ’ 받침 뒤에는 ‘-이’를 써요.'],
  ['곰곰히', '곰곰이', ''],
  ['일일히', '일일이', ''],
  ['틈틈히', '틈틈이', ''],
  ['번번히', '번번이', ''],
  ['낱낱히', '낱낱이', ''],
  ['일찌기', '일찍이', ''],
  ['더우기', '더욱이', ''],
  ['아뭏든', '아무튼', ''],
  ['어쨋든', '어쨌든', ''],
  ['설레임', '설렘', '‘설레다’의 명사는 ‘설렘’이에요.'],
  ['바램(?=[이은을도과]|[^가-힣]|$)', '바람', '‘바라다’의 명사는 ‘바람’이에요. (‘바래다’는 색이 바래는 것)'],
  ['내노라', '내로라', ''],
  ['숫가락', '숟가락', ''],
  ['가르키', '가리키', '손으로 짚는 것은 ‘가리키다’예요.'],
  ['얼만큼', '얼마큼', ''],
  ['눈쌀', '눈살', ''],
  ['닥달', '닦달', ''],
  ['짜집기', '짜깁기', ''],
  ['구렛나루', '구레나룻', ''],
  ['촛점', '초점', ''],
  ['댓가', '대가', ''],
  ['갯수', '개수', ''],
  ['우뢰', '우레', ''],
  ['웅큼', '움큼', ''],
  ['넓직', '널찍', ''],
  ['핼쓱', '핼쑥', ''],
  ['으시대', '으스대', ''],
  ['애띠', '앳되', ''],
  ['애닳', '애달', ''],
  ['덮히', '덮이', ''],
  ['부숴지', '부서지', ''],
  ['뒤치닥거리', '뒤치다꺼리', ''],
  ['([있없었았였했겠])슴(?![니다])', '$1음', '‘-음’으로 써요.'],
];
const words = WORDS.map(([re, to, why]) => ({ re: new RegExp(re, 'g'), to, why }));

// 규칙: find(text) → [{i, len, fix: [고칠 말…], why}]
const each = (text, re, fn) => {
  const out = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) { const r = fn(m); if (r) out.push({ i: m.index, len: m[0].length, ...r }); }
  return out;
};
export const RULES = [
  { id: 'dwae', kind: 'sp', label: '되/돼, 뵈/봬', hint: '되요 → 돼요 · 됬다 → 됐다 · 되서 → 돼서 · 뵈요 → 봬요', find: (t) => [
    ...each(t, /되요(?![가-힣])/g, () => ({ fix: ['돼요'], why: '‘되어요’를 줄이면 ‘돼요’예요.' })),
    ...each(t, /됬/g, () => ({ fix: ['됐'], why: '‘되었’을 줄이면 ‘됐’이에요.' })),
    ...each(t, /되(서|야)/g, (m) => ({ fix: ['돼' + m[1]], why: `‘되어${m[1]}’를 줄이면 ‘돼${m[1]}’예요.` })),
    ...each(t, /돼(?=[다고는면었어])/g, () => ({ fix: ['되'], why: '‘되어’로 바꿔 말이 안 되면 ‘되’를 써요.' })),
    ...each(t, /뵈요/g, () => ({ fix: ['봬요'], why: '‘뵈어요’를 줄이면 ‘봬요’예요.' })),
    ...each(t, /뵜/g, () => ({ fix: ['뵀'], why: '' })),
  ] },
  { id: 'words', kind: 'sp', label: '자주 틀리는 낱말', hint: '몇일 → 며칠 · 왠일 → 웬일 · 금새 → 금세 · 설레임 → 설렘 …', find: (t) =>
    [...words.flatMap((w) => each(t, w.re, (m) => ({ fix: [m[0].replace(new RegExp(w.re.source), w.to)], why: w.why }))),
      ...each(t, /([가-힣])이였/g, (m) => (jong(m[1]) > 0 ? { fix: [m[1] + '이었'], why: '받침 있는 말 뒤에는 ‘이었다’예요. (받침 없으면 ‘였다’)' } : null))] },
  { id: 'anh', kind: 'sp', label: '안/않', hint: '않되 → 안 되 · 않해 → 안 해', find: (t) =>
    each(t, /않(되|돼|하|해|했|할|한)/g, (m) => ({ fix: ['안 ' + m[1]], why: '‘아니’를 줄인 말은 ‘안’이에요. (‘않’은 ‘아니하’)' })) },
  { id: 'lge', kind: 'sp', label: '-ㄹ게 · -ㄹ걸 · -ㄹ 거', hint: '할께 → 할게 · 할껄 → 할걸 · 할꺼야 → 할 거야', find: (t) =>
    each(t, /([가-힣])(께|껄|꺼)(?=[요야예다니면라고지든]|[^가-힣]|$)/g, (m) => {
      if (jong(m[1]) !== RIEUL || /[불말]/.test(m[1])) return null;
      const to = m[2] === '께' ? m[1] + '게' : m[2] === '껄' ? m[1] + '걸' : m[1] + ' 거';
      return { fix: [to], why: m[2] === '꺼' ? '‘것’을 말하는 ‘거’는 띄어 쓰고 예사소리로 써요.' : '소리는 [께]로 나도 ‘-ㄹ게’, ‘-ㄹ걸’로 써요.' };
    }) },
  { id: 'spacing', kind: 'sp', label: '띄어쓰기 (자주 붙여 쓰는 말)', hint: '할수있다 → 할 수 있다 · 갈때 → 갈 때 · 할거야 → 할 거야 · 것같다 → 것 같다', find: (t) => [
    ...each(t, /([가-힣])수 ?(있|없)/g, (m) => (jong(m[1]) !== RIEUL || /[말술]/.test(m[1]) ? null : { fix: [`${m[1]} 수 ${m[2]}`], why: '‘수’는 띄어 써요.' })),
    ...each(t, /([가-힣])때(?!문)/g, (m) => (jong(m[1]) !== RIEUL || /[물쓸]/.test(m[1]) ? null : { fix: [`${m[1]} 때`], why: '‘때’는 띄어 써요.' })),
    ...each(t, /([가-힣])거(?=야|예요|에요|다|면|라|니|지|든|였)/g, (m) => (jong(m[1]) !== RIEUL || /[설]/.test(m[1]) ? null : { fix: [`${m[1]} 거`], why: '‘거(것)’는 띄어 써요.' })),
    ...each(t, /것같/g, () => ({ fix: ['것 같'], why: '‘같다’는 띄어 써요.' })),
  ] },
  { id: 'quotePair', kind: 'pn', label: '따옴표 짝', hint: '여는 따옴표만 있거나 닫는 따옴표만 있을 때', find: (t) => {
    const out = [];
    const pairs = { '“': '”', '「': '」', '『': '』' };
    const close = { '”': '“', '」': '「', '』': '『' };
    const stack = [];
    [...t].forEach((ch, i) => {
      if (pairs[ch]) stack.push({ ch, i });
      else if (close[ch]) {
        const k = stack.findLastIndex((x) => x.ch === close[ch]);
        if (k < 0) out.push({ i, len: 1, fix: [], why: `여는 ${close[ch]}이 없어요.` });
        else stack.splice(k, 1);
      }
    });
    for (const x of stack) out.push({ i: x.i, len: 1, fix: [], why: `닫는 ${pairs[x.ch]}이 없어요.` });
    return out;
  } },
  { id: 'straight', kind: 'pn', label: '곧은따옴표 섞임', hint: '“말”과 "말"이 한 문단에 섞여 있을 때', find: (t) => {
    if (!/[“”]/.test(t) || !t.includes('"')) return [];
    return each(t, /"/g, (m) => { const p = t[m.index - 1]; const open = !p || /[\s(\[{‘「『—-]/.test(p); return { fix: [open ? '“' : '”'], why: '둥근 따옴표와 곧은따옴표가 섞여 있어요.' }; });
  } },
  { id: 'punctSpace', kind: 'pn', label: '문장부호 앞 빈칸', hint: '가자 . → 가자.', find: (t) =>
    each(t, /(?<=[^\s]) +(?=[.,!?”’」』)](?!\.))/g, () => ({ fix: [''], why: '문장부호 앞에는 빈칸을 두지 않아요.' })) },
  { id: 'punctAfter', kind: 'pn', label: '문장부호 뒤 빈칸 없음', hint: '왔다.그리고 → 왔다. 그리고', find: (t) =>
    each(t, /(?<=[가-힣])([.,!?])([가-힣])/g, (m) => ({ fix: [`${m[1]} ${m[2]}`], why: '문장부호 뒤에는 한 칸 띄어요.' })) },
  { id: 'quoteInner', kind: 'pn', label: '따옴표 안쪽 빈칸', hint: '“ 가자.” → “가자.”', find: (t) =>
    each(t, /([“‘「『]) +/g, (m) => ({ fix: [m[1]], why: '여는 따옴표 바로 뒤에는 빈칸을 두지 않아요.' })) },
  { id: 'quoteBefore', kind: 'pn', label: '따옴표 앞 빈칸 없음', hint: '그는“가자 → 그는 “가자', find: (t) =>
    each(t, /([가-힣.!?…])([“「『])/g, (m) => ({ fix: [`${m[1]} ${m[2]}`], why: '여는 따옴표 앞에는 한 칸 띄어요.' })) },
  { id: 'marks', kind: 'pn', label: '겹친 문장부호', hint: '.. → … · ,, → , · ?. → ?', find: (t) => [
    ...each(t, /(?<!\.)\.\.(?!\.)/g, () => ({ fix: ['…', '.'], why: '마침표 두 개는 말줄임표(…)나 마침표 하나로 써요.' })),
    ...each(t, /,{2,}/g, () => ({ fix: [','], why: '쉼표가 겹쳤어요.' })),
    ...each(t, /([?!])\.(?!\.)/g, (m) => ({ fix: [m[1]], why: '물음표·느낌표 뒤에는 마침표를 찍지 않아요.' })),
    ...each(t, /\.,|,\./g, () => ({ fix: ['.', ','], why: '마침표와 쉼표가 겹쳤어요.' })),
  ] },
  { id: 'spaces', kind: 'pn', label: '두 칸 이상 빈칸', hint: '낱말 사이 빈칸은 한 칸', find: (t) =>
    each(t, /(?<=\S) {2,}(?=\S)/g, () => ({ fix: [' '], why: '빈칸이 두 칸 이상이에요.' })) },
  { id: 'dialogEnd', kind: 'pn', label: '대사 끝 마침표', off: true, hint: '“가자” → “가자.” (써도 안 써도 되는 규칙이라 처음에는 꺼 둠)', find: (t) =>
    each(t, /([가-힣])(”)/g, (m) => ({ fix: [`${m[1]}.”`], why: '인용한 문장 끝에는 마침표를 쓰는 것이 원칙이에요 (안 써도 틀리지는 않아요).' })) },
];

// ---------- 설정 ----------
export const isOn = () => app.settings.proof !== false;
const offRules = () => new Set(app.settings.proofOff ?? RULES.filter((r) => r.off).map((r) => r.id));
const ignored = () => new Set(app.project?.proofIgnore || []);

// 문단 하나 검사 (결과는 문단 노드마다 기억: 바뀌지 않은 문단은 다시 보지 않는다)
let memo = new WeakMap();
let memoSig = '';
function checkText(text) {
  const off = offRules(), ign = ignored();
  const out = [];
  for (const r of RULES) {
    if (off.has(r.id)) continue;
    for (const x of r.find(text)) {
      const word = text.slice(x.i, x.i + x.len);
      if (ign.has(`${r.id}:${word}`)) continue;
      out.push({ ...x, rule: r.id, kind: r.kind, word });
    }
  }
  // 겹치면 앞의 것만
  out.sort((a, b) => a.i - b.i || b.len - a.len);
  return out.filter((x, k) => !out.slice(0, k).some((y) => x.i < y.i + y.len && y.i < x.i + x.len && y !== x));
}
function issuesOf(doc) {
  const sig = `${[...offRules()].join()}|${(app.project?.proofIgnore || []).length}`;
  if (sig !== memoSig) { memo = new WeakMap(); memoSig = sig; }
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let list = memo.get(node);
    if (!list) { list = checkText(node.textBetween(0, node.content.size, null, '￼')); memo.set(node, list); }
    for (const x of list) out.push({ ...x, from: pos + 1 + x.i, to: pos + 1 + x.i + x.len });
    return false;
  });
  return out;
}

// ---------- 편집기 표시 ----------
const key = new PluginKey('proof');
const build = (doc, issues) => DecorationSet.create(doc, issues.filter((x) => x.to > x.from).map((x) =>
  Decoration.inline(x.from, x.to, { class: `pf pf-${x.kind}${x.ai ? ' pf-ai' : ''}`, 'data-pf': '1' }, { issue: x })));

const plugin = new Plugin({
  key,
  state: {
    init: () => ({ deco: DecorationSet.empty, issues: [], ai: [] }),
    apply(tr, prev, _old, state) {
      const meta = tr.getMeta(key);
      let ai = prev.ai;
      if (tr.docChanged && ai.length) {
        // AI가 찾은 곳: 위치를 따라가고, 글이 바뀌었으면 버린다
        ai = ai.map((x) => ({ ...x, from: tr.mapping.map(x.from, 1), to: tr.mapping.map(x.to, -1) }))
          .filter((x) => x.to > x.from && state.doc.textBetween(x.from, x.to, '\n', '￼') === x.word);
      }
      if (meta?.ai) ai = meta.ai;
      if (meta?.clearAi) ai = [];
      if (!isOn()) return { deco: DecorationSet.empty, issues: [], ai };
      if (meta?.recheck || meta?.ai || meta?.clearAi) {
        const rules = issuesOf(state.doc).filter((x) => !ai.some((y) => x.from < y.to && y.from < x.to));
        const issues = [...rules, ...ai].sort((a, b) => a.from - b.from);
        return { deco: build(state.doc, issues), issues, ai };
      }
      if (!tr.docChanged) return prev;
      // 쓰는 동안에는 밑줄 위치만 따라가고, 잠깐 멈추면 다시 검사한다 (한글 조합 중 화면이 흔들리지 않게)
      return { deco: prev.deco.map(tr.mapping, tr.doc), issues: prev.issues, ai, stale: true };
    },
  },
  props: {
    decorations: (state) => key.getState(state).deco,
    handleClick(view, pos, e) {
      if (!isOn()) return false;
      const hit = key.getState(view.state).deco.find(pos, pos).find((d) => d.from <= pos && pos <= d.to);
      if (!hit) { closePop(); return false; }
      setTimeout(() => openPop(view, hit.spec.issue, hit.from, hit.to, e), 0);
      return false;
    },
  },
  view(view) {
    let t = null;
    const kick = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (view.composing) { kick(); return; }
        if (isOn() && key.getState(view.state).stale !== false) view.dispatch(view.state.tr.setMeta(key, { recheck: true }).setMeta('addToHistory', false));
      }, 450);
    };
    kick();
    return { update(v, prevState) { if (v.state.doc !== prevState.doc) kick(); }, destroy() { clearTimeout(t); } };
  },
});

export function recheck() {
  const ed = app.editor;
  if (!ed) return;
  ed.view.dispatch(ed.state.tr.setMeta(key, { recheck: true }).setMeta('addToHistory', false));
  updateCount();
}
const current = () => (app.editor ? key.getState(app.editor.state)?.issues || [] : []);

// ---------- 고치기·무시 ----------
function apply(x, to) {
  const ed = app.editor;
  const { state } = ed;
  if (state.doc.textBetween(x.from, x.to, '\n', '￼') !== x.word) { toast('그 사이에 글이 바뀌었어요.'); recheck(); return false; }
  const tr = to ? state.tr.insertText(to, x.from, x.to) : state.tr.delete(x.from, x.to);
  ed.view.dispatch(tr);
  recheck();
  return true;
}
async function ignore(x) {
  if (x.ai) {
    const ed = app.editor;
    ed.view.dispatch(ed.state.tr.setMeta(key, { ai: key.getState(ed.state).ai.filter((y) => y !== x && !(y.from === x.from && y.to === x.to)) }));
  } else {
    const p = app.project;
    p.proofIgnore = [...new Set([...(p.proofIgnore || []), `${x.rule}:${x.word}`])];
    await S.putProject(p);
  }
  recheck();
}
function ruleOff(id) {
  const off = offRules();
  off.add(id);
  app.settings.proofOff = [...off];
  saveSettings();
  recheck();
}

// ---------- 밑줄을 눌렀을 때 ----------
let pop = null;
function closePop() { pop?.remove(); pop = null; }
const kindName = (x) => (x.ai ? `AI · ${x.label || (x.kind === 'pn' ? '문장부호' : '맞춤법')}` : x.kind === 'pn' ? '문장부호' : '맞춤법');
function openPop(view, x, from, to, e) {
  closePop();
  const cur = { ...x, from, to };
  pop = document.createElement('div');
  pop.className = 'proof-pop';
  pop.setAttribute('role', 'dialog');
  const rule = RULES.find((r) => r.id === x.rule);
  pop.innerHTML = `<div class="pp-k pp-${x.kind}">${h(kindName(x))}</div>
    <div class="pp-word"><s>${h(x.word.trim() ? x.word : '빈칸')}</s></div>
    ${x.why ? `<p class="pp-why">${h(x.why)}</p>` : ''}
    <div class="pp-to">${x.fix.map((t, i) => `<button type="button" data-to="${i}" class="primary">${h(t === '' ? '지우기' : t.trim() ? t : '빈칸 하나로')}</button>`).join('')}</div>
    <div class="pp-more"><button type="button" data-a="ign">${x.ai ? '이번만 무시' : '이 작품에서 무시'}</button>${rule ? `<button type="button" data-a="off" title="${h(rule.label)} 규칙 끄기">이 규칙 끄기</button>` : ''}<button type="button" data-a="list">목록</button></div>`;
  document.body.append(pop);
  const r = view.coordsAtPos(from);
  const w = pop.offsetWidth, hh = pop.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - w - 8, r.left - 12));
  const top = r.bottom + 8 + hh > innerHeight - 8 ? r.top - hh - 8 : r.bottom + 8;
  Object.assign(pop.style, { left: left + 'px', top: Math.max(8, top) + 'px' });
  pop.addEventListener('mousedown', (ev) => ev.preventDefault()); // 편집기 커서를 지키기
  pop.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.to != null) apply(cur, x.fix[+b.dataset.to]);
    else if (b.dataset.a === 'ign') ignore(x);
    else if (b.dataset.a === 'off') { ruleOff(x.rule); toast(`‘${rule.label}’ 규칙을 껐어요. 교정 목록에서 다시 켤 수 있어요.`); }
    else if (b.dataset.a === 'list') showProof();
    closePop();
    app.editor.commands.focus();
  });
}

// ---------- 켜고 끄기 ----------
export function setProof(on) {
  app.settings.proof = on;
  saveSettings();
  closePop();
  app.editor?.view.dom.setAttribute('spellcheck', on ? 'false' : 'true'); // 브라우저 밑줄과 겹치지 않게
  recheck();
  syncMenu();
}
export function toggleProof() {
  setProof(!isOn());
  toast(isOn() ? '맞춤법·문장부호 교정을 켰어요. 밑줄을 누르면 고칠 말이 나와요.' : '맞춤법·문장부호 교정을 껐어요.');
}
function syncMenu() {
  document.querySelectorAll('[data-act=proof]').forEach((b) => b.classList.toggle('on', isOn()));
}
function updateCount() {
  const el = $('#stProof');
  if (!el) return;
  const n = current().length;
  el.hidden = !isOn();
  el.textContent = n ? `교정 ${n}` : '교정 ✓';
  el.classList.toggle('has', n > 0);
  el.title = n ? `틀렸을 수 있는 곳 ${n}곳 · 눌러서 목록 보기` : '맞춤법·문장부호: 걸리는 곳이 없어요';
}

// ---------- AI 검사 ----------
async function aiCheck({ signal, onProgress } = {}) {
  const ed = app.editor;
  const doc = ed.state.doc;
  const paras = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, null, '￼');
    if (text.trim()) paras.push({ pos: pos + 1, text });
    return false;
  });
  // 문단을 묶어 2,500자 안팎으로 나눠 보낸다
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const p of paras) {
    if (cur.length && len + p.text.length > 2500) { chunks.push(cur); cur = []; len = 0; }
    cur.push(p); len += p.text.length + 1;
  }
  if (cur.length) chunks.push(cur);
  const schema = { type: 'OBJECT', properties: { errors: { type: 'ARRAY', items: { type: 'OBJECT', properties: { p: { type: 'INTEGER' }, wrong: { type: 'STRING' }, right: { type: 'STRING' }, kind: { type: 'STRING', enum: ['맞춤법', '띄어쓰기', '문장부호'] }, why: { type: 'STRING' } }, required: ['p', 'wrong', 'right', 'kind'] } } }, required: ['errors'] };
  const found = [];
  const c = cfg();
  const key = getKey();
  for (let k = 0; k < chunks.length; k++) {
    onProgress?.(k, chunks.length);
    const ch = chunks[k];
    const prompt = `다음은 한국어 소설 원고입니다. 표준 맞춤법·띄어쓰기·문장부호(국립국어원 규정)에 어긋난 곳만 찾으세요.
- 문체·어휘 선택·문장 다듬기는 하지 마세요. 틀린 것만.
- 대사 속 사투리·구어·말버릇·일부러 쓴 표현, 고유 명사는 고치지 마세요.
- p: 문단 번호. wrong: 그 문단에 있는 그대로 옮긴 틀린 부분(앞뒤로 한두 글자를 붙여 문단 안에서 한 번만 나오게). right: wrong을 고친 글. why: 까닭을 짧게.
- 틀린 곳이 없으면 빈 목록.

${ch.map((p, i) => `[${i + 1}] ${p.text}`).join('\n')}`;
    const r = await askText(prompt, schema, { key, c, signal });
    for (const e of r.errors || []) {
      const p = ch[(e.p || 0) - 1];
      if (!p || !e.wrong || e.wrong === e.right) continue;
      const i = p.text.indexOf(e.wrong);
      if (i < 0) continue;
      // 앞뒤 같은 글자는 빼고 바뀐 곳만 밑줄
      let a = 0, b = 0;
      const w = e.wrong, t = e.right || '';
      while (a < w.length && a < t.length && w[a] === t[a]) a++;
      while (b < w.length - a && b < t.length - a && w[w.length - 1 - b] === t[t.length - 1 - b]) b++;
      let from = i + a, to = i + w.length - b, rep = t.slice(a, t.length - b);
      if (to <= from) { // 빈칸을 넣기만 하는 경우: 앞 글자까지 밑줄
        from = Math.max(i, from - 1); rep = p.text.slice(from, i + a) + rep;
      }
      found.push({ from: p.pos + from, to: p.pos + to, word: p.text.slice(from, to), fix: [rep], why: e.why || '', kind: e.kind === '문장부호' ? 'pn' : 'sp', label: e.kind, ai: true });
    }
  }
  // 같은 곳 중복 제거
  const seen = new Set();
  return found.filter((x) => { const k = `${x.from}:${x.to}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- 교정 목록 창 ----------
export async function showProof() {
  closePop();
  if (!isOn()) setProof(true);
  recheck();
  let busy = null;
  const r = await dialog({
    title: '맞춤법·문장부호 교정',
    wide: true,
    body: `<div class="proof">
      <div class="proof-top">
        <label class="check"><input type="checkbox" name="on" ${isOn() ? 'checked' : ''}> <b>쓰는 동안 밑줄로 보여 주기</b> <small data-kbd="proof">Ctrl+Alt+K</small></label>
        <span class="grow"></span>
        <button type="button" class="small" data-p="ai">AI로 이 장 꼼꼼히 검사</button>
        <button type="button" class="small" data-p="fixall">제안대로 모두 고치기</button>
      </div>
      <p id="pfMsg" class="hint" aria-live="polite" style="margin:0"></p>
      <div id="pfList" class="proof-list"></div>
      <details class="proof-rules"><summary>규칙 고르기 · 무시한 말</summary>
        <div class="proof-rule-grid">${RULES.map((x) => `<label class="check"><input type="checkbox" data-rule="${x.id}" ${offRules().has(x.id) ? '' : 'checked'}> <span>${h(x.label)} <small class="hint">${h(x.hint)}</small></span></label>`).join('')}</div>
        <p class="hint" style="margin:6px 0 0">이 작품에서 무시한 말: <span id="pfIgn"></span></p>
      </details>
      <p class="hint" style="margin:0">자주 틀리는 맞춤법·띄어쓰기와 문장부호는 이 기기 안에서 바로 찾아요. 더 꼼꼼히 보려면 ‘AI로 검사’를 눌러 주세요 (낭독 설정의 Gemini 키를 써요).</p>
    </div>`,
    buttons: [{ label: '닫기', value: 'close', primary: true }],
    onOpen: (f) => {
      const msg = $('#pfMsg');
      const ctx = (x) => {
        const d = app.editor.state.doc;
        const a = Math.max(0, x.from - 14), b = Math.min(d.content.size, x.to + 14);
        const pre = d.textBetween(a, x.from, ' ', ' '), post = d.textBetween(x.to, b, ' ', ' ');
        return `${h(pre)}<mark class="pf-${x.kind}">${h(x.word.trim() ? x.word : '␣'.repeat(x.word.length || 1))}</mark>${h(post)}`;
      };
      const draw = () => {
        const list = current();
        const fixable = list.filter((x) => x.fix.length);
        f.querySelector('[data-p=fixall]').disabled = !fixable.length;
        $('#pfList').innerHTML = list.length
          ? list.map((x, i) => `<div class="pf-row" data-i="${i}">
              <span class="pf-k pp-${x.kind}">${h(kindName(x))}</span>
              <span class="pf-ctx" data-a="go" tabindex="0" title="원고에서 보기">${ctx(x)}</span>
              <span class="pf-act">${x.fix.map((t, k) => `<button type="button" class="small" data-a="fix" data-k="${k}" title="${h(x.why)}">→ ${h(t === '' ? '지우기' : t.trim() ? t : '빈칸 하나')}</button>`).join('')}<button type="button" class="small ghost" data-a="ign" title="${x.ai ? '이번만 무시' : '이 작품에서 무시'}">무시</button></span>
              ${x.why ? `<small class="pf-why">${h(x.why)}</small>` : ''}</div>`).join('')
          : `<p class="proof-empty">${isOn() ? '걸리는 곳이 없어요.' : '교정이 꺼져 있어요.'}</p>`;
        $('#pfIgn').textContent = (app.project.proofIgnore || []).map((x) => x.split(':').slice(1).join(':')).join(', ') || '없음';
        f._list = list;
      };
      draw();
      f.addEventListener('change', (e) => {
        if (e.target.name === 'on') { setProof(e.target.checked); draw(); }
        if (e.target.dataset.rule) {
          const off = offRules();
          if (e.target.checked) off.delete(e.target.dataset.rule); else off.add(e.target.dataset.rule);
          app.settings.proofOff = [...off]; saveSettings(); recheck(); draw();
        }
      });
      f.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a], [data-p]');
        if (!b) return;
        const row = b.closest('.pf-row');
        const x = row && f._list[+row.dataset.i];
        if (b.dataset.a === 'fix') { apply(x, x.fix[+b.dataset.k]); draw(); }
        if (b.dataset.a === 'ign') { await ignore(x); draw(); }
        if (b.dataset.a === 'go') {
          const ed = app.editor;
          ed.chain().setTextSelection({ from: x.from, to: x.to }).scrollIntoView().run();
        }
        if (b.dataset.p === 'fixall') {
          const list = current().filter((y) => y.fix.length).sort((p, q) => q.from - p.from);
          const ed = app.editor;
          const tr = ed.state.tr;
          let n = 0;
          for (const y of list) {
            if (tr.doc.textBetween(y.from, y.to, '\n', '￼') !== y.word) continue;
            if (y.fix[0]) tr.insertText(y.fix[0], y.from, y.to); else tr.delete(y.from, y.to);
            n++;
          }
          if (n) ed.view.dispatch(tr);
          recheck(); draw();
          msg.textContent = n ? `${n}곳을 고쳤어요. 마음에 안 들면 Ctrl+Z로 한 번에 되돌릴 수 있어요.` : '';
        }
        if (b.dataset.p === 'ai') {
          if (!getKey()) { msg.textContent = 'Gemini API 키가 없어요. 낭독 → 낭독 설정에서 키를 넣어 주세요.'; return; }
          busy?.abort(); busy = new AbortController();
          b.disabled = true;
          msg.textContent = 'AI가 읽는 중…';
          try {
            const ai = await aiCheck({ signal: busy.signal, onProgress: (k, n) => { msg.textContent = n > 1 ? `AI가 읽는 중… (${k + 1}/${n})` : 'AI가 읽는 중…'; } });
            app.editor.view.dispatch(app.editor.state.tr.setMeta(key, { ai }));
            updateCount(); draw();
            msg.textContent = ai.length ? `AI가 ${ai.length}곳을 더 찾았어요 (‘AI’ 표시). 맞는지 한 번씩 확인해 주세요.` : 'AI가 더 찾은 곳은 없어요.';
          } catch (err) { if (err.name !== 'AbortError') msg.textContent = '✕ ' + err.message; }
          b.disabled = false;
        }
      });
    },
  });
  busy?.abort();
  void r;
}

// ---------- 시작 ----------
export function bindProof() {
  app.editor.registerPlugin(plugin);
  app.editor.view.dom.setAttribute('spellcheck', isOn() ? 'false' : 'true');
  app.editor.on('transaction', ({ transaction }) => { if (transaction.getMeta(key)) updateCount(); });
  app.hooks.afterOpen.push(() => {
    closePop();
    app.editor.view.dispatch(app.editor.state.tr.setMeta(key, { clearAi: true }).setMeta('addToHistory', false));
    updateCount();
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) closePop(); });
  addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target) && !e.target.closest?.('.pf')) closePop(); }, true);
  document.querySelector('.paper-scroll')?.addEventListener('scroll', closePop, { passive: true });
  $('#stProof')?.addEventListener('click', () => showProof());
  syncMenu();
  updateCount();
}
