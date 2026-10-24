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
async function fakeServer(page, files = new Map(), devs = new Map()) { // files: id → {modifiedTime, size, body}
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
    if (u.pathname === '/api/projects') return route.fulfill({ json: [...files].map(([id, f]) => ({ id, name: id, modifiedTime: f.modifiedTime, size: f.size })) });
    const dm = u.pathname.match(/^\/api\/devices(?:\/([^/]+))?$/);
    if (dm) {
      if (req.method() === 'PUT') { const d = { ...JSON.parse(req.postData()), lastSync: new Date().toISOString() }; devs.set(d.id, d); return route.fulfill({ json: d }); }
      if (req.method() === 'DELETE') { devs.delete(decodeURIComponent(dm[1])); return route.fulfill({ json: { ok: true } }); }
      return route.fulfill({ json: [...devs.values()] });
    }
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
    files, devs,
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
    await page.click('[data-find="all"]'); await pressDialog(page, 'ok'); await page.waitForTimeout(500);
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
  await page.click('[data-find="all"]'); await pressDialog(page, 'ok'); await page.waitForTimeout(500);
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
    await page.click('[data-find="all"]'); await pressDialog(page, 'ok'); await page.waitForTimeout(400);
    const allTxt = await page.textContent('.ProseMirror');
    assert(allTxt === `${rep} ${rep}`, `모두(${rep}): ${allTxt}`);
    const b = await run(page, 'const id = A.app.project.order[1]; const d = document.createElement("div"); d.innerHTML = (await S.getChapter(id)).html; return d.textContent;');
    assert(b === rep, `모든 장(${rep}): ${b}`);
  }
  await ctx.close();
});

await test('바꾸기 되돌리기: 모두 바꾸기는 한 번 더 묻고(취소하면 그대로), 바꾼 뒤 되돌리기로 모든 장이 돌아온다', async () => {
  const { ctx, page } = await boot();
  const { order } = await mkProject(page, [{ title: 'A', html: '<p>사과 <strong>사과</strong></p>' }, { title: 'B', html: '<p>사과와 배</p>' }, { title: 'C', html: '<p>없음</p>' }]);
  await findUI(page, '사과'); await page.fill('#replaceInput', '감');
  await page.click('[data-find="all"]');
  await page.waitForSelector('#dlg[open]');
  const msg = await page.textContent('#dlg');
  assert(/정말 바꾸시겠습니까/.test(msg) && /2개 장/.test(msg) && /3곳/.test(msg), '확인 문구: ' + msg);
  await pressDialog(page, 'close'); await page.waitForTimeout(200);
  assert(await page.textContent('.ProseMirror') === '사과 사과', '취소하면 그대로');
  assert(await page.isDisabled('#findUndo'), '되돌릴 것 없음');
  await page.click('[data-find="all"]'); await pressDialog(page, 'ok'); await page.waitForTimeout(500);
  assert(await page.textContent('.ProseMirror') === '감 감', '바뀜');
  assert(/되돌리기/.test(await page.textContent('#toast')), '알림에 되돌리기 단추');
  await page.click('#findUndo'); await page.waitForTimeout(400);
  assert(await page.textContent('.ProseMirror') === '사과 사과', 'A 되돌림: ' + await page.textContent('.ProseMirror'));
  assert(await page.$('.ProseMirror strong'), 'A 굵게 유지');
  const b = await run(page, 'return (await S.getChapter(arg)).html;', order[1]);
  assert(b === '<p>사과와 배</p>', 'B 되돌림: ' + b);
  // 한 개 바꾸기 → 되돌리기 (Ctrl+Z로 되돌린 것도 다시 살릴 수 있다)
  await findUI(page, '사과'); await page.fill('#replaceInput', '감'); await nextBtn(page);
  await page.click('[data-find="one"]'); await page.waitForTimeout(200);
  assert(/감/.test(await page.textContent('.ProseMirror')), '한 개 바뀜');
  await page.click('#findUndo'); await page.waitForTimeout(300);
  assert(await page.textContent('.ProseMirror') === '사과 사과', '한 개 되돌림: ' + await page.textContent('.ProseMirror'));
  // 바꾼 뒤 손으로 고친 장은 덮어쓰지 않는다
  await page.click('[data-find="all"]'); await pressDialog(page, 'ok'); await page.waitForTimeout(500);
  await run(page, 'const c = A.app.chapters.get(arg); c.html = "<p>감와 배 그리고 새 글</p>"; await S.putChapter(c);', order[1]);
  await page.click('#findUndo'); await page.waitForTimeout(400);
  assert(await page.textContent('.ProseMirror') === '사과 사과', 'A는 되돌림');
  assert((await run(page, 'return (await S.getChapter(arg)).html;', order[1])).includes('새 글'), 'B의 새 글은 남음');
  assert(/B/.test(await page.textContent('#toast')), '그대로 둔 장 알림: ' + await page.textContent('#toast'));
  await ctx.close();
});

await test('찾기 화면: 치는 동안 첫 결과를 보여 주고, Enter는 둘째로, 이미 보이는 결과는 화면을 밀지 않는다', async () => {
  const { ctx, page } = await boot();
  const paras = Array.from({ length: 60 }, (_, i) => `<p>${i + 1}번째 문단. ${i === 30 ? '고양이 하나 고양이 둘. ' : ''}${'가나다라마바사 '.repeat(10)}</p>`).join('');
  await mkProject(page, [{ title: 'A', html: paras }]);
  const top = () => page.evaluate(() => Math.round(document.querySelector('.paper-scroll').scrollTop));
  await findUI(page, '고양이'); await page.waitForTimeout(500);
  const t1 = await top();
  assert(t1 > 300 && await page.textContent('#findCount') === '1/2', `치면 첫 결과로: ${t1} ${await page.textContent('#findCount')}`);
  await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  assert(await page.textContent('#findCount') === '2/2', '둘째: ' + await page.textContent('#findCount'));
  assert(Math.abs(await top() - t1) < 2, `같은 화면의 결과는 그대로: ${t1} → ${await top()}`);
  await ctx.close();
});

await test('유의어 사전: 커서 낱말의 기본형을 찾아 뜻풀이·유의어·반의어·예문을 보여 주고, 누르면 원고 낱말을 조사까지 맞춰 바꾼다', async () => {
  const { ctx, page } = await boot();
  await mkProject(page, [{ title: 'A', html: '<p>그는 너무 기뻤다. 거짓말을 했다. 마음이 흐뭇한 날.</p>' }]);
  const body = () => page.textContent('#thPanel .th-body');
  // 활용형 → 기본형, 반의어·뜻풀이·예문
  await run(page, 'A.app.editor.commands.setTextSelection(7);');
  await page.keyboard.press('Control+Shift+U');
  await page.waitForFunction(() => /기쁘다/.test(document.querySelector('#thPanel .th-body')?.textContent || ''));
  let t = await body();
  assert(/‘기뻤다’의 기본형/.test(t) && /반의어\s*슬프다/.test(t) && /흐뭇하다/.test(t) && /뜻풀이/.test(t) && /예문/.test(t), '기쁘다: ' + t.slice(0, 300));
  // 이름씨+조사: 유의어를 누르면(↵) ‘거짓말을’ → ‘거짓부리를’
  await run(page, 'A.app.editor.commands.setTextSelection(13);');
  await page.click('#thPanel .th-cur');
  await page.waitForFunction(() => /‘거짓말을’의 기본형/.test(document.querySelector('#thPanel .th-body')?.textContent || ''));
  t = await body();
  assert(/유의어/.test(t) && /거짓부리/.test(t), '거짓말 유의어: ' + t.slice(0, 300));
  await page.locator('#thPanel .th-chip:has(button[data-go="거짓부리"]) .th-rep').first().click();
  await page.waitForTimeout(200);
  assert(/거짓부리를 했다/.test(await page.textContent('.ProseMirror')), '바꿈: ' + await page.textContent('.ProseMirror'));
  // ‘…하다’끼리는 활용형도 바꾼다: 흐뭇한 → 흡족한
  await run(page, 'const d = A.app.editor.state.doc.textContent; A.app.editor.commands.setTextSelection(d.indexOf("흐뭇") + 2);');
  await page.click('#thPanel .th-cur');
  await page.waitForFunction(() => /‘흐뭇한’의 기본형/.test(document.querySelector('#thPanel .th-body')?.textContent || ''));
  await page.locator('#thPanel .th-chip:has(button[data-go="흡족하다"]) .th-rep').first().click();
  await page.waitForTimeout(200);
  assert(/흡족한 날/.test(await page.textContent('.ProseMirror')), '하다 활용 바꿈: ' + await page.textContent('.ProseMirror'));
  // 낱말을 눌러 찾아 들어가기 · 뒤로 · 책갈피 · 최근
  await page.click('#thPanel button[data-go="흡족하다"]');
  await page.waitForFunction(() => /^흡족하다/.test(document.querySelector('#thPanel .th-title')?.textContent.trim() || ''));
  await page.click('#thPanel .th-star');
  await page.click('#thPanel .th-back');
  await page.waitForFunction(() => /^흐뭇하다/.test(document.querySelector('#thPanel .th-title')?.textContent.trim() || ''));
  await page.click('#thPanel [data-tab="marks"]');
  assert(/흡족하다/.test(await body()), '책갈피');
  await page.click('#thPanel [data-tab="recent"]');
  assert(/흐뭇하다/.test(await body()) && /기쁘다/.test(await body()), '최근: ' + await body());
  // 직접 치기 · 자동 완성 · 없는 말
  await page.click('#thPanel [data-tab="look"]');
  await page.fill('#thPanel .th-q', '아름다');
  await page.waitForSelector('#thPanel .th-sug:not([hidden]) button');
  assert((await page.textContent('#thPanel .th-sug')).includes('아름답다'), '자동 완성');
  await page.fill('#thPanel .th-q', '쀍쀍'); await page.press('#thPanel .th-q', 'Enter');
  await page.waitForFunction(() => /찾지 못했어요/.test(document.querySelector('#thPanel .th-body')?.textContent || ''));
  // 낱말 맞히기
  await page.click('#thPanel [data-tab="quiz"]');
  await page.waitForSelector('#thPanel .th-quiz-q');
  await page.click('#thPanel [data-quiz="give"]');
  assert(/정답은/.test(await body()), '정답 보기');
  await ctx.close();
});

