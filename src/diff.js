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

// 옛 문단이 새 문단에 얼마나 남아 있는지 (문단이 길어지기만 했으면 1에 가깝다)
function keepRatio(a, b) {
  const parts = diffArrays(tokenize(a), tokenize(b));
  let same = 0;
  for (const p of parts) if (!p.added && !p.removed) same += p.value.join('').length;
  return a.length ? same / a.length : 0;
}
