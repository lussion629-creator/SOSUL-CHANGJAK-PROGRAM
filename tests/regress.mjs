// 회귀시험: 점검 보고서 F01~F07 재현 케이스를 실제 앱 화면(개발 서버)에서 돌린다.
// 쓰는 법: npm run dev (다른 창) → npm run test:regress  [주소, 기본 http://localhost:5173/]
// 브라우저마다 새 임시 프로필(IndexedDB)을 쓴다. 사용자 원고에는 손대지 않는다.
// 외부 서비스는 쓰지 않고, 동기화는 page.route로 흉내 낸 서버를 쓴다.
let pw;
try { pw = await import('playwright'); } catch { pw = await import(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright/index.mjs'); }
const URL0 = process.argv[2] || 'http://localhost:5173/';
process.on('unhandledRejection', () => {}); // 시간 초과로 닫은 시험의 늦은 오류는 무시
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

const browser = await pw.chromium.launch();
const results = [];
const open = new Set(); // 시험이 시간 안에 끝나지 않으면 닫을 브라우저 문맥
function assert(cond, msg) { if (!cond) throw new Error('단언 실패: ' + msg); }

async function boot(extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  await ctx.addInitScript((extra) => {
    if (!localStorage.getItem('nw-settings')) localStorage.setItem('nw-settings', JSON.stringify({ syncAsked: true, syncTarget: 'off', proof: false, autoSaveSeconds: 60, ...extra }));
    // 장애 주입: window.__fail = { store: 'chapters', name: 'QuotaExceededError' } 이면 그 저장소 put이 실패한다
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      const f = window.__fail;
      if (f && (f.store === this.name || f.store === '*')) throw new DOMException(f.msg || '저장 공간이 부족합니다', f.name || 'QuotaExceededError');
      return put.apply(this, a);
    };
  }, extra);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  open.add(ctx);
  page.on('pageerror', (e) => console.log('   [pageerror]', e.message));
  await page.goto(URL0);
  await page.waitForSelector('.ProseMirror');
  await page.waitForTimeout(600);
  return { ctx, page };
}
// 앱 모듈을 불러 쓰는 도우미 (dev 서버라서 /src 경로로 바로 불러진다)
const M = `const A = await import('/src/app.js'); const S = await import('/src/store.js');`;
const run = (page, body, arg) => page.evaluate(new Function('arg', `return (async () => { ${M} ${body} })()`), arg);
// 장 두 개짜리 시험 작품을 만들고 연다
const mkProject = (page, chapters, title = 'QA') => run(page, `
  const p = await S.createProject(arg.title, arg.chapters);
  await A.openProject(p.id); return { id: p.id, order: p.order };`, { chapters, title });
const typeInto = (page, html) => run(page, `A.app.editor.commands.setContent(arg, { emitUpdate: true }); A.app.dirty = true;`, html);
const pressDialog = async (page, value) => { await page.waitForSelector('#dlg[open]'); await page.click(`#dlg .dlg-foot button[value="${value}"]`); };

async function test(name, fn) {
  if (only && !only.test(name)) return;
  const t0 = Date.now();
  try { await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('시간 초과 (40초)')), 40e3))]); results.push([name, '통과', Date.now() - t0]); console.log('✔', name); }
  catch (e) { results.push([name, '실패: ' + e.message, Date.now() - t0]); console.log('✘', name, '\n   ', e.message.split('\n')[0]); }
  for (const c of open) await c.close().catch(() => {});
  open.clear();
}

// ---------------- F01 저장 실패 ----------------
await test('F01 저장 실패: 닫기 전 저장은 false를 돌려주고 표시가 남는다', async () => {
  const { ctx, page } = await boot();
  await mkProject(page, [{ title: 'A', html: '<p>사과 원본입니다.</p>' }, { title: 'B', html: '<p>B장</p>' }]);
  await typeInto(page, '<p>저장실패로 잃으면 안 되는 새 원고</p>');
  await page.evaluate(() => { window.__fail = { store: 'chapters' }; });
  const r = await page.evaluate(() => window.__saveBeforeClose());
  assert(r === false, '__saveBeforeClose가 false여야 함: ' + r);
  assert(/실패/.test(await page.textContent('#saveState')), '저장 표시가 실패');
  await ctx.close();
});

await test('F01 저장 실패 후 장 전환: 확인을 묻고, 옮겨도 실패 표시·메모리 원고가 남으며, 복구 뒤 최신본이 저장된다', async () => {
  const { ctx, page } = await boot();
  const { order } = await mkProject(page, [{ title: 'A', html: '<p>사과 원본입니다.</p>' }, { title: 'B', html: '<p>B장</p>' }]);
  await typeInto(page, '<p>저장실패로 잃으면 안 되는 새 원고</p>');
  await page.evaluate(() => { window.__fail = { store: 'chapters' }; });
  const p = run(page, 'return A.openChapter(arg);', order[1]);
  await page.waitForSelector('#dlg[open]');
  assert(/저장하지 못했어요/.test(await page.textContent('#dlg h2')), '실패 대화상자');
  await pressDialog(page, 'go'); // 그대로 장 옮기기
  assert(await p === true, '장 전환 진행');
  assert(/실패/.test(await page.textContent('#saveState')), '다른 장을 열어도 실패 표시 유지: ' + await page.textContent('#saveState'));
  assert(await run(page, 'return A.app.unsaved.has(arg);', order[0]), 'A장이 못 쓴 장으로 남음');
  // 실패 해제 → 다시 시도 성공
  await page.evaluate(() => { window.__fail = null; });
  assert(await run(page, 'return A.saveNow();') === true, '재시도 성공');
  assert(/저장됨/.test(await page.textContent('#saveState')), '경고 해제');
  // 새로 시작해 A장 확인
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(500);
  const html = await run(page, 'return (await S.getChapter(arg)).html;', order[0]);
  assert(html.includes('잃으면 안 되는 새 원고'), '재시작 뒤 최신본: ' + html);
  await ctx.close();
});

