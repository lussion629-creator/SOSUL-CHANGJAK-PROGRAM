// 첫 화면 깜빡임 없이 테마 적용 (CSP 때문에 HTML 안이 아니라 따로 둔 파일)
try {
  var t = localStorage.getItem('nw-theme');
  if (t && t !== 'auto' && t !== 'custom') document.documentElement.dataset.theme = t;
  // 사용자가 고른 화면 색
  var v = JSON.parse(localStorage.getItem('nw-theme-vars') || 'null');
  if (v) for (var k in v) if (/^--[a-z0-9-]+$/.test(k) && /^#[0-9a-f]{6}$/i.test(v[k])) document.documentElement.style.setProperty(k, v[k]);
} catch (e) {}
