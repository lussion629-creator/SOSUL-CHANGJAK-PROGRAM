// 단축키: 기능마다 기본 단축키가 있고, '단축키 설정' 창에서 바꿀 수 있다 (환경 설정 keys에 저장).
// 키 이름은 e.code로 읽어 한글 입력 상태에서도 똑같이 동작한다.
import { app, saveSettings } from './app.js';
import { $, h, toast, dialog } from './ui.js';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// 기본 단축키 (group: 설정 창에서 묶어 보여 줄 이름)
// editor: 편집기(TipTap)가 원래 가진 단축키 → 바꾸면 원래 키는 막는다
export const COMMANDS = [
  { id: 'save', label: '지금 저장', key: 'Ctrl+S', group: '파일' },
  { id: 'print', label: '인쇄', key: 'Ctrl+P', group: '파일' },
  { id: 'undo', label: '실행 취소', key: 'Ctrl+Z', group: '편집', editor: true },
  { id: 'redo', label: '다시 실행', key: 'Ctrl+Y', group: '편집', editor: true },
  { id: 'find', label: '찾기', key: 'Ctrl+F', group: '편집' },
  { id: 'replace', label: '바꾸기', key: 'Ctrl+H', group: '편집' },
  { id: 'annotate', label: '주석 달기', key: 'Ctrl+Alt+M', group: '편집' },
  { id: 'annoSticky', label: '주석 포스트잇 켜기/끄기', key: 'Ctrl+Alt+P', group: '편집' },
  { id: 'proof', label: '맞춤법·문장부호 교정 켜기/끄기', key: 'Ctrl+Alt+K', group: '편집' },
  { id: 'proofList', label: '교정 목록·AI 맞춤법 검사', key: '', group: '편집' },
  { id: 'scene', label: '장면 전환 넣기 (* * *)', key: '', group: '편집' },
  { id: 'snapshot', label: '지금 버전 저장', key: '', group: '편집' },
  { id: 'bold', label: '굵게', key: 'Ctrl+B', group: '글자', editor: true },
  { id: 'italic', label: '기울임', key: 'Ctrl+I', group: '글자', editor: true },
  { id: 'underline', label: '밑줄', key: 'Ctrl+U', group: '글자', editor: true },
  { id: 'strike', label: '취소선', key: 'Ctrl+Shift+S', group: '글자', editor: true },
  { id: 'highlight', label: '형광펜', key: 'Ctrl+Shift+H', group: '글자', editor: true },
  { id: 'fontDlg', label: '글꼴 창', key: 'Ctrl+D', group: '글자' },
  { id: 'bigger', label: '글자 0.5pt 크게', key: 'Ctrl+]', group: '글자' },
  { id: 'smaller', label: '글자 0.5pt 작게', key: 'Ctrl+[', group: '글자' },
  { id: 'lsWide', label: '자간 넓게', key: 'Alt+Shift+W', group: '글자' },
  { id: 'lsNarrow', label: '자간 좁게', key: 'Alt+Shift+N', group: '글자' },
  { id: 'clear', label: '서식 지우기', key: '', group: '글자' },
  { id: 'paraDlg', label: '단락 창', key: 'Ctrl+Shift+P', group: '문단' },
  { id: 'left', label: '왼쪽 정렬', key: 'Ctrl+Shift+L', group: '문단', editor: true },
  { id: 'center', label: '가운데 정렬', key: 'Ctrl+Shift+E', group: '문단', editor: true },
  { id: 'right', label: '오른쪽 정렬', key: 'Ctrl+Shift+R', group: '문단', editor: true },
  { id: 'justify', label: '양쪽 정렬', key: 'Ctrl+Shift+J', group: '문단', editor: true },
  { id: 'pageSetup', label: '쪽 설정', key: 'F7', group: '문단' },
  { id: 'focus', label: '집중 모드', key: 'Ctrl+Shift+F', group: '보기' },
  { id: 'sidebar', label: '왼쪽 목록 접기/펴기', key: 'Ctrl+\\', group: '보기' },
  { id: 'pageView', label: '쪽 보기', key: '', group: '보기' },
  { id: 'book', label: '장 이어서 전체 보기', key: '', group: '보기' },
  { id: 'bookPlain', label: '장 없이 전체 보기', key: '', group: '보기' },
  { id: 'revision', label: '퇴고 모드', key: '', group: '보기' },
  { id: 'theme', label: '다크 모드 전환', key: '', group: '보기' },
  { id: 'colors', label: '화면 색 (라이트·다크·내 색)', key: '', group: '보기' },
  { id: 'synonyms', label: '유의어 창 (GPT·Claude)', key: 'Ctrl+Shift+Y', group: '보기' },
  { id: 'wordsisters', label: '유의어 사전에서 찾기 (워드시스터즈)', key: 'Ctrl+Shift+U', group: '보기' },
  { id: 'complement', label: '보색 글자·형광펜 켜기/끄기', key: '', group: '보기' },
  { id: 'zoomIn', label: '원고 확대 (Ctrl+휠 위로)', key: 'Ctrl+=', group: '보기' },
  { id: 'zoomOut', label: '원고 축소 (Ctrl+휠 아래로)', key: 'Ctrl+-', group: '보기' },
  { id: 'zoomReset', label: '원고 배율 처음대로', key: 'Ctrl+0', group: '보기' },
  { id: 'addChapter', label: '새 장', key: '', group: '장' },
  { id: 'split', label: '커서 자리에서 장 나누기', key: '', group: '장' },
  { id: 'prevChapter', label: '앞 장으로', key: 'Ctrl+Alt+ArrowUp', group: '장' },
  { id: 'nextChapter', label: '다음 장으로', key: 'Ctrl+Alt+ArrowDown', group: '장' },
  { id: 'readAloud', label: 'AI로 읽어 주기 (재생·멈춤)', key: 'Ctrl+Alt+R', group: '낭독' },
  { id: 'readSentence', label: '이 문장만 읽기', key: 'Ctrl+Alt+E', group: '낭독' },
  { id: 'readParagraph', label: '이 문단만 읽기', key: '', group: '낭독' },
  { id: 'readHere', label: '낭독: 커서 문단부터 이어 읽기', key: '', group: '낭독' },
  { id: 'readNext', label: '낭독: 다음 조각', key: '', group: '낭독' },
  { id: 'readPrev', label: '낭독: 앞 조각', key: '', group: '낭독' },
  { id: 'readStop', label: '낭독 그만', key: '', group: '낭독' },
  { id: 'readSettings', label: '낭독 설정', key: '', group: '낭독' },
  { id: 'aiSettings', label: 'AI 글 모델', key: '', group: '낭독' },
  { id: 'storage', label: '저장 방식 (오프라인·개인 서버·구글 드라이브)', key: '', group: '파일' },
  { id: 'server', label: '개인 서버 연결', key: '', group: '파일' },
  { id: 'readCast', label: '등장인물 목소리', key: '', group: '낭독' },
  { id: 'speak', label: '이 문단 기기 목소리로 읽기', key: '', group: '낭독' },
  { id: 'sprint', label: '타이머', key: '', group: '도구' },
  { id: 'index', label: '찾아보기 (색인)', key: '', group: '도구' },
  { id: 'tidy', label: '원고 다듬기', key: '', group: '도구' },
  { id: 'tidyMark', label: '원고 다듬기 표시 켜기/끄기', key: '', group: '도구' },
  { id: 'appear', label: '인물 등장 지도', key: '', group: '도구' },
  { id: 'keys', label: '단축키 설정 창', key: '', group: '도구' },
  { id: 'help', label: '도움말 열기/닫기', key: 'F1', group: '도구' },
];
const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));
// 브라우저·운영체제가 쓰는 키: 바꿀 수는 있지만 알려 준다
const RESERVED = new Set(['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Q', 'Ctrl+R', 'Ctrl+L', 'Ctrl+Tab', 'Alt+F4', 'F5', 'F11', 'F12']);