await test('유의어 사전: 활용형·조사 붙은 말에서 기본형을 찾는다 (애매하면 다른 후보에 든다)', async () => {
  const { ctx, page } = await boot();
  const cases = { 기뻤다: '기쁘다', 걸었다: '걷다', 예쁜: '예쁘다', 더워서: '덥다', 불러: '부르다', 들었다: '듣다', 지었다: '짓다', 파란: '파랗다', 갔다: '가다', 했다: '하다', 마셨다: '마시다', 봤다: '보다', 바다를: '바다', 사과를: '사과', 아름다운: '아름답다', 쓸쓸한: '쓸쓸하다', 살았다: '살다', 몰라: '모르다', 흘렀다: '흐르다', 웃으며: '웃다', 하얀: '하얗다', 그랬다: '그렇다', 잡혔다: '잡히다', 서러웠다: '서럽다', 도와: '돕다', 나았다: '낫다', 추웠다: '춥다', 써서: '쓰다', 깨달았다: '깨닫다', 물었다: '묻다', 아팠다: '아프다', 고요했다: '고요하다', 사람들은: '사람', 그녀에게: '그녀', 하늘이었다: '하늘', 기다렸다: '기다리다', 건넸다: '건네다' };
  const out = await run(page, `const T = await import('/src/thesaurus.js'); const r = {}; for (const f of arg) { const x = await T.find(f); r[f] = x ? [x.key, ...(x.alt || [])] : []; } return r;`, Object.keys(cases));
  const bad = Object.entries(cases).filter(([f, e]) => !out[f].includes(e)).map(([f, e]) => `${f}→${out[f].join('/')}(기대 ${e})`);
  assert(!bad.length, bad.join(', '));
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

await test('쪽 보기: 쪽 번호를 작품 전체로 이어 매기면 앞 장들의 쪽 수만큼 이어지고, 장 끝 줄도 쪽 아래 여백에 놓이지 않는다', async () => {
  const { ctx, page } = await boot({ pageView: true });
  const para = '<p>' + PARA.repeat(30) + '</p>';
  const ids = (await mkProject(page, [{ title: '1장', html: para }, { title: '2장', html: para + para }, { title: '3장', html: '<p>짧은 장</p>' }])).order;
  const real = [];
  for (const id of ids) {
    await run(page, 'await A.openChapter(arg);', id);
    await page.waitForTimeout(700);
    real.push(await page.$$eval('#sheets .sheet', (e) => e.length));
    // 마지막 줄 아래 끝이 그 쪽 본문 칸(띄움 기둥의 본문 높이) 안에 있어야 한다
    const over = await page.evaluate(() => {
      const d = document.querySelector('#editorHost .ProseMirror'); const b = d.getBoundingClientRect().top;
      const bottom = d.lastElementChild.getBoundingClientRect().bottom - b;
      const f = [...document.querySelectorAll('#pvFloats .gapf')].map((g) => [g.getBoundingClientRect().top - b, g.getBoundingClientRect().bottom - b]);
      return f.some(([t, u]) => bottom > t + 1 && bottom < u) || (f.length && bottom > f[f.length - 1][1] + (f[0][0]) + 1);
    });
    assert(!over, '장 끝 줄이 쪽 아래 여백에 있음');
  }
  await page.selectOption('#pvNumSel', 'all');
  await page.waitForTimeout(900);
  const nos = await page.$$eval('#sheets .pno', (e) => e.map((x) => +x.textContent));
  assert(nos[0] === real[0] + real[1] + 1, `3장 첫 쪽 번호 ${nos[0]} (앞 장 ${real})`);
  assert((await page.textContent('#pvStat')).includes(`전체 ${real[0] + real[1] + real[2]}쪽`), await page.textContent('#pvStat'));
  await run(page, 'await A.openChapter(arg);', ids[1]);
  await page.waitForTimeout(900);
  const nos2 = await page.$$eval('#sheets .pno', (e) => e.map((x) => +x.textContent));
  assert(nos2[0] === real[0] + 1 && nos2.length === real[1], `2장 쪽 번호 ${nos2}`);
  await page.selectOption('#pvNumSel', 'ch');
  await page.waitForTimeout(300);
  assert((await page.$$eval('#sheets .pno', (e) => +e[0].textContent)) === 1, '장마다로 돌리면 1부터');
  await ctx.close();
});

await test('쪽 보기: 아주 긴 장(수십 쪽)을 처음 열어도 모든 쪽 사이가 나뉘고 끝 줄이 마지막 쪽 칸 안에 든다', async () => {
  const { ctx, page } = await boot({ pageView: true });
  const para = '<p>' + PARA.repeat(30) + '</p>';
  const ids = (await mkProject(page, [{ title: '짧은 장', html: '<p>짧다</p>' }, { title: '긴 장', html: para.repeat(25) }])).order;
  await page.waitForTimeout(500);
  await run(page, 'await A.openChapter(arg);', ids[1]);
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const d = document.querySelector('#editorHost .ProseMirror'); const b = d.getBoundingClientRect().top;
    const gaps = [...document.querySelectorAll('#pvFloats .gapf')].map((g) => [g.getBoundingClientRect().top - b, g.getBoundingClientRect().bottom - b]);
    const sheets = document.querySelectorAll('#sheets .sheet').length;
    const bottom = d.lastElementChild.getBoundingClientRect().bottom - b;
    const sheetH = parseFloat(getComputedStyle(document.getElementById('paper')).getPropertyValue('--pv-h'));
    const pitch = gaps.length > 1 ? gaps[1][0] - gaps[0][0] : 0;
    // 마지막 쪽 본문 칸 끝 = 마지막 띄움 아래 끝 + 본문 높이(첫 띄움 윗선)
    const lastBodyEnd = (gaps.length ? gaps[gaps.length - 1][1] : 0) + (gaps.length ? gaps[0][0] : sheetH);
    return { gaps: gaps.length, sheets, bottom, lastBodyEnd, pitch };
  });
  assert(r.sheets > 30, '쪽 수 ' + r.sheets);
  assert(r.gaps === r.sheets - 1, `쪽 ${r.sheets}개인데 쪽 사이 띄움 ${r.gaps}개`);
  assert(r.bottom <= r.lastBodyEnd + 1, `끝 줄 ${Math.round(r.bottom)} > 마지막 쪽 본문 끝 ${Math.round(r.lastBodyEnd)}`);
  await ctx.close();
});

