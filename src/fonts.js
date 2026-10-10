// 글꼴 목록 (화면·한글·Word 이름 대응)
export const FONTS = [
  // [CSS 글꼴, 화면에 보이는 이름, 한글·Word에 넘길 글꼴 이름]
  ["'KoPub Batang Light'", 'KoPub바탕 Light', 'KoPub바탕체 Light'],
  ["'Gowun Batang'", '고운바탕', 'Gowun Batang'],
  ["'Nanum Myeongjo'", '나눔명조', '나눔명조'],
  ["'Noto Serif KR'", '본명조 (Noto Serif KR)', 'Noto Serif KR'],
  ["'함초롬바탕', 'HCR Batang'", '함초롬바탕 (설치된 글꼴)', '함초롬바탕'],
  ['Batang', '바탕 (설치된 글꼴)', '바탕'],
  ["'Nanum Gothic'", '나눔고딕', '나눔고딕'],
  ['Pretendard', '프리텐다드', 'Pretendard'],
];
export const fontName = (css) => FONTS.find((f) => f[0] === css)?.[2] || String(css).split(',')[0].replace(/['"]/g, '').trim();
// 한글 문서의 글꼴 이름 → CSS
export function cssFont(face) {
  const f = FONTS.find((x) => x[2] === face || x[1] === face);
  if (f) return f[0];
  if (/^KoPub.*바탕.*Light/i.test(face)) return FONTS[0][0];
  if (/^바탕/.test(face)) return 'Batang';
  return `'${face.replace(/'/g, '')}'`;
}

