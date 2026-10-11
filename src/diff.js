// 퇴고 비교: 두 원고의 차이를 문단 → 낱말 단위로 계산한다
import { diffArrays } from 'diff';

export const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/￼/g, ' ');
const tokenize = (s) => s.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || [];

// 한 쌍의 문단을 낱말 단위로 비교
function wordDiff(a, b) {
  const parts = diffArrays(tokenize(a), tokenize(b));
  let left = '', right = '', added = 0, removed = 0, off = 0;
  const ins = [], dels = [], changes = [];
  for (const p of parts) {
    const v = p.value.join('');
    if (p.added) {
      right += `<ins>${esc(v)}</ins>`; added += v.trim().length;
      ins.push([off, off + v.length]); off += v.length;
      if (v.trim()) changes.push({ type: 'add', text: v });
    } else if (p.removed) {
      left += `<del>${esc(v)}</del>`; removed += v.trim().length;
      dels.push({ at: off, text: v });
      if (v.trim()) changes.push({ type: 'del', text: v });
    } else { left += esc(v); right += esc(v); off += v.length; }
  }
  return { left, right, added, removed, ins, dels, changes };
}

function ratio(a, b) {
  const parts = diffArrays(tokenize(a), tokenize(b));
  let same = 0;
  for (const p of parts) if (!p.added && !p.removed) same += p.value.join('').length;
  return same / (Math.max(a.length, b.length) || 1);
}

/**
 * 문단 배열 두 개를 비교한다.
 * rows: {type:'same'|'changed'|'added'|'removed', left, right (html|null), li, ri (문단 번호), ins:[[s,e]], dels:[{at,text}]}
 * 삭제된 문단(removed)의 ri는 "그 자리 바로 뒤에 오는 새 문단 번호"다.
 */
export function compare(oldParas, newParas) {
  const parts = diffArrays(oldParas, newParas);
  const rows = [], changes = [];
  const stats = { added: 0, removed: 0, addedParas: 0, removedParas: 0, changedParas: 0 };
  let li = 0, ri = 0;

  const added = (t) => {
    rows.push({ type: 'added', left: null, right: `<ins>${esc(t)}</ins>`, ri: ri++, ins: [[0, t.length]], dels: [] });
    stats.added += t.trim().length; stats.addedParas++;
    if (t.trim()) changes.push({ type: 'add', text: t, row: rows.length - 1, whole: true });
  };
  const removed = (t) => {
    rows.push({ type: 'removed', left: `<del>${esc(t)}</del>`, right: null, li: li++, ri, ins: [], dels: [] });
    stats.removed += t.trim().length; stats.removedParas++;
    if (t.trim()) changes.push({ type: 'del', text: t, row: rows.length - 1, whole: true });
  };

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (const t of p.value) rows.push({ type: 'same', left: esc(t), right: esc(t), li: li++, ri: ri++, ins: [], dels: [] });
      continue;
    }
    if (p.removed && parts[i + 1]?.added) {
      const dels = p.value, adds = parts[i + 1].value;
      i++;
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const a = dels[k], b = adds[k];
        if (a === undefined) { added(b); continue; }
        if (b === undefined) { removed(a); continue; }
        if (ratio(a, b) < 0.35) { removed(a); added(b); continue; }
        const w = wordDiff(a, b);
        rows.push({ type: 'changed', left: w.left, right: w.right, li: li++, ri: ri++, ins: w.ins, dels: w.dels });
        stats.added += w.added; stats.removed += w.removed; stats.changedParas++;
        for (const c of w.changes) changes.push({ ...c, row: rows.length - 1 });
      }
      continue;
    }
    for (const t of p.value) (p.added ? added : removed)(t);
  }
  return { rows, changes, stats };
}

/**
 * 고친 분량 세기 (공백 제외 글자 수)
 * - 쓴 양(add): 새로 써 넣은 글자
 * - 고친 양(rev): 원래 있던 말을 다른 말로 바꾼 자리의 새 글자
 * - 지운 양(del): 바꾸지 않고 지우기만 한 글자
 */
