// 도움말: 오른쪽 위 ? 단추(F1)로 여는 옆 창. 모든 기능 설명과 찾기(초성으로도).
import { CATS, HELP } from './helpdata.js';
import { keyOf, pretty } from './keys.js';
import { $, h } from './ui.js';

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const chosung = (s) => s.replace(/[가-힣]/g, (c) => CHO[Math.floor((c.charCodeAt(0) - 0xac00) / 588)]);
const isCho = (s) => /^[ㄱ-ㅎ\s]+$/.test(s);
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

let cat = 'all';
let query = '';

const textOf = (e) => [e.t, e.where || '', e.tags || '', ...e.body, keyOf(e.keys) ? pretty(keyOf(e.keys)) : ''].join(' ');

function matches(e, q) {
  if (!q) return true;
  const hay = norm(textOf(e));
  return q.split(' ').every((w) => {
    if (isCho(w)) return chosung(e.t).replace(/\s/g, '').includes(w) || chosung(hay).replace(/\s/g, '').includes(w);
    return hay.includes(w);
  });
}

// 찾은 낱말에 표시 (HTML을 이스케이프한 뒤에 감싼다)
function mark(s, q) {
  let out = h(s);
  if (!q) return out;
  for (const w of q.split(' ').filter((x) => x && !isCho(x))) {
    const re = new RegExp(h(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

function canRun(act) {
  if (!act) return false;
  if (act === 'checkUpdate') return !!window.desktop?.checkUpdate;
  return true;
}

function render() {
  const q = norm(query);
  const list = HELP.filter((e) => (cat === 'all' || e.cat === cat) && matches(e, q));
  const panel = $('#helpPanel');
  panel.querySelectorAll('.hp-cats button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === cat)));
  const body = panel.querySelector('.hp-list');
  if (!list.length) {
    body.innerHTML = `<p class="hp-empty">‘${h(query)}’에 맞는 설명이 없어요. 다른 낱말이나 초성(예: ㅈㄷㅈㅈ)으로 찾아보세요.</p>`;
    return;
  }
  let lastCat = '';
  body.innerHTML = list.map((e) => {
    const k = e.keys && keyOf(e.keys);
    const head = cat === 'all' && e.cat !== lastCat ? `<h3 class="hp-cat">${h(CATS.find((c) => c.id === e.cat).label)}</h3>` : '';
    lastCat = e.cat;
    return `${head}<details class="hp-item" ${q || list.length <= 4 ? 'open' : ''}>
      <summary><span class="hp-t">${mark(e.t, q)}</span>${k ? `<kbd>${h(pretty(k))}</kbd>` : ''}</summary>
      <div class="hp-body">
        ${e.where ? `<p class="hp-where">${mark(e.where, q)}</p>` : ''}
        ${e.body.map((p) => `<p>${mark(p, q)}</p>`).join('')}
        ${canRun(e.act) ? `<button type="button" class="small" data-act="${e.act}">해 보기</button>` : ''}
      </div></details>`;
  }).join('');
  panel.querySelector('.hp-count').textContent = q ? `${list.length}개 찾음` : '';
}

function build() {
  const p = document.createElement('aside');
  p.id = 'helpPanel';
  p.className = 'help-panel';
  p.hidden = true;
  p.setAttribute('aria-label', '도움말');
  p.innerHTML = `<div class="hp-head">
      <h2>도움말</h2>
      <button type="button" class="icon-btn hp-close" title="닫기 (Esc)" aria-label="도움말 닫기">✕</button>
    </div>
    <div class="hp-search"><input type="search" placeholder="기능 찾기 (예: 자간, 내보내기, ㅈㄷㅈㅈ)" aria-label="도움말에서 찾기" spellcheck="false"><span class="hp-count" aria-live="polite"></span></div>
    <div class="hp-cats" role="toolbar" aria-label="갈래">${[{ id: 'all', label: '모두' }, ...CATS].map((c) => `<button type="button" data-cat="${c.id}" aria-pressed="false">${h(c.label)}</button>`).join('')}</div>
    <div class="hp-list"></div>`;
  document.body.appendChild(p);
  const input = p.querySelector('input');
  input.addEventListener('input', () => { query = input.value; render(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; query = ''; render(); } });
  p.querySelector('.hp-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (b) { cat = b.dataset.cat; render(); }
  });
  p.querySelector('.hp-close').addEventListener('click', () => toggleHelp(false));
  // '해 보기'를 누르면 도움말은 열어 둔 채 기능을 연다 (창이 뜨는 기능은 그 창이 위에 뜬다)
  return p;
}

export function isHelpOpen() { return !!$('#helpPanel') && !$('#helpPanel').hidden; }

export function toggleHelp(open, q) {
  const p = $('#helpPanel') || build();
  const on = open ?? p.hidden;
  p.hidden = !on;
  // 맨 위 줄(메뉴·도움말 단추)은 가리지 않는다
  if (on) p.style.top = Math.max(0, Math.round(document.querySelector('header')?.getBoundingClientRect().bottom || 0)) + 'px';
  document.body.classList.toggle('help-open', on);
  $('#btnHelp')?.setAttribute('aria-expanded', String(on));
  if (on) {
    if (q != null) { query = q; p.querySelector('input').value = q; }
    render();
    setTimeout(() => p.querySelector('input').focus(), 0);
  }
}

export function bindHelp() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isHelpOpen() && !document.querySelector('dialog[open]')) toggleHelp(false);
  });
}