await test('F01 저장 실패 후 장 전환 취소: 그대로 머문다', async () => {
  const { ctx, page } = await boot();
  const { order } = await mkProject(page, [{ title: 'A', html: '<p>원본</p>' }, { title: 'B', html: '<p>B</p>' }]);
  await typeInto(page, '<p>새 원고</p>');
  await page.evaluate(() => { window.__fail = { store: 'chapters' }; });
  const p = run(page, 'return A.openChapter(arg);', order[1]);
  await pressDialog(page, 'close');
  assert(await p === false, '전환 안 함');
  assert(await run(page, 'return A.app.cur;') === order[0], '그대로 A장');
  assert((await page.textContent('.ProseMirror')).includes('새 원고'), '편집기 내용 유지');
  await ctx.close();
});

await test('F01 저장 실패 후 작품 전환: 취소하면 남고, 다시 시도 성공하면 넘어간다', async () => {
  const { ctx, page } = await boot();
  const other = await run(page, `const p = await S.createProject('다른 작품', [{ title: '1장', html: '<p>다른</p>' }]); return p.id;`);
  const { id, order } = await mkProject(page, [{ title: 'A', html: '<p>원본</p>' }]);
  await typeInto(page, '<p>작품 전환 전 새 원고</p>');
  await page.evaluate(() => { window.__fail = { store: 'chapters' }; });
  let p = run(page, 'return A.openProject(arg);', other);
  await pressDialog(page, 'close');
  assert(await p === false, '작품 전환 취소');
  assert(await run(page, 'return A.app.project.id;') === id, '같은 작품');
  p = run(page, 'return A.openProject(arg);', other);
  await page.waitForSelector('#dlg[open]');
  await page.evaluate(() => { window.__fail = null; });
  await pressDialog(page, 'retry');
  assert(await p === true, '재시도 뒤 전환');
  const html = await run(page, 'return (await S.getChapter(arg)).html;', order[0]);
  assert(html.includes('작품 전환 전 새 원고'), '전환 전 원고 저장됨');
  await ctx.close();
});

await test('F01 저장 실패 시 백업은 메모리의 최신 원고로 복구 파일을 만든다', async () => {
  const { ctx, page } = await boot();
  await mkProject(page, [{ title: 'A', html: '<p>원본</p>' }]);
  await typeInto(page, '<p>백업에 들어가야 할 최신 원고</p>');
  await page.evaluate(() => { window.__fail = { store: 'chapters' }; });
  const [dl] = await Promise.all([page.waitForEvent('download'), run(page, `const F = await import('/src/features.js'); await F.downloadBackup();`)]);
  const text = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
  assert(text.includes('백업에 들어가야 할 최신 원고'), '복구 파일에 최신 원고');
  // (시험용 헤드리스 크롬은 한글 파일 이름을 'download'로 알려 주므로 내용으로 확인)
  assert(JSON.parse(text).rescue === true, '복구 파일 표시');
  await ctx.close();
});

await test('F01 통계 기록 실패는 본문 저장 실패로 보지 않는다', async () => {
  const { ctx, page } = await boot();
  const { order } = await mkProject(page, [{ title: 'A', html: '<p>원본</p>' }]);
  await typeInto(page, '<p>본문은 저장되어야 함</p>');
  await page.evaluate(() => { window.__fail = { store: 'daily' }; });
  assert(await run(page, 'return A.saveNow();') === true, '본문 저장 성공');
  assert(/기록 일부 실패/.test(await page.textContent('#saveState')), '기록 실패는 따로 표시: ' + await page.textContent('#saveState'));
  assert((await run(page, 'return (await S.getChapter(arg)).html;', order[0])).includes('본문은 저장'), '본문 디스크 반영');
  await ctx.close();
});

await test('F01 저장 중 추가 입력: 저장한 뒤에도 dirty가 남고 다음 저장에 들어간다', async () => {
  const { ctx, page } = await boot();
  const { order } = await mkProject(page, [{ title: 'A', html: '<p>원본</p>' }]);
  await typeInto(page, '<p>첫 입력</p>');
  // 느린 저장: chapters put을 400ms 늦춘다
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    window.__slow = true;
    IDBObjectStore.prototype.put = function (...a) {
      if (window.__slow && this.name === 'chapters') { const until = Date.now() + 400; while (Date.now() < until); }
      return put.apply(this, a);
    };
  });
  const saving = run(page, 'return A.saveNow();');
  await page.waitForTimeout(50);
  await page.locator('.ProseMirror').click(); await page.keyboard.press('End'); await page.keyboard.type(' 추가');
  await saving;
  await page.evaluate(() => { window.__slow = false; });
  assert(await run(page, 'return A.app.dirty;') === true, '추가 입력 뒤 dirty 유지');
  await run(page, 'return A.saveNow();');
  assert((await run(page, 'return (await S.getChapter(arg)).html;', order[0])).includes('추가'), '추가 입력도 저장');
  await ctx.close();
});

// ---------------- F02 백업 덮어쓰기 ----------------
const bundleOnlyA = `
  const b = await S.exportBundle(arg.id);
  const a = b.chapters.find((c) => c.title === 'A');
  return { ...b, project: { ...b.project, order: [a.id] }, chapters: [{ ...a, html: '<p>백업의 A</p>' }], notes: [], snapshots: [] };`;

