// 하루 기록 그래프: 날마다 쓴 양·고친 양·지운 양을 따로, 쌓아서, 또는 합산해서 본다
import * as S from './store.js';
import { app, saveNow } from './app.js';
import { fmt } from './stats.js';
import { $, $$, h, dialog } from './ui.js';

const SERIES = [
  { key: 'add', name: '쓴 양', cls: 's-add' },
  { key: 'rev', name: '고친 양', cls: 's-rev' },
  { key: 'del', name: '지운 양', cls: 's-del' },
];
const view = { range: 30, mode: 'group', scope: 'project', on: { add: true, rev: true, del: true } };
try { Object.assign(view, JSON.parse(localStorage.getItem('nw-statview') || '{}')); } catch { /* 무시 */ }

// 날짜별 합계 (예전 기록에는 쓴 양 대신 늘어난 글자 수를 쓴다)
async function dailyRows(scope) {
  const all = scope === 'project' ? await S.dailyOf(app.project.id) : await S.dailyAll();
  const by = new Map();
  for (const r of all) {
    const v = by.get(r.date) || { add: 0, rev: 0, del: 0 };
    v.add += r.add ?? Math.max(0, (r.end || 0) - (r.start || 0));
    v.rev += r.rev || 0;
    v.del += r.del || 0;
    by.set(r.date, v);
  }
  return by;
}

function dayList(by, range) {
  const days = [];
  let n = range;
  if (range === 'all') {
    const first = [...by.keys()].sort()[0];
    n = first ? Math.max(7, Math.ceil((Date.parse(S.today()) - Date.parse(first)) / 864e5) + 1) : 30;
  }
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = S.today(d);
    days.push({ date: k, ...(by.get(k) || { add: 0, rev: 0, del: 0 }) });
  }
  return days;
}

function chartSvg(days, width = 760) {
  const keys = SERIES.filter((s) => view.on[s.key]);
  if (!keys.length) return '<p class="hint" style="margin:0">위에서 볼 항목을 하나 이상 고르세요.</p>';
  const W = Math.max(300, Math.round(width)), H = W < 500 ? 200 : 240, L = 40, R = 8, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const val = (d) => (view.mode === 'group' ? Math.max(...keys.map((s) => d[s.key])) : keys.reduce((a, s) => a + d[s.key], 0));
  const step = niceStep(Math.max(1, ...days.map(val)) / 4);
  const max = step * 4;
  const y = (v) => T + ih - (v / max) * ih;
  const slot = iw / days.length;
  const gap = Math.min(4, slot * 0.2);
  let g = '';
  // 눈금
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="tick">${fmtShort(v)}</text>`;
  }
  // 날짜 눈금: 7개 안팎
  const labels = Math.max(3, Math.floor(iw / 70));
  const every = Math.max(1, Math.ceil(days.length / labels));
  const lastI = days.length - 1;
  days.forEach((d, i) => {
    if ((i % every === 0 && lastI - i >= every * 0.6) || i === lastI) {
      const [, m, dd] = d.date.split('-');
      // 양 끝 날짜는 그래프 밖으로 잘리지 않게 안쪽으로 붙인다
      const [x, anchor] = i === lastI ? [L + slot * (i + 1), 'end'] : i === 0 ? [L, 'start'] : [L + slot * i + slot / 2, 'middle'];
      g += `<text x="${x}" y="${H - 8}" text-anchor="${anchor}" class="tick">${+m}/${+dd}</text>`;
    }
  });
  const bw = slot - gap;
  days.forEach((d, i) => {
    const x0 = L + slot * i + gap / 2;
    const tip = `${d.date} · ` + SERIES.map((s) => `${s.name} ${fmt(d[s.key])}`).join(' · ') + ` · 합계 ${fmt(d.add + d.rev + d.del)}`;
    if (view.mode === 'group') {
      const w = bw / keys.length;
      keys.forEach((s, k) => { if (d[s.key]) g += bar(x0 + w * k, w, y(d[s.key]), y(0), s.cls); });
    } else if (view.mode === 'stack') {
      let acc = 0;
      keys.forEach((s) => {
        if (!d[s.key]) return;
        g += bar(x0, bw, y(acc + d[s.key]), y(acc), s.cls, acc > 0);
        acc += d[s.key];
      });
    } else {
      const t = keys.reduce((a, s) => a + d[s.key], 0);
      if (t) g += bar(x0, bw, y(t), y(0), 's-sum');
    }
    g += `<rect x="${L + slot * i}" y="${T}" width="${slot}" height="${ih}" class="hit"><title>${h(tip)}</title></rect>`;
  });
  g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="axis"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="daychart" role="img" aria-label="날짜별 글쓰기 기록">${g}</svg>`;
}

function bar(x, w, top, bottom, cls, stacked) {
  const hgt = Math.max(1, bottom - top - (stacked ? 2 : 0)); // 쌓을 때는 2px 틈
  const r = Math.min(4, w / 2, hgt);
  const yy = bottom - (stacked ? 2 : 0) - hgt;
  // 위쪽 모서리만 둥글게
  return `<path class="${cls}" d="M${x},${yy + hgt} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + w - r} Q${x + w},${yy} ${x + w},${yy + r} V${yy + hgt} Z"/>`;
}
// 눈금 한 칸: 1·2·5 단위로 반올림
function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, v)));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return Math.max(1, m * p);
  return v;
}
const fmtShort = (v) => (v >= 10000 ? +(v / 10000).toFixed(1) + '만' : fmt(Math.round(v)));

