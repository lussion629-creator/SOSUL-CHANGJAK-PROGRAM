// 첫 화면 깜빡임 없이 테마 적용 (CSP 때문에 HTML 안이 아니라 따로 둔 파일)
try { var t = localStorage.getItem('nw-theme'); if (t && t !== 'auto') document.documentElement.dataset.theme = t; } catch (e) {}
