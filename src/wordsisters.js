// 유의어 사전 (워드시스터즈 wordsisters.com): AI·API 키 없이 쓰는 사전.
// 사전 내용은 앱에 담지 않고(그 사이트의 이용 약관: 데이터 대량 수집·재배포 금지) 사이트 화면을 그대로 띄운다.
// 데스크톱 앱: 원고 옆에 붙는 창 안에 띄운다. 웹: 옆에 작은 창으로 연다(다른 사이트를 웹 앱 안에 넣는 것은 그 사이트가 막을 수 있어서).
// 사전 사이트에 부담을 주지 않도록 커서를 옮길 때마다 찾지 않고, 찾으라고 할 때만 찾는다.
import { app, saveSettings } from './app.js';
import { applyPageView, isPageView } from './pageview.js';
import { $, toast } from './ui.js';

const HOME = 'https://wordsisters.com/';
export const wsUrl = (w) => (w ? `${HOME}search/${encodeURIComponent(w)}` : HOME);
const docked = () => !!window.desktop; // 데스크톱 앱이면 원고 옆 창
const isOpen = () => !!app.settings.wsOpen && docked();
// 유의어(AI) 창과 겹치지 않게: 유의어 창이 열려 있으면 그 반대쪽, 아니면 정한 쪽(기본 오른쪽)
function side() {
  if (app.settings.synOpen) return app.settings.synSide === 'left' ? 'right' : 'left';
  return app.settings.wsSide === 'left' ? 'left' : 'right';
}