await test('Word 내보내기: 어절 단위 쪽 설정이면 한글 단어 잘림 허용을 끄고(기본 문단 wordWrap=1), 글자 단위면 문단마다 켠다', async () => {
  const { ctx, page } = await boot();
  const xml = async (breakWord) => run(page, `
    const io = await import('/src/io/index.js'); const L = { ...(await import('/src/layout.js')).layoutOf(), breakWord: arg };
    const out = await io.exportBook('docx', { title: 'T', chapters: [{ title: '1', html: '<p>가시는 재가 되어도 남아있는 독성 때문에</p>' }] }, { layout: L, titlePage: false, chapterTitles: false });
    const u = new Uint8Array(await out.blob.arrayBuffer()); let t = ''; for (const x of u) t += String.fromCharCode(x); return btoa(t);`, breakWord)
    .then(async (b64) => { const z = await (await import('jszip')).default.loadAsync(Buffer.from(b64, 'base64')); return { doc: await z.file('word/document.xml').async('string'), sty: await z.file('word/styles.xml').async('string') }; });
  const w = await xml('word');
  assert(/<w:pPrDefault><w:pPr><w:wordWrap w:val="1"\/>/.test(w.sty), '기본 문단에 wordWrap=1 없음');
  assert(!w.doc.includes('w:wordWrap w:val="0"'), '어절 단위인데 단어 잘림 허용이 켜짐');
  const c = await xml('char');
  assert(c.doc.includes('<w:wordWrap w:val="0"/>'), '글자 단위인데 단어 잘림 허용이 꺼짐');
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

// ---------------- 낭독 ----------------
// 흉내 음성: 24kHz 16비트 무음 WAV
const fakeWav = (secs) => {
  const n = Math.round(secs * 24000) * 2, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b.toString('base64');
};
// 구글 API 흉내: 음성(Gemini·Chirp)과 글 AI(시점·대사 판정·캐스팅)
async function mockGoogle(ctx, { secs = 1, pov = { pov: '1인칭', narrator: '민준', gender: '남' } } = {}) {
  const log = { tts: [], cloud: [], ask: [] };
  await ctx.route('https://generativelanguage.googleapis.com/**', (r) => {
    const url = r.request().url();
    const body = r.request().postData() ? JSON.parse(r.request().postData()) : null;
    if (url.includes('/interactions')) {
      log.tts.push(body);
      return r.fulfill({ json: { outputs: [{ type: 'audio', mime_type: 'audio/wav', data: fakeWav(secs) }] } });
    }
    if (url.includes('/models?')) return r.fulfill({ json: { models: [{ name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-9-custom-tts', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] }] } });
    const prompt = body.contents[0].parts[0].text;
    log.ask.push({ model: url.match(/models\/([^:]+)/)[1], prompt });
    let out;
    if (prompt.includes('서술 시점')) out = pov;
    else if (prompt.includes('캐스팅 감독')) out = { genre: '성장 소설', pov: '1인칭', narrator: '민준', narrationVoice: 'Charon', narrationStyle: '담담하게 회상하듯', chars: [{ name: '민준', gender: '남', voice: 'Puck', style: '열일곱 소년, 조금 높고 맑은 목소리, 빠른 말투' }, { name: '할머니', gender: '여', voice: 'Puck', style: '일흔 넘은 할머니, 느리고 갈라진 목소리, 사투리' }] };
    else if (prompt.includes('맞춤법·띄어쓰기·문장부호')) out = { errors: prompt.includes('바램이었다') ? [{ p: 1, wrong: '안쓰럽게', right: '안쓰럽게', kind: '맞춤법' }, { p: 1, wrong: '구지 그럴', right: '굳이 그럴', kind: '맞춤법', why: '‘굳이’가 맞아요.' }] : [] };
    else if (prompt.includes('누가 말했는지')) { const n = (prompt.match(/\[Q\d+\]/g) || []).length; out = { lines: Array.from({ length: n }, (_, i) => ({ q: i + 1, speaker: i === 0 ? '나' : '할머니', gender: '여' })) }; }
    else out = {};
    r.fulfill({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] } });
  });
  await ctx.route('https://texttospeech.googleapis.com/**', (r) => {
    log.cloud.push({ body: JSON.parse(r.request().postData()), key: r.request().headers()['x-goog-api-key'] });
    r.fulfill({ json: { audioContent: fakeWav(secs) } });
  });
  return log;
}
const novel1 = '<p>나는 그날 처음으로 할머니 집에 갔다. 마당에는 감나무가 있었다.</p><p>“안녕하세요.” 내가 말했다. “왔냐.” 할머니가 대답했다.</p>';

await test('낭독 1인칭: 해설과 ‘나’의 대사는 화자 인물의 목소리, 다른 인물은 제 목소리 (시점은 AI가 판정, 흉내)', async () => {
  const { ctx, page } = await boot({ tts: { cast: true, cache: false, voice: 'Sulafat' }, ai: { provider: 'gemini', models: { gemini: 'gemini-4-argon' } } });
  const log = await mockGoogle(ctx);
  await page.evaluate(() => localStorage.setItem('nw-gemini-key', 'AIza-test-key-0000000000'));
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(500);
  const { id } = await mkProject(page, [{ title: '1장', html: novel1 }]);
  await run(page, `const R = await import('/src/reader.js'); await R.speak(A.app.editor.getText(), { chapter: A.app.cur });`);
  assert(log.ask.some((x) => x.prompt.includes('서술 시점')), '시점을 판정해야 함');
  assert(log.ask.every((x) => x.model === 'gemini-4-argon'), '고른 글 모델(gemini-4-argon)로 물어야 함: ' + log.ask.map((x) => x.model));
  assert(log.ask.some((x) => x.prompt.includes('서술자 ‘나’는 민준')), '대사 판정에 화자를 알려야 함');
  const cast = await run(page, `return A.app.project.cast;`);
  const minjun = cast.chars.find((x) => x.name === '민준');
  const halmi = cast.chars.find((x) => x.name === '할머니');
  assert(minjun && halmi && minjun.voice !== halmi.voice, '인물 목록: ' + JSON.stringify(cast.chars));
  // 보낸 음성 요청: 줄마다 어떤 목소리였는지
  const spoken = [];
  for (const b of log.tts) {
    const sp = b.generation_config.speech_config;
    const voiceOf = (lab) => (Array.isArray(sp) ? sp[0].voice : sp.speakers.find((x) => x.speaker === lab)?.voice);
    for (const c of b.input[0].content) spoken.push([voiceOf(c.annotations[0].speaker), c.text]);
  }
  const vOf = (frag) => spoken.find(([, t]) => t.includes(frag))?.[0];
  assert(vOf('할머니 집에 갔다') === minjun.voice, '해설은 화자(민준) 목소리: ' + JSON.stringify(spoken));
  assert(vOf('안녕하세요') === minjun.voice, '‘나’의 대사도 민준 목소리');
  assert(vOf('왔냐') === halmi.voice, '할머니 대사는 할머니 목소리');
  assert(vOf('할머니 집에 갔다') !== 'Sulafat', '해설 목소리를 쓰면 안 됨');
  // 3인칭으로 정하면 해설은 해설 목소리
  log.tts.length = 0;
  await run(page, `A.app.project.cast.pov = '3'; const R = await import('/src/reader.js'); await R.speak(A.app.editor.getText(), { chapter: A.app.cur });`);
  const sp = log.tts[0].generation_config.speech_config;
  assert(JSON.stringify(sp).includes('Sulafat'), '3인칭이면 해설 목소리: ' + JSON.stringify(sp));
  await ctx.close();
});

await test('낭독: AI가 작품 전체를 읽고 인물마다 목소리·연기 지시를 정하고, 겹친 목소리는 바꾼다 (흉내)', async () => {
  const { ctx, page } = await boot({ tts: { cast: true, cache: false } });
  const log = await mockGoogle(ctx);
  await page.evaluate(() => localStorage.setItem('nw-gemini-key', 'AIza-test-key-0000000000'));
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(500);
  await mkProject(page, [{ title: '1장', html: novel1 }, { title: '2장', html: '<p>둘째 장의 글. “밥 먹어라.” 할머니가 불렀다.</p>' }]);
  await page.evaluate(() => { (async () => (await import('/src/reader.js')).showCast())(); });
  await page.waitForSelector('#dlg[open] [data-c=design]');
  await page.click('#dlg [data-c=design]');
  await page.waitForFunction(() => /목소리와 연기 지시를 정했어요/.test(document.querySelector('#castMsg')?.textContent || ''));
  const prompt = log.ask.find((x) => x.prompt.includes('캐스팅 감독')).prompt;
  assert(prompt.includes('둘째 장의 글') && prompt.includes('감나무'), '작품 전체를 보내야 함');
  assert(await page.inputValue('#dlg [name=pov]') === '1' && await page.inputValue('#dlg [name=narrator]') === '민준', '시점·화자 채움');
  await page.click('#dlg .dlg-foot button[value=ok]');
  await page.waitForTimeout(300);
  const r = await run(page, `const R = await import('/src/reader.js'); return { cast: A.app.project.cast, c: R.cfg() };`);
  const m = r.cast.chars.find((x) => x.name === '민준'), g = r.cast.chars.find((x) => x.name === '할머니');
  assert(m.voice === 'Puck' && m.style.includes('열일곱'), '민준: ' + JSON.stringify(m));
  assert(g.voice !== 'Puck' && g.voice !== 'Charon' && g.style.includes('할머니'), '겹친 목소리는 바꿔야 함: ' + JSON.stringify(g));
  assert(r.c.voice === 'Charon' && r.c.style === '담담하게 회상하듯', '해설 목소리·분위기: ' + r.c.voice + r.c.style);
  assert(r.cast.pov === '1' && r.cast.narrator === '민준', '시점 저장');
  await ctx.close();
});

await test('낭독: Chirp 3 HD는 구글 클라우드 TTS로, 목소리마다 따로 보내고 클라우드 키를 쓴다 · TTS 모델 목록 불러오기 (흉내)', async () => {
  const { ctx, page } = await boot({ tts: { cache: false, model: 'chirp3-hd', voice: 'Kore', voice2: 'Puck' } });
  const log = await mockGoogle(ctx);
  await page.evaluate(() => { localStorage.setItem('nw-gemini-key', 'AIza-gemini-0000000000'); localStorage.setItem('nw-gcloud-key', 'AIza-cloud-1111111111'); });
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(500);
  const r = await run(page, `const R = await import('/src/reader.js'); const x = await R.speak('바람이 불었다. “어디 가?” 그가 물었다.'); return x.secs;`);
  assert(log.tts.length === 0 && log.cloud.length === 3, `클라우드로만 3번: ${log.tts.length}/${log.cloud.length}`);
  assert(log.cloud[0].body.voice.name === 'ko-KR-Chirp3-HD-Kore' && log.cloud[1].body.voice.name === 'ko-KR-Chirp3-HD-Puck', JSON.stringify(log.cloud.map((x) => x.body.voice)));
  assert(log.cloud.every((x) => x.key === 'AIza-cloud-1111111111'), '클라우드 키');
  assert(Math.abs(r - 3) < 0.05, '세 조각을 이어 붙임 ' + r);
  // 낭독 설정: 내 키로 쓸 수 있는 TTS 모델 불러오기 → 목록에 생김
  await page.evaluate(() => { (async () => (await import('/src/reader.js')).showReaderSettings())(); });
  await page.waitForSelector('#dlg[open] [data-x=models]');
  await page.click('#dlg [data-x=models]');
  await page.waitForFunction(() => /TTS 모델 2개/.test(document.querySelector('#rdModels')?.textContent || ''));
  assert(await page.$('#dlg select[name=model] option[value="gemini-9-custom-tts"]'), '불러온 모델이 목록에');
  await ctx.close();
});

await test('낭독: 이 문장만 읽기는 커서 문장 하나만, 읽는 중 다른 문단을 두 번 누르면 그 문단부터, 빠르게 읽어도 화면이 따라간다', async () => {
  const { ctx, page } = await boot({ tts: { cache: false, rate: 2, chunk: 400, prefetch: 1 } });
  const log = await mockGoogle(ctx, { secs: 3 });
  await page.evaluate(() => localStorage.setItem('nw-gemini-key', 'AIza-test-key-0000000000'));
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(500);
  const paras = Array.from({ length: 40 }, (_, i) => `<p>${i + 1}번째 문단입니다. 첫 문장이 있고 둘째 문장도 있다. 그리고 셋째 문장으로 끝난다. ${'가나다라마바사 '.repeat(8)}</p>`).join('');
  await mkProject(page, [{ title: '1장', html: paras }]);
  // 문장 범위
  const sr = await run(page, `const R = await import('/src/reader.js'); const ed = A.app.editor; let at; ed.state.doc.descendants((n, p) => { if (at == null && n.isText && n.text.includes('둘째 문장')) at = p + n.text.indexOf('둘째 문장') + 2; }); ed.commands.setTextSelection(at); const [a, b] = R.sentenceRange(); return ed.state.doc.textBetween(a, b);`);
  assert(sr === '첫 문장이 있고 둘째 문장도 있다.', '문장 범위: ' + sr);
  await run(page, `(await import('/src/reader.js')).readSentence();`);
  await page.waitForFunction(() => document.querySelector('#readBar') && !document.querySelector('#readBar').hidden);
  await page.waitForTimeout(400);
  const sent = log.tts.map((b) => b.input[0].content.map((c) => c.text).join(' '));
  assert(sent.length === 1 && sent[0] === '첫 문장이 있고 둘째 문장도 있다.', '문장만 보냄: ' + JSON.stringify(sent));
  await run(page, `(await import('/src/reader.js')).stop();`);
  // 장 처음부터 2배속으로 읽기: 읽는 문단이 화면 안(위쪽 40% 근처)에 있어야 한다
  log.tts.length = 0;
  await run(page, `(await import('/src/reader.js')).readChapter();`);
  await page.waitForTimeout(4500);
  const pos = await page.evaluate(() => {
    const el = document.querySelector('.ra-cur'), sc = document.querySelector('#paperScroll');
    if (!el) return null;
    const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
    return { top: r.top - s.top, bottom: r.bottom - s.top, h: s.height, scrolled: sc.scrollTop, n: [...el.parentElement.children].indexOf(el) };
  });
  assert(pos && pos.n > 2, '읽는 자리가 넘어가야 함 ' + JSON.stringify(pos));
  assert(pos.top < pos.h * 0.7 && pos.bottom > 0, '읽는 문단이 화면 안에 있어야 함 ' + JSON.stringify(pos));
  // 읽는 중 다른 문단을 두 번 누르면 그 문단부터
  const target = await page.$('.ProseMirror p:nth-child(' + (pos.n + 4) + ')');
  await target.scrollIntoViewIfNeeded();
  const want = (await target.textContent()).slice(0, 8);
  log.tts.length = 0;
  await target.dblclick();
  const cur = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => res(document.querySelector('.ra-cur')?.textContent.slice(0, 8)))));
  assert(cur === want, `두 번 누른 문단부터: ${cur} / ${want}`);
  assert(log.tts.length === 0 || log.tts[0].input[0].content.map((c) => c.text).join(' ').startsWith(want), '그 문단부터 음성 요청');
  await run(page, `(await import('/src/reader.js')).stop();`);
  await ctx.close();
});

// ---------------- 문장 보관함 ----------------
await test('문장 보관함: 고른 글 지우기·잘라내기·이어서 지우기는 50자 이상이면 담고, 짧은 것·되돌리기는 담지 않으며 백업에 함께 간다', async () => {
  const { ctx, page } = await boot();
  const long1 = '그날 밤 그는 오래된 편지를 다시 꺼내 읽었고, 거기 적힌 문장 하나하나가 낯설게 느껴져서 한참 동안 창밖만 바라보았다.';
  const long2 = '바람이 멎자 골목은 이상할 만큼 조용해졌고 아이들은 하나둘 집으로 돌아가며 서로의 이름을 작게 불렀다. 그 소리가 오래 남았다.';
  const long3 = '마지막 문장은 한 글자씩 지워도 모여서 보관함에 들어가야 하는 아주 긴 문장인데, 오십 자를 넘기려고 조금 더 길게 쓴다.';
  const { id } = await mkProject(page, [{ title: '첫 장', html: `<p>${long1}</p><p>짧은 문장.</p><p>${long2}</p><p>${long3}</p>` }]);
  const sel = (i) => run(page, `const d = A.app.editor.state.doc; let n = 0, r; d.forEach((c, off) => { if (n++ === arg) r = [off + 1, off + 1 + c.content.size]; }); A.app.editor.commands.setTextSelection({ from: r[0], to: r[1] }); A.app.editor.view.focus(); return r;`, i);
  const stash = () => run(page, `return (await S.stashOf(arg)).filter((x) => !x.gone);`, id);
  const wait = (ms = 250) => page.waitForTimeout(ms);
  // 1) 고른 긴 문장을 Backspace로 지움
  await sel(0); await page.keyboard.press('Backspace'); await wait();
  let st = await stash();
  assert(st.length === 1 && st[0].text === long1 && st[0].kind === 'del' && st[0].title === '첫 장', '지운 문장이 담겨야 함: ' + JSON.stringify(st));
  // 2) 짧은 문장은 담지 않음
  await sel(1); await page.keyboard.press('Delete'); await wait();
  assert((await stash()).length === 1, '짧은 문장은 담지 않음');
  // 3) 되돌리기로 돌아왔다 다시 사라지는 것은 담지 않음 (되돌리기·다시 하기)
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+Shift+z'); await wait();
  assert((await stash()).length === 1, '되돌리기는 담지 않음');
  // 4) 잘라내기
  const n = await run(page, `return A.app.editor.state.doc.childCount;`);
  const idx2 = await run(page, `let k = -1, n = 0; A.app.editor.state.doc.forEach((c) => { if (c.textContent === arg) k = n; n++; }); return k;`, long2);
  assert(idx2 >= 0, '두 번째 긴 문장 찾기 ' + n);
  await sel(idx2); await page.keyboard.press('Control+x'); await wait();
  st = await stash();
  assert(st.some((x) => x.text === long2 && x.kind === 'cut'), '잘라 낸 문장이 담겨야 함');
  // 5) 문단 끝에서 Backspace를 이어서 눌러 지움 → 모여서 하나로 담김
  const idx3 = await run(page, `let k = -1, n = 0; A.app.editor.state.doc.forEach((c) => { if (c.textContent === arg) k = n; n++; }); return k;`, long3);
  const r = await sel(idx3);
  await run(page, `A.app.editor.commands.setTextSelection(arg); A.app.editor.view.focus();`, r[1]);
  for (let i = 0; i < long3.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('새 글'); // 다른 입력이 들어오면 모은 것을 담는다
  await wait(400);
  st = await stash();
  assert(st.some((x) => x.text === long3), '이어서 지운 글이 하나로 담겨야 함: ' + JSON.stringify(st.map((x) => x.text)));
  assert(st.length === 3, '세 개여야 함 ' + st.length);
  // 6) 보관함 탭에 보이고, 넣기로 다시 넣을 수 있음
  await page.click('.tabs [data-tab="stash"]');
  await page.waitForSelector('#stashList li[data-id]');
  assert((await page.$$('#stashList li[data-id]')).length === 3, '목록 3개');
  await page.fill('#stashSearch', '골목');
  await page.waitForTimeout(200);
  assert((await page.$$('#stashList li[data-id]')).length === 1, '검색 결과 1개');
  await page.click('#stashList li[data-id] [data-do=insert]');
  assert((await run(page, `return A.app.editor.getText();`)).includes(long2), '넣기로 다시 들어가야 함');
  // 7) 백업 묶음에 들어가고, 다른 기기에서 받으면 합쳐짐 (지운 항목은 되살아나지 않음)
  const b = await run(page, `return S.packBundle(await S.exportBundle(arg));`, id);
  assert(b.stash.filter((x) => !x.gone).length === 3, '백업에 담겨야 함');
  await run(page, `const l = await S.stashOf(arg); l[0].gone = true; l[0].text = ''; l.push({ id: 'local1', t: Date.now(), text: '이 기기에서만 담은 문장', kind: 'del' }); await S.putStash(arg, l);`, id);
  await run(page, `await S.importBundle(arg, { mode: 'merge' });`, b);
  st = await stash();
  assert(st.length === 3 && st.some((x) => x.id === 'local1') && !st.some((x) => x.text === long1), '합치기: ' + JSON.stringify(st.map((x) => x.text.slice(0, 6))));
  await ctx.close();
});

// ---------------- 드라이브 연결 유지 · 내 기기 연결 ----------------
// 구글 로그인(GIS)과 드라이브 API를 흉내 낸다. 요청한 prompt 값을 window.__prompts에 남긴다
async function mockDrive(ctx, { failSilent = false } = {}) {
  await ctx.addInitScript((failSilent) => {
    window.__prompts = []; window.__hints = [];
    window.google = { accounts: { oauth2: {
      initTokenClient: (cfg) => ({ requestAccessToken: ({ prompt }) => {
        window.__prompts.push(prompt); window.__hints.push(cfg.hint || '');
        setTimeout(() => (prompt === 'none' && failSilent ? cfg.error_callback({ type: 'popup_failed_to_open' }) : cfg.callback({ access_token: 'tok' + window.__prompts.length, expires_in: window.__exp || 3600 })), 10);
      } }),
      revoke: () => {},
    } } };
  }, failSilent);
  const files = new Map();
  await ctx.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const qq = u.searchParams.get('q') || '';
    if (/\/about$/.test(u.pathname)) return route.fulfill({ json: { user: { emailAddress: 'writer@example.com' } } });
    if (/\/files$/.test(u.pathname) && req.method() === 'GET') {
      if (/vnd.google-apps.folder/.test(qq)) return route.fulfill({ json: { files: [{ id: 'folder1' }] } });
      const pm = qq.match(/key='(\w+)' and value='([^']+)'/);
      const list = [...files.values()].filter((f) => (pm ? f.appProperties?.[pm[1]] === pm[2] : /\.novel\.json/.test(f.name)));
      return route.fulfill({ json: { files: list } });
    }
    const idm = u.pathname.match(/\/files\/([^/]+)$/);
    if (idm && req.method() === 'GET') return route.fulfill({ body: files.get(idm[1])?.body || '' });
    if (/upload/.test(u.pathname)) {
      const body = req.postDataBuffer();
      const raw = body.toString('latin1');
      const meta = JSON.parse(Buffer.from(raw.match(/\r\n\r\n(\{.*?\})\r\n/s)[1], 'latin1').toString('utf8'));
      const fi = raw.indexOf('name="file"'); const st = raw.indexOf('\r\n\r\n', fi) + 4; const en = raw.lastIndexOf('\r\n--');
      const id = idm ? idm[1] : 'f' + (files.size + 1);
      const old = files.get(id) || {};
      files.set(id, { ...old, ...meta, id, body: body.subarray(st, en), modifiedTime: new Date().toISOString(), size: en - st });
      return route.fulfill({ json: { id, modifiedTime: files.get(id).modifiedTime, size: en - st } });
    }
    return route.fulfill({ json: {} });
  });
  return files;
}