export function editAmounts(oldParas, newParas) {
  const n = (s) => s.replace(/\s/g, '').length;
  const out = { add: 0, rev: 0, del: 0 };
  const parts = diffArrays(oldParas, newParas);
  // 바뀐 덩어리: 앞뒤로 같은 글자를 떼고 남은 부분만 센다 ("오래" → "오래된"은 '쓴 양' 1글자)
  const replaced = (d, a) => {
    let i = 0;
    while (i < d.length && i < a.length && d[i] === a[i]) i++;
    let j = 0;
    while (j < d.length - i && j < a.length - i && d[d.length - 1 - j] === a[a.length - 1 - j]) j++;
    const dd = n(d.slice(i, d.length - j)), aa = n(a.slice(i, a.length - j));
    if (!dd) out.add += aa;
    else if (!aa) out.del += dd;
    else { out.rev += aa; if (dd > aa) out.del += dd - aa; }
  };
  const tokenLevel = (a, b) => {
    const ps = diffArrays(tokenize(a), tokenize(b));
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p.added && !p.removed) continue;
      const next = ps[i + 1];
      // 지운 덩어리와 써 넣은 덩어리가 붙어 있으면 '고침'
      if (next && ((p.removed && next.added) || (p.added && next.removed))) {
        replaced((p.removed ? p : next).value.join(''), (p.added ? p : next).value.join(''));
        i++;
        continue;
      }
      if (p.added) out.add += n(p.value.join(''));
      else out.del += n(p.value.join(''));
    }
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) continue;
    if (p.removed && parts[i + 1]?.added) {
      const dels = p.value, adds = parts[i + 1].value;
      i++;
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const a = dels[k], b = adds[k];
        if (a === undefined) out.add += n(b);
        else if (b === undefined) out.del += n(a);
        else if (keepRatio(a, b) < 0.35) { out.del += n(a); out.add += n(b); }
        else tokenLevel(a, b);
      }
      continue;
    }
    for (const t of p.value) out[p.added ? 'add' : 'del'] += n(t);
  }
  return out;
}

/**
 * 기준 원고(전날·지난번)와 지금 원고의 순 변화 (공백 제외 글자 수)
 * - plus: 기준에 없던 글자, minus: 기준에서 없어진 글자. 썼다가 같은 날 지운 글자는 어느 쪽에도 안 남는다.
 */
export function netAmounts(oldParas, newParas) {
  const n = (s) => s.replace(/\s/g, '').length;
  const out = { plus: 0, minus: 0 };
  const keep = (ps) => ps.filter((p) => p.trim()); // 빈 줄은 글자가 없고, 맞춰 보는 데 방해만 된다
  const parts = diffArrays(keep(oldParas), keep(newParas));
  // 같은 문단 사이의 바뀐 덩어리(지운 문단 + 새 문단)를 통째로 낱말 단위로 견준다.
  // 문단을 옮기거나 합치거나 나눠도 실제로 바뀐 글자만 센다.
  const flush = (a, b) => {
    if (!a && !b) return;
    if (a.length + b.length > 60000) { out.minus += n(a); out.plus += n(b); return; }
    for (const t of diffArrays(tokenize(a), tokenize(b))) if (t.added) out.plus += n(t.value.join('')); else if (t.removed) out.minus += n(t.value.join(''));
  };
  let a = [], b = [];
  for (const p of parts) {
    if (p.added) b.push(...p.value);
    else if (p.removed) a.push(...p.value);
    else { flush(a.join('\n'), b.join('\n')); a = []; b = []; }
  }
  flush(a.join('\n'), b.join('\n'));
  return out;
}

// 옛 문단이 새 문단에 얼마나 남아 있는지 (문단이 길어지기만 했으면 1에 가깝다)
function keepRatio(a, b) {
  const parts = diffArrays(tokenize(a), tokenize(b));
  let same = 0;
  for (const p of parts) if (!p.added && !p.removed) same += p.value.join('').length;
  return a.length ? same / a.length : 0;
}