// 낱말 끝의 흔한 조사를 떼어 사전에서 찾기 쉽게 한다 (‘사과를’ → ‘사과’). 떼고 한 글자만 남으면 그대로 둔다.
// ‘이·가·도·의·로·과’처럼 낱말 끝 글자와 헷갈리기 쉬운 것은 떼지 않는다 (‘고양이’, ‘포도’)
const JOSA = ['에게서', '한테서', '으로서', '으로써', '에서는', '에게는', '에서', '에게', '한테', '께서', '으로', '까지', '부터', '처럼', '보다', '마저', '조차', '이나', '이랑', '을', '를', '은', '는', '에', '와', '랑'];
export function lemmaOf(word) {
  const w = String(word || '').trim().replace(/^[\s"'“”‘’「」『』()[\]<>]+|[\s"'“”‘’「」『』()[\]<>.,!?…·:;~]+$/g, '');
  if (!/^[가-힣]+$/.test(w)) return w;
  for (const j of JOSA) if (w.endsWith(j) && w.length - j.length >= 2) return w.slice(0, -j.length);
  return w;
}

// 지금 고른 글자 또는 커서가 있는 낱말
export function currentWord() {
  const ed = app.editor;
  if (!ed) return '';
  const { from, to, $from } = ed.state.selection;
  if (from !== to) {
    const t = ed.state.doc.textBetween(from, to, ' ').trim();
    return t.length <= 30 ? t : '';
  }
  const block = $from.parent;
  if (!block.isTextblock) return '';
  const text = block.textBetween(0, block.content.size, null, '￼');
  let a = $from.parentOffset, b = a;
  const W = /[\p{L}\p{N}]/u;
  while (a > 0 && W.test(text[a - 1])) a--;
  while (b < text.length && W.test(text[b])) b++;
  return text.slice(a, b);
}

// 찾기: 데스크톱은 옆 창, 웹은 작은 창(같은 창을 다시 쓴다)
let popup = null;
export function lookupWS(word = currentWord(), { raw = false } = {}) {
  const w = raw ? String(word || '').trim() : lemmaOf(word);
  if (docked()) {
    app.settings.wsOpen = true; saveSettings();
    layout();
    go(w);
    return;
  }
  const W = 480, H = Math.min(screen.availHeight || 900, 900);
  const left = Math.max(0, (window.screenX || 0) + (window.outerWidth || 1200) - W);
  try {
    popup = window.open(wsUrl(w), 'wordsisters', `popup,width=${W},height=${H},left=${left},top=${window.screenY || 0}`);
    if (popup) { try { popup.opener = null; } catch { /* 다른 사이트 창 */ } popup.focus(); }
  } catch { popup = null; }
  if (!popup) toast('사전 창이 막혔어요. 브라우저의 팝업 차단을 풀고 다시 눌러 주세요.', 6000);
}

export function toggleWS(on) {
  if (!docked()) { lookupWS(); return; }
  on = on ?? !isOpen();
  app.settings.wsOpen = on; saveSettings();
  layout();
  if (on) {
    const f = $('#wsPanel iframe');
    if (!f.src) go(lemmaOf(currentWord()));
    $('#wsPanel .ws-q').focus();
  }
}

function go(w) {
  const el = $('#wsPanel');
  if (!el) return;
  el.querySelector('.ws-q').value = w || '';
  el.querySelector('iframe').src = wsUrl(w);
  el.querySelector('.ws-ext').href = wsUrl(w);
}

function build() {
  const el = document.createElement('aside');
  el.id = 'wsPanel';
  el.className = 'ws-panel';
  el.setAttribute('aria-label', '유의어 사전');
  el.innerHTML = `<div class="syn-head">
      <b>유의어 사전 <small>워드시스터즈</small></b>
      <a class="icon-btn ws-ext" href="${HOME}" target="_blank" rel="noopener" title="브라우저에서 열기" aria-label="브라우저에서 열기">↗</a>
      <button type="button" class="icon-btn ws-side" title="반대쪽으로 옮기기" aria-label="반대쪽으로 옮기기">⇄</button>
      <button type="button" class="icon-btn ws-close" title="닫기" aria-label="유의어 사전 닫기">✕</button>
    </div>
    <form class="ws-form">
      <input class="ws-q" type="search" placeholder="찾을 낱말" aria-label="찾을 낱말">
      <button type="button" class="ws-cur" title="원고에서 커서가 있는 낱말(고른 글자)을 찾아요">원고 낱말</button>
      <button type="submit">찾기</button>
    </form>
    <iframe class="ws-frame" title="워드시스터즈 유의어 사전" referrerpolicy="strict-origin-when-cross-origin"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>`;
  $('#workspace').appendChild(el);
  el.querySelector('.ws-close').addEventListener('click', () => toggleWS(false));
  el.querySelector('.ws-side').addEventListener('click', () => {
    if (app.settings.synOpen) app.settings.synSide = side(); // 유의어 창과 자리를 바꾼다
    else app.settings.wsSide = side() === 'left' ? 'right' : 'left';
    saveSettings(); layout();
    document.dispatchEvent(new CustomEvent('nw-syn-layout'));
  });
  el.querySelector('.ws-form').addEventListener('submit', (e) => { e.preventDefault(); go(el.querySelector('.ws-q').value.trim()); });
  el.querySelector('.ws-cur').addEventListener('mousedown', (e) => e.preventDefault()); // 원고의 선택을 지킨다
  el.querySelector('.ws-cur').addEventListener('click', () => {
    const w = lemmaOf(currentWord());
    if (!w) { toast('원고에서 찾을 낱말에 커서를 두거나 글자를 골라 주세요.'); return; }
    go(w);
  });
  return el;
}

export function layout() {
  const on = isOpen() && !!app.project;
  const el = $('#wsPanel') || (on ? build() : null);
  document.body.classList.toggle('ws-open', on);
  document.body.classList.toggle('ws-left', on && side() === 'left');
  if (!el) return;
  el.hidden = !on;
  el.classList.toggle('left', side() === 'left');
  if (isPageView()) applyPageView();
}

export function bindWS() {
  app.hooks.afterOpen.push(() => layout());
  document.addEventListener('nw-syn-changed', () => layout());
  layout();
}