await test('드라이브: 한 번 연결하면 앱을 다시 켜거나 업데이트해도 연결이 남고, 표가 끝나면 창 없이(prompt=none) 다시 받는다', async () => {
  const { ctx, page } = await boot({ syncTarget: 'drive', driveClientId: 'x.apps.googleusercontent.com', autoSync: false });
  await mockDrive(ctx);
  await page.reload(); await page.waitForSelector('.ProseMirror');
  await run(page, `const G = await import('/src/gdrive.js'); await G.connect();`);
  assert((await page.evaluate(() => window.__prompts)).join() === 'consent', '처음은 동의 화면');
  const ls = await page.evaluate(() => ({ t: localStorage.getItem('gd-token'), l: localStorage.getItem('gd-linked') }));
  assert(ls.t && ls.l === 'x.apps.googleusercontent.com', '표와 연결 표시는 localStorage에: ' + JSON.stringify(ls));
  // 다시 켜기(업데이트 뒤와 같다): 표가 남아 있어 바로 연결됨
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(300);
  assert((await run(page, `const G = await import('/src/gdrive.js'); return G.status().connected;`)) === true, '다시 켠 뒤에도 연결');
  // 표가 끝난 채로 켜기: 창 없이 조용히 새 표
  await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('gd-token')); t.expires_at = Date.now() - 1000; localStorage.setItem('gd-token', JSON.stringify(t)); });
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(800);
  const st = await run(page, `const G = await import('/src/gdrive.js'); return G.status();`);
  assert(st.connected, '조용히 다시 연결: ' + JSON.stringify(st));
  assert((await page.evaluate(() => window.__prompts)).join() === 'none', '창 없이 받기');
  // 드라이브 호출 중 401이 나도 다시 받아 이어 간다
  await run(page, `const G = await import('/src/gdrive.js'); return G.listBundles();`);
  await ctx.close();
});

