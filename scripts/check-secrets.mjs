// 올리기 전 점검: 저장소에 비밀 키·토큰이 들어 있지 않은지 찾는다.
// 사용: npm run check:secrets  (찾으면 실패로 끝나서 빌드·배포가 멈춘다)
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  ['OpenAI·Anthropic 키', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['구글 API 키', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['구글 OAuth 클라이언트 비밀번호', /\bGOCSPX-[0-9A-Za-z_-]{20,}/],
  ['구글 액세스 토큰', /\bya29\.[0-9A-Za-z_-]{20,}/],
  ['GitHub 토큰', /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}|\bgithub_pat_[0-9A-Za-z_]{40,}/],
  ['AWS 키', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack 토큰', /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
  ['비밀 키 파일', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['client_secret 값', /["']?client_secret["']?\s*[:=]\s*["'][^"']{8,}["']/i],
];
const files = execSync('git ls-files -z --cached --others --exclude-standard', { encoding: 'utf8' }).split('\0').filter(Boolean);
const bad = [];
for (const f of files) {
  if (/\.env(\.|$)/.test(f) && !f.endsWith('.env.example')) bad.push([f, 0, '.env 파일이 저장소에 들어 있음']);
  let st;
  try { st = statSync(f); } catch { continue; }
  if (!st.isFile() || st.size > 5e6 || /\.(png|jpe?g|gif|ico|woff2?|ttf|otf|hwpx?|docx?|pdf|zip|gz|exe)$/i.test(f) || f === 'package-lock.json') continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of RULES) if (re.test(line) && !/check-secrets/.test(f)) bad.push([f, i + 1, name]);
  });
}
if (bad.length) {
  console.error('비밀 값으로 보이는 것이 있습니다. 지우고 .env로 옮기거나, 이미 올렸다면 키를 새로 발급하세요.');
  for (const [f, n, name] of bad) console.error(`  ${f}${n ? ':' + n : ''}  ${name}`);
  process.exit(1);
}
console.log(`비밀 값 점검 통과 (${files.length}개 파일)`);
