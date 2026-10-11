// 하루 기록 그래프: 날마다 쓴 양·고친 양·지운 양을 따로, 쌓아서, 또는 합산해서 본다
import * as S from './store.js';
import { app, saveNow, saveSettings, addOf, addAll, addTyped, delOf, resetToday, restoreToday, renderGoal, netToday, removeClips, openChapter } from './app.js';
import { fmt } from './stats.js';
import { $, $$, h, dialog, toast, toastAction, confirmDlg } from './ui.js';

const SERIES = [
  { key: 'add', name: '쓴 양', cls: 's-add' },
  { key: 'rev', name: '고친 양', cls: 's-rev' },
  { key: 'del', name: '지운 양', cls: 's-del' },
];
const view = { range: 30, mode: 'group', scope: 'project', skipEmpty: false, on: { add: true, rev: true, del: true } };
try { Object.assign(view, JSON.parse(localStorage.getItem('nw-statview') || '{}')); } catch { /* 무시 */ }

// 날짜별 합계 (예전 기록에는 쓴 양 대신 늘어난 글자 수를 쓴다)
async function dailyRows(scope) {
  const all = scope === 'project' ? await S.dailyOf(app.project.id) : await S.dailyAll();
  const by = new Map();
  for (const r of all) {
    const v = by.get(r.date) || { add: 0, rev: 0, del: 0 };
    v.add += addOf(r);
    v.rev += r.rev || 0;
    v.del += delOf(r);
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
  if (!days.length) return '<p class="hint" style="margin:0">이 기간에는 쓴 날이 없습니다.</p>';
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
      const x = Math.min(W - R - 18, Math.max(L + 18, L + slot * i + slot / 2));
      g += `<text x="${x}" y="${H - 8}" text-anchor="middle" class="tick">${+m}/${+dd}</text>`;
    }
  });
  // 날이 적을 때 막대가 너무 넓어지지 않게
  const bw = Math.min(slot - gap, view.mode === 'group' ? 20 * keys.length : 36);
  days.forEach((d, i) => {
    const x0 = L + slot * i + (slot - bw) / 2;
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
      <div class="stat"><b class="tn">${fmt(tot.add)}</b><span><i class="sw s-add"></i>쓴 양 <small>(${app.settings.countPaste ? '붙여넣기 포함' : '붙여넣기 뺌'})</small></span></div>
      <div class="stat"><b class="tn">${fmt(tot.rev)}</b><span><i class="sw s-rev"></i>고친 양</span></div>
      <div class="stat"><b class="tn">${fmt(tot.del)}</b><span><i class="sw s-del"></i>지운 양</span></div>
      <div class="stat"><b class="tn">${fmt(sum)}</b><span>합계 (${active}일 동안)</span></div>
    </div>
    <div class="chartbox">
      ${view.mode === 'sum'
        ? `<div class="legend"><span><i class="sw s-sum"></i>${legend.map((s) => s.name).join(' + ')} 합산</span></div>`
        : `<div class="legend">${legend.map((s) => `<span><i class="sw ${s.cls}"></i>${s.name}</span>`).join('')}</div>`}
      ${chartSvg(view.skipEmpty ? days.filter((d) => SERIES.some((s) => view.on[s.key] && d[s.key])) : days, width)}
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
      <label class="check"><input type="checkbox" data-skip ${view.skipEmpty ? 'checked' : ''}>안 쓴 날 빼기</label>
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
        if ('skip' in e.target.dataset) { view.skipEmpty = e.target.checked; save(); render(f); return; }
        const k = e.target.dataset.k;
        if (!k) return;
        view.on[k] = e.target.checked;
        save(); render(f);
      });
    },
  });
}