await test('F02 A+B 작품에 A만 있는 백업으로 덮어쓰면 A만 남고, B는 휴지통의 덮어쓰기 전 작품에서 되살릴 수 있다', async () => {
  const { ctx, page } = await boot();
  const { id } = await mkProject(page, [{ title: 'A', html: '<p>A 원본</p>' }, { title: 'B', html: '<p>B 원본</p>' }]);
  await run(page, `await S.putNote({ id: 'n-only-local', projectId: arg, type: 'memo', name: '지울 자료', fields: {}, body: '' });`, id);
  const b = await run(page, bundleOnlyA, { id });
  await run(page, `await S.importBundle(arg, { mode: 'restore' }); await A.openProject(arg.project.id);`, b);
  const chs = await run(page, `return (await S.chaptersOf(arg)).map((c) => c.title + ':' + c.html);`, id);
  assert(chs.length === 1 && chs[0].includes('백업의 A'), '장 구성: ' + JSON.stringify(chs));
  assert(JSON.stringify(await run(page, 'return A.app.project.order.map((x) => A.app.chapters.get(x).title);')) === '["A"]', '열린 작품 순서');
  assert((await run(page, `return (await S.notesOf(arg)).length;`, id)) === 0, '백업에 없는 자료 제거');
  const t = await run(page, `return (await S.trashList()).map((x) => ({ kind: x.kind, title: x.title, n: x.bundle?.chapters?.length, id: x.id }));`);
  const before = t.find((x) => /덮어쓰기 전/.test(x.title));
  assert(before && before.n === 2, '덮어쓰기 전 안전본: ' + JSON.stringify(t));
  const back = await run(page, `const r = await S.restoreTrash(arg); return (await S.chaptersOf(r.project.id)).map((c) => c.title).sort();`, before.id);
  assert(JSON.stringify(back) === '["A","B"]', '안전본에서 B 회수: ' + back);
  // A의 덮어쓰기 전 원고는 버전 기록에도 남는다
  const snaps = await run(page, `const a = (await S.chaptersOf(arg))[0]; return (await S.snapshotsOf(a.id)).map((s) => s.label);`, id);
  assert(snaps.includes('덮어쓰기 전 이 기기 버전'), '버전 기록: ' + snaps);
  await ctx.close();
});

await test('F02 덮어쓰기 중 쓰기 실패: 기존 작품 전체가 그대로 남는다 (섞인 상태 없음)', async () => {
  const { ctx, page } = await boot();
  const { id } = await mkProject(page, [{ title: 'A', html: '<p>A 원본</p>' }, { title: 'B', html: '<p>B 원본</p>' }]);
  const b = await run(page, bundleOnlyA, { id });
  await page.evaluate(() => { window.__fail = { store: 'projects' }; }); // 마지막 단계에서 실패
  const err = await run(page, `try { await S.importBundle(arg, { mode: 'restore' }); return null; } catch (e) { return e.message; }`, b);
  await page.evaluate(() => { window.__fail = null; });
  assert(err, '오류가 나야 함');
  const chs = await run(page, `return (await S.chaptersOf(arg)).map((c) => c.title + ':' + c.html).sort();`, id);
  assert(JSON.stringify(chs) === JSON.stringify(['A:<p>A 원본</p>', 'B:<p>B 원본</p>']), '그대로: ' + JSON.stringify(chs));
  assert(!(await run(page, `return (await S.trashList()).length;`)), '휴지통에도 반쯤 쓴 것이 없음');
  await ctx.close();
});

await test('F02 잘못된 백업(중복 아이디·없는 장 참조·다른 작품과 겹치는 아이디·모르는 버전)은 아무것도 바꾸지 않는다', async () => {
  const { ctx, page } = await boot();
  const other = await run(page, `const p = await S.createProject('남의 작품', [{ title: 'X', html: '<p>X</p>' }]); return p;`);
  const { id } = await mkProject(page, [{ title: 'A', html: '<p>A 원본</p>' }, { title: 'B', html: '<p>B 원본</p>' }]);
  const base = await run(page, `return S.exportBundle(arg);`, id);
  const cases = {
    dup: { ...base, chapters: [base.chapters[0], base.chapters[0]] },
    missingRef: { ...base, project: { ...base.project, order: [...base.project.order, 'nope'] } },
    clash: { ...base, chapters: [...base.chapters, { id: other.order[0], title: '겹침', html: '<p>!</p>' }] },
    version: { ...base, version: 99 },
  };
  for (const [k, bad] of Object.entries(cases)) {
    const err = await run(page, `try { await S.importBundle(arg, { mode: 'restore' }); return null; } catch (e) { return e.message; }`, bad);
    assert(err, k + ' 거절');
  }
  const chs = await run(page, `return (await S.chaptersOf(arg)).length;`, id);
  assert(chs === 2, '작품 그대로');
  assert((await run(page, `return (await S.getChapter(arg)).html;`, other.order[0])) === '<p>X</p>', '남의 작품 그대로');
  await ctx.close();
});

await test('F02 사본 가져오기는 기존 작품과 다른 아이디를 쓴다', async () => {
  const { ctx, page } = await boot();
  const { id } = await mkProject(page, [{ title: 'A', html: '<p>A</p>' }, { title: 'B', html: '<p>B</p>' }]);
  const b = await run(page, `return S.exportBundle(arg);`, id);
  const r = await run(page, `const p = await S.importBundle(arg, { mode: 'copy' }); return { pid: p.id, ch: (await S.chaptersOf(p.id)).map((c) => c.id) };`, b);
  assert(r.pid !== id, '작품 아이디 다름');
  assert(r.ch.length === 2 && r.ch.every((x) => !b.chapters.some((c) => c.id === x)), '장 아이디 다름');
  assert((await run(page, `return (await S.chaptersOf(arg)).length;`, id)) === 2, '원래 작품 그대로');
  await ctx.close();
});

