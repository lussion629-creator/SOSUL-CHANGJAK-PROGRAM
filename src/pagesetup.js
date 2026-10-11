// 쪽 설정 창: 용지·여백·쪽 번호·글자·문단을 정하고, 템플릿으로 저장하거나 불러온다
import {
  FONTS, PAPERS, KEYS, templates, templateById, defaultTemplateId, setDefaultTemplate, saveTemplate, deleteTemplate,
  layoutOf, setProjectLayout, bodyBox, linesPerPage, readHwpxLayout, readDocxLayout,
} from './layout.js';
import { applyPageView, isPageView, togglePageView } from './pageview.js';
import { $, h, toast, dialog } from './ui.js';

const NUM = [['outside', '바깥쪽 아래 (책처럼)'], ['center', '가운데 아래'], ['right', '오른쪽 아래'], ['left', '왼쪽 아래'], ['none', '쪽 번호 없음']];

function form(L) {
  const num = (name, label, v, step = 0.5, min = 0, max = 999) => `<label class="field"><span>${label}</span><input name="${name}" type="number" step="${step}" min="${min}" max="${max}" value="${v}"></label>`;
  const paper = PAPERS.find(([, w, hh]) => (w === L.w && hh === L.h) || (w === L.h && hh === L.w));
  return `
  <div class="ps">
    <div class="ps-main">
      <fieldset><legend>템플릿</legend>
        <div class="ps-row">
          <select name="tpl">${templates().map((t) => `<option value="${t.id}" ${t.id === L.templateId ? 'selected' : ''}>${h(t.name)}${t.id === defaultTemplateId() ? ' · 기본' : ''}</option>`).join('')}</select>
          <button type="button" class="small" data-ps="load">불러오기</button>
          <button type="button" class="small" data-ps="default">새 작품 기본으로</button>
          <button type="button" class="small" data-ps="del">지우기</button>
        </div>
        <div class="ps-row">
          <input name="tplName" placeholder="새 템플릿 이름 (예: 공모전 A4)">
          <button type="button" class="small" data-ps="save">지금 설정을 템플릿으로 저장</button>
        </div>
        <div class="ps-row"><button type="button" class="small" data-ps="hwpx">한글(hwpx) 파일에서 쪽 설정 가져오기…</button><button type="button" class="small" data-ps="docx">Word(docx) 파일에서 가져오기…</button></div>
      </fieldset>
      <fieldset><legend>용지</legend>
        <div class="ps-grid3">
          <label class="field"><span>종류</span><select name="paper"><option value="">직접 입력</option>${PAPERS.map(([n, w, hh]) => `<option value="${w}x${hh}" ${paper && paper[0] === n ? 'selected' : ''}>${n} (${w}×${hh})</option>`).join('')}</select></label>
          ${num('w', '너비 (mm)', L.w, 0.1, 50, 600)}
          ${num('h', '높이 (mm)', L.h, 0.1, 50, 900)}
        </div>
        <label class="check"><input type="checkbox" name="land" ${L.w > L.h ? 'checked' : ''}> 가로로 놓기</label>
      </fieldset>
      <fieldset><legend>여백 (mm)</legend>
        <div class="ps-grid3">
          ${num('mt', '위쪽', L.mt)}${num('mb', '아래쪽', L.mb)}${num('mh', '머리말', L.mh)}
          ${num('ml', '왼쪽 (안쪽)', L.ml)}${num('mr', '오른쪽 (바깥쪽)', L.mr)}${num('mf', '꼬리말', L.mf)}
        </div>
        <label class="check"><input type="checkbox" name="mirror" ${L.mirror ? 'checked' : ''}> 맞쪽 (책처럼 펼쳐 놓는 쪽, 짝수 쪽은 왼쪽·오른쪽 여백이 바뀜)</label>
      </fieldset>
      <fieldset><legend>쪽 번호</legend>
        <div class="ps-grid3">
          <label class="field" style="grid-column:span 2"><span>위치</span><select name="num">${NUM.map(([v, l]) => `<option value="${v}" ${L.num === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${num('numStart', '시작 번호', L.numStart, 1, 0, 9999)}
        </div>
      </fieldset>
      <fieldset><legend>글자</legend>
        <div class="ps-grid3">
          <label class="field"><span>글꼴</span><select name="font">${(FONTS.some((f) => f[0] === L.font) ? FONTS : [...FONTS, [L.font, L.font.replace(/'/g, ''), '']]).map(([v, l]) => `<option value="${h(v)}" ${v === L.font ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>
          ${num('size', '크기 (pt)', L.size, 0.5, 6, 40)}
          ${num('spacing', '자간 (%)', L.spacing, 1, -50, 50)}
        </div>
      </fieldset>
      <fieldset><legend>문단</legend>
        <div class="ps-grid3">
          ${num('line', '줄 간격 (%)', L.line, 5, 80, 400)}
          ${num('indent', '첫 줄 들여쓰기 (글자)', L.indent, 0.5, 0, 10)}
          ${num('paraAfter', '문단 아래 (pt)', L.paraAfter, 1, 0, 72)}
          <label class="field"><span>정렬</span><select name="align"><option value="justify" ${L.align === 'justify' ? 'selected' : ''}>양쪽 맞춤</option><option value="left" ${L.align === 'left' ? 'selected' : ''}>왼쪽 맞춤</option></select></label>
          <label class="field" style="grid-column:span 2"><span>줄 나눔 기준 (한글)</span><select name="breakWord"><option value="word" ${L.breakWord === 'word' ? 'selected' : ''}>어절 (낱말이 줄 끝에서 잘리지 않음)</option><option value="char" ${L.breakWord === 'char' ? 'selected' : ''}>글자 (줄 끝을 꽉 채움)</option></select></label>
        </div>
      </fieldset>
    </div>
    <aside class="ps-side">
      <div class="ps-prev" id="psPrev"></div>
      <p class="hint" id="psInfo"></p>
      <label class="check"><input type="checkbox" name="pv" ${isPageView() ? 'checked' : ''}> 편집할 때 쪽 보기로 보기</label>
    </aside>
  </div>`;
}

function read(f) {
  const v = {};
  for (const k of KEYS) {
    const el = f.elements[k];
    if (!el) continue;
    v[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
  }
  v.mirror = f.mirror.checked;
  return v;
}
function fill(f, L) {
  for (const k of KEYS) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!L[k];
    else {
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === String(L[k]))) el.add(new Option(String(L[k]).replace(/'/g, ''), L[k]));
      el.value = L[k];
    }
  }
  f.land.checked = L.w > L.h;
  const p = PAPERS.find(([, w, hh]) => (w === L.w && hh === L.h) || (w === L.h && hh === L.w));
  f.paper.value = p ? `${p[1]}x${p[2]}` : '';
}

function preview(f) {
  const L = read(f);
  const b = bodyBox(L);
  const sc = 150 / Math.max(L.w, L.h);
  const W = L.w * sc, H = L.h * sc;
  const n = linesPerPage(L);
  const lines = [];
  const pitch = (b.h * sc) / n;
  for (let i = 0; i < Math.min(n, 60); i++) {
    const y = (L.mt + L.mh) * sc + pitch * i + pitch * 0.35;
    const x0 = L.ml * sc + (i === 0 ? L.indent * L.size * 0.3528 * sc : 0);
    lines.push(`<line x1="${x0}" x2="${(L.w - L.mr) * sc - (i === n - 1 ? 18 : 0)}" y1="${y}" y2="${y}"/>`);
  }
  const side = L.num === 'none' ? null : L.num === 'outside' || L.num === 'right' ? 'end' : L.num === 'left' ? 'start' : 'middle';
  const nx = side === 'end' ? (L.w - L.mr) * sc : side === 'start' ? L.ml * sc : W / 2;
  $('#psPrev', f).innerHTML = `<svg viewBox="-4 -4 ${W + 8} ${H + 8}" width="${W + 8}" height="${H + 8}" role="img" aria-label="쪽 미리보기">
    <rect class="pp-paper" x="0" y="0" width="${W}" height="${H}"/>
    <rect class="pp-body" x="${L.ml * sc}" y="${(L.mt + L.mh) * sc}" width="${b.w * sc}" height="${b.h * sc}"/>
    <g class="pp-lines">${lines.join('')}</g>
    ${side ? `<text class="pp-num" x="${nx}" y="${(L.h - L.mb) * sc - 1}" text-anchor="${side}">1</text>` : ''}
  </svg>`;
  $('#psInfo', f).innerHTML = b.w > 10 && b.h > 10
    ? `본문 칸 ${Math.round(b.w)}×${Math.round(b.h)}mm<br>한 쪽에 ${n}줄 (${L.size}pt, 줄 간격 ${L.line}%)<br>줄은 ${L.breakWord === 'word' ? '어절' : '글자'} 단위로 나눕니다.`
    : '여백이 너무 커서 본문이 들어갈 자리가 없어요.';
}

export async function showPageSetup() {
  const L = layoutOf();
  const r = await dialog({
    title: '쪽 설정',
    wide: true,
    body: form(L),
    buttons: [{ label: '취소', value: 'close' }, { label: '이 작품에 적용', value: 'ok', primary: true }],
    onOpen: (f) => {
      let tplSel = templateById(L.templateId) || null;
      preview(f);
      f.addEventListener('input', (e) => {
        if (e.target.name === 'paper' && e.target.value) {
          const [w, hh] = e.target.value.split('x').map(Number);
          const land = f.land.checked;
          f.w.value = land ? hh : w; f.h.value = land ? w : hh;
        }
        if (e.target.name === 'land') {
          const w = +f.w.value, hh = +f.h.value;
          if ((e.target.checked && w < hh) || (!e.target.checked && w > hh)) { f.w.value = hh; f.h.value = w; }
        }
        if (['w', 'h'].includes(e.target.name)) f.paper.value = '';
        if (e.target.name !== 'tpl' && e.target.name !== 'tplName' && e.target.name !== 'pv') tplSel = null;
        preview(f);
      });
      f.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-ps]');
        if (!b) return;
        const t = templateById(f.tpl.value);
        if (b.dataset.ps === 'load' && t) { fill(f, t); tplSel = t; preview(f); toast(`“${t.name}” 설정을 불러왔어요. ‘이 작품에 적용’을 누르면 바뀝니다.`); }
        if (b.dataset.ps === 'default' && t) { await setDefaultTemplate(t.id); f.tpl.innerHTML = templates().map((x) => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${h(x.name)}${x.id === t.id ? ' · 기본' : ''}</option>`).join(''); toast(`새 작품은 “${t.name}”으로 시작해요.`); }
        if (b.dataset.ps === 'del' && t) {
          if (t.builtin) { toast('기본으로 들어 있는 템플릿은 지울 수 없어요.'); return; }
          await deleteTemplate(t.id);
          f.tpl.querySelector(`option[value="${t.id}"]`)?.remove();
          toast(`“${t.name}” 템플릿을 지웠어요.`);
        }
        if (b.dataset.ps === 'save') {
          const name = f.tplName.value.trim();
          if (!name) { f.tplName.focus(); toast('템플릿 이름을 적어 주세요.'); return; }
          const nt = await saveTemplate(name, read(f));
          f.tpl.add(new Option(nt.name, nt.id, true, true));
          tplSel = nt;
          f.tplName.value = '';
          toast(`“${name}” 템플릿으로 저장했어요.`);
        }
        if (b.dataset.ps === 'docx') {
          const file = await pick('.docx,.dotx,.docm');
          if (!file) return;
          try {
            const got = await readDocxLayout(await file.arrayBuffer());
            fill(f, got); tplSel = null; preview(f);
            f.tplName.value = file.name.replace(/\.(docx|dotx|docm)$/i, '');
            toast('Word 파일의 쪽 설정(용지·여백·쪽 번호·글자·문단)을 가져왔어요. 템플릿으로 저장하거나 이 작품에 적용하세요.', 5000);
          } catch (err) { toast('가져오지 못했습니다: ' + err.message, 5000); }
        }
        if (b.dataset.ps === 'hwpx') {
          const file = await pick('.hwpx');
          if (!file) return;
          try {
            const got = await readHwpxLayout(await file.arrayBuffer());
            fill(f, got); tplSel = null; preview(f);
            f.tplName.value = file.name.replace(/\.hwpx$/i, '');
            toast('한글 파일의 쪽 설정을 가져왔어요. 템플릿으로 저장하거나 이 작품에 적용하세요.', 5000);
          } catch (err) { toast('가져오지 못했습니다: ' + err.message, 5000); }
        }
      });
    },
  });
  if (r.value !== 'ok') return;
  const f = r.form;
  const v = read(f);
  const tpl = templateById(f.tpl.value);
  const same = tpl && KEYS.every((k) => String(tpl[k]) === String(v[k]));
  await setProjectLayout(v, same ? tpl : null);
  if (f.pv.checked !== isPageView()) togglePageView(f.pv.checked);
  else applyPageView();
  toast('쪽 설정을 바꿨어요.');
}

function pick(accept) {
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => res(inp.files[0] || null);
    inp.click();
  });
}

export const layoutSummary = (L = layoutOf()) => `${L.templateName || '직접 정한 설정'} · ${L.w}×${L.h}mm · ${FONTS.find((x) => x[0] === L.font)?.[1] || L.font.replace(/'/g, '')} ${L.size}pt · 줄 간격 ${L.line}%`;
