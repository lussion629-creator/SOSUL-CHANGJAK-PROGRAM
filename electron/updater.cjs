// 자동 업데이트: GitHub 릴리스에 새 버전이 올라오면 알아서 받는다.
// Windows: 뒤에서 받아 두었다가 '지금 다시 시작'을 누르거나 앱을 끌 때 설치한다.
// macOS: 서명이 없는 앱은 스스로 바꿀 수 없어서, 새 버전이 나왔다고 알려 주고 받는 곳을 연다.
const { app, dialog, shell, net } = require('electron');

const REPO = 'lussion629-creator/SOSUL-CHANGJAK-PROGRAM';
const PAGE = `https://github.com/${REPO}/releases/latest`;
const EVERY = 6 * 3600e3; // 켜 둔 동안 6시간마다 다시 확인

let getWin = () => null;
let beforeQuit = async () => {};
let au = null;
let asked = ''; // 같은 버전을 두 번 묻지 않는다

const newer = (a, b) => {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const box = (o) => { const w = getWin(); return w ? dialog.showMessageBox(w, o) : dialog.showMessageBox(o); };
const latest = () => box({ type: 'info', message: '최신 버전을 쓰고 있어요.', detail: `버전 ${app.getVersion()}` });

async function checkMac(manual) {
  const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (r.status === 404) { if (manual) await latest(); return; } // 아직 릴리스가 없음
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const v = String((await r.json()).tag_name || '').replace(/^v/, '');
  if (!v || !newer(v, app.getVersion())) { if (manual) await latest(); return; }
  if (!manual && asked === v) return;
  asked = v;
  const { response } = await box({
    type: 'info', buttons: ['받으러 가기', '나중에'], defaultId: 0, cancelId: 1,
    message: `새 버전(${v})이 나왔어요.`,
    detail: `지금 쓰는 버전은 ${app.getVersion()}입니다. 새 설치 파일(.dmg)을 받아 응용 프로그램 폴더에 덮어 넣으면 됩니다. 원고는 그대로 남아요.`,
  });
  if (response === 0) shell.openExternal(PAGE);
}

function winUpdater() {
  if (au) return au;
  ({ autoUpdater: au } = require('electron-updater'));
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  au.allowPrerelease = false;
  au.allowDowngrade = false;
  au.on('update-downloaded', async (info) => {
    if (asked === info.version) return;
    asked = info.version;
    const { response } = await box({
      type: 'info', buttons: ['지금 다시 시작', '나중에 (끌 때 설치)'], defaultId: 0, cancelId: 1,
      message: `새 버전(${info.version})을 받았어요.`,
      detail: '다시 시작하면 바로 적용됩니다. 원고는 먼저 저장해요. ‘나중에’를 고르면 앱을 끌 때 설치됩니다.',
    });
    if (response === 0) { await beforeQuit(); au.quitAndInstall(false, true); }
  });
  au.on('error', () => {}); // 인터넷이 없을 때 등: 조용히 다음 확인을 기다린다
  return au;
}

async function check(manual = false) {
  if (!app.isPackaged) { if (manual) await box({ type: 'info', message: '개발용으로 실행 중이라 업데이트를 확인하지 않아요.' }); return; }
  try {
    if (process.platform === 'darwin') { await checkMac(manual); return; }
    const r = await winUpdater().checkForUpdates();
    const v = r?.updateInfo?.version;
    if (!manual) return;
    if (!v || !newer(v, app.getVersion())) await latest();
    else if (asked !== v) await box({ type: 'info', message: `새 버전(${v})을 받는 중이에요.`, detail: '다 받으면 다시 알려 드릴게요. 그동안 계속 쓰셔도 됩니다.' });
  } catch (e) {
    if (manual) await box({ type: 'warning', message: '업데이트를 확인하지 못했어요.', detail: `인터넷 연결을 확인해 주세요.\n(${e?.message || e})` });
  }
}

function start(opts) {
  getWin = opts.getWin;
  beforeQuit = opts.beforeQuit;
  setTimeout(() => check(false), 15000); // 켜고 조금 뒤에 한 번
  setInterval(() => check(false), EVERY);
}

module.exports = { start, check };
