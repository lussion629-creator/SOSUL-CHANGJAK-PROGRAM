// Ctrl(맥은 ⌘)을 누른 채 마우스 휠을 돌리면 원고 화면을 확대·축소한다 (노트북 터치패드 두 손가락 벌리기·오므리기도 같다).
// 쪽 보기면 쪽 배율, 쪽 설정을 따르는 원고면 화면 배율, 아니면 글자 크기를 바꾼다. 메뉴·도구 줄 같은 앱 화면 크기는 그대로.
import { app, saveSettings, followsLayout } from './app.js';
import { isPageView, setZoom, pvZoomNow } from './pageview.js';
import { $ } from './ui.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let acc = 0;
let badgeTimer = null;

function badge(text) {
  let b = $('#zoomBadge');
  if (!b) {
    b = document.createElement('div');
    b.id = 'zoomBadge';
    b.className = 'zoom-badge';
    b.setAttribute('role', 'status');
    document.body.appendChild(b);
  }
  b.textContent = text;
  b.classList.add('on');
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => b.classList.remove('on'), 900);
}

/** dir: +1 크게, -1 작게, 0 처음 크기로 */
export function zoomStep(dir) {
  const s = app.settings;
  if (isPageView()) {
    const cur = Math.round(pvZoomNow() * 100);
    const next = dir === 0 ? 100 : clamp(Math.round((cur + dir * 10) / 10) * 10, 30, 300);
    setZoom(next);
    badge(`쪽 보기 ${next}%`);
  } else if (followsLayout()) {
    const cur = s.edZoom || 130;
    s.edZoom = dir === 0 ? 130 : clamp(Math.round((cur + dir * 10) / 10) * 10, 60, 250);
    saveSettings();
    badge(`화면 배율 ${s.edZoom}%`);
  } else {
    s.size = dir === 0 ? 17 : clamp((+s.size || 17) + dir, 12, 30);
    saveSettings();
    badge(`글자 ${s.size}px`);
  }
}

export function bindZoom() {
  // 브라우저·데스크톱 앱 전체 확대 대신 원고만 키운다 (passive:false여야 막을 수 있다)
  addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.target.closest?.('dialog, .help-panel, .menu')) return;
    e.preventDefault();
    // 마우스 휠 한 칸(약 100)마다 한 단계, 터치패드처럼 잘게 오는 것은 모아서
    acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const unit = Math.abs(e.deltaY) >= 50 || e.deltaMode ? 50 : 30;
    while (Math.abs(acc) >= unit) {
      const dir = acc > 0 ? -1 : 1;
      acc -= Math.sign(acc) * unit;
      zoomStep(dir);
    }
  }, { passive: false });
}
