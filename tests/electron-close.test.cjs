// 회귀시험 F08: 데스크톱 앱의 닫기·업데이트 전 저장 흐름을 가짜 Electron으로 돌린다.
// 쓰는 법: node tests/electron-close.test.cjs   (실제 창·설치는 하지 않는다)
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');

const log = [];
let nextDialog = []; // showMessageBox가 돌려줄 response 차례
const windows = [];
class FakeWC extends EventEmitter {
  constructor(w) { super(); this.w = w; this.js = async () => true; this.calls = 0; }
  executeJavaScript(code) { this.calls++; log.push(['js', this.w.id, code.slice(0, 40)]); return this.js(code); }
  setWindowOpenHandler() {}
  send() {}
}
let ids = 0;
class FakeWin extends EventEmitter {
  constructor() { super(); this.id = ++ids; this.destroyed = false; this.webContents = new FakeWC(this); this.closeCount = 0; windows.push(this); }
  loadURL() {} setMenuBarVisibility() {}
  isDestroyed() { return this.destroyed; }
  close() {
    if (this.destroyed) throw new Error('이미 닫힌 창');
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    if (!prevented) { this.destroyed = true; this.closeCount++; log.push(['closed', this.id]); this.emit('closed'); }
  }
  static fromWebContents(wc) { return wc.w; }
  static getAllWindows() { return windows.filter((w) => !w.destroyed); }
}
const fakeElectron = {
  app: { userAgentFallback: 'x', requestSingleInstanceLock: () => false, quit() {}, on() {}, whenReady: () => new Promise(() => {}), getVersion: () => '0', isPackaged: false },
  BrowserWindow: FakeWin,
  shell: { openExternal() {} },
  ipcMain: { handle() {}, on() {} },
  dialog: { showMessageBox: async () => { log.push(['ask']); return { response: nextDialog.shift() ?? 2 }; }, showErrorBox() {} },
  session: {},
  net: {},
};
const load = Module._load;
Module._load = function (req, ...a) { if (req === 'electron') return fakeElectron; return load.call(this, req, ...a); };
process.env.NW_TEST = '1';
const M = require('../electron/main.cjs');
M.WAIT.close = 150; M.WAIT.update = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function test(name, fn) {
  log.length = 0; nextDialog = [];
  try { await fn(); results.push([name, true]); console.log('✔', name); }
  catch (e) { results.push([name, false]); console.log('✘', name, '\n   ', e.message); }
}
const fresh = () => { M.createWindow(); return M.getWin(); };
let uncaught = [];
process.on('uncaughtException', (e) => uncaught.push(e));
process.on('unhandledRejection', (e) => uncaught.push(e));

(async () => {
  await test('즉시 저장 성공: 한 번 닫힘', async () => {
    const w = fresh();
    w.close(); await sleep(20);
    assert.equal(w.closeCount, 1);
    await sleep(250); // 예전 코드는 여기서 타이머가 null.close()를 불렀다
    assert.equal(uncaught.length, 0, String(uncaught[0]));
  });
  await test('느린 저장 성공(제한 안): 한 번 닫힘, 묻지 않음', async () => {
    const w = fresh();
    w.webContents.js = () => sleep(80).then(() => true);
    w.close(); await sleep(200);
    assert.equal(w.closeCount, 1);
    assert.ok(!log.some((x) => x[0] === 'ask'));
  });
  await test('저장 실패(false): 닫지 않고 앱 화면에 알린다', async () => {
    const w = fresh();
    w.webContents.js = async (code) => (code.includes('__closeBlocked') ? undefined : false);
    w.close(); await sleep(50);
    assert.equal(w.closeCount, 0);
    assert.ok(log.some((x) => x[0] === 'js' && x[2].includes('__closeBlocked')));
  });
  await test('저장 거절(화면 오류): 묻고, 취소하면 남고, 진행하면 한 번 닫힘', async () => {
    const w = fresh();
    w.webContents.js = async () => { throw new Error('renderer gone'); };
    nextDialog = [2];
    w.close(); await sleep(50);
    assert.equal(w.closeCount, 0);
    nextDialog = [1];
    w.close(); await sleep(50);
    assert.equal(w.closeCount, 1);
  });
  await test('시간 제한: 저장으로 치지 않고 묻는다 → 기다리기 → 성공하면 닫힘', async () => {
    const w = fresh();
    let n = 0;
    w.webContents.js = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve(true));
    nextDialog = [0];
    w.close(); await sleep(400);
    assert.equal(w.closeCount, 1);
    assert.equal(log.filter((x) => x[0] === 'ask').length, 1);
  });
  await test('겹친 닫기 요청은 합친다: 저장 한 번, 닫힘 한 번', async () => {
    const w = fresh();
    w.webContents.js = () => sleep(60).then(() => true);
    w.close(); w.close(); w.close(); await sleep(150);
    assert.equal(w.webContents.calls, 1);
    assert.equal(w.closeCount, 1);
  });
  await test('예전 창의 늦은 결과가 새 창을 닫지 않는다', async () => {
    const a = fresh();
    let release;
    a.webContents.js = () => new Promise((r) => { release = r; });
    a.close(); await sleep(10);
    // 예전 창이 다른 이유로 없어지고 새 창이 생김 (macOS에서 창 없이 남았다가 다시 연 경우 등)
    a.destroyed = true; a.emit('closed');
    const b = fresh();
    release(true); await sleep(50);
    assert.equal(b.closeCount, 0, '새 창은 그대로');
    assert.ok(!b.isDestroyed());
    assert.equal(uncaught.length, 0, String(uncaught[0]));
  });
  await test('업데이트 전 저장: 실패면 false(설치 미룸), 성공이면 true', async () => {
    const w = fresh();
    w.webContents.js = async (code) => (code.includes('__closeBlocked') ? undefined : false);
    assert.equal(await M.saveForQuit(), false);
    w.webContents.js = async () => true;
    assert.equal(await M.saveForQuit(), true);
  });
  const fail = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();