await test('드라이브: 조용한 재연결이 막히면(브라우저) ☁ 표시가 ‘눌러서 다시 연결’이 되고, 아무 곳이나 누르면 다시 연결한다', async () => {
  const { ctx, page } = await boot({ syncTarget: 'drive', driveClientId: 'x.apps.googleusercontent.com', autoSync: false });
  await mockDrive(ctx, { failSilent: true });
  await page.evaluate(() => { localStorage.setItem('gd-linked', 'x.apps.googleusercontent.com'); localStorage.setItem('gd-token', JSON.stringify({ access_token: 'old', expires_at: Date.now() - 1000 })); });
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(500);
  assert(/다시 연결/.test(await page.textContent('#syncState')), '표시: ' + await page.textContent('#syncState'));
  await page.evaluate(() => { window.google.accounts.oauth2.initTokenClient = (cfg) => ({ requestAccessToken: ({ prompt }) => { window.__prompts.push('g:' + prompt); setTimeout(() => cfg.callback({ access_token: 'new', expires_in: 3600 }), 10); } }); });
  await page.mouse.click(640, 400); await page.waitForTimeout(300);
  assert((await run(page, `const G = await import('/src/gdrive.js'); return G.status().connected;`)) === true, '누르면 다시 연결');
  await ctx.close();
});

