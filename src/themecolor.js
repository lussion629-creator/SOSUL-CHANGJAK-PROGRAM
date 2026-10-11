// 화면 색: 기본은 라이트·다크(그리고 기기 설정 따르기). 그 밖에 사용자가 RGB로 고른 배경색을 ‘내 색’으로 저장해 두고 언제든 바꾼다.
// 고른 색은 원고 종이 색이 되고, 둘레(바탕·옆 목록·선)는 그 색에서 조금 어둡게/밝게 만든다.
// 글자는 그 색 위에서 더 잘 읽히는 쪽(어두운 글자 = 라이트, 밝은 글자 = 다크)을 저절로 고른다.
import { app, saveSettings } from './app.js';
import { $, h, dialog, toast } from './ui.js';

export const CUSTOM_KEYS = ['--bg', '--bg2', '--panel', '--paper', '--line', '--accent-bg'];
const DARK_INK = '#27231e';
const LIGHT_INK = '#ffffff';

export const normHex = (s) => {
  let v = String(s || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) v = v.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/i.test(v) ? '#' + v.toLowerCase() : '';
};
export const toRgb = (hex) => { const n = parseInt(normHex(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const toHex = (r, g, b) => '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(+x || 0))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const A = toRgb(a), B = toRgb(b); return toHex(...A.map((x, i) => x + (B[i] - x) * t)); };
const lum = (hex) => {
  const c = toRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** 고른 색에 맞는 바탕(라이트/다크)과 색 값들 */
export function customTheme(hex) {
  const c = normHex(hex) || '#f6f2ea';
  const base = contrast(c, DARK_INK) >= contrast(c, LIGHT_INK) ? 'light' : 'dark';
  const accent = base === 'light' ? '#7a4b2a' : '#e0a878';
  const vars = base === 'light'
    ? { '--paper': c, '--panel': mix(c, '#000000', 0.03), '--bg': mix(c, '#000000', 0.07), '--bg2': mix(c, '#000000', 0.11), '--line': mix(c, '#000000', 0.15), '--accent-bg': mix(c, accent, 0.16) }
    : { '--paper': c, '--panel': mix(c, '#000000', 0.22), '--bg': mix(c, '#000000', 0.3), '--bg2': mix(c, '#000000', 0.18), '--line': mix(c, '#ffffff', 0.13), '--accent-bg': mix(c, accent, 0.22) };
  return { base, vars, color: c };
}

/** 설정대로 화면 색을 입힌다 (app.applySettings에서 부른다) */
export function applyTheme(s) {
  const root = document.documentElement;
  CUSTOM_KEYS.forEach((k) => root.style.removeProperty(k));
  let saved = s.theme;
  let vars = null;
  if (s.theme === 'custom' && normHex(s.bgColor)) {
    const t = customTheme(s.bgColor);
    root.dataset.theme = t.base;
    for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
    saved = t.base; vars = t.vars;
  } else if (s.theme === 'light' || s.theme === 'dark') root.dataset.theme = s.theme;
  else delete root.dataset.theme;
  // 다음에 켤 때 첫 화면부터 같은 색으로 (public/theme.js가 읽는다)
  try {
    localStorage.setItem('nw-theme', saved || 'auto');
    if (vars) localStorage.setItem('nw-theme-vars', JSON.stringify(vars)); else localStorage.removeItem('nw-theme-vars');
  } catch { /* 저장소 사용 불가 */ }
}

/** 예전 ‘종이색’ 테마는 내 색 하나로 옮긴다 */
export function migrateTheme(s) {
  if (!Array.isArray(s.bgColors)) s.bgColors = [];
  if (s.theme === 'sepia') {
    s.theme = 'custom'; s.bgColor = '#f8f0df';
    if (!s.bgColors.some((x) => x.color === '#f8f0df')) s.bgColors.push({ color: '#f8f0df', name: '종이색' });
  }
  if (s.theme === 'custom' && !normHex(s.bgColor)) s.theme = 'auto';
}

// ---------- 화면 색 창 ----------
export async function showColors() {
  const s = app.settings;
  const before = { theme: s.theme, bgColor: s.bgColor };
  let picked = s.theme === 'custom' ? s.bgColor : '';
  let draft = normHex(s.bgColor) || '#e8efe6';
  const std = [
    { v: 'auto', t: '기기 설정 따르기', sw: 'linear-gradient(135deg, #f6f2ea 50%, #222429 50%)' },
    { v: 'light', t: '라이트', sw: '#f6f2ea' },
    { v: 'dark', t: '다크', sw: '#222429' },
  ];
  const mine = () => s.bgColors.map((c, i) => `<div class="cl-mine-item"><button type="button" class="cl-sw ${s.theme === 'custom' && c.color === s.bgColor ? 'on' : ''}" data-mine="${i}" style="background:${c.color}" title="${h(c.name || c.color)}" aria-label="${h(c.name || c.color)}"></button><span>${h(c.name || c.color)}</span><button type="button" class="cl-del" data-del="${i}" title="내 색에서 지우기" aria-label="${h(c.name || c.color)} 지우기">✕</button></div>`).join('')
    || '<p class="hint" style="margin:0">아직 만든 색이 없어요. 아래에서 RGB로 골라 ‘내 색에 저장’을 누르세요.</p>';
  const r = await dialog({
    title: '화면 색',
    body: `<div class="cl">
      <h3 class="cl-h">기본</h3>
      <div class="cl-std" role="radiogroup" aria-label="기본 화면 색">${std.map((o) => `<label class="cl-opt"><input type="radio" name="std" value="${o.v}" ${s.theme === o.v ? 'checked' : ''}><span class="cl-sw" style="background:${o.sw}"></span><span>${o.t}</span></label>`).join('')}</div>
      <h3 class="cl-h">내 색</h3>
      <div class="cl-mine">${mine()}</div>
      <h3 class="cl-h">새 색 만들기</h3>
      <div class="cl-new">
        <input type="color" name="pick" value="${draft}" aria-label="색 고르기">
        <label class="cl-num"><span>R</span><input name="r" type="number" min="0" max="255" value="${toRgb(draft)[0]}"></label>
        <label class="cl-num"><span>G</span><input name="g" type="number" min="0" max="255" value="${toRgb(draft)[1]}"></label>
        <label class="cl-num"><span>B</span><input name="b" type="number" min="0" max="255" value="${toRgb(draft)[2]}"></label>
        <label class="cl-num cl-hex"><span>#</span><input name="hex" value="${draft.slice(1)}" maxlength="7" spellcheck="false" aria-label="16진수 색"></label>
      </div>
      <div class="cl-new2"><input name="cname" placeholder="이름 (예: 연두, 새벽)" maxlength="20" aria-label="색 이름"><button type="button" class="small" data-a="try">이 색으로 보기</button><button type="button" class="small" data-a="save">내 색에 저장</button></div>
      <p class="hint" style="margin:0">고른 색은 원고 종이 색이 되고, 둘레는 그 색에 맞춰 조금 짙게 칠해요. 글자는 더 잘 읽히는 쪽(어두운 글자·밝은 글자)을 저절로 골라요. 오른쪽 위 달 단추는 언제나 라이트·다크로 돌아가요.</p>
    </div>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '적용', value: 'ok', primary: true }],
    onOpen: (f) => {
      const preview = (theme, color) => { applyTheme({ ...s, theme, bgColor: color }); };
      const setDraft = (hex, from) => {
        const v = normHex(hex);
        if (!v) return;
        draft = v;
        const [R, G, B] = toRgb(v);
        if (from !== 'pick') f.pick.value = v;
        if (from !== 'rgb') { f.r.value = R; f.g.value = G; f.b.value = B; }
        if (from !== 'hex') f.hex.value = v.slice(1);
      };
      const markOn = () => {
        f.querySelectorAll('.cl-mine .cl-sw').forEach((b) => b.classList.toggle('on', picked && s.bgColors[+b.dataset.mine]?.color === picked));
        if (picked) f.querySelectorAll('input[name=std]').forEach((x) => { x.checked = false; });
      };
      const usePicked = (c) => { picked = c; markOn(); preview('custom', c); };
      f.pick.addEventListener('input', () => { setDraft(f.pick.value, 'pick'); usePicked(draft); });
      for (const k of ['r', 'g', 'b']) f[k].addEventListener('input', () => { setDraft(toHex(f.r.value, f.g.value, f.b.value), 'rgb'); usePicked(draft); });
      f.hex.addEventListener('input', () => { if (normHex(f.hex.value)) { setDraft(f.hex.value, 'hex'); usePicked(draft); } });
      f.addEventListener('change', (e) => {
        if (e.target.name === 'std') { picked = ''; markOn(); preview(e.target.value, s.bgColor); }
      });
      f.addEventListener('click', (e) => {
        const b = e.target.closest('button[type=button]');
        if (!b) return;
        if (b.dataset.mine) { const c = s.bgColors[+b.dataset.mine].color; setDraft(c); usePicked(c); }
        else if (b.dataset.del) {
          const [gone] = s.bgColors.splice(+b.dataset.del, 1);
          if (picked === gone.color) { picked = ''; }
          saveSettings();
          f.querySelector('.cl-mine').innerHTML = mine();
          markOn();
          if (!picked && !f.querySelector('input[name=std]:checked')) { f.querySelector('input[name=std][value=light]').checked = true; preview('light'); }
        } else if (b.dataset.a === 'try') usePicked(draft);
        else if (b.dataset.a === 'save') {
          const name = f.cname.value.trim() || draft;
          const at = s.bgColors.findIndex((x) => x.color === draft);
          if (at >= 0) s.bgColors[at].name = name; else s.bgColors.push({ color: draft, name });
          saveSettings();
          f.querySelector('.cl-mine').innerHTML = mine();
          f.cname.value = '';
          usePicked(draft);
        }
      });
    },
  });
  if (r.value !== 'ok') { Object.assign(s, before); saveSettings(); return; }
  const chosen = r.form.querySelector('input[name=std]:checked');
  if (picked) { s.theme = 'custom'; s.bgColor = picked; } else if (chosen) s.theme = chosen.value;
  saveSettings();
  toast(s.theme === 'custom' ? '화면 색을 바꿨어요. 보기 → 화면 색에서 언제든 바꿀 수 있어요.' : '화면 색을 바꿨어요.');
}
