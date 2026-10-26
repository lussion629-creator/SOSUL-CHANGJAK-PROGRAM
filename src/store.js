// 로컬 저장소 (IndexedDB). 모든 원고·자료·버전 기록은 기기 안에 먼저 저장된다.
import { diffArrays } from 'diff';
import { openDB } from 'idb';
import { sanitizeHtml } from './sanitize.js';

const DB_NAME = 'novel-writer';
let dbp;

function db() {
  if (!dbp) {
    dbp = openDB(DB_NAME, 1, {
      upgrade(d) {
        d.createObjectStore('projects', { keyPath: 'id' });
        const ch = d.createObjectStore('chapters', { keyPath: 'id' });
        ch.createIndex('projectId', 'projectId');
        const nt = d.createObjectStore('notes', { keyPath: 'id' });
        nt.createIndex('projectId', 'projectId');
        const sn = d.createObjectStore('snapshots', { keyPath: 'id' });
        sn.createIndex('chapterId', 'chapterId');
        sn.createIndex('projectId', 'projectId');
        d.createObjectStore('daily', { keyPath: 'key' });
        d.createObjectStore('kv');
      },
    });
  }
  return dbp;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const today = (d = new Date()) => {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};

// ---------- 작품 ----------
export async function listProjects() {
  const all = await (await db()).getAll('projects');
  return all.sort((a, b) => b.updated - a.updated);
}
export async function getProject(id) { return (await db()).get('projects', id); }
export async function putProject(p) { p.updated = p.updated || Date.now(); await (await db()).put('projects', p); return p; }

export async function createProject(title = '새 작품', chapters = [{ title: '1장', html: '' }]) {
  const p = {
    id: uid(), title, created: Date.now(), updated: Date.now(),
    order: [], goalTotal: 0, goalDaily: 0, deadline: '', synopsis: '', logline: '',
  };
  for (const c of chapters) {
    const ch = newChapter(p.id, c.title, c.html);
    p.order.push(ch.id);
    await putChapter(ch);
  }
  await putProject(p);
  return p;
}

export async function deleteProject(id) {
  const d = await db();
  const tx = d.transaction(['projects', 'chapters', 'notes', 'snapshots', 'kv'], 'readwrite');
  for (const store of ['chapters', 'notes', 'snapshots']) {
    const keys = await tx.objectStore(store).index('projectId').getAllKeys(id);
    for (const k of keys) await tx.objectStore(store).delete(k);
  }
  await tx.objectStore('kv').delete(stashKey(id));
  await tx.objectStore('projects').delete(id);
  await tx.done;
}

// ---------- 장(원고) ----------
export function newChapter(projectId, title = '새 장', html = '') {
  return { id: uid(), projectId, title, html, status: 'draft', synopsis: '', label: '', created: Date.now(), updated: Date.now() };
}
export async function getChapter(id) { return (await db()).get('chapters', id); }
export async function putChapter(c) {
  // _로 시작하는 값(화면용 캐시)은 저장하지 않는다
  const clean = Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_')));
  await (await db()).put('chapters', clean);
  return c;
}
export async function chaptersOf(projectId) { return (await db()).getAllFromIndex('chapters', 'projectId', projectId); }
export async function deleteChapter(id) {
  const d = await db();
  await d.delete('chapters', id);
  const keys = await d.getAllKeysFromIndex('snapshots', 'chapterId', id);
  for (const k of keys) await d.delete('snapshots', k);
}

// ---------- 휴지통: 지운 장·작품을 30일 동안 보관했다가 되살린다 ----------
const TRASH_DAYS = 30;
export async function trashList() {
  const all = (await kvGet('trash', [])) || [];
  const keep = all.filter((t) => Date.now() - t.time < TRASH_DAYS * 864e5);
  if (keep.length !== all.length) await kvSet('trash', keep);
  return keep.sort((a, b) => b.time - a.time);
}
async function pushTrash(item) {
  const all = await trashList();
  all.unshift({ id: uid(), time: Date.now(), ...item });
  await kvSet('trash', all);
}
// 장을 휴지통으로 (버전 기록도 같이)
export async function trashChapter(ch, { projectTitle = '', index = 0 } = {}) {
  const d = await db();
  const snaps = await d.getAllFromIndex('snapshots', 'chapterId', ch.id);
  const clean = Object.fromEntries(Object.entries(ch).filter(([k]) => !k.startsWith('_')));
  await pushTrash({ kind: 'chapter', title: ch.title, projectId: ch.projectId, projectTitle, index, chapter: clean, snapshots: packSnapshots(snaps) });
  await deleteChapter(ch.id);
}
// 작품을 휴지통으로 (장·자료·버전 기록·하루 기록 모두)
export async function trashProject(id) {
  const b = packBundle(await exportBundle(id));
  await pushTrash({ kind: 'project', title: b.project.title, bundle: b });
  await deleteProject(id);
}
export async function dropTrash(id) { await kvSet('trash', (await trashList()).filter((t) => t.id !== id)); }
// 되살리기: 장이면 {chapter}를, 작품이면 {project}를 돌려준다
export async function restoreTrash(id) {
  const t = (await trashList()).find((x) => x.id === id);
  if (!t) throw new Error('휴지통에서 찾지 못했습니다.');
  const d = await db();
  let out;
  if (t.kind === 'chapter') {
    await d.put('chapters', t.chapter);
    for (const s of unpackSnapshots(t.snapshots || [])) await d.put('snapshots', s);
    out = { chapter: t.chapter, index: t.index };
  } else {
    out = { project: await importBundle(t.bundle, { keepIds: !(await d.get('projects', t.bundle.project.id)) }) };
  }
  await dropTrash(id);
  return out;
}

// ---------- 자료(인물·장소·설정·메모) ----------
export async function notesOf(projectId) { return (await db()).getAllFromIndex('notes', 'projectId', projectId); }
export async function putNote(n) { n.updated = Date.now(); await (await db()).put('notes', n); return n; }
export async function deleteNote(id) { await (await db()).delete('notes', id); }

// ---------- 버전 기록 ----------
export async function addSnapshot(chapter, kind = 'auto', label = '') {
  const s = {
    id: uid(), chapterId: chapter.id, projectId: chapter.projectId, time: Date.now(),
    html: chapter.html, title: chapter.title, kind, label,
  };
  await (await db()).put('snapshots', s);
  return s;
}
export async function snapshotsOf(chapterId) {
  const all = await (await db()).getAllFromIndex('snapshots', 'chapterId', chapterId);
  return all.sort((a, b) => b.time - a.time);
}
export async function getSnapshot(id) { return (await db()).get('snapshots', id); }
export async function updateSnapshot(s) { await (await db()).put('snapshots', s); }
export async function deleteSnapshot(id) { await (await db()).delete('snapshots', id); }

// 오래된 자동 기록 정리: 최근 3일은 전부, 30일까지는 1시간에 하나, 그 이전은 하루에 하나.
// 직접 저장한 버전(manual)과 이름 붙인 버전은 지우지 않는다.
export async function pruneSnapshots(chapterId) {
  const list = await snapshotsOf(chapterId);
  const now = Date.now();
  const seen = new Set();
  for (const s of list) {
    const age = now - s.time;
    // 크게 지우기 전에 자동으로 남긴 버전은 30일 동안 둔다
    if (s.kind === 'safety') { if (age > 30 * 864e5) await deleteSnapshot(s.id); continue; }
    if (s.kind !== 'auto' || s.label) continue;
    if (age < 3 * 864e5) continue;
    const d = new Date(s.time);
    const bucket = age < 30 * 864e5 ? `${today(d)} ${d.getHours()}` : today(d);
    if (seen.has(bucket)) await deleteSnapshot(s.id);
    else seen.add(bucket);
  }
}

// ---------- 일일 기록 ----------
export async function getDaily(projectId, date = today()) {
  return (await db()).get('daily', `${projectId}|${date}`);
}
export async function putDaily(rec) { await (await db()).put('daily', rec); }
export async function dailyOf(projectId) {
  const all = await (await db()).getAll('daily');
  return all.filter((r) => r.projectId === projectId).sort((a, b) => a.date.localeCompare(b.date));
}

export async function dailyAll() { return (await db()).getAll('daily'); }

// ---------- 설정 ----------
export async function kvGet(k, def) { const v = await (await db()).get('kv', k); return v === undefined ? def : v; }
export async function kvSet(k, v) { await (await db()).put('kv', v, k); }

// ---------- 문장 보관함 (지우거나 잘라 낸 긴 문장) ----------
// 항목: { id, t, text, kind: 'cut'|'del', ch, title }. 지운 항목은 gone으로 남겨 다른 기기와 맞출 때 되살아나지 않게 한다.
export const stashKey = (pid) => `stash:${pid}`;
export async function stashOf(pid) { return kvGet(stashKey(pid), []); }
export async function putStash(pid, list) { await kvSet(stashKey(pid), list); }
export function mergeStash(a = [], b = []) {
  const m = new Map();
  for (const x of [...a, ...b]) {
    if (!x || typeof x.id !== 'string' || (typeof x.text !== 'string' && !x.gone)) continue;
    const cur = m.get(x.id);
    if (!cur) { m.set(x.id, x); continue; }
    if (x.gone || cur.gone) m.set(x.id, { id: x.id, t: Math.max(x.t || 0, cur.t || 0), gone: true, text: '' });
    else if ((x.t || 0) > (cur.t || 0)) m.set(x.id, x);
  }
  return [...m.values()].sort((x, y) => (x.t || 0) - (y.t || 0));
}

// ---------- 백업 (드라이브 동기화·파일 백업용) ----------
export async function exportBundle(projectId, { withHistory = true } = {}) {
  const d = await db();
  const project = await d.get('projects', projectId);
  const chapters = (await chaptersOf(projectId)).map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_'))));
  const notes = await notesOf(projectId);
  const snapshots = withHistory ? await d.getAllFromIndex('snapshots', 'projectId', projectId) : [];
  const daily = await dailyOf(projectId);
  const stash = await stashOf(projectId);
  return { format: 'novel-writer', version: 1, exported: Date.now(), project, chapters, notes, snapshots, daily, stash };
}

// 버전 기록을 작게 묶기: 장마다 시간순으로 늘어놓고, 바로 앞 버전과 비교해 달라진 문단만 담는다.
// d: [[앞 버전 문단 번호, 개수] | '새 문단 HTML', ...]  — 30만 자짜리 장도 버전 하나가 보통 몇 KB로 줄어든다.
const splitBlocks = (html) => (html || '').split(/(?<=<\/(?:p|h[1-6]|blockquote|ul|ol|li)>|<hr>)/);
export function packSnapshots(snaps) {
  const byCh = new Map();
  for (const s of snaps) (byCh.get(s.chapterId) || byCh.set(s.chapterId, []).get(s.chapterId)).push(s);
  const out = [];
  for (const list of byCh.values()) {
    list.sort((a, b) => a.time - b.time);
    let prev = null;
    for (const s of list) {
      const { html, ...meta } = s;
      if (!prev) { out.push(s); prev = s; continue; }
      const d = [];
      let ai = 0, size = 0;
      for (const part of diffArrays(splitBlocks(prev.html), splitBlocks(html))) {
        if (part.removed) { ai += part.count; continue; }
        if (part.added) { const t = part.value.join(''); d.push(t); size += t.length; continue; }
        d.push([ai, part.count]); ai += part.count;
      }
      out.push(size > (html || '').length * 0.8 ? s : { ...meta, base: prev.id, d });
      prev = s;
    }
  }
  return out;
}
export function unpackSnapshots(snaps) {
  const blocks = new Map();
  return snaps.map((s) => {
    if (!s.d) { blocks.set(s.id, splitBlocks(s.html)); return s; }
    const { d, base, ...meta } = s;
    const A = blocks.get(base) || [];
    const B = [];
    for (const x of d) {
      if (typeof x === 'string') B.push(...splitBlocks(x));
      else for (let k = x[0]; k < x[0] + x[1]; k++) B.push(A[k]);
    }
    blocks.set(s.id, B);
    return { ...meta, html: B.join('') };
  });
}
// 파일·드라이브에 올릴 묶음 (버전 기록은 바뀐 곳만)
export const packBundle = (b) => ({ ...b, version: 2, snapshots: packSnapshots(b.snapshots || []) });

// 드라이브용 압축 (gzip)
export async function gzip(text) {
  if (typeof CompressionStream === 'undefined') return new Blob([text], { type: 'application/json' });
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
export async function readBundleBytes(buf) {
  const u = new Uint8Array(buf.slice(0, 2));
  if (u[0] === 0x1f && u[1] === 0x8b) {
    return JSON.parse(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

// 백업 묶음을 검사하고 들여올 모양으로 정리한다. 잘못된 묶음은 아무것도 쓰기 전에 거절한다.
export function checkBundle(b) {
  if (!b || b.format !== 'novel-writer') throw new Error('이 앱의 백업 파일이 아닙니다.');
  if (b.version != null && !(+b.version >= 1 && +b.version <= 2)) throw new Error(`지원하지 않는 백업 버전입니다 (${b.version}). 앱을 최신으로 올린 뒤 다시 열어 주세요.`);
  const p = b.project;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) throw new Error('백업에 작품 정보가 없습니다.');
  if (!Array.isArray(b.chapters)) throw new Error('백업에 장 목록이 없습니다.');
  const dup = (list, what) => {
    const seen = new Set();
    for (const x of list) {
      if (!x || typeof x.id !== 'string' || !x.id) throw new Error(`백업의 ${what} 아이디가 비어 있습니다.`);
      if (seen.has(x.id)) throw new Error(`백업에 같은 ${what} 아이디가 두 번 있습니다 (${x.id}).`);
      seen.add(x.id);
    }
    return seen;
  };
  const chIds = dup(b.chapters, '장');
  dup(b.notes || [], '자료');
  const order = Array.isArray(p.order) ? p.order : [];
  const missing = order.filter((id) => !chIds.has(id));
  if (missing.length) throw new Error(`백업의 장 순서가 없는 장을 가리킵니다 (${missing.length}개). 파일이 손상되었을 수 있어요.`);
  if ((b.snapshots || []).some((s) => s.d)) b = { ...b, snapshots: unpackSnapshots(b.snapshots) };
  // 남이 만든 백업일 수 있으니 원고 HTML에서 스크립트 등을 걸러 낸다
  return {
    ...b,
    project: { ...p, order: [...order, ...b.chapters.map((c) => c.id).filter((id) => !order.includes(id))] },
    chapters: b.chapters.map((c) => ({ ...c, html: sanitizeHtml(typeof c.html === 'string' ? c.html : '') })),
    notes: b.notes || [],
    snapshots: (b.snapshots || []).map((s) => ({ ...s, html: sanitizeHtml(s.html) })),
    daily: b.daily || [],
    stash: Array.isArray(b.stash) ? b.stash.filter((x) => x && typeof x.id === 'string' && (typeof x.text === 'string' || x.gone)).map((x) => ({ ...x, text: x.gone ? '' : x.text, title: typeof x.title === 'string' ? x.title : '' })) : [],
  };
}

const trashItem = (item) => ({ id: uid(), time: Date.now(), ...item });

/**
 * 백업 묶음을 들여온다. 모든 쓰기는 한 트랜잭션: 중간에 실패하면 아무것도 바뀌지 않는다.
 * mode
 *  - 'copy'    사본: 모든 아이디를 새로 만들어 기존 작품과 섞이지 않는다.
 *  - 'restore' 덮어쓰기: 작품을 백업 상태 그대로 되돌린다. 백업에 없는 장·자료는 지우되,
 *              덮어쓰기 전 작품 전체를 휴지통에 ‘덮어쓰기 전’ 작품으로 남겨 되살릴 수 있다.
 *              버전 기록은 지우지 않고 더한다. 하루 기록은 백업에 있는 날만 바꾼다.
 *  - 'merge'   동기화: 받은 장·자료로 바꾸고, 이 기기에만 있는 장·자료는
 *              since(마지막 동기화 시각) 뒤에 고친 것이면 남기고(다른 기기에서 지운 뒤 여기서 고침),
 *              그 전 것이면 다른 기기에서 지운 것으로 보고 휴지통으로 옮긴다. since가 없으면 모두 남긴다.
 *  바뀌는 장의 지금 원고는 버전 기록(‘덮어쓰기 전 이 기기 버전’)으로 남긴다.
 */
export async function importBundle(raw, { keepIds = true, mode = keepIds ? 'merge' : 'copy', since = 0, keepLocal = {} } = {}) {
  let b = checkBundle(raw);
  const copy = mode === 'copy';
  const map = new Map();
  // 아이디는 화면 HTML 속성에도 들어가므로, 이상한 글자가 섞인 아이디는 새로 만든다
  const nid = (old) => {
    if (!copy && /^[\w-]{1,64}$/.test(String(old ?? ''))) return old;
    if (!map.has(old)) map.set(old, uid());
    return map.get(old);
  };
  // 자료(주석) 아이디가 바뀌면 원고 HTML의 data-anno도 함께 바꾼다
  for (const n of b.notes) nid(n.id);
  const reAnno = (html) => {
    if (!html || !html.includes('data-anno=')) return html;
    let out = html;
    for (const [o, nw] of map) if (o !== nw && out.includes(`data-anno="${o}"`)) out = out.split(`data-anno="${o}"`).join(`data-anno="${nw}"`);
    return out;
  };
  const project = { ...b.project, id: nid(b.project.id) };
  if (copy) for (const k of ['syncedAt', 'srvSyncedAt', 'driveFileId', 'syncedSize', 'srvSyncedSize', 'syncLocal']) delete project[k];
  // 쪽 설정 값은 화면·인쇄용 CSS에 들어가므로 숫자·참거짓·안전한 글자만 남긴다
  if (project.layout && typeof project.layout === 'object') {
    project.layout = Object.fromEntries(Object.entries(project.layout).filter(([, v]) =>
      (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && v.length < 120 && !/[<>{};\\]|\/\*/.test(v))));
  } else delete project.layout;
  project.order = project.order.map(nid);
  const chapters = b.chapters.map((c) => ({ ...c, html: reAnno(c.html), id: nid(c.id), projectId: project.id }));
  const notes = b.notes.map((n) => ({ ...n, id: nid(n.id), projectId: project.id }));
  const snapshots = b.snapshots.map((s) => ({ ...s, html: reAnno(s.html), id: nid(s.id), chapterId: nid(s.chapterId), projectId: project.id }));
  const daily = b.daily.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x?.date || '')).map((r) => ({ ...r, projectId: project.id, key: `${project.id}|${r.date}` }));

  const d = await db();
  const tx = d.transaction(['projects', 'chapters', 'notes', 'snapshots', 'daily', 'kv'], 'readwrite');
  const T = (n) => tx.objectStore(n);
  try {
    // 다른 작품의 장·자료와 아이디가 겹치면 거절 (그 작품을 망가뜨리지 않게)
    for (const c of chapters) { const cur = await T('chapters').get(c.id); if (cur && cur.projectId !== project.id) throw new Error(`다른 작품의 장과 아이디가 겹칩니다 (${c.id}). ‘사본으로 불러오기’를 쓰세요.`); }
    for (const n of notes) { const cur = await T('notes').get(n.id); if (cur && cur.projectId !== project.id) throw new Error(`다른 작품의 자료와 아이디가 겹칩니다 (${n.id}). ‘사본으로 불러오기’를 쓰세요.`); }
    const local = copy ? null : await T('projects').get(project.id);
    const localCh = local ? await T('chapters').index('projectId').getAll(project.id) : [];
    const localNotes = local ? await T('notes').index('projectId').getAll(project.id) : [];
    const incomingCh = new Set(chapters.map((c) => c.id)), incomingNotes = new Set(notes.map((n) => n.id));
    let trash = null;
    const addTrash = async (item) => { trash ??= ((await T('kv').get('trash')) || []); trash.unshift(trashItem(item)); };
    const dropChapter = async (id) => {
      await T('chapters').delete(id);
      for (const k of await T('snapshots').index('chapterId').getAllKeys(id)) await T('snapshots').delete(k);
    };

    if (mode === 'restore' && local) {
      // 덮어쓰기 전 작품 전체를 휴지통에 남긴다 (되살리면 사본 작품으로 돌아온다)
      const before = {
        format: 'novel-writer', version: 2, exported: Date.now(), project: local,
        chapters: localCh, notes: localNotes,
        snapshots: packSnapshots(await T('snapshots').index('projectId').getAll(project.id)),
        daily: (await T('daily').getAll()).filter((r) => r.projectId === project.id),
      };
      await addTrash({ kind: 'project', title: `${local.title} (덮어쓰기 전)`, bundle: before });
      for (const c of localCh) if (!incomingCh.has(c.id)) await dropChapter(c.id);
      for (const n of localNotes) if (!incomingNotes.has(n.id)) await T('notes').delete(n.id);
    }

    if (mode === 'merge' && local) {
      // 이 기기에만 있는 장·자료
      for (const c of localCh) {
        if (incomingCh.has(c.id)) continue;
        if (since && (c.updated || 0) <= since && !keepLocal[c.id]) {
          const snaps = await T('snapshots').index('chapterId').getAll(c.id);
          await addTrash({ kind: 'chapter', title: c.title, projectId: c.projectId, projectTitle: local.title, index: (local.order || []).indexOf(c.id), chapter: c, snapshots: packSnapshots(snaps), why: 'sync' });
          await dropChapter(c.id);
        } else project.order.push(c.id);
      }
      for (const n of localNotes) {
        if (incomingNotes.has(n.id)) continue;
        if (since && (n.updated || 0) <= since) await T('notes').delete(n.id);
      }
      if (local.syncLocal) project.syncLocal = local.syncLocal; // 이 기기의 마지막 동기화 시각은 이 기기 것
      // 쪽 설정은 더 나중에 바꾼 쪽을 남긴다 (이 기기에서 바꾸고 아직 올리기 전에 받아 와도 되돌아가지 않게)
      if (local.layout && (local.layoutAt || 0) > (project.layoutAt || 0)) { project.layout = local.layout; project.layoutAt = local.layoutAt; }
    }

    for (const c of chapters) {
      const cur = await T('chapters').get(c.id);
      if (cur && cur.html !== c.html) {
        await T('snapshots').put({ id: uid(), chapterId: cur.id, projectId: cur.projectId, time: Date.now(), kind: 'auto', label: mode === 'restore' ? '덮어쓰기 전 이 기기 버전' : '동기화 전 이 기기 버전', html: cur.html, title: cur.title });
      }
      await T('chapters').put(c);
    }
    for (const n of notes) await T('notes').put(n);
    for (const s of snapshots) if (!(await T('snapshots').get(s.id))) await T('snapshots').put(s);
    for (const r of daily) await T('daily').put(r);
    // 문장 보관함은 양쪽을 합친다 (어느 기기에서 담은 문장도 잃지 않게)
    if (b.stash.length) {
      const inc = b.stash.map((x) => ({ ...x, ch: x.ch && map.has(x.ch) ? map.get(x.ch) : x.ch }));
      const cur = copy ? [] : ((await T('kv').get(stashKey(project.id))) || []);
      await T('kv').put(mergeStash(cur, inc), stashKey(project.id));
    }
    if (trash) await T('kv').put(trash, 'trash');
    await T('projects').put(project);
    await tx.done;
  } catch (e) {
    try { tx.abort(); } catch { /* 이미 끝남 */ }
    await tx.done.catch(() => {});
    throw e;
  }
  return project;
}