await test('내 기기: 데스크톱에서 만든 연결 코드를 랩톱에 넣으면 같은 서버에 붙어 작품을 모두 받아 오고, 두 기기가 목록에 오른다', async () => {
  const files = new Map(), devs = new Map();
  // 데스크톱: 서버에 연결해 작품 두 개를 올림
  const A = await boot({ syncTarget: 'server', syncServer: 'http://sync.test', autoSync: false, deviceName: '집 데스크톱' });
  await A.page.evaluate(() => localStorage.setItem('nw-sync-code', 'test-code-1234'));
  await fakeServer(A.page, files, devs);
  await run(A.page, `const SV = await import('/src/syncserver.js'); SV.configure('http://sync.test');`);
  await run(A.page, `const p = await S.createProject('두 번째 작품', [{ title: '1장', html: '<p>둘째</p>' }]); await A.openProject(p.id); await A.syncNow({ quiet: true });`);
  await mkProject(A.page, [{ title: '1장', html: '<p>첫째 작품 본문</p>' }], '첫 작품');
  await run(A.page, `await A.syncNow({ quiet: true });`);
  assert(files.size === 2, '서버에 2개: ' + files.size);
  await A.page.evaluate(() => document.querySelector('[data-act="devices"]').click());
  await A.page.waitForSelector('#dlg[open] .dev-row');
  await A.page.click('#dlg [data-d=make]');
  const code = await A.page.inputValue('#devCode textarea');
  assert(/^NW1-/.test(code), '코드: ' + code);
  assert([...devs.values()].some((d) => d.name === '집 데스크톱'), '데스크톱 등록');
  // 랩톱: 아무 연결 없이 시작해 코드만 넣음
  const B = await boot({ deviceName: '노트북' });
  await fakeServer(B.page, files, devs);
  await B.page.evaluate(() => document.querySelector('[data-act="devices"]').click());
  await B.page.click('#dlg [data-d=join]');
  await B.page.fill('#dlg textarea[name=code]', code);
  await B.page.click('#dlg [data-d=go]');
  await B.page.waitForFunction(() => /작품 2개를 받아 왔어요/.test(document.querySelector('#devMsg').textContent), null, { timeout: 10000 });
  const titles = await run(B.page, `return (await S.listProjects()).map((p) => p.title).sort();`);
  assert(titles.includes('첫 작품') && titles.includes('두 번째 작품'), '받은 작품: ' + titles);
  const st = await run(B.page, `return { t: A.syncTarget(), s: A.app.settings.syncServer, synced: (await S.listProjects()).every((p) => p.srvSyncedAt) };`);
  assert(st.t === 'server' && st.s === 'http://sync.test' && st.synced, '랩톱 설정: ' + JSON.stringify(st));
  assert([...devs.values()].map((d) => d.name).sort().join() === '노트북,집 데스크톱', '기기 목록: ' + [...devs.values()].map((d) => d.name));
  // 잘못된 코드
  const bad = await run(B.page, `const D = await import('/src/devices.js'); try { D.readCode('NW1-abc'); return 'ok'; } catch (e) { return e.message; }`);
  assert(/읽지 못|아니에요/.test(bad), '잘못된 코드: ' + bad);
  const dc = await run(B.page, `const D = await import('/src/devices.js'); return D.readCode(D.makeCode({ t: 'd', i: 'abc.apps.googleusercontent.com' }));`);
  assert(dc.t === 'd' && dc.i === 'abc.apps.googleusercontent.com', '드라이브 코드');
  await A.ctx.close(); await B.ctx.close();
});

await test('내 기기: 드라이브 연결 코드로 랩톱을 붙이면 드라이브의 작품을 받아 오고, 기기 목록 파일이 드라이브 폴더에 생긴다', async () => {
  const A = await boot({ syncTarget: 'drive', driveClientId: 'x.apps.googleusercontent.com', autoSync: false, deviceName: '데스크톱' });
  const files = await mockDrive(A.ctx);
  await A.page.reload(); await A.page.waitForSelector('.ProseMirror');
  await run(A.page, `const G = await import('/src/gdrive.js'); await G.connect();`);
  await mkProject(A.page, [{ title: '1장', html: '<p>드라이브 작품</p>' }], '드라이브 작품');
  await run(A.page, `await A.syncNow({ quiet: true }); const D = await import('/src/devices.js'); const G = await import('/src/gdrive.js'); await G.putDevice({ id: D.deviceId(), name: D.deviceName() });`);
  const code = await run(A.page, `const D = await import('/src/devices.js'); return D.makeCode({ t: 'd', i: A.app.settings.driveClientId });`);
  const B = await boot({ deviceName: '랩톱' });
  // 같은 드라이브를 쓰도록 B에도 흉내를 걸되 파일은 A의 것을 나눈다
  await B.ctx.addInitScript(() => { window.google = { accounts: { oauth2: { initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'b', expires_in: 3600 }), 10) }), revoke: () => {} } } }; });
  await B.page.reload(); await B.page.waitForSelector('.ProseMirror');
  await B.ctx.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const qq = u.searchParams.get('q') || '';
    if (/\/files$/.test(u.pathname) && req.method() === 'GET') {
      if (/vnd.google-apps.folder/.test(qq)) return route.fulfill({ json: { files: [{ id: 'folder1' }] } });
      const pm = qq.match(/key='(\w+)' and value='([^']+)'/);
      return route.fulfill({ json: { files: [...files.values()].filter((f) => (pm ? f.appProperties?.[pm[1]] === pm[2] : /\.novel\.json/.test(f.name))).map(({ body, ...f }) => f) } });
    }
    const idm = u.pathname.match(/\/files\/([^/]+)$/);
    if (idm && req.method() === 'GET') return route.fulfill({ body: files.get(idm[1])?.body || '' });
    return route.fulfill({ json: { id: 'x', modifiedTime: new Date().toISOString(), size: 1 } });
  });
  await B.page.evaluate(() => document.querySelector('[data-act="devices"]').click());
  await B.page.click('#dlg [data-d=join]');
  await B.page.fill('#dlg textarea[name=code]', code);
  await B.page.click('#dlg [data-d=go]');
  await B.page.waitForFunction(() => /작품 1개를 받아 왔어요/.test(document.querySelector('#devMsg').textContent), null, { timeout: 10000 });
  assert((await run(B.page, `return (await S.listProjects()).map((p) => p.title);`)).includes('드라이브 작품'), '드라이브 작품 받기');
  const devFile = [...files.values()].find((f) => f.appProperties?.novelDevices === '1');
  assert(devFile && devFile.name === '기기 목록.json', '기기 목록 파일');
  await A.ctx.close(); await B.ctx.close();
});