// ---------- 오늘 쓴 양 (상태 표시줄) ----------
// 직접 친 글자 / 붙여넣은 글자 / 합계를 보여 주고, 목표·그래프에 어느 쪽을 셀지 고르고, 오늘 기록을 0부터 다시 셀 수 있다
export async function showToday() {
  await saveNow();
  const r = app.todayRec || {};
  const typed = addTyped(r), all = addAll(r), paste = all - typed;
  const nt = netToday(r);
  const clips = r.clips || [];
  const goal = app.project?.goalDaily || 0;
  const res = await dialog({
    title: '오늘 쓴 양',
    body: `<div class="statgrid today-grid">
        <div class="stat"><b class="tn">${fmt(typed)}</b><span>직접 친 글자</span></div>
        <div class="stat"><b class="tn">${fmt(paste)}</b><span>붙여넣은 글자</span></div>
        <div class="stat"><b class="tn">${fmt(all)}</b><span>합계 (붙여넣기 포함)</span></div>
        <div class="stat"><b class="tn">${fmt(r.rev || 0)} · ${fmt(r.del || 0)}</b><span>고친 · 지운 글자 (직접)</span></div>
        <div class="stat"><b class="tn">${fmt(r.cut || 0)}</b><span>잘라내거나 붙여넣기로 덮은 글자</span></div>
        <div class="stat"><b class="tn">${fmt(clips.filter((e) => e.k !== 'copy').length)} · ${fmt(clips.filter((e) => e.k === 'copy').length)}</b><span>붙여넣기·잘라내기 · 복사 (번)</span></div>
      </div>
      <fieldset class="today-net"><legend>전날(지난번) 원고 대비</legend>
        ${r.base ? `<div class="row"><span><b class="p">+${fmt(nt.plus)}</b> 늘어남</span><span><b class="m">−${fmt(nt.minus)}</b> 줄어듦</span><span>순 <b>${nt.plus - nt.minus >= 0 ? '+' : '−'}${fmt(Math.abs(nt.plus - nt.minus))}</b>자</span></div>
        <small class="hint">오늘 처음 고치기 직전 원고와 지금 원고를 견준 값이에요. 썼다가 오늘 다시 지운 글자는 양쪽에서 빠져요. 위의 쓴·고친·지운 합계와는 따로 셉니다.</small>` : '<small class="hint">오늘 아직 고친 장이 없어요.</small>'}
      </fieldset>
      <fieldset class="today-mode"><legend>목표·그래프·연속 기록에 셀 양</legend>
        <label class="radio"><input type="radio" name="mode" value="typed" ${app.settings.countPaste ? '' : 'checked'}> 직접 친 글자만 <small>붙여넣기·끌어 놓기는 쓴 양에서, 잘라내기·덮어쓰기는 지운 양에서 빼요</small></label>
        <label class="radio"><input type="radio" name="mode" value="all" ${app.settings.countPaste ? 'checked' : ''}> 붙여넣기·잘라내기까지 포함</label>
      </fieldset>
      ${goal ? `<p class="hint" style="margin:0">오늘 목표 ${fmt(goal)}자 중 <b id="tdGoal">${fmt(app.settings.countPaste ? all : typed)}</b>자</p>` : ''}
      <p class="hint" style="margin:0">공백은 세지 않아요. ${r.resetAt ? `오늘 ${new Date(r.resetAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}에 초기화한 뒤부터 센 값이에요. ` : ''}붙여넣기·잘라내기는 이 기능을 넣은 뒤부터 따로 세요.</p>`,
    buttons: [{ label: '오늘 기록 초기화', value: 'reset', left: true }, { label: '복사·붙여넣기 기록', value: 'clips' }, { label: '날짜별 그래프', value: 'graph' }, { label: '닫기', value: 'close', primary: true }],
    onOpen: (f) => f.querySelectorAll('[name=mode]').forEach((x) => x.addEventListener('change', () => {
      app.settings.countPaste = f.mode.value === 'all';
      saveSettings();
      renderGoal();
      const g = f.querySelector('#tdGoal');
      if (g) g.textContent = fmt(app.settings.countPaste ? all : typed);
    })),
  });
  if (res.value === 'graph') { showStats(); return; }
  if (res.value === 'clips') { showClips(); return; }
  if (res.value !== 'reset') return;
  if (!(await confirmDlg('오늘 기록 초기화', `이 작품의 오늘 쓴·고친·지운 양을 0으로 되돌리고 지금부터 다시 셉니다. 원고는 바뀌지 않아요.`, '초기화'))) return;
  const old = await resetToday();
  toastAction('오늘 기록을 0부터 다시 세요.', '되돌리기', () => restoreToday(old));
}

// ---------- 복사·붙여넣기 기록 ----------
const CLIP_K = { paste: '붙여넣기', drop: '끌어 놓기', move: '끌어 옮김', cut: '잘라내기', copy: '복사' };
const hm2 = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
const dayName = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${m}월 ${dd}일 (${'일월화수목금토'[new Date(y, m - 1, dd).getDay()]})`; };

// 붙여넣은 글을 지금 원고에서 찾아 고른다
async function findClip(e) {
  if (!app.chapters.has(e.ch)) { toast('그 장은 지워졌어요.'); return; }
  if (app.cur !== e.ch) await openChapter(e.ch);
  const lines = e.text.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return;
  const first = lines[0].slice(0, 60), last = lines[lines.length - 1].slice(-60);
  const find = (needle, after = 0) => {
    let at = null;
    app.editor.state.doc.descendants((n, pos) => {
      if (at !== null) return false;
      if (!n.isTextblock) return true;
      if (pos + n.nodeSize < after) return false;
      const i = n.textContent.indexOf(needle, Math.max(0, after - pos - 1));
      if (i >= 0) at = pos + 1 + i;
      return false;
    });
    return at;
  };
  const from = find(first);
  if (from === null) { toast('지금 원고에서는 찾을 수 없어요. 그 뒤에 고치거나 지운 것 같아요.'); return; }
  const end = lines.length > 1 ? find(last, from) : null;
  const to = end !== null ? end + last.length : from + first.length;
  app.editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
}

export async function showClips() {
  await saveNow();
  const all = [];
  for (const r of await S.dailyOf(app.project.id)) for (const e of r.clips || []) all.push({ ...e, date: r.date });
  all.sort((a, b) => b.t - a.t);
  const st = { kind: 'all', range: '7', q: '', limit: 200 };
  const today = S.today();
  const since = (days) => { const d = new Date(); d.setDate(d.getDate() - days + 1); return S.today(d); };
  const pick = () => all.filter((e) => !e.gone
    && (st.kind === 'all' || (st.kind === 'paste' ? ['paste', 'drop'].includes(e.k) : e.k === st.kind))
    && (st.range === 'all' || e.date >= (st.range === '1' ? today : since(+st.range)))
    && (!st.q || e.text.includes(st.q) || e.title?.includes(st.q)));
  const item = (e) => {
    const long = e.text.length > 280 || e.text.split('\n').length > 4;
    return `<li class="clip k-${e.k}" data-t="${e.t}">
      <div class="clip-h"><span class="clip-k">${CLIP_K[e.k] || e.k}</span>
        <span class="clip-meta">${hm2(e.t)} · ${h(app.chapters.get(e.ch)?.title || e.title || '지운 장')} · ${fmt(e.n)}자${e.cut ? ' (앞부분만 남김)' : ''}</span>
        <span class="clip-acts">${e.k !== 'cut' ? '<button type="button" data-c="find">본문에서 찾기</button>' : ''}<button type="button" data-c="copy">복사</button><button type="button" data-c="del" title="이 기록 지우기" aria-label="이 기록 지우기">✕</button></span></div>
      <div class="clip-tx${long ? ' long' : ''}">${h(e.text)}</div>
      ${e.rep ? `<div class="clip-rep">덮어쓴 글 ${fmt(e.repN)}자: <del>${h(e.rep.length > 200 ? e.rep.slice(0, 200) + '…' : e.rep)}</del></div>` : ''}
      ${long ? '<button type="button" class="linkish" data-c="more">전체 보기</button>' : ''}</li>`;
  };
  const render = (f) => {
    const list = pick();
    const sum = (ks) => list.filter((e) => ks.includes(e.k)).reduce((n, e) => n + e.n, 0);
    const cnt = (ks) => list.filter((e) => ks.includes(e.k)).length;
    f.querySelector('#clipSum').innerHTML = `붙여넣기 <b>${cnt(['paste', 'drop'])}</b>번 ${fmt(sum(['paste', 'drop']))}자 · 잘라내기 <b>${cnt(['cut'])}</b>번 ${fmt(sum(['cut']))}자 · 끌어 옮김 <b>${cnt(['move'])}</b>번 · 복사 <b>${cnt(['copy'])}</b>번`;
    let html = '', day = '';
    for (const e of list.slice(0, st.limit)) {
      if (e.date !== day) { if (day) html += '</ol>'; day = e.date; html += `<h4>${dayName(day)}${day === today ? ' · 오늘' : ''}</h4><ol class="clip-list">`; }
      html += item(e);
    }
    if (day) html += '</ol>';
    if (list.length > st.limit) html += `<button type="button" class="small" data-c="all">나머지 ${fmt(list.length - st.limit)}개 더 보기</button>`;
    f.querySelector('#clipBody').innerHTML = html || '<p class="hint">이 조건에 맞는 기록이 없어요. 원고에서 복사·잘라내기·붙여넣기를 하면 여기에 남아요.</p>';
  };
  const res = await dialog({
    title: '복사·붙여넣기 기록',
    wide: true,
    body: `<div class="clip-tools">
        <div class="chip-row" role="radiogroup" aria-label="종류">${[['all', '전체'], ['paste', '붙여넣기'], ['cut', '잘라내기'], ['move', '끌어 옮김'], ['copy', '복사']].map(([v, l]) => `<label class="chip-radio"><input type="radio" name="ck" value="${v}" ${v === 'all' ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <select name="range" aria-label="기간"><option value="1">오늘</option><option value="7" selected>최근 7일</option><option value="30">최근 30일</option><option value="all">전체</option></select>
        <input name="q" type="search" placeholder="내용·장 이름으로 찾기" aria-label="내용 찾기">
      </div>
      <p class="hint clip-sum" id="clipSum"></p>
      <div class="clip-body" id="clipBody"></div>
      <p class="hint" style="margin:0">이 작품 원고 안에서 한 복사·잘라내기·붙여넣기를 날짜별로 남겨요. 백업과 드라이브 동기화에 함께 실려요. 붙여넣은 글자는 쓴 양에서, 잘라내거나 덮어쓴 글자는 지운 양에서 따로 셉니다.</p>`,
    buttons: [{ label: '보이는 기록 모두 지우기', value: 'clear', left: true }, { label: '닫기', value: 'close', primary: true }],
    onOpen: (f) => {
      render(f);
      f.addEventListener('change', (ev) => {
        if (ev.target.name === 'ck') st.kind = ev.target.value;
        else if (ev.target.name === 'range') st.range = ev.target.value;
        else return;
        st.limit = 200; render(f);
      });
      f.q.addEventListener('input', () => { st.q = f.q.value.trim(); render(f); });
      f.querySelector('#clipBody').addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-c]');
        if (b?.dataset.c === 'all') { st.limit = Infinity; render(f); return; }
        const li = ev.target.closest('li.clip');
        if (!li) return;
        const e = all.find((x) => x.t === +li.dataset.t);
        const c = b?.dataset.c;
        if (!c) { if (ev.target.closest('.clip-tx.long')) li.classList.toggle('open'); return; }
        if (c === 'more') { li.classList.toggle('open'); b.textContent = li.classList.contains('open') ? '접기' : '전체 보기'; }
        if (c === 'copy') {
          try { await navigator.clipboard.writeText(e.text); toast('복사했어요.', 1200); } catch { toast('복사하지 못했어요. 글을 직접 골라 복사해 주세요.'); }
        }
        if (c === 'find') { $('#dlg').close(); await findClip(e); }
        if (c === 'del') { await removeClips(e.date, e.t); e.gone = true; render(f); }
      });
    },
  });
  if (res.value !== 'clear') return;
  const gone = pick();
  if (!gone.length) return;
  if (!(await confirmDlg('기록 지우기', `지금 보이는 기록 ${fmt(gone.length)}개를 지웁니다. 원고와 쓴 양은 바뀌지 않아요.`, '지우기'))) return;
  const byDay = new Map();
  for (const e of gone) (byDay.get(e.date) || byDay.set(e.date, []).get(e.date)).push(e.t);
  for (const [d, ts] of byDay) for (const t of ts) await removeClips(d, t);
  toast(`기록 ${fmt(gone.length)}개를 지웠어요.`);
}
