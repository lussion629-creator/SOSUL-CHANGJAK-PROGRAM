// 공통 UI 도우미: 대화 상자, 알림, 시간 표시
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
export function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/**
 * 대화 상자 열기
 * @param {{title:string, body:string, buttons?:{label,value,primary?,left?}[], onOpen?:(form)=>void, wide?:boolean}} o
 * @returns {Promise<{value:string, form:HTMLFormElement}>}
 */
export function dialog({ title, body, buttons = [{ label: '닫기', value: 'close' }], onOpen, wide }) {
  const dlg = $('#dlg');
  if (dlg.open) dlg.close('close');
  // 이전 대화 상자의 이벤트가 남지 않도록 폼을 새로 만든다
  const old = $('#dlgForm');
  const form = old.cloneNode(false);
  old.replaceWith(form);
  dlg.style.width = wide ? 'min(860px, calc(100vw - 24px))' : '';
  form.innerHTML = `
    <div class="dlg-head"><h2>${h(title)}</h2><button value="close" class="icon-btn" title="닫기" formnovalidate>✕</button></div>
    <div class="dlg-body">${body}</div>
    ${buttons.length ? `<div class="dlg-foot">${buttons.map((b) => `<button value="${b.value}" class="${b.primary ? 'primary' : ''} ${b.left ? 'left' : ''}" ${b.value === 'close' || b.left ? 'formnovalidate' : ''}>${h(b.label)}</button>`).join('')}</div>` : ''}`;
  // 닫기 이벤트(close)는 늦게 도착해 다음 대화 상자와 섞일 수 있어, 이 폼의 submit과 Esc(cancel)로 결과를 받는다
  return new Promise((resolve) => {
    form.addEventListener('submit', (e) => resolve({ value: e.submitter?.value || 'close', form }));
    const onCancel = () => { dlg.removeEventListener('cancel', onCancel); resolve({ value: 'close', form }); };
    dlg.addEventListener('cancel', onCancel);
    form.addEventListener('submit', () => dlg.removeEventListener('cancel', onCancel));
    dlg.returnValue = '';
    dlg.showModal();
    onOpen?.(form, dlg);
  });
}

export async function confirmDlg(title, msg, okLabel = '확인', danger = false) {
  const r = await dialog({ title, body: `<p style="margin:0;line-height:1.6">${msg}</p>`, buttons: [{ label: '취소', value: 'close' }, { label: okLabel, value: 'ok', primary: !danger, left: false }] });
  return r.value === 'ok';
}

export async function promptDlg(title, label, value = '') {
  const r = await dialog({
    title, body: `<label class="field"><span>${h(label)}</span><input name="v" value="${h(value)}" autofocus></label>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '확인', value: 'ok', primary: true }],
    onOpen: (f) => { const i = f.querySelector('input'); i.focus(); i.select(); },
  });
  return r.value === 'ok' ? r.form.v.value.trim() : null;
}

const z = (n) => String(n).padStart(2, '0');
export const hm = (t) => { const d = new Date(t); return `${z(d.getHours())}:${z(d.getMinutes())}`; };
export const hms = (t) => { const d = new Date(t); return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
export function dayLabel(t) {
  const d = new Date(t);
  const now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 864e5);
  const w = '일월화수목금토'[d.getDay()];
  if (diff === 0) return `오늘 (${d.getMonth() + 1}월 ${d.getDate()}일)`;
  if (diff === 1) return `어제 (${d.getMonth() + 1}월 ${d.getDate()}일)`;
  return `${d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '년 ' : ''}${d.getMonth() + 1}월 ${d.getDate()}일 (${w})`;
}
export const fullTime = (t) => `${dayLabel(t)} ${hm(t)}`;
export function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