await test('F02 동기화 병합: 다른 기기에서 지운 장은 휴지통으로, 지운 뒤 이 기기에서 고친 장은 남는다', async () => {
  const { ctx, page } = await boot();
  const { id } = await mkProject(page, [{ title: 'A', html: '<p>A</p>' }, { title: 'B', html: '<p>B</p>' }, { title: 'C', html: '<p>C</p>' }]);
  const since = Date.now();
  await page.waitForTimeout(20);
  // C는 마지막 동기화 뒤 이 기기에서 고침
  await run(page, `const c = (await S.chaptersOf(arg)).find((x) => x.title === 'C'); c.html = '<p>C 고침</p>'; c.updated = Date.now(); await S.putChapter(c);`, id);
  const remote = await run(page, `const b = await S.exportBundle(arg); const a = b.chapters.find((c) => c.title === 'A'); return { ...b, project: { ...b.project, order: [a.id] }, chapters: [a] };`, id);
  await run(page, `await S.importBundle(arg.b, { mode: 'merge', since: arg.since });`, { b: remote, since });
  const left = await run(page, `return (await S.chaptersOf(arg)).map((c) => c.title).sort();`, id);
  assert(JSON.stringify(left) === '["A","C"]', '남은 장: ' + left);
  const order = await run(page, `return (await S.getProject(arg)).order.length;`, id);
  assert(order === 2, '순서에 C 포함');
  const tr = await run(page, `return (await S.trashList()).map((t) => t.title);`);
  assert(tr.includes('B'), '지운 B는 휴지통: ' + tr);
  await ctx.close();
});

// ---------------- F03 동기화 중 작품 전환 ----------------
// 흉내 서버: page.route로 /api 요청에 답한다. 지정한 요청은 풀어 줄 때까지 붙잡아 둔다.
async function fakeServer(page) {
  const files = new Map(); // id → {modifiedTime, size, body}
  const hold = { match: null, release: null, hit: null };
  let n = 0;
  await page.route('http://sync.test/api/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const m = u.pathname.match(/^\/api\/projects\/([^/]+)(\/info)?$/);
    const key = `${req.method()} ${u.pathname}`;
    if (hold.match && hold.match.test(key)) {
      hold.match = null;
      hold.hit?.();
      await new Promise((r) => { hold.release = r; });
    }
    if (u.pathname === '/api/ping') return route.fulfill({ json: { ok: true } });
    if (!m) return route.fulfill({ status: 404, json: {} });
    const id = decodeURIComponent(m[1]);
    if (m[2]) { const f = files.get(id); return f ? route.fulfill({ json: { id, modifiedTime: f.modifiedTime, size: f.size } }) : route.fulfill({ status: 404, json: { error: 'none' } }); }
    if (req.method() === 'PUT') {
      const body = req.postDataBuffer();
      const f = { modifiedTime: `${id}-remote-time-${++n}`, size: body.length, body };
      files.set(id, f);
      return route.fulfill({ json: { id, modifiedTime: f.modifiedTime, size: f.size } });
    }
    if (req.method() === 'GET') { const f = files.get(id); return route.fulfill({ status: 200, body: f.body, contentType: 'application/octet-stream' }); }
    return route.fulfill({ status: 405, json: {} });
  });
  return {
    files,
    holdNext(re) { return new Promise((r) => { hold.match = re; hold.hit = r; }); },
    release() { hold.release?.(); },
  };
}

for (const step of ['info', 'put']) {
  await test(`F03 동기화 응답(${step}) 대기 중 A→B 전환: B 작품 정보는 바뀌지 않고 A에만 기록된다`, async () => {
    const { ctx, page } = await boot({ syncTarget: 'server', syncServer: 'http://sync.test', autoSync: false });
    await page.evaluate(() => localStorage.setItem('nw-sync-code', 'test-code-1234'));
    const srv = await fakeServer(page);
    await run(page, `const SV = await import('/src/syncserver.js'); SV.configure('http://sync.test');`);
    const pb = await run(page, `const p = await S.createProject('B 작품', [{ title: 'B1', html: '<p>B 본문</p>' }]); return p.id;`);
    const { id: pa } = await mkProject(page, [{ title: 'A1', html: '<p>A 본문</p>' }], 'A 작품');
    await typeInto(page, '<p>A 고침</p>');
    const held = srv.holdNext(step === 'info' ? /^GET .*\/info$/ : /^PUT /);
    const syncing = run(page, 'return A.syncNow({ quiet: true });');
    await held;
    await run(page, 'return A.openProject(arg);', pb);
    srv.release();
    await syncing;
    await page.waitForTimeout(200);
    const B = await run(page, 'return S.getProject(arg);', pb);
    const Am = await run(page, 'return S.getProject(arg);', pa);
    assert(!B.srvSyncedAt && !B.srvSyncedSize, 'B는 그대로: ' + JSON.stringify({ t: B.srvSyncedAt, s: B.srvSyncedSize }));
    assert(String(Am.srvSyncedAt || '').startsWith(pa + '-remote-time'), 'A에 기록: ' + Am.srvSyncedAt);
    assert((await run(page, 'return A.app.project.id;')) === pb, '열린 작품은 B');
    assert((await run(page, `return (await S.chaptersOf(arg))[0].html;`, pb)) === '<p>B 본문</p>', 'B 본문 그대로');
    await ctx.close();
  });
}

