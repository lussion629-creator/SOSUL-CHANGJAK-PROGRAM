// 맞춤법·문장부호 교정: 틀리기 쉬운 곳에 물결 밑줄을 긋고, 누르면 고칠 말을 보여 준다.
// 규칙(이 기기 안에서 바로) + AI 맞춤법 검사(고른 AI로, 장 하나씩). 켜고 끌 수 있다.
// 규칙마다 '자동 고침'(쓰다가 손을 떼면 알아서 고침) · '수동 고침'(밑줄과 왼쪽 여백 카드로 보여 주고 직접 고침) · '끄기'.
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { closeHistory } from '@tiptap/pm/history';
import * as S from './store.js';
import { app, saveSettings } from './app.js';
import { $, h, toast, toastAction, dialog, symRails } from './ui.js';
import { scheduleRail } from './annotate.js';
import { applyPageView, isPageView } from './pageview.js';
import { askJSON, aiLabel, aiMissing, showAiSettings } from './ai.js';

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
    each(t, /(?<=[^\s])[ \u00a0]+(?=[.,!?”’」』)](?!\.))/g, () => ({ fix: [''], why: '문장부호 앞에는 빈칸을 두지 않아요.' })) },
  { id: 'punctAfter', kind: 'pn', label: '문장부호 뒤 빈칸 없음', hint: '왔다.그리고 → 왔다. 그리고', find: (t) =>
    each(t, /(?<=[가-힣])([.,!?])([가-힣])/g, (m) => ({ fix: [`${m[1]} ${m[2]}`], why: '문장부호 뒤에는 한 칸 띄어요.' })) },
  { id: 'quoteInner', kind: 'pn', label: '따옴표 안쪽 빈칸', hint: '“ 가자.” → “가자.”', find: (t) =>
    each(t, /([“‘「『])[ \u00a0]+/g, (m) => ({ fix: [m[1]], why: '여는 따옴표 바로 뒤에는 빈칸을 두지 않아요.' })) },
  { id: 'quoteBefore', kind: 'pn', label: '따옴표 앞 빈칸 없음', hint: '그는“가자 → 그는 “가자', find: (t) =>
    each(t, /([가-힣.!?…])([“「『])/g, (m) => ({ fix: [`${m[1]} ${m[2]}`], why: '여는 따옴표 앞에는 한 칸 띄어요.' })) },
  { id: 'marks', kind: 'pn', label: '겹친 문장부호', hint: '.. → … · ,, → , · ?. → ?', find: (t) => [
    ...each(t, /(?<!\.)\.\.(?!\.)/g, () => ({ fix: ['…', '.'], why: '마침표 두 개는 말줄임표(…)나 마침표 하나로 써요.' })),
    ...each(t, /,{2,}/g, () => ({ fix: [','], why: '쉼표가 겹쳤어요.' })),
    ...each(t, /([?!])\.(?!\.)/g, (m) => ({ fix: [m[1]], why: '물음표·느낌표 뒤에는 마침표를 찍지 않아요.' })),
    ...each(t, /\.,|,\./g, () => ({ fix: ['.', ','], why: '마침표와 쉼표가 겹쳤어요.' })),
  ] },
  { id: 'spaces', kind: 'pn', label: '두 칸 이상 빈칸', hint: '낱말 사이 빈칸은 한 칸', find: (t) =>
    each(t, /(?<=\S)[ \u00a0]{2,}(?=\S)/g, () => ({ fix: [' '], why: '빈칸이 두 칸 이상이에요.' })) },
  { id: 'dialogEnd', kind: 'pn', label: '대사 끝 마침표', off: true, hint: '“가자” → “가자.” (써도 안 써도 되는 규칙이라 처음에는 꺼 둠)', find: (t) =>
    each(t, /([가-힣])(”)/g, (m) => ({ fix: [`${m[1]}.”`], why: '인용한 문장 끝에는 마침표를 쓰는 것이 원칙이에요 (안 써도 틀리지는 않아요).' })) },
];