// 키 이름 (e.code → 보여 줄 글자)
const CODE = {
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'",
  Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
};
function keyName(e) {
  // 영문 글자·숫자는 자판 배열(드보락 등)을 따르도록 e.key로, 한글 입력 중 등 그 밖에는 물리 키(e.code)로
  if (/^[a-z0-9]$/i.test(e.key || '')) return e.key.toUpperCase();
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (/^F\d{1,2}$/.test(c)) return c;
  return CODE[c] || null;
}
export function comboOf(e) {
  const k = keyName(e);
  if (!k) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}
// 보여 줄 때: 맥이면 ⌘, 화살표는 기호로
export function pretty(combo) {
  if (!combo) return '';
  return combo.split('+').map((p) => ({ Ctrl: MAC ? '⌘' : 'Ctrl', Alt: MAC ? '⌥' : 'Alt', Shift: MAC ? '⇧' : 'Shift', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: '스페이스' }[p] || p)).join(MAC ? '' : '+');
}

export const keyOf = (id) => {
  const o = app.settings.keys || {};
  return id in o ? o[id] : BY_ID.get(id)?.key || '';
};
let table = new Map(); // combo → id
let blocked = new Set(); // 편집기의 원래 키 가운데 다른 키로 옮긴 것
function rebuild() {
  table = new Map();
  for (const c of COMMANDS) { const k = keyOf(c.id); if (k) table.set(k, c.id); }
  blocked = new Set(COMMANDS.filter((c) => c.editor && c.key && keyOf(c.id) !== c.key && !table.has(c.key)).map((c) => c.key));
  // Ctrl+Shift+Z도 다시 실행 (편집기 기본)
  if (keyOf('redo') !== 'Ctrl+Y' && !table.has('Ctrl+Shift+Z')) blocked.add('Ctrl+Shift+Z');
  paintHints();
}