await test('파일 이름에 날짜: 내보내기에서 고르면 내보낸 파일·백업 파일 이름에 날짜(·시각)가 붙고, 다음에도 남는다', async () => {
  const { ctx, page } = await boot();
  await mkProject(page, [{ title: '1장', html: '<p>본문</p>' }], 'Spring'); // (시험 브라우저는 한글 파일 이름을 'download'로 바꿔서 영문 제목으로)
  const n = await run(page, `const IO = await import('/src/io/index.js'); const d = new Date(2026, 9, 16, 14, 5);
    return [IO.withDate('봄밤.docx', 'date', d), IO.withDate('봄밤.novel.json', 'time', d), IO.withDate('봄밤.docx', 'off', d), IO.withDate('a.novel.json.gz', 'date', d)];`);
  assert(n.join('|') === '봄밤 2026-10-16.docx|봄밤 2026-10-16 1405.novel.json|봄밤.docx|a 2026-10-16.novel.json.gz', '이름: ' + n);
  const today = await run(page, 'return S.today();');
  await page.evaluate(() => document.querySelector('[data-act="export"]').click());
  await page.waitForSelector('#dlg[open] select[name=nameDate]');
  await page.selectOption('#dlg select[name=fmt]', 'txt');
  await page.selectOption('#dlg select[name=nameDate]', 'date');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlg .dlg-foot button[value=ok]')]);
  assert(dl.suggestedFilename() === `Spring ${today}.txt`, '내보낸 이름: ' + dl.suggestedFilename());
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => document.querySelector('[data-act="backup"]').click())]);
  assert(dl2.suggestedFilename() === `Spring ${today}.novel.json`, '백업 이름: ' + dl2.suggestedFilename());
  await page.evaluate(() => document.querySelector('[data-act="export"]').click());
  await page.waitForSelector('#dlg[open] select[name=nameDate]');
  assert((await page.inputValue('#dlg select[name=nameDate]')) === 'date', '고른 값이 남아야 함');
  await ctx.close();
});

await test('드라이브: 쓰는 도중 표가 끝나도 다음 동기화 때 창 없이 다시 받아 올리고(끊김 표시 없음), 끝나기 10분 전이면 다음 클릭·키 입력 때 미리 받으며, 계정 주소를 기억해 고른다', async () => {
  const { ctx, page } = await boot({ syncTarget: 'drive', driveClientId: 'x.apps.googleusercontent.com', autoSync: true, syncMinutes: 1 });
  const files = await mockDrive(ctx);
  await page.reload(); await page.waitForSelector('.ProseMirror');
  await run(page, `const G = await import('/src/gdrive.js'); await G.connect();`);
  await page.waitForFunction(() => localStorage.getItem('gd-hint') === 'writer@example.com');
  await mkProject(page, [{ title: '1장', html: '<p>본문</p>' }], '끊김 시험');
  // 표를 끝난 것으로 만들고(앱을 오래 켜 둔 상황) 글을 고친다
  await page.evaluate(() => { window.__exp = 3600; });
  await run(page, `const G = await import('/src/gdrive.js'); const t = JSON.parse(localStorage.getItem('gd-token')); t.expires_at = Date.now() - 1000; localStorage.setItem('gd-token', JSON.stringify(t)); G.configure('');  G.configure('x.apps.googleusercontent.com'); return G.status();`);
  assert(!(await run(page, `return (await import('/src/gdrive.js')).status().connected;`)), '끝난 표');
  await run(page, `A.scheduleSync(0);`);
  await page.waitForFunction(() => window.__prompts.at(-1) === 'none');
  await page.waitForFunction(() => /연결됨|맞춤|동기화/.test(document.querySelector('#syncState').textContent) && !/다시 연결/.test(document.querySelector('#syncState').textContent), null, { timeout: 8000 });
  assert((await page.evaluate(() => window.__hints.at(-1))) === 'writer@example.com', '계정 주소로 고르기');
  for (let i = 0; i < 40 && ![...files.values()].some((f) => /끊김 시험/.test(f.name || '')); i++) await page.waitForTimeout(200);
  assert([...files.values()].some((f) => /끊김 시험/.test(f.name || '')), '다시 연결 뒤 올림: ' + [...files.values()].map((f) => f.name));
  // 10분 안에 끝나는 표: 키를 누르면 미리 받는다
  await page.evaluate(() => { window.__exp = 300; });
  await run(page, `const G = await import('/src/gdrive.js'); await G.connect({ silent: true });`);
  const n = await page.evaluate(() => window.__prompts.length);
  await page.evaluate(() => { window.__exp = 3600; });
  await page.mouse.click(640, 400);
  await page.waitForFunction((n) => window.__prompts.length > n, n);
  await page.waitForTimeout(200);
  const left = await run(page, `return JSON.parse(localStorage.getItem('gd-token')).expires_at - Date.now();`);
  assert(left > 50 * 60e3, '새 표 1시간: ' + left);
  await ctx.close();
});

await test('맞춤법 검사: 작품 전체의 틀린 곳이 장마다 한 번에 나오고(틀린 말 → 고칠 말), 다른 장도 고치기·모두 고치기·AI 검사가 되며, 흔한 오탐은 없다', async () => {
  const { ctx, page } = await boot({ proof: false, tts: { cache: false } }); // 밑줄을 꺼 두어도 목록은 보인다
  await mockGoogle(ctx);
  await page.evaluate(() => localStorage.setItem('nw-gemini-key', 'AIza-test-key-0000000000'));
  await page.reload(); await page.waitForSelector('.ProseMirror');
  const { order } = await mkProject(page, [
    { title: '첫 장', html: '<p>비가 왔다.그는 “어떻해, 할께.”라고 했다.</p><p>그는 실수 없이 멀거니 서서 볼때기를 긁었다.</p>' },
    { title: '둘째 장', html: '<p>그녀는 안되요 라고 했다. 몇일 뒤였다.</p>' },
    { title: '셋째 장', html: '<p>그것은 바램이었다. 구지 그럴 필요는 없었다.</p>' }]);
  await page.evaluate(() => { (async () => (await import('/src/proof.js')).showProof())(); });
  await page.waitForSelector('#dlg[open] .pf-row');
  const rows = async () => page.$$eval('#pfList .pf-row', (els) => els.map((e) => e.querySelector('.pf-fix').textContent.replace(/\s+/g, ' ').trim()));
  let r = await rows();
  const heads = await page.$$eval('#pfList .pf-ch b', (els) => els.map((e) => e.textContent));
  assert(heads.join() === '첫 장,둘째 장,셋째 장', '장 묶음: ' + heads);
  for (const want of ['.그 → . 그', '어떻해 → 어떡해', '할께 → 할게', '되요 → 돼요', '몇일 → 며칠', '바램 → 바람']) assert(r.some((x) => x.startsWith(want)), '빠짐: ' + want + ' / ' + r.join(' | '));
  assert(!r.some((x) => /실수|멀거|볼때/.test(x)), '오탐: ' + r.join(' | '));
  assert(/작품 전체에서 6곳/.test(await page.textContent('#pfSum')), '요약: ' + await page.textContent('#pfSum'));
  // 다른 장(둘째 장) 하나 고치기: 그 장 원고가 바뀌고 목록에서 빠진다
  const k = r.findIndex((x) => x.startsWith('몇일'));
  await (await page.$$('#pfList .pf-row'))[k].$('[data-a=fix]').then((b) => b.click());
  await page.waitForFunction(() => ![...document.querySelectorAll('#pfList .pf-fix')].some((e) => e.textContent.startsWith('몇일')));
  assert((await run(page, `return (await S.chaptersOf(arg)).find((c) => c.title === '둘째 장').html;`, (await run(page, 'return A.app.project.id;')))).includes('며칠 뒤'), '둘째 장 저장');
  // AI 검사 (작품 전체): 셋째 장에서 ‘구지’를 찾는다
  await page.click('#dlg [data-p=ai]');
  await page.waitForFunction(() => /AI가 \d+곳을 찾았어요/.test(document.querySelector('#pfMsg').textContent));
  r = await rows();
  assert(r.some((x) => x.startsWith('구지 → 굳이')), 'AI 결과: ' + r.join(' | '));
  // 원고에서 보기: 다른 장이면 그 장을 열고 그 자리를 고른다. AI가 찾은 곳도 그 장 밑줄로 남는다
  await (await page.$$('#pfList .pf-row'))[r.findIndex((x) => x.startsWith('구지'))].$('[data-a=go]').then((b) => b.click());
  await page.waitForFunction((id) => true, null);
  await page.waitForTimeout(300);
  const at = await run(page, `const e = A.app.editor; return { cur: A.app.cur, sel: e.state.doc.textBetween(e.state.selection.from, e.state.selection.to), ai: document.querySelectorAll('.ProseMirror .pf-ai').length };`);
  assert(at.cur === order[2] && at.sel === '구지', '셋째 장으로: ' + JSON.stringify(at));
  // 이 장만 보기
  await page.click('#dlg label:has(input[name=scope][value=cur])');
  assert((await page.$$('#pfList .pf-ch')).length === 0 && (await rows()).every((x) => !/어떻해|되요/.test(x)), '이 장만: ' + (await rows()).join(' | '));
  await page.click('#dlg label:has(input[name=scope][value=all])');
  // 모두 고치기: 모든 장이 고쳐지고, 고치기 전 원고는 버전 기록에
  await page.click('#dlg [data-p=fixall]');
  await page.waitForFunction(() => /곳을 고쳤어요/.test(document.querySelector('#pfMsg').textContent));
  const pid = await run(page, 'return A.app.project.id;');
  await run(page, 'await A.saveNow();');
  const chs = await run(page, `return (await S.chaptersOf(arg)).map((c) => c.title + ':' + c.html);`, pid);
  const cur = (await run(page, `return (await S.chaptersOf(arg)).find((c) => c.title === '첫 장').html;`, pid));
  assert(cur.includes('왔다. 그는') && cur.includes('어떡해') && cur.includes('할게') && cur.includes('실수 없이'), '첫 장: ' + cur);
  assert(chs.some((c) => c.startsWith('둘째 장') && c.includes('돼요')), '둘째 장: ' + chs);
  assert(chs.some((c) => c.startsWith('셋째 장') && c.includes('바람이었다') && c.includes('굳이 그럴')), '셋째 장(AI 포함): ' + chs);
  const snaps = await run(page, `return (await S.snapshotsOf(arg)).map((s) => s.label);`, order[2]);
  assert(snaps.includes('맞춤법 모두 고치기 전'), '버전 기록: ' + snaps);
  assert(/걸리는 곳이 없어요/.test(await page.textContent('#pfList')), '다 고친 뒤 빈 목록');
  // 셋째 장을 열어도 남은 것 없음, 다른 장으로 가기 동작
  await ctx.close();
});

