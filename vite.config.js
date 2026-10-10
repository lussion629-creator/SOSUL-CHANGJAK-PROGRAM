import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import csp from './electron/csp.cjs';
const { CSP } = csp;

// 배포용(dist)에만 보안 정책을 넣는다: HTML 안의 스크립트를 파일로 빼고 CSP를 단다.
// (개발 서버와 파일 하나짜리 미리보기는 그대로)
const INLINE_THEME = /<script>\s*\/\/ 첫 화면 깜빡임[\s\S]*?<\/script>/;
function securityHeaders() {
  return {
    name: 'novel-csp',
    apply: 'build',
    transformIndexHtml(html) {
      if (!INLINE_THEME.test(html)) throw new Error('index.html의 테마 스크립트를 찾지 못했습니다.');
      return html
        .replace(INLINE_THEME, '<script src="./theme.js"></script>')
        .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">\n<meta name="referrer" content="strict-origin-when-cross-origin">`);
    },
  };
}

// npm run build        → dist/ (웹 서버·GitHub Pages에 올리는 PWA)
// npm run build:single → dist-single/index.html (파일 하나짜리 미리보기)
export default defineConfig(({ mode }) => ({
  base: './',
  build: mode === 'single'
    ? { outDir: 'dist-single', assetsInlineLimit: 100000000, chunkSizeWarningLimit: 10000 }
    : { outDir: 'dist', chunkSizeWarningLimit: 3000 },
  plugins: mode === 'single' ? [viteSingleFile()] : [securityHeaders()],
}));