// ---------- 설정 ----------
export const isOn = () => app.settings.proof !== false;
// 규칙마다 고치는 방식: 'auto' 자동 고침 · 'manual' 수동 고침 · 'off' 끄기
// 처음에는 모두 수동 고침 (자동 고침은 규칙마다 골라서 켠다)
const AUTO_DEF = new Set();
export const MODES = [['auto', '자동 고침'], ['manual', '수동 고침'], ['off', '끄기']];
export function modeOf(id) {
  const m = app.settings.proofMode?.[id];
  if (m) return m;
  const r = RULES.find((x) => x.id === id);
  if (app.settings.proofOff ? app.settings.proofOff.includes(id) : r?.off) return 'off'; // 예전 설정
  return AUTO_DEF.has(id) ? 'auto' : 'manual';
}
function setMode(id, m) { (app.settings.proofMode ||= {})[id] = m; saveSettings(); recheck(); }
const offRules = () => new Set(RULES.filter((r) => modeOf(r.id) === 'off').map((r) => r.id));
const autoOn = () => app.settings.proofAuto !== false;
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
      // 여백 카드가 보이면 그 카드에 불을 켜고, 아니면 작은 창을 띄운다
      if (railEl && !railEl.hidden) { setTimeout(() => hotCard(hit.from), 0); return false; }
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
        if (!isOn()) return;
        view.dispatch(view.state.tr.setMeta(key, { recheck: true }).setMeta('addToHistory', false));
        autoFix(view);
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
  scheduleProofRail(60);
}