await test('F03 받아 오기(pull) 대기 중 A→B 전환: 받은 내용은 A에만 들어가고 B 화면을 덮지 않는다', async () => {
  const { ctx, page } = await boot({ syncTarget: 'server', syncServer: 'http://sync.test', autoSync: false });
  await page.evaluate(() => localStorage.setItem('nw-sync-code', 'test-code-1234'));
  const srv = await fakeServer(page);
  await run(page, `const SV = await import('/src/syncserver.js'); SV.configure('http://sync.test');`);
  const pb = await run(page, `const p = await S.createProject('B 작품', [{ title: 'B1', html: '<p>B 본문</p>' }]); return p.id;`);
  const { id: pa } = await mkProject(page, [{ title: 'A1', html: '<p>A 본문</p>' }], 'A 작품');
  await run(page, 'return A.syncNow({ quiet: true });'); // 처음 올림
  // 다른 기기에서 A를 고쳐 올린 것처럼 서버 파일을 바꾼다
  const other = await run(page, `const b = S.packBundle(await S.exportBundle(arg)); b.chapters[0].html = '<p>다른 기기의 A</p>'; return JSON.stringify(b);`, pa);
  const f = srv.files.get(pa); srv.files.set(pa, { modifiedTime: pa + '-remote-time-other', size: other.length, body: Buffer.from(other) });
  const held = srv.holdNext(/^GET \/api\/projects\/[^/]+$/);
  const syncing = run(page, 'return A.syncNow({ quiet: true });');
  await held;
  await run(page, 'return A.openProject(arg);', pb);
  srv.release();
  await syncing;
  await page.waitForTimeout(300);
  assert((await run(page, 'return A.app.project.id;')) === pb, '열린 작품은 그대로 B');
  assert((await page.textContent('.ProseMirror')).includes('B 본문'), 'B 화면 그대로');
  assert((await run(page, `return (await S.chaptersOf(arg))[0].html;`, pa)).includes('다른 기기의 A'), 'A에 받은 내용');
  assert((await run(page, `return (await S.chaptersOf(arg))[0].html;`, pb)) === '<p>B 본문</p>', 'B 본문 그대로');
  void f;
  await ctx.close();
});

// ---------------- F04 모든 장 찾기 ----------------
const findUI = async (page, q, all = true) => {
  await page.keyboard.press('Control+f');
  await page.waitForSelector('#findbar:not([hidden])');
  if ((await page.isChecked('#findAllChapters')) !== all) await page.click('#findAllChapters');
  await page.fill('#findInput', q);
  await page.waitForTimeout(150);
};
const nextBtn = (page, dir = 'next') => page.click(`[data-find="${dir}"]`).then(() => page.waitForTimeout(250));
const curTitle = (page) => run(page, 'return A.app.chapters.get(A.app.cur).title;');

await test('F04 지금 장 0건·다른 장 1건: 다음을 누르면 그 장의 결과로 간다', async () => {
  const { ctx, page } = await boot();
  await mkProject(page, [{ title: 'A', html: '<p>사과 원본입니다.</p>' }, { title: 'B', html: '<p>사과와 배입니다.</p>' }]);
  await findUI(page, '와');
  assert(/다른 장 1/.test(await page.textContent('#findCount')), '개수 표시: ' + await page.textContent('#findCount'));
  await nextBtn(page);
  assert(await curTitle(page) === 'B', 'B장으로 이동');
  assert(await page.textContent('#findCount') === '1/1', '전체 기준 번호: ' + await page.textContent('#findCount'));
  const sel = await run(page, 'const { from, to } = A.app.editor.state.selection; return A.app.editor.state.doc.textBetween(from, to);');
  assert(sel === '와', '결과 선택: ' + sel);
  await ctx.close();
});

await test('F04 여러 장 여러 건: 정방향·역방향·끝에서 처음으로 돈다 (서식 경계·이모지 포함)', async () => {
  const { ctx, page } = await boot();
  await mkProject(page, [
    { title: 'A', html: '<p>고양이 🐱고양이</p>' },
    { title: 'B', html: '<p>없음</p>' },
    { title: 'C', html: '<p><strong>고</strong>양이와 <em>고양</em>이</p>' },
  ]);
  await findUI(page, '고양이');
  assert(/\/4$/.test(await page.textContent('#findCount')), '총 4건: ' + await page.textContent('#findCount'));
  const seen = [];
  for (let i = 0; i < 5; i++) { await nextBtn(page); seen.push(`${await curTitle(page)}:${await page.textContent('#findCount')}`); }
  assert(JSON.stringify(seen) === JSON.stringify(['A:2/4', 'C:3/4', 'C:4/4', 'A:1/4', 'A:2/4']), '정방향: ' + seen);
  const back = [];
  for (let i = 0; i < 3; i++) { await nextBtn(page, 'prev'); back.push(`${await curTitle(page)}:${await page.textContent('#findCount')}`); }
  assert(JSON.stringify(back) === JSON.stringify(['A:1/4', 'C:4/4', 'C:3/4']), '역방향: ' + back);
  await ctx.close();
});

// ---------------- F05 모든 장 바꾸기 ----------------
for (const startAt of ['A', 'B']) {
  await test(`F05 모든 장 바꾸기: 서식 경계를 넘는 낱말도 바뀐다 (지금 장 ${startAt})`, async () => {
    const { ctx, page } = await boot();
    const { order } = await mkProject(page, [{ title: 'A', html: '<p>사과 원본입니다.</p>' }, { title: 'B', html: '<p><strong>사</strong>과와 사과입니다.</p>' }]);
    if (startAt === 'B') await run(page, 'return A.openChapter(arg);', order[1]);
    await findUI(page, '사과');
    await page.fill('#replaceInput', '배');
    await page.click('[data-find="all"]'); await page.waitForTimeout(500);
    await run(page, 'return A.saveNow();');
    const html = await run(page, 'return Promise.all(arg.map(async (id) => (await S.getChapter(id)).html));', order);
    assert(html[0] === '<p>배 원본입니다.</p>', 'A: ' + html[0]);
    assert(!html[1].includes('사') && (html[1].match(/배/g) || []).length === 2, 'B: ' + html[1]);
    assert(html[1].includes('<strong>배</strong>'), 'B의 굵게 유지: ' + html[1]);
    await ctx.close();
  });
}

await test('F05 주석이 달린 낱말을 바꿔도 주석 표시가 남는다', async () => {
  const { ctx, page } = await boot();
  const { order } = await mkProject(page, [{ title: 'A', html: '<p>처음</p>' }, { title: 'B', html: '<p>그는 <span data-anno="n1">사과</span>를 먹었다.</p>' }]);
  await findUI(page, '사과'); await page.fill('#replaceInput', '배');
  await page.click('[data-find="all"]'); await page.waitForTimeout(500);
  const h = await run(page, 'return (await S.getChapter(arg)).html;', order[1]);
  assert(h.includes('배') && !h.includes('사과'), 'B 바뀜: ' + h);
  const hasAnno = await run(page, `return !!A.app.editor.schema.marks.anno || !!Object.keys(A.app.editor.schema.marks).find((k) => /anno/i.test(k));`);
  if (hasAnno) assert(/data-anno="n1"[^>]*>배/.test(h), '주석 유지: ' + h);
  await ctx.close();
});

