// 콘텐츠 보안 정책(CSP): 이 앱이 쓰는 곳(자기 자신, 구글 로그인·드라이브, 구글 글꼴) 말고는
// 스크립트를 불러오거나 데이터를 보내지 못하게 막는다. (Gemini 낭독·AI 글 모델(Gemini·OpenAI·Anthropic)은 사용자가 키를 넣었을 때만 그곳으로 보낸다) 웹(dist)과 데스크톱 앱이 함께 쓴다.
// (주고받기 connect-src는 사용자가 정한 동기화 서버 주소로도 가야 해서 https·http 주소를 열어 둔다. 스크립트는 여전히 막혀 있다)
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "connect-src 'self' https://www.googleapis.com https://accounts.google.com https://oauth2.googleapis.com https://fonts.googleapis.com https://fonts.gstatic.com https://generativelanguage.googleapis.com https://api.openai.com https://api.anthropic.com https: http:",
  "media-src 'self' blob: data:",
  'frame-src https://accounts.google.com',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
module.exports = { CSP };