await test('맞춤법 규칙: 바른 문장 130여 개는 걸리지 않고, 틀린 문장 50여 개는 고칠 말대로 고치면 바른 문장이 된다', async () => {
  const { OK, BAD } = await import('./proof-cases.mjs');
  const { ctx, page } = await boot();
  const r = await run(page, `const P = await import('/src/proof.js');
    const fp = arg.OK.map((t) => [t, P.checkText(t)]).filter(([, l]) => l.length).map(([t, l]) => t + ' ⇒ ' + l.map((x) => x.word + '→' + x.fix.join('/')).join(', '));
    const bad = arg.BAD.map(([t, want]) => { const l = P.checkText(t); let s = t; for (const x of [...l].sort((a, b) => b.i - a.i)) s = s.slice(0, x.i) + (x.fix[0] ?? x.word) + s.slice(x.i + x.len); return s === want ? null : t + ' ⇒ ' + s + ' (바람: ' + want + ')'; }).filter(Boolean);
    return { fp, bad };`, { OK, BAD });
  assert(!r.fp.length, '바른 문장을 잡음:\n' + r.fp.join('\n'));
  assert(!r.bad.length, '틀린 문장을 못 고침:\n' + r.bad.join('\n'));
  await ctx.close();
});

await test('문장 보관함: 문장만·문단만 따로 보고, 보이는 것을 한 번에 복사한다 (문단을 통째로 지우면 문단)', async () => {
  const { ctx, page } = await boot();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const p1 = '첫째 문단은 통째로 지울 문단입니다. 이 문단은 오십 자가 넘도록 길게 쓴 문단이라서 보관함에 들어가야 합니다.';
  const s1 = '둘째 문단 안의 이 문장만 골라서 지웁니다. 이 문장도 오십 자가 넘도록 길게 길게 늘여 쓴 문장입니다.';
  const { id } = await mkProject(page, [{ title: '1장', html: `<p>${p1}</p><p>앞말 ${s1} 뒷말</p><p>끝</p>` }]);
  const del = (from, to) => run(page, `const e = A.app.editor; e.view.focus(); e.commands.setTextSelection({ from: arg[0], to: arg[1] });`, [from, to]).then(() => page.keyboard.press('Backspace'));
  // 문단 통째로 (첫 문단 처음부터 끝까지)
  await del(1, 1 + p1.length);
  await page.waitForTimeout(300);
  // 둘째 문단 가운데 문장만
  const at = await run(page, `let a; A.app.editor.state.doc.descendants((n, pos) => { if (a == null && n.isText && n.text.includes('둘째 문단 안의')) a = pos + n.text.indexOf('둘째 문단 안의'); }); return a;`);
  await del(at, at + s1.length);
  await page.waitForTimeout(300);
  const st = await run(page, `return (await S.stashOf(arg)).map((x) => x.unit + ':' + x.text.slice(0, 5));`, id);
  assert(st.includes('para:첫째 문단') && st.includes('sent:둘째 문단'), '종류: ' + st);
  await page.click('.tabs [data-tab="stash"]');
  await page.waitForSelector('#stashList li[data-id]');
  await page.click('#stashFilter [data-u=para]');
  await page.waitForTimeout(100);
  let items = await page.$$eval('#stashList li[data-id] .stash-text', (els) => els.map((e) => e.textContent.slice(0, 5)));
  assert(items.join() === '첫째 문단', '문단만: ' + items);
  await page.click('#stashFilter [data-u=sent]');
  await page.waitForTimeout(100);
  items = await page.$$eval('#stashList li[data-id] .stash-text', (els) => els.map((e) => e.textContent.slice(0, 5)));
  assert(items.join() === '둘째 문단', '문장만: ' + items);
  await page.click('#stashFilter [data-u=all]');
  await page.waitForTimeout(100);
  assert((await page.textContent('#stashCopyAll')).includes('2개'), '복사 단추: ' + await page.textContent('#stashCopyAll'));
  await page.click('#stashCopyAll');
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(clip === p1 + '\n\n' + s1, '복사한 글: ' + JSON.stringify(clip));
  await ctx.close();
});

await test('드라이브: 끊긴 뒤 ☁ 표시를 누르면 창 없는 연결을 다시 하지 않고 계정을 고를 수 있는 구글 창을 연다 (Popup window closed 대신)', async () => {
  const { ctx, page } = await boot({ syncTarget: 'drive', driveClientId: 'x.apps.googleusercontent.com', autoSync: false });
  await mockDrive(ctx, { failSilent: true });
  await page.evaluate(() => { localStorage.setItem('gd-linked', 'x.apps.googleusercontent.com'); localStorage.setItem('gd-token', JSON.stringify({ access_token: 'old', expires_at: Date.now() - 1000 })); });
  await page.reload(); await page.waitForSelector('.ProseMirror'); await page.waitForTimeout(500);
  await page.evaluate(() => { window.__prompts.length = 0; });
  await page.click('#syncState');
  await page.waitForFunction(() => window.__prompts.length > 0);
  await page.waitForTimeout(200);
  const p = await page.evaluate(() => window.__prompts);
  assert(p.join('|') === '', '보이는 창 하나만(prompt 없음): ' + JSON.stringify(p));
  assert((await run(page, `return (await import('/src/gdrive.js')).status().connected;`)) === true, '다시 연결');
  // 창을 닫으면 알기 쉬운 말로
  const msg = await run(page, `const G = await import('/src/gdrive.js'); G.disconnect(); G.configure('x.apps.googleusercontent.com'); window.google.accounts.oauth2.initTokenClient = (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.error_callback({ type: 'popup_closed', message: 'Popup window closed' }), 5) }); try { await G.connect(); } catch (e) { return e.message; }`);
  assert(/창이 닫혔어요/.test(msg), '안내: ' + msg);
  await ctx.close();
});

export { browser, boot, run, mkProject, typeInto, pressDialog, test, assert, results, mockGoogle };
if (!process.env.NO_CLOSE) {
  await browser.close();
  const fail = results.filter((r) => r[1] !== '통과');
  console.log(`\n${results.length - fail.length}/${results.length} 통과`);
  process.exitCode = fail.length ? 1 : 0;
}