// 메뉴에 적힌 단축키 글자를 지금 설정대로
export function paintHints(root = document) {
  root.querySelectorAll('[data-kbd]').forEach((el) => {
    const k = keyOf(el.dataset.kbd);
    el.textContent = el.dataset.kbdPrefix ? `${el.dataset.kbdPrefix}${k ? ', ' + pretty(k) : ''}` : pretty(k);
    el.hidden = !k && !el.dataset.kbdPrefix;
  });
  root.querySelectorAll('[data-kbd-title]').forEach((el) => {
    const k = keyOf(el.dataset.kbdTitle);
    el.title = el.title.replace(/ \([^)]*\)$/, '') + (k ? ` (${pretty(k)})` : '');
  });
}

let runners = {};
export function bindKeys(run) {
  runners = run;
  rebuild();
  // 편집기보다 먼저 받는다 (바꾼 키가 편집기 기본 동작과 겹치지 않게)
  window.addEventListener('keydown', (e) => {
    if (recording || e.isComposing) return;
    const combo = comboOf(e);
    if (!combo) return;
    const inDlg = e.target.closest?.('dialog');
    const inField = e.target.closest?.('input, textarea, select') && !e.target.closest?.('.ProseMirror');
    if (inDlg) return;
    const id = table.get(combo);
    if (id) {
      const plain = !/Ctrl|Alt/.test(combo) && !/^F\d/.test(combo);
      if (inField && (plain || BY_ID.get(id).editor)) return; // 입력 칸에서는 보통 글자·편집 키를 그대로 둔다
      const fn = runners[id];
      if (!fn) return;
      e.preventDefault();
      e.stopPropagation();
      fn();
      return;
    }
    if (blocked.has(combo) && !inField) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

// ---------- 단축키 설정 창 ----------
let recording = false;
let recKey = null; // 지금 키를 기다리는 리스너 (하나만)
function stopRec() { if (recKey) window.removeEventListener('keydown', recKey, true); recKey = null; recording = false; }
export async function showKeys() {
  const draft = { ...(app.settings.keys || {}) };
  const cur = (id) => (id in draft ? draft[id] : BY_ID.get(id).key);
  const groups = [...new Set(COMMANDS.map((c) => c.group))];
  const rows = () => groups.map((g) => `<h4 class="kb-group">${g}</h4>` + COMMANDS.filter((c) => c.group === g).map((c) => `
      <div class="kb-row" data-id="${c.id}">
        <span class="kb-label">${h(c.label)}</span>
        <button type="button" class="kb-key ${cur(c.id) !== c.key ? 'changed' : ''}" data-rec="${c.id}">${cur(c.id) ? h(pretty(cur(c.id))) : '<i>없음</i>'}</button>
        <button type="button" class="kb-reset" data-reset="${c.id}" title="기본값 (${h(pretty(c.key) || '없음')})" ${cur(c.id) === c.key ? 'disabled' : ''}>↺</button>
      </div>`).join('')).join('');
  const r = await dialog({
    title: '단축키 설정',
    wide: true,
    body: `<p class="hint" style="margin:0">바꿀 기능의 단축키 칸을 누르고 새 키 조합을 누르세요. Esc는 취소, Backspace는 단축키 없애기예요. 한글 입력 상태에서도 똑같이 동작해요.</p>
      <input class="search" data-kb-search placeholder="기능 찾기 (예: 자간, 정렬)">
      <div class="kb-list">${rows()}</div>
      <p class="hint kb-msg" aria-live="polite" style="margin:0"></p>`,
    buttons: [{ label: '모두 기본값으로', value: 'reset', left: true }, { label: '취소', value: 'close' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f) => {
      const list = f.querySelector('.kb-list');
      const msg = f.querySelector('.kb-msg');
      const redraw = () => { list.innerHTML = rows(); filter(); };
      const filter = () => {
        const q = f.querySelector('[data-kb-search]').value.trim();
        list.querySelectorAll('.kb-row').forEach((row) => { row.hidden = q && !row.textContent.includes(q); });
        list.querySelectorAll('.kb-group').forEach((g) => { let n = g.nextElementSibling, any = false; while (n && !n.classList.contains('kb-group')) { if (!n.hidden) any = true; n = n.nextElementSibling; } g.hidden = !any; });
      };
      f.querySelector('[data-kb-search]').addEventListener('input', filter);
      list.addEventListener('click', (e) => {
        const rs = e.target.closest('[data-reset]');
        if (rs) { delete draft[rs.dataset.reset]; const k = BY_ID.get(rs.dataset.reset).key; takeOver(k, rs.dataset.reset); redraw(); return; }
        const b = e.target.closest('[data-rec]');
        if (!b) return;
        stopRec();
        recording = true;
        b.classList.add('rec');
        b.textContent = '키를 누르세요…';
        const id = b.dataset.rec;
        // 받을 수 없는 키는 창을 닫지 않고 계속 기다리며 그 줄 바로 아래에 까닭을 보여 준다 (아래쪽 안내는 목록에 가려 안 보일 수 있다)
        const warn = (t) => {
          msg.textContent = t;
          let n = b.closest('.kb-row').querySelector('.kb-warn');
          if (!n) { n = document.createElement('small'); n.className = 'kb-warn'; b.closest('.kb-row').appendChild(n); }
          n.textContent = t;
        };
        const onKey = (ev) => {
          // 조합키만 누른 동안은 기다린다. 한글 자판의 오른쪽 Alt(한/영)·오른쪽 Ctrl(한자)도 조합키처럼 보고 기다린다
          if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'OS'].includes(ev.key)) return;
          if (ev.key === 'HangulMode' || ev.key === 'HanjaMode' || ev.key === 'KanaMode' || /^(Lang\d|AltRight|ControlRight|KanaMode|NonConvert|Convert)$/.test(ev.code || '')) {
            ev.preventDefault(); ev.stopPropagation();
            warn('오른쪽 Alt(한/영)·오른쪽 Ctrl(한자) 키는 한글 자판에서 단축키로 쓸 수 없어요. 왼쪽 Ctrl·Alt를 함께 눌러 주세요.');
            return;
          }
          ev.preventDefault(); ev.stopPropagation();
          if (ev.key === 'Escape') { stopRec(); redraw(); return; }
          if ((ev.key === 'Backspace' || ev.key === 'Delete') && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { stopRec(); draft[id] = ''; msg.textContent = `‘${BY_ID.get(id).label}’ 단축키를 없앴어요.`; redraw(); return; }
          const combo = comboOf(ev);
          if (!combo) { warn('이 키는 쓸 수 없어요. 다른 키를 눌러 주세요. (Esc: 취소)'); return; }
          if (!/Ctrl|Alt/.test(combo) && !/^F\d/.test(combo)) { warn(`${pretty(combo)}: Ctrl이나 Alt를 함께 누르거나 F1~F12 키를 쓰세요. (글자만 누르면 원고에 입력돼요)`); return; }
          stopRec();
          draft[id] = combo;
          const other = takeOver(combo, id);
          msg.textContent = (other ? `‘${BY_ID.get(other).label}’에 쓰던 ${pretty(combo)}를 옮겼어요. ` : '') + (RESERVED.has(combo) ? `${pretty(combo)}는 브라우저·운영체제도 쓰는 키라 다른 동작과 겹칠 수 있어요.` : '');
          redraw();
          if (msg.textContent) toast(msg.textContent, 4000);
        };
        recKey = onKey;
        window.addEventListener('keydown', onKey, true);
      });
      // 같은 키를 쓰던 다른 기능은 비운다
      const takeOver = (combo, id) => {
        if (!combo) return null;
        const other = COMMANDS.find((c) => c.id !== id && cur(c.id) === combo);
        if (other) draft[other.id] = '';
        return other?.id || null;
      };
    },
  });
  stopRec(); // 키를 기다리다 창을 닫아도 리스너가 남지 않게
  if (r.value === 'reset') { app.settings.keys = {}; saveSettings(); rebuild(); toast('단축키를 모두 기본값으로 돌렸어요.'); return; }
  if (r.value !== 'ok') return;
  // 기본값과 같은 것은 지운다
  for (const [k, v] of Object.entries(draft)) if (BY_ID.get(k)?.key === v) delete draft[k];
  app.settings.keys = draft;
  saveSettings();
  rebuild();
  toast('단축키를 저장했어요.');
}
