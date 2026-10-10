import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// npm run build        → dist/ (웹 서버·GitHub Pages에 올리는 PWA)
// npm run build:single → dist-single/index.html (파일 하나짜리 미리보기)
export default defineConfig(({ mode }) => ({
  base: './',
  build: mode === 'single'
    ? { outDir: 'dist-single', assetsInlineLimit: 100000000, chunkSizeWarningLimit: 10000 }
    : { outDir: 'dist', chunkSizeWarningLimit: 3000 },
  plugins: mode === 'single' ? [viteSingleFile()] : [],
}));