// ---------- 자동 고침 ----------
// 쓰다가 손을 떼면, 커서가 닿아 있지 않은 곳만 고친다 (지금 쓰는 낱말은 건드리지 않게).
// 고친 곳은 장마다 기억해 두고, 나중에라도 하나씩 또는 한꺼번에 되돌릴 수 있다 (여백 카드·교정 목록).
// 되돌린 낱말은 (같은 규칙으로) 다시 자동으로 고치지 않는다.
const rejected = new Set();
const rejKey = (x) => `${x.rule}|${x.word}`;
let fixed = []; // 자동으로 고친 곳 [{id, chapter, rule, word, fix, why, from, time}]
let fixSeq = 0;
export const autoFixed = (ch = app.cur) => fixed.filter((r) => r.chapter === ch);
const textAt = (doc, from, len) => (from >= 0 && from + len <= doc.content.size ? doc.textBetween(from, from + len, '\n', '￼') : null);
export function trackAuto(tr) {
  if (!tr.docChanged || !fixed.length) return;
  const ch = app.cur, undo = !!tr.getMeta('history$');
  fixed = fixed.filter((r) => {
    if (r.chapter !== ch) return true;
    r.from = tr.mapping.map(r.from, 1);
    if (textAt(tr.doc, r.from, r.fix.length) === r.fix) return true;
    // 고친 말이 사라졌다: Ctrl+Z로 되돌렸으면 다시 고치지 않게 기억하고, 어느 쪽이든 목록에서 뺀다
    if (undo && textAt(tr.doc, r.from, r.word.length) === r.word) rejected.add(rejKey(r));
    return false;
  });
}
// 자동 고침 되돌리기 (하나 또는 여럿)
export function revertFixes(items) {
  const ed = app.editor;
  const tr = ed.state.tr;
  let n = 0;
  for (const r of [...items].sort((a, b) => b.from - a.from)) {
    if (r.chapter !== app.cur || textAt(tr.doc, r.from, r.fix.length) !== r.fix) continue;
    if (r.fix.length) tr.insertText(r.word, r.from, r.from + r.fix.length); else tr.insertText(r.word, r.from);
    rejected.add(rejKey(r));
    n++;
  }
  const ids = new Set(items.map((r) => r.id));
  fixed = fixed.filter((r) => !ids.has(r.id));
  if (n) { tr.setMeta('proofAuto', true); ed.view.dispatch(tr); }
  recheck();
  if (!n && items.length) toast('그 자리 글이 그 뒤로 바뀌어 되돌릴 수 없어요.');
  return n;
}
export function keepFixes(items) { const ids = new Set(items.map((r) => r.id)); fixed = fixed.filter((r) => !ids.has(r.id)); scheduleProofRail(0); }
export function allManual() {
  app.settings.proofMode = Object.fromEntries(RULES.map((r) => [r.id, modeOf(r.id) === 'off' ? 'off' : 'manual']));
  saveSettings(); recheck();
}
function autoFix(view) {
  if (!isOn() || !autoOn() || view.composing) return;
  const st = view.state, sel = st.selection;
  const list = (key.getState(st).issues || []).filter((x) => !x.ai && x.fix.length === 1 && modeOf(x.rule) === 'auto'
    && !(sel.from <= x.to + 1 && sel.to >= x.from - 1) && !rejected.has(rejKey(x)));
  if (!list.length) return;
  const tr = st.tr;
  const done = [];
  for (const x of [...list].sort((a, b) => b.from - a.from)) {
    if (tr.doc.textBetween(x.from, x.to, '\n', '￼') !== x.word) continue;
    if (x.fix[0]) tr.insertText(x.fix[0], x.from, x.to); else tr.delete(x.from, x.to);
    done.push(x);
  }
  if (!done.length) return;
  closeHistory(tr); // 자동 고침은 Ctrl+Z 한 번으로 따로 되돌릴 수 있게
  tr.setMeta(key, { recheck: true }).setMeta('proofAuto', true);
  // 고친 자리 (뒤에서부터 고쳤으니 앞쪽 위치는 지도를 따라 옮긴다)
  const items = done.map((x) => ({ id: ++fixSeq, chapter: app.cur, rule: x.rule, word: x.word, fix: x.fix[0], why: x.why, from: tr.mapping.map(x.from, -1), time: Date.now() }));
  view.dispatch(tr);
  view.dispatch(closeHistory(view.state.tr)); // 이어 쓰는 글과 섞이지 않게
  fixed.push(...items);
  fixed.splice(0, Math.max(0, fixed.length - 300));
  const show = (r) => `${r.word.trim() ? r.word : '빈칸'} → ${r.fix === '' ? '(지움)' : r.fix.trim() ? r.fix : '빈칸 하나'}`;
  const sorted = [...items].sort((a, b) => a.from - b.from);
  toastAction(`자동 고침: ${sorted.slice(0, 2).map(show).join(', ')}${items.length > 2 ? ` 외 ${items.length - 2}곳` : ''}`, '되돌리기', () => revertFixes(items), 6000);
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
const ruleOff = (id) => setMode(id, 'off');

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
    <div class="pp-more"><button type="button" data-a="ign">${x.ai ? '이번만 무시' : '이 작품에서 무시'}</button>${rule && x.fix.length === 1 && modeOf(rule.id) !== 'auto' ? '<button type="button" data-a="auto" title="이 규칙에 걸리면 앞으로 자동으로 고쳐요">늘 자동으로</button>' : ''}${rule ? `<button type="button" data-a="off" title="${h(rule.label)} 규칙 끄기">이 규칙 끄기</button>` : ''}<button type="button" data-a="list">목록</button></div>`;
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
    else if (b.dataset.a === 'auto') { apply(cur, x.fix[0]); setMode(x.rule, 'auto'); toast(`‘${rule.label}’은 앞으로 자동으로 고쳐요.`); }
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
  scheduleProofRail(0);
}
export function toggleProof() {
  setProof(!isOn());
  toast(isOn() ? '맞춤법·문장부호 교정을 켰어요. 틀린 곳은 밑줄과 왼쪽 여백에 고칠 말을 보여 줘요.' : '맞춤법·문장부호 교정을 껐어요.');
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
  scheduleProofRail();
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
  for (let k = 0; k < chunks.length; k++) {
    onProgress?.(k, chunks.length);
    const ch = chunks[k];
    const prompt = `다음은 한국어 소설 원고입니다. 표준 맞춤법·띄어쓰기·문장부호(국립국어원 규정)에 어긋난 곳만 찾으세요.
- 문체·어휘 선택·문장 다듬기는 하지 마세요. 틀린 것만.
- 대사 속 사투리·구어·말버릇·일부러 쓴 표현, 고유 명사는 고치지 마세요.
- p: 문단 번호. wrong: 그 문단에 있는 그대로 옮긴 틀린 부분(앞뒤로 한두 글자를 붙여 문단 안에서 한 번만 나오게). right: wrong을 고친 글. why: 까닭을 짧게.
- 틀린 곳이 없으면 빈 목록.

${ch.map((p, i) => `[${i + 1}] ${p.text}`).join('\n')}`;
    const r = await askJSON(prompt, schema, { signal });
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
        <label class="check"><input type="checkbox" name="on" ${isOn() ? 'checked' : ''}> <b>교정 모드</b> <small data-kbd="proof">Ctrl+Alt+K</small></label>
        <label class="check"><input type="checkbox" name="auto" ${autoOn() ? 'checked' : ''}> 자동 고침 쓰기</label>
        <label class="check"><input type="checkbox" name="rail" ${app.settings.proofRail !== false ? 'checked' : ''}> 왼쪽 여백에 고칠 말 보이기</label>
        <span class="grow"></span>
        <button type="button" class="small" data-p="fixall">수동 고칠 곳 제안대로 모두 고치기</button>
      </div>
      <div class="proof-ai"><button type="button" class="small" data-p="ai">AI 맞춤법 검사 (이 장)</button><span class="hint">AI가 맞춤법·띄어쓰기·문장부호 틀림만 찾아요. 문장·문체는 고치지 않아요.</span><span class="grow"></span><span class="ai-now">${h(aiLabel())}</span><button type="button" class="small ghost" data-p="aiset">바꾸기…</button></div>
      <p id="pfMsg" class="hint" aria-live="polite" style="margin:0"></p>
      <div id="pfList" class="proof-list"></div>
      <div id="pfDone" class="proof-done"></div>
      <details class="proof-rules" ${app.settings.proofRulesOpen ? 'open' : ''}><summary>규칙마다 자동 고침 · 수동 고침 · 끄기</summary>
        <div class="proof-rule-grid">${RULES.map((x) => `<div class="proof-rule"><span>${h(x.label)} <small class="hint">${h(x.hint)}</small></span><select data-rule="${x.id}" aria-label="${h(x.label)}">${MODES.map(([v, l]) => `<option value="${v}" ${modeOf(x.id) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}</div>
        <p class="hint" style="margin:8px 0 0"><b>자동 고침</b>은 쓰다가 손을 떼면 알아서 고쳐요 (지금 쓰는 낱말은 건드리지 않고, Ctrl+Z로 되돌린 곳은 다시 고치지 않아요). <b>수동 고침</b>(기본)은 밑줄과 왼쪽 여백 카드로 보여 주고 직접 고쳐요. 고칠 말이 둘 이상이거나 AI가 찾은 곳은 늘 수동이에요. 자동으로 고친 곳은 여백 카드나 이 창에서 언제든 되돌릴 수 있어요.</p>
        <p class="hint" style="margin:6px 0 0">이 작품에서 무시한 말: <span id="pfIgn"></span></p>
        <div class="proof-auto-acts"><button type="button" class="small" data-p="manual">모든 규칙을 수동 고침으로</button></div>
      </details>
    </div>`,
    buttons: [{ label: 'AI', value: 'aiset' }, { label: '닫기', value: 'close', primary: true }],
    onOpen: (f) => {
      f.querySelector('.dlg-foot button[value=aiset]').hidden = true;
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
        const done = autoFixed().sort((a, b) => a.from - b.from);
        $('#pfDone').innerHTML = done.length ? `<div class="pd-head"><b>이 장에서 자동으로 고친 곳 ${done.length}곳</b><button type="button" class="small" data-p="revertAll">모두 되돌리기</button><button type="button" class="small ghost" data-p="keepAll">모두 확인</button></div>
          ${done.map((r, i) => `<div class="pd-row" data-d="${i}"><span class="pd-fix"><del>${h(vis(r.word))}</del> → <ins>${h(vis(r.fix))}</ins></span><small class="hint">${h(RULES.find((x) => x.id === r.rule)?.label || '')}</small><button type="button" class="small" data-p="revert">되돌리기</button></div>`).join('')}` : '';
        f._done = done;
        f._list = list;
      };
      draw();
      f.addEventListener('change', (e) => {
        if (e.target.name === 'on') { setProof(e.target.checked); draw(); }
        if (e.target.name === 'auto') { app.settings.proofAuto = e.target.checked; saveSettings(); }
        if (e.target.name === 'rail') { app.settings.proofRail = e.target.checked; saveSettings(); scheduleProofRail(0); }
        if (e.target.dataset.rule) { setMode(e.target.dataset.rule, e.target.value); draw(); }
      });
      f.querySelector('.proof-rules').addEventListener('toggle', (e) => { app.settings.proofRulesOpen = e.target.open; saveSettings(); });
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
        if (b.dataset.p === 'revert') { revertFixes([f._done[+b.closest('.pd-row').dataset.d]]); draw(); return; }
        if (b.dataset.p === 'revertAll') { const n = revertFixes(f._done); msg.textContent = n ? `${n}곳을 원래대로 되돌렸어요.` : ''; draw(); return; }
        if (b.dataset.p === 'keepAll') { keepFixes(f._done); draw(); return; }
        if (b.dataset.p === 'manual') { allManual(); f.querySelectorAll('select[data-rule]').forEach((sel) => { sel.value = modeOf(sel.dataset.rule); }); msg.textContent = '모든 규칙을 수동 고침으로 바꿨어요. 이제 저절로 고치지 않아요.'; draw(); return; }
        if (b.dataset.p === 'aiset') { f.requestSubmit(f.querySelector('.dlg-foot button[value=aiset]')); return; }
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
          const miss = aiMissing();
          if (miss) { msg.textContent = miss; return; }
          busy?.abort(); busy = new AbortController();
          b.disabled = true;
          msg.textContent = 'AI가 맞춤법·띄어쓰기·문장부호를 보는 중…';
          try {
            const ai = await aiCheck({ signal: busy.signal, onProgress: (k, n) => { msg.textContent = `AI가 맞춤법·띄어쓰기·문장부호를 보는 중…${n > 1 ? ` (${k + 1}/${n})` : ''}`; } });
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
  if (r.value === 'aiset') await showAiSettings({ back: () => showProof() });
}

// ---------- 왼쪽 여백 카드 (색인처럼) ----------
// 교정 모드에서 걸린 곳마다 그 줄 옆에 '틀린 말 → 고칠 말' 카드를 세운다. 주석 여백이 왼쪽이면 오른쪽에.
let railEl = null, railT = null, railItems = [];
const RAIL_W = 232, RAIL_MAX = 200;
export function scheduleProofRail(d = 150) { clearTimeout(railT); railT = setTimeout(drawProofRail, d); }
const vis = (t) => (t === '' ? '(지움)' : t.trim() ? t : `빈칸 ${t.length}칸`);
function cardHtml(x, i) {
  if (x.done) {
    return `<div class="pf-card pc-done pc-${x.kind}" data-i="${i}" tabindex="0" title="눌러서 원고에서 보기">
    <div class="pc-head"><span class="pc-k">자동으로 고침</span></div>
    <div class="pc-fix"><del>${h(vis(x.word))}</del> → <ins>${h(vis(x.fix))}</ins></div>
    <div class="pc-acts"><button type="button" data-a="revert" class="go">되돌리기</button><button type="button" data-a="keep" title="이대로 두고 카드 치우기">확인</button></div></div>`;
  }
  const rule = RULES.find((r) => r.id === x.rule);
  const auto = rule && !x.ai && x.fix.length === 1 && modeOf(rule.id) === 'auto' && autoOn() && !rejected.has(rejKey(x));
  const fix = x.fix.length === 1
    ? `<div class="pc-fix"><del>${h(vis(x.word))}</del> → <ins>${h(vis(x.fix[0]))}</ins></div>`
    : x.fix.length ? `<div class="pc-fix"><del>${h(vis(x.word))}</del> → ${x.fix.map((t) => `<ins>${h(vis(t))}</ins>`).join(' 또는 ')}</div>`
      : `<div class="pc-fix"><del>${h(vis(x.word))}</del></div>`;
  return `<div class="pf-card pc-${x.kind}${x.ai ? ' pc-ai' : ''}" data-i="${i}" tabindex="0" title="눌러서 원고에서 보기">
    <div class="pc-head"><span class="pc-k">${h(kindName(x))}</span>${auto ? '<span class="pc-auto" title="손을 떼고 커서가 떠나면 자동으로 고쳐요">자동</span>' : ''}</div>
    ${fix}${x.why ? `<div class="pc-why">${h(x.why)}</div>` : ''}
    <div class="pc-acts">${x.fix.map((t, k) => `<button type="button" data-a="fix" data-k="${k}"${k === 0 ? ' class="go"' : ''}>${x.fix.length > 1 ? h(vis(t)) + '로' : '고치기'}</button>`).join('')}<button type="button" data-a="ign" title="${x.ai ? '이번만 무시' : '이 작품에서 무시'}">무시</button></div></div>`;
}
function drawProofRail() {
  if (!railEl || !app.editor) return;
  const scroll = $('#paperScroll');
  const body = document.body;
  const issues = isOn() && app.settings.proofRail !== false ? current() : [];
  const done = isOn() && app.settings.proofRail !== false ? autoFixed().map((r) => ({ ...r, done: true, to: r.from + r.fix.length, kind: RULES.find((x) => x.id === r.rule)?.kind || 'sp' })) : [];
  const list = [...issues, ...done].sort((a, b) => a.from - b.from);
  const annoRail = body.classList.contains('has-anno-rail');
  const right = annoRail && body.classList.contains('anno-left');
  const need = annoRail ? 1120 : 860;
  const on = list.length > 0 && !body.classList.contains('focus') && !body.classList.contains('revising') && scroll.clientWidth >= need;
  const was = body.classList.contains('has-proof-rail') + (body.classList.contains('proof-right') ? 2 : 0);
  body.classList.toggle('has-proof-rail', on);
  body.classList.toggle('proof-right', on && right);
  const now = on + (on && right ? 2 : 0);
  const symChanged = symRails();
  if (was !== now || symChanged) { scheduleRail(30); if (isPageView()) { applyPageView(); scheduleProofRail(80); return; } }
  if (!on) { railEl.hidden = true; railEl.innerHTML = ''; railItems = []; return; }
  railEl.hidden = false;
  const paper = $('#paper');
  const base = scroll.getBoundingClientRect().top - scroll.scrollTop;
  const pr = paper.getBoundingClientRect(), sr = scroll.getBoundingClientRect();
  railEl.style.width = RAIL_W + 'px';
  railEl.style.left = (right ? pr.right - sr.left + 20 : Math.max(8, pr.left - sr.left - RAIL_W - 20)) + scroll.scrollLeft + 'px';
  const view = app.editor.view;
  railItems = list.slice(0, RAIL_MAX).map((x) => {
    let top = 0;
    try { top = view.coordsAtPos(x.from).top - base; } catch { /* 화면 밖 */ }
    return { ...x, top };
  });
  railEl.innerHTML = `<div class="pc-title">교정 ${issues.length}곳${done.length ? ` · 자동 고침 ${done.length}곳` : ''}<button type="button" data-a="list">목록</button></div>`
    + railItems.map(cardHtml).join('')
    + (list.length > RAIL_MAX ? `<div class="pf-card pc-more" data-a="list">그 밖에 ${list.length - RAIL_MAX}곳 · 목록에서 보기</div>` : '');
  const cards = [...railEl.querySelectorAll('.pf-card')];
  const head = railEl.querySelector('.pc-title');
  head.style.top = Math.max(0, (railItems[0]?.top ?? 0) - head.offsetHeight - 8) + 'px';
  let y = 0;
  cards.forEach((el, i) => {
    const t = Math.max(railItems[i]?.top ?? y, y);
    el.style.top = t + 'px';
    y = t + el.offsetHeight + 6;
  });
  hotCard(app.editor.state.selection.from, false);
}
function hotCard(pos, scrollTo = true) {
  if (!railEl || railEl.hidden) return;
  let hit = -1;
  railItems.forEach((x, i) => { if (hit < 0 && x.from <= pos && pos <= x.to) hit = i; });
  railEl.querySelectorAll('.pf-card.hot').forEach((c) => c.classList.remove('hot'));
  if (hit < 0) return;
  const c = railEl.querySelector(`.pf-card[data-i="${hit}"]`);
  c?.classList.add('hot');
  if (scrollTo) c?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function bindRail() {
  railEl = document.createElement('aside');
  railEl.className = 'proof-rail';
  railEl.id = 'proofRail';
  railEl.setAttribute('aria-label', '맞춤법·문장부호 교정');
  railEl.hidden = true;
  $('#paperScroll').appendChild(railEl);
  railEl.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  railEl.addEventListener('click', async (e) => {
    if (e.target.closest('[data-a=list]')) { showProof(); return; }
    const card = e.target.closest('.pf-card');
    const x = card && railItems[+card.dataset.i];
    if (!x) return;
    const b = e.target.closest('button');
    if (b?.dataset.a === 'fix') { apply(x, x.fix[+b.dataset.k]); app.editor.commands.focus(); return; }
    if (b?.dataset.a === 'ign') { await ignore(x); return; }
    if (b?.dataset.a === 'revert') { revertFixes([x]); app.editor.commands.focus(); return; }
    if (b?.dataset.a === 'keep') { keepFixes([x]); return; }
    app.editor.chain().focus().setTextSelection({ from: x.from, to: x.to }).scrollIntoView().run();
  });
  railEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('pf-card')) e.target.click(); });
  app.editor.on('update', () => scheduleProofRail(250));
  app.editor.on('selectionUpdate', () => hotCard(app.editor.state.selection.from, false));
  addEventListener('resize', () => scheduleProofRail(100));
  // 주석 여백이 생기거나 옮겨지면 다시 놓는다
  let sig = '';
  new MutationObserver(() => {
    const b = document.body.classList;
    const n = `${b.contains('has-anno-rail')}${b.contains('anno-left')}${b.contains('focus')}${b.contains('revising')}${b.contains('pageview')}`;
    if (n !== sig) { sig = n; scheduleProofRail(60); }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

// ---------- 시작 ----------
export function bindProof() {
  app.editor.registerPlugin(plugin);
  bindRail();
  app.editor.view.dom.setAttribute('spellcheck', isOn() ? 'false' : 'true');
  app.editor.on('transaction', ({ transaction }) => { trackAuto(transaction); if (transaction.getMeta(key)) updateCount(); });
  app.hooks.afterOpen.push(() => {
    closePop();
    app.editor.view.dispatch(app.editor.state.tr.setMeta(key, { clearAi: true }).setMeta('addToHistory', false));
    updateCount();
    scheduleProofRail(80);
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) closePop(); });
  addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target) && !e.target.closest?.('.pf')) closePop(); }, true);
  document.querySelector('.paper-scroll')?.addEventListener('scroll', closePop, { passive: true });
  $('#stProof')?.addEventListener('click', () => showProof());
  syncMenu();
  updateCount();
}