// ---------------- F06 한 개 바꾸기는 글자 그대로 ----------------
await test('F06 바꿀 말은 HTML로 해석하지 않는다 (한 개·모두·모든 장이 같다)', async () => {
  const { ctx, page } = await boot();
  const samples = ['<b>배</b>', '<장면>', '&nbsp;', '&', '"따옴표\'', '역\\슬래시', '🍐'];
  for (const rep of samples) {
    await run(page, 'const p = await S.createProject("Q", [{ title: "A", html: "<p>사과 사과</p>" }, { title: "B", html: "<p>사과</p>" }]); await A.openProject(p.id);');
    await findUI(page, '사과');
    await page.fill('#replaceInput', rep);
    await nextBtn(page);
    await page.click('[data-find="one"]'); await page.waitForTimeout(200);
    const one = await page.textContent('.ProseMirror');
    assert(one === `사과 ${rep}` || one === `${rep} 사과`, `한 개(${rep}): ${one}`);
    assert(!(await page.$('.ProseMirror strong')), `굵게가 생기면 안 됨(${rep})`);
    await page.click('[data-find="all"]'); await page.waitForTimeout(400);
    const allTxt = await page.textContent('.ProseMirror');
    assert(allTxt === `${rep} ${rep}`, `모두(${rep}): ${allTxt}`);
    const b = await run(page, 'const id = A.app.project.order[1]; const d = document.createElement("div"); d.innerHTML = (await S.getChapter(id)).html; return d.textContent;');
    assert(b === rep, `모든 장(${rep}): ${b}`);
  }
  await ctx.close();
});

// ---------------- F07 겹친 대화상자 ----------------
await test('F07 내보내기 → 쪽 설정(취소·Esc·적용·✕) 뒤에도 내보내기 창과 입력값이 남고, 내보내기는 한 번만 된다', async () => {
  const { ctx, page } = await boot();
  await mkProject(page, [{ title: 'A', html: '<p>본문</p>' }]);
  const exp = run(page, `const F = await import('/src/features.js'); return F.showExport();`);
  await page.waitForSelector('#dlg[open] [name=author]');
  await page.fill('#dlg [name=author]', 'QA author');
  await page.selectOption('#dlg [name=fmt]', 'txt');
  await page.uncheck('#dlg [name=titlePage]');
  const back = async (how) => {
    await page.click('#dlg [data-open-setup]');
    await page.waitForSelector('#dlg[open] h2:has-text("쪽 설정")');
    if (how === 'esc') await page.keyboard.press('Escape');
    else if (how === 'x') await page.click('#dlg .dlg-head button[value=close]');
    else await page.click(`#dlg .dlg-foot button[value=${how}]`);
    await page.waitForTimeout(250);
    assert(await page.isVisible('#dlg[open] h2:has-text("내보내기")'), `${how} 뒤 내보내기 창으로 돌아옴`);
    assert(await page.inputValue('#dlg [name=author]') === 'QA author', `${how} 뒤 지은이 유지`);
    assert(await page.inputValue('#dlg [name=fmt]') === 'txt', `${how} 뒤 형식 유지`);
    assert(!(await page.isChecked('#dlg [name=titlePage]')), `${how} 뒤 표지 선택 유지`);
  };
  for (const how of ['close', 'esc', 'x', 'ok', 'close']) await back(how);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.click('#dlg .dlg-foot button[value=ok]');
  await exp;
  await page.waitForTimeout(600);
  assert(downloads === 1, '내보내기 한 번: ' + downloads);
  assert(!(await page.isVisible('#dlg[open]')), '창이 닫힘');
  assert(await run(page, 'return A.app.settings.author;') === 'QA author', '지은이 저장');
  await ctx.close();
});

await test('F07 대화상자 결과는 확인·취소·프로그램 닫기·바뀜 어느 길이든 한 번만 정해진다', async () => {
  const { ctx, page } = await boot();
  const r = await run(page, `
    const U = await import('/src/ui.js');
    const out = [];
    const a = U.dialog({ title: 'a', body: '', buttons: [{ label: 'ok', value: 'ok', primary: true }] }).then((x) => out.push('a:' + x.value));
    document.querySelector('#dlg .dlg-foot button[value=ok]').click();
    await a;
    const b = U.dialog({ title: 'b', body: '' }).then((x) => out.push('b:' + x.value));
    document.getElementById('dlg').close('close');
    await b;
    const c = U.dialog({ title: 'c', body: '' }).then((x) => out.push('c:' + x.value));
    document.getElementById('dlg').close('close');
    const d = U.dialog({ title: 'd', body: '', buttons: [{ label: 'ok', value: 'ok' }] }).then((x) => out.push('d:' + x.value));
    await c;
    await new Promise((r) => setTimeout(r, 50));
    document.querySelector('#dlg .dlg-foot button[value=ok]').click();
    await d;
    await new Promise((r) => setTimeout(r, 50));
    return { out, open: document.getElementById('dlg').open };`);
  assert(JSON.stringify(r.out) === JSON.stringify(['a:ok', 'b:close', 'c:close', 'd:ok']), '결과: ' + JSON.stringify(r.out));
  assert(!r.open, '모두 닫힘');
  await ctx.close();
});

// ---------------- 쪽 보기 ----------------
const PARA = '모든 것이 나였습니다. 나에 대한 일은 어떤 것도 나와 무관하지 않았습니다. 시야에 닿는 곳마다 내가 있었습니다. ';
const caretY = (page) => run(page, 'const v = A.app.editor.view; return Math.round(v.coordsAtPos(v.state.selection.head).top - v.dom.getBoundingClientRect().top);');