// ---------- 바뀐 내용 요약 ----------
const clip = (s, n = 40) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const tail = (s, n = 12) => { s = s.replace(/\s+/g, ' '); return s.length > n ? '…' + s.slice(-n) : s; };
const head = (s, n = 12) => { s = s.replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; };

// 고친 문단 하나에서 바뀐 자리들: [{before, del, add, after}]
function edits(a, b, max = 3) {
  const ps = diffArrays(tokenize(a), tokenize(b));
  const out = [];
  let same = '';
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (!p.added && !p.removed) { same = p.value.join(''); if (out.length && out[out.length - 1].after == null) out[out.length - 1].after = head(same); continue; }
    let del = '', add = '';
    while (i < ps.length && (ps[i].added || ps[i].removed)) {
      if (ps[i].added) add += ps[i].value.join(''); else del += ps[i].value.join('');
      i++;
    }
    i--;
    if (!del.trim() && !add.trim()) continue;
    out.push({ before: tail(same), del: clip(del, 30), add: clip(add, 30), after: null });
  }
  for (const e of out) if (e.after == null) e.after = '';
  return { list: out.slice(0, max), more: Math.max(0, out.length - max) };
}

/**
 * 두 버전의 문단 목록을 비교해 "어디가 어떻게 바뀌었는지" 정리한다.
 * places: {kind:'changed'|'added'|'removed', at(새 원고 기준 문단 번호, 1부터), pos(0~100 %), add, del, edits}
 */
export function summarize(oldParas, newParas, max = 40) {
  const { rows, stats } = compare(oldParas, newParas);
  const places = [];
  const N = Math.max(1, newParas.length);
  for (const r of rows) {
    if (r.type === 'same') continue;
    const at = r.ri + 1;
    const item = { kind: r.type, at, pos: Math.min(100, Math.round((r.ri / N) * 100)) };
    if (r.type === 'added') { if (!newParas[r.ri].trim()) continue; item.add = clip(newParas[r.ri], 60); }
    else if (r.type === 'removed') { if (!oldParas[r.li].trim()) continue; item.del = clip(oldParas[r.li], 60); }
    else { const e = edits(oldParas[r.li], newParas[r.ri]); if (!e.list.length) continue; item.edits = e.list; item.more = e.more; }
    // 붙어 있는 추가·삭제 문단은 하나로 묶는다
    const last = places[places.length - 1];
    if (last && last.kind === item.kind && item.kind !== 'changed' && item.at - (last.at + (last.n || 1) - 1) <= 1) {
      last.n = (last.n || 1) + 1;
      continue;
    }
    places.push(item);
  }
  return { stats, total: places.length, places: places.slice(0, max) };
}

// 원고 어디쯤인지 말로
export const where = (pos) => (pos < 20 ? '앞부분' : pos < 40 ? '앞쪽' : pos < 60 ? '가운데' : pos < 80 ? '뒤쪽' : '끝부분');

// 요약 한 줄 (버전 목록용)
export function summaryLine(sm) {
  if (!sm || !sm.total) return '바뀐 곳 없음';
  const c = sm.places.filter((p) => p.kind === 'changed').length;
  const a = sm.places.filter((p) => p.kind === 'added').reduce((n, p) => n + (p.n || 1), 0);
  const d = sm.places.filter((p) => p.kind === 'removed').reduce((n, p) => n + (p.n || 1), 0);
  const bits = [c && `${c}곳 고침`, a && `${a}문단 추가`, d && `${d}문단 삭제`].filter(Boolean).join(' · ');
  const p = sm.places[0];
  let ex = '';
  if (p.kind === 'changed') { const e = p.edits[0]; ex = e.del && e.add ? `‘${e.del}’→‘${e.add}’` : e.add ? `+‘${e.add}’` : `−‘${e.del}’`; }
  else if (p.kind === 'added') ex = `+‘${clip(p.add, 18)}’`;
  else ex = `−‘${clip(p.del, 18)}’`;
  return `${bits} · ${p.at}문단 ${ex}`;
}
