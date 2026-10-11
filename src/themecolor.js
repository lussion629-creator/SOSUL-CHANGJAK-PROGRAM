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

// ---------- 보색: 바탕 색의 맞은편 색상에서, 가장 잘 보이는 밝기를 고른다 ----------
const toHsl = (hex) => {
  const [r, g, b] = toRgb(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, s, l];
};
const fromHsl = (hh, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
};
// 무채색(회색·흰색·검정)에 가까운 바탕은 맞은편 색상이 없으니 바탕의 따뜻함/차가움 반대쪽(남색·주황)을 쓴다
const oppositeHue = (bg) => {
  const [hh] = toHsl(bg);
  const [r, g, b] = toRgb(bg);
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma >= 10) return (hh + 180) % 360;
  return b >= r ? 30 : 220;
};
/** 바탕(bg) 위 글자로 가장 잘 보이는 보색. 대비 10:1을 넘는 것 가운데 색이 가장 살아 있는 것 (그만큼 안 되는 바탕이면 대비가 가장 큰 것) */
export function complementInk(bg) {
  const hh = oppositeHue(bg);
  let best = null;
  for (let l = 0.02; l <= 0.98; l += 0.01) {
    const c = fromHsl(hh, 0.75, l);
    const k = contrast(c, bg);
    const vivid = 1 - Math.abs(l - 0.5) * 2; // 0.5에 가까울수록 색이 또렷하다
    const score = k >= 10 ? 100 + vivid : k;
    if (!best || score > best.score) best = { c, score };
  }
  return best.c;
}
/** 바탕(bg)에서 가장 도드라지면서 글자(ink)는 잘 읽히는 보색 형광펜 */
export function complementHl(bg, ink) {
  const hh = oppositeHue(bg);
  let best = null;
  for (let l = 0.05; l <= 0.95; l += 0.01) {
    const c = fromHsl(hh, 0.85, l);
    const readable = contrast(ink, c);
    const stand = contrast(c, bg);
    const score = readable >= 4.5 ? 100 + stand : readable;
    if (!best || score > best.score) best = { c, score };
  }
  return best.c;
}
const readHex = (v) => { v = v.trim(); return normHex(v) || '' };

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
  applyContrast(s);
  // 다음에 켤 때 첫 화면부터 같은 색으로 (public/theme.js가 읽는다)
  try {
    localStorage.setItem('nw-theme', saved || 'auto');
    if (vars) localStorage.setItem('nw-theme-vars', JSON.stringify(vars)); else localStorage.removeItem('nw-theme-vars');
  } catch { /* 저장소 사용 불가 */ }
}

// 원고 글자색·형광펜을 바탕의 보색으로 (inkMode·hlMode: 'auto' | 'comp'). 화면에만 쓰고, 내보낸 파일의 색은 그대로
const INK_KEYS = ['--ed-ink', '--hl', '--hl-ink'];
export function applyContrast(s) {
  const root = document.documentElement;
  INK_KEYS.forEach((k) => root.style.removeProperty(k));
  delete root.dataset.hl;
  if (s.inkMode !== 'comp' && s.hlMode !== 'comp') return;
  const css = getComputedStyle(root);
  const paper = readHex(css.getPropertyValue('--paper')) || '#f6f2ea';
  const ink = s.inkMode === 'comp' ? complementInk(paper) : readHex(css.getPropertyValue('--ed-ink')) || readHex(css.getPropertyValue('--ink')) || '#27231e';
  if (s.inkMode === 'comp') root.style.setProperty('--ed-ink', ink);
  if (s.hlMode === 'comp') {
    root.style.setProperty('--hl', complementHl(paper, ink));
    root.style.setProperty('--hl-ink', ink);
    root.dataset.hl = 'comp';
  }
}
// 기기 설정 따르기일 때 기기의 밝기가 바뀌면 다시 계산
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (app.settings) applyContrast(app.settings); });

/** 예전 ‘종이색’ 테마는 내 색 하나로 옮긴다 */
export function migrateTheme(s) {
  if (!Array.isArray(s.bgColors)) s.bgColors = [];
  if (s.theme === 'sepia') {
    s.theme = 'custom'; s.bgColor = '#f8f0df';
    if (!s.bgColors.some((x) => x.color === '#f8f0df')) s.bgColors.push({ color: '#f8f0df', name: '종이색' });
  }
  if (s.theme === 'custom' && !normHex(s.bgColor)) s.theme = 'auto';
}

/** 보기 메뉴: 글자·형광펜 보색 한꺼번에 켜고 끄기 */
export function toggleComplement() {
  const s = app.settings;
  const on = !(s.inkMode === 'comp' && s.hlMode === 'comp');
  s.inkMode = s.hlMode = on ? 'comp' : 'auto';
  saveSettings();
  toast(on ? '원고 글자와 형광펜을 바탕의 보색으로 보여 줘요. 보기 → 화면 색에서 하나씩 고를 수 있어요.' : '글자와 형광펜을 원래 색으로 돌렸어요.');
}

// ---------- 화면 색 창 ----------
export async function showColors() {
  const s = app.settings;
  const before = { theme: s.theme, bgColor: s.bgColor, inkMode: s.inkMode, hlMode: s.hlMode };
  const opt = { inkMode: s.inkMode === 'comp' ? 'comp' : 'auto', hlMode: s.hlMode === 'comp' ? 'comp' : 'auto' };
  const cur = { theme: s.theme, bgColor: s.bgColor };
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
      <h3 class="cl-h">글자·형광펜</h3>
      <div class="cl-ink">
        <label class="cl-opt"><input type="checkbox" name="inkComp" ${opt.inkMode === 'comp' ? 'checked' : ''}><span>원고 글자를 <b>보색</b>으로</span></label>
        <label class="cl-opt"><input type="checkbox" name="hlComp" ${opt.hlMode === 'comp' ? 'checked' : ''}><span>형광펜을 <b>보색</b>으로</span></label>
        <span class="cl-sample" aria-hidden="true">가나다 <mark>형광펜</mark></span>
      </div>
      <p class="hint" style="margin:0">보색: 바탕 색의 맞은편 색 가운데 가장 잘 보이는 밝기를 저절로 골라요. 글자는 대비 10:1 안팎(바탕이 허락하는 만큼 가장 높게), 형광펜은 바탕에서 가장 도드라지면서 글자가 잘 읽히는 색이에요. 화면에서만 바뀌고 내보낸 파일의 색은 그대로예요.</p>
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
      const sample = f.querySelector('.cl-sample');
      const paintSample = () => { const cs = getComputedStyle(document.documentElement); sample.style.background = cs.getPropertyValue('--paper'); sample.style.color = cs.getPropertyValue('--ed-ink'); };
      const preview = (theme, color) => { cur.theme = theme; cur.bgColor = color; applyTheme({ ...s, ...opt, theme, bgColor: color }); paintSample(); };
      paintSample();
      f.inkComp.addEventListener('change', () => { opt.inkMode = f.inkComp.checked ? 'comp' : 'auto'; preview(cur.theme, cur.bgColor); });
      f.hlComp.addEventListener('change', () => { opt.hlMode = f.hlComp.checked ? 'comp' : 'auto'; preview(cur.theme, cur.bgColor); });
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
  Object.assign(s, opt);
  if (picked) { s.theme = 'custom'; s.bgColor = picked; } else if (chosen) s.theme = chosen.value;
  saveSettings();
  toast(s.theme === 'custom' ? '화면 색을 바꿨어요. 보기 → 화면 색에서 언제든 바꿀 수 있어요.' : '화면 색을 바꿨어요.');
}