await test('쪽 보기: 위아래 화살표가 쪽 사이를 한 줄씩 넘는다 (맨 끝·맨 앞으로 튀지 않음)', async () => {
  const { ctx, page } = await boot({ pageView: true });
  await run(page, `A.app.editor.commands.setContent(Array.from({ length: 12 }, (_, i) => '<p>' + i + ' ' + arg.repeat(4) + '</p>').join('')); A.app.editor.chain().focus().setTextSelection(3).run();`, PARA);
  await page.waitForTimeout(800);
  let prev = await caretY(page);
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('ArrowDown'); await page.waitForTimeout(20);
    const y = await caretY(page);
    assert(y > prev && y - prev < 400, `아래 ${i}: ${prev} → ${y}`);
    prev = y;
  }
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(20);
    const y = await caretY(page);
    assert(y < prev && prev - y < 400, `위 ${i}: ${prev} → ${y}`);
    prev = y;
  }
  await ctx.close();
});

await test('쪽 보기: 쪽 마지막 줄에서 한글을 조합하는 동안에도 넘친 글자가 쪽 아래 여백에 보이지 않고 바로 다음 쪽에 놓인다', async () => {
  const { ctx, page } = await boot({ pageView: true });
  await run(page, `A.app.editor.commands.setContent('<p>' + arg.repeat(30) + '</p>');`, PARA);
  await page.waitForTimeout(800);
  // 1쪽 마지막 줄 끝 두 글자 앞에 커서, 화면을 그릴 때마다 커서 높이를 적는다
  await run(page, `const v = A.app.editor.view; const g = document.querySelector('#pvFloats .gapf').getBoundingClientRect();
    let lo = 1, hi = v.state.doc.content.size - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (v.coordsAtPos(m).top >= g.bottom - 2) hi = m; else lo = m + 1; }
    A.app.editor.chain().focus().setTextSelection(lo - 2).run();
    window.__gap = [g.top - v.dom.getBoundingClientRect().top, g.bottom - v.dom.getBoundingClientRect().top];
    window.__ys = []; const tick = () => { const s = getSelection(); if (s.rangeCount) window.__ys.push(s.getRangeAt(0).getBoundingClientRect().bottom - v.dom.getBoundingClientRect().top); window.__raf = requestAnimationFrame(tick); }; tick();`);
  const cdp = await ctx.newCDPSession(page);
  for (const s of [['ㄱ', '가', '각'], ['ㄴ', '나', '난'], ['ㄷ', '다', '닫'], ['ㄹ', '라', '랄'], ['ㅁ', '마', '맘'], ['ㅂ', '바', '밥'], ['ㄱ', '가', '각'], ['ㄴ', '나', '난']]) {
    for (const t of s) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(50); }
    await cdp.send('Input.insertText', { text: s[2] });
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return { ys: window.__ys, gap: window.__gap }; });
  const bad = r.ys.filter((y) => y > r.gap[0] + 2 && y < r.gap[1] - 2);
  assert(r.ys.some((y) => y > r.gap[1]), '다음 쪽으로 넘어가지 않음');
  assert(!bad.length, `쪽 사이 여백에 그려진 프레임 ${bad.length}개 (여백 ${r.gap.map(Math.round)})`);
  const txt = await run(page, 'return A.app.editor.state.doc.textContent;');
  assert(txt.includes('각난닫랄맘밥각난'), '조합한 글자가 그대로 들어가야 함');
  await ctx.close();
});

await test('쪽 보기(폭 맞춤): 교정 여백이 생겼다 없어져도 쪽 크기가 바뀌지 않는다', async () => {
  const { ctx, page } = await boot({ pageView: true, proof: true });
  await page.setViewportSize({ width: 1600, height: 900 });
  await run(page, `A.app.editor.commands.setContent('<p>바른 문장입니다.</p>');`);
  await page.waitForTimeout(1000);
  const w0 = await page.evaluate(() => getComputedStyle(document.getElementById('paper')).getPropertyValue('--pv-w'));
  await run(page, `A.app.editor.commands.setContent('<p>그는 몇일 동안 되요 라고 말했다 .</p>', { emitUpdate: true });`);
  await page.waitForTimeout(1500);
  const rail = await page.evaluate(() => document.body.classList.contains('has-proof-rail'));
  const w1 = await page.evaluate(() => getComputedStyle(document.getElementById('paper')).getPropertyValue('--pv-w'));
  assert(w0 === w1, `쪽 폭 ${w0} → ${w1} (교정 여백 ${rail})`);
  await ctx.close();
});

// ---------------- 유의어 창 ----------------
await test('유의어 창: 구절 통째로 바꾸기는 고른 구절을 새로 쓴 표현으로 바꾸고, 서식을 지킨다 (AI는 흉내)', async () => {
  const { ctx, page } = await boot({ synProvider: 'openai', ai: { provider: 'openai', models: { openai: 'gpt-test-mini' } } });
  const asked = [];
  await ctx.route('https://api.openai.com/**', (r) => {
    if (r.request().method() !== 'POST') return r.fulfill({ json: { data: [{ id: 'gpt-test-mini' }] } });
    const c = JSON.parse(r.request().postData()).messages.map((m) => m.content).join('\n');
    const phrase = c.includes('통째로');
    asked.push((phrase ? 'phrase:' : 'word:') + c.match(/대상: «(.*?)»/)[1]);
    r.fulfill({ json: { choices: [{ message: { content: JSON.stringify(phrase ? { items: [{ word: '통닭의 아름다움' }, { word: '닭튀김이 지닌 멋', note: '풀어 씀' }] } : { lemma: '미학', items: [{ word: '아름다움' }], antonyms: [] }) } }] } });
  });
  await page.evaluate(() => localStorage.setItem('nw-openai-key', 'sk-test'));
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(600);
  await run(page, `A.app.editor.commands.setContent('<p>오늘의 주제는 <em>치킨의 미학</em>이다.</p>');`);
  await run(page, `(await import('/src/synonym.js')).toggleSynonyms(true);`);
  await page.click('#synPanel [data-mode=phrase]');
  await run(page, `const ed = A.app.editor; let f; ed.state.doc.descendants((n, p) => { if (n.isText && n.text.includes('치킨의 미학')) f = p + n.text.indexOf('치킨의 미학'); }); ed.chain().focus().setTextSelection({ from: f, to: f + 6 }).run();`);
  await page.waitForSelector('#synPanel .syn-item[data-w="통닭의 아름다움"]');
  await page.click('#synPanel .syn-item[data-w="통닭의 아름다움"]');
  await page.waitForTimeout(300);
  const html = await run(page, 'return A.app.editor.getHTML();');
  assert(html === '<p>오늘의 주제는 <em>통닭의 아름다움</em>이다.</p>', html);
  assert(asked[0] === 'phrase:치킨의 미학', asked.join());
  await ctx.close();
});

