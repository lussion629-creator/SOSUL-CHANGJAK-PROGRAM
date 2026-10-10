// 로컬 저장소 (IndexedDB). 모든 원고·자료·버전 기록은 기기 안에 먼저 저장된다.
import { openDB } from 'idb';

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
  const tx = d.transaction(['projects', 'chapters', 'notes', 'snapshots'], 'readwrite');
  for (const store of ['chapters', 'notes', 'snapshots']) {
    const keys = await tx.objectStore(store).index('projectId').getAllKeys(id);
    for (const k of keys) await tx.objectStore(store).delete(k);
  }
  await tx.objectStore('projects').delete(id);
  await tx.done;
}

// ---------- 장(원고) ----------
export function newChapter(projectId, title = '새 장', html = '') {
  return { id: uid(), projectId, title, html, status: 'draft', synopsis: '', label: '', created: Date.now(), updated: Date.now() };
}
export async function getChapter(id) { return (await db()).get('chapters', id); }
export async function putChapter(c) { await (await db()).put('chapters', c); return c; }
export async function chaptersOf(projectId) { return (await db()).getAllFromIndex('chapters', 'projectId', projectId); }
export async function deleteChapter(id) {
  const d = await db();
  await d.delete('chapters', id);
  const keys = await d.getAllKeysFromIndex('snapshots', 'chapterId', id);
  for (const k of keys) await d.delete('snapshots', k);
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
    if (s.kind !== 'auto' || s.label) continue;
    const age = now - s.time;
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

// ---------- 백업 (드라이브 동기화·파일 백업용) ----------
export async function exportBundle(projectId, { withHistory = true } = {}) {
  const d = await db();
  const project = await d.get('projects', projectId);
  const chapters = await chaptersOf(projectId);
  const notes = await notesOf(projectId);
  const snapshots = withHistory ? await d.getAllFromIndex('snapshots', 'projectId', projectId) : [];
  const daily = await dailyOf(projectId);
  return { format: 'novel-writer', version: 1, exported: Date.now(), project, chapters, notes, snapshots, daily };
}

// 백업 묶음을 들여온다. 같은 id가 있으면 덮어쓰기 전에 현재 원고를 버전 기록으로 남긴다.
export async function importBundle(b, { keepIds = true } = {}) {
  if (!b || b.format !== 'novel-writer') throw new Error('이 앱의 백업 파일이 아닙니다.');
  const d = await db();
  const map = new Map();
  const nid = (old) => { if (keepIds) return old; if (!map.has(old)) map.set(old, uid()); return map.get(old); };
  const project = { ...b.project, id: nid(b.project.id) };
  project.order = (project.order || []).map(nid);
  for (const c of b.chapters) {
    const id = nid(c.id);
    const cur = await d.get('chapters', id);
    if (cur && cur.html !== c.html) await addSnapshot(cur, 'auto', '동기화 전 이 기기 버전');
    await d.put('chapters', { ...c, id, projectId: project.id });
  }
  for (const n of b.notes || []) await d.put('notes', { ...n, id: nid(n.id), projectId: project.id });
  for (const s of b.snapshots || []) {
    const id = nid(s.id);
    if (!(await d.get('snapshots', id))) await d.put('snapshots', { ...s, id, chapterId: nid(s.chapterId), projectId: project.id });
  }
  for (const r of b.daily || []) await d.put('daily', { ...r, projectId: project.id, key: `${project.id}|${r.date}` });
  await d.put('projects', project);
  return project;
}