function body(days, width) {
  const tot = { add: 0, rev: 0, del: 0 };
  for (const d of days) for (const k in tot) tot[k] += d[k];
  const active = days.filter((d) => d.add + d.rev + d.del > 0).length;
  const sum = tot.add + tot.rev + tot.del;
  const legend = SERIES.filter((s) => view.on[s.key]);
  const rows = days.filter((d) => d.add + d.rev + d.del > 0).reverse();
  return `
    <div class="statgrid">
      <div class="stat"><b class="tn">${fmt(tot.add)}</b><span><i class="sw s-add"></i>쓴 양</span></div>
      <div class="stat"><b class="tn">${fmt(tot.rev)}</b><span><i class="sw s-rev"></i>고친 양</span></div>
      <div class="stat"><b class="tn">${fmt(tot.del)}</b><span><i class="sw s-del"></i>지운 양</span></div>
      <div class="stat"><b class="tn">${fmt(sum)}</b><span>합계 (${active}일 동안)</span></div>
    </div>
    <div class="chartbox">
      ${view.mode === 'sum'
        ? `<div class="legend"><span><i class="sw s-sum"></i>${legend.map((s) => s.name).join(' + ')} 합산</span></div>`
        : `<div class="legend">${legend.map((s) => `<span><i class="sw ${s.cls}"></i>${s.name}</span>`).join('')}</div>`}
      ${chartSvg(days, width)}
    </div>
    <details><summary>날짜별 표로 보기</summary>
      <div class="tablewrap"><table class="daytable"><thead><tr><th>날짜</th><th>쓴 양</th><th>고친 양</th><th>지운 양</th><th>합계</th></tr></thead>
      <tbody>${rows.map((d) => `<tr><td>${d.date}</td><td>${fmt(d.add)}</td><td>${fmt(d.rev)}</td><td>${fmt(d.del)}</td><td>${fmt(d.add + d.rev + d.del)}</td></tr>`).join('') || '<tr><td colspan="5">이 기간에는 기록이 없습니다.</td></tr>'}</tbody></table></div>
    </details>
    <p class="hint" style="margin:0">글자 수는 공백을 뺀 수입니다. 쓴 양은 새로 써 넣은 글자, 고친 양은 있던 말을 다른 말로 바꾼 자리, 지운 양은 지우기만 한 글자입니다. 손을 멈추고 저장될 때마다 셉니다.</p>`;
}

export async function showStats() {
  await saveNow();
  const save = () => { try { localStorage.setItem('nw-statview', JSON.stringify(view)); } catch { /* 무시 */ } };
  const controls = () => `
    <div class="statctl">
      <div class="seg" data-g="range">${[[7, '7일'], [30, '30일'], [90, '90일'], ['all', '전체']].map(([v, l]) => `<button type="button" data-v="${v}" class="${String(view.range) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" data-g="mode">${[['group', '따로'], ['stack', '쌓아서'], ['sum', '합산']].map(([v, l]) => `<button type="button" data-v="${v}" class="${view.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" data-g="scope">${[['project', '이 작품'], ['all', '모든 작품']].map(([v, l]) => `<button type="button" data-v="${v}" class="${view.scope === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="checks">${SERIES.map((s) => `<label class="check"><input type="checkbox" data-k="${s.key}" ${view.on[s.key] ? 'checked' : ''}><i class="sw ${s.cls}"></i>${s.name}</label>`).join('')}</div>
    </div>`;
  const render = async (f) => {
    const by = await dailyRows(view.scope);
    $('#statCtl', f).innerHTML = controls();
    $('#statBody', f).innerHTML = body(dayList(by, view.range === 'all' ? 'all' : +view.range), $('#statBody', f).clientWidth || Math.min(innerWidth - 72, 760));
  };
  await dialog({
    title: '하루 기록',
    wide: true,
    body: '<div id="statCtl"></div><div id="statBody" style="display:grid;gap:12px"></div>',
    buttons: [{ label: '닫기', value: 'close', primary: true }],
    onOpen: (f) => {
      render(f);
      // 창 크기가 바뀌면 그래프를 그 폭에 맞춰 다시 그린다
      let lastW = 0;
      new ResizeObserver(([e]) => {
        const w = e.contentRect.width;
        if (lastW && Math.abs(w - lastW) > 40) render(f);
        lastW = w;
      }).observe($('#statBody', f));
      f.addEventListener('click', (e) => {
        const b = e.target.closest('[data-g] [data-v]');
        if (!b) return;
        view[b.closest('[data-g]').dataset.g] = b.dataset.v;
        save(); render(f);
      });
      f.addEventListener('change', (e) => {
        const k = e.target.dataset.k;
        if (!k) return;
        view.on[k] = e.target.checked;
        save(); render(f);
      });
    },
  });
}