// ---------------- 단축키 ----------------
await test('단축키 설정: 한/영·한자 키나 글자만 눌러도 키 받기가 끝나지 않고, 이어서 누른 조합이 칸에 들어가 저장·동작한다', async () => {
  const { ctx, page } = await boot();
  await mkProject(page, [{ title: 'A', html: '<p>글</p>' }]);
  await page.evaluate(() => document.querySelector('[data-act=keys]').click());
  await page.waitForSelector('#dlg[open] .kb-list');
  const btn = '#dlg .kb-row[data-id=synonyms] [data-rec]';
  await page.click(btn);
  // 한글 자판의 오른쪽 Alt(한/영)
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'HangulMode', code: 'AltRight', bubbles: true, cancelable: true })));
  assert((await page.textContent(btn)).includes('키를 누르세요'), '한/영 키에서 키 받기가 끝남');
  assert((await page.textContent('#dlg .kb-row[data-id=synonyms] .kb-warn')).includes('왼쪽'), '안내가 그 줄에 보여야 함');
  await page.keyboard.press('U');
  assert((await page.textContent(btn)).includes('키를 누르세요'), '글자만 눌렀을 때 키 받기가 끝남');
  await page.keyboard.press('Control+Alt+U');
  assert((await page.textContent(btn)).replace(/\s/g, '') === 'Ctrl+Alt+U', await page.textContent(btn));
  await pressDialog(page, 'ok');
  await page.waitForTimeout(200);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+Alt+U');
  await page.waitForTimeout(300);
  assert(await page.isVisible('#synPanel'), '새 키로 유의어 창이 열려야 함');
  await ctx.close();
});

// ---------------- 내보내기 ----------------
await test('내보내기: 처음에는 표지(작품 제목)·장 제목 없이, 고른 것은 다음에도 남는다 (txt·md·html·docx·hwpx·doc)', async () => {
  const { ctx, page } = await boot();
  await mkProject(page, [{ title: '0장', html: '<p>첫 장 본문</p>' }, { title: '1장', html: '<p>둘째 장 본문</p>' }], '작품제목가나');
  const exportAs = async (fmt, tweak = '') => {
    await page.evaluate(() => { (async () => (await import('/src/features.js')).showExport())(); });
    await page.waitForSelector('#dlg[open] select[name=fmt]');
    await page.selectOption('#dlg select[name=fmt]', fmt);
    if (tweak) await page.click(`#dlg input[name=${tweak}]`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlg .dlg-foot button[value="ok"]')]);
    const buf = await (await import('node:fs/promises')).readFile(await dl.path());
    if (fmt === 'docx' || fmt === 'hwpx') {
      const JSZip = (await import('jszip')).default;
      const z = await JSZip.loadAsync(buf);
      let t = '';
      for (const n of Object.keys(z.files)) if (/document\.xml$|section0\.xml$/.test(n)) t += await z.file(n).async('string');
      return t.replace(/<[^>]+>/g, ' ');
    }
    const s = buf.toString('utf8');
    // RTF는 한글을 \uNNNN? 꼴로 적는다
    return fmt === 'doc' ? s.replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((+n + 65536) % 65536)) : s;
  };
  for (const fmt of ['txt', 'md', 'html', 'docx', 'hwpx', 'doc']) {
    const t = await exportAs(fmt);
    assert(t.includes('첫 장 본문') && t.includes('둘째 장 본문'), fmt + ': 본문이 빠짐');
    assert(!/(^|[^가-힣])[01]장/.test(t.replace(/<title>.*?<\/title>/, '')), fmt + ': 장 제목이 들어감');
    const body = fmt === 'html' ? t.replace(/<title>.*?<\/title>/, '') : fmt === 'doc' ? t.replace(/\{\\info.*?\}\}/, '') : t;
    assert(!body.includes('작품제목가나'), fmt + ': 작품 제목이 들어감');
  }
  // 장 제목을 켜면 다음에도 켜져 있다
  const t = await exportAs('txt', 'chapterTitles');
  assert(t.includes('0장') && t.includes('1장'), '장 제목을 켰는데 없음');
  await page.evaluate(() => { (async () => (await import('/src/features.js')).showExport())(); });
  await page.waitForSelector('#dlg[open] input[name=chapterTitles]');
  assert(await page.isChecked('#dlg input[name=chapterTitles]'), '고른 것이 남아야 함');
  assert(!(await page.isChecked('#dlg input[name=titlePage]')), '표지는 계속 꺼져 있어야 함');
  await ctx.close();
});

export { browser, boot, run, mkProject, typeInto, pressDialog, test, assert, results };
if (!process.env.NO_CLOSE) {
  await browser.close();
  const fail = results.filter((r) => r[1] !== '통과');
  console.log(`\n${results.length - fail.length}/${results.length} 통과`);
  process.exitCode = fail.length ? 1 : 0;
}
