// 공통 UI 도우미: 대화 상자, 알림, 시간 표시
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
export function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('act');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
// 단추가 달린 알림 (예: '되돌리기')
export function toastAction(msg, label, fn, ms = 9000) {
  const t = $('#toast');
  t.innerHTML = `<span>${h(msg)}</span><button type="button">${h(label)}</button>`;
  t.classList.add('act');
  t.hidden = false;
  t.querySelector('button').onclick = () => { t.hidden = true; fn(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/**
 * 대화 상자 열기
 * @param {{title:string, body:string, buttons?:{label,value,primary?,left?}[], onOpen?:(form)=>void, wide?:boolean}} o
 * @returns {Promise<{value:string, form:HTMLFormElement}>}
 */
// 대화상자는 겹쳐 열 수 있다: 열린 대화상자(부모)에서 다른 대화상자(자식)를 열면 부모의 폼을 입력값·이벤트째 보관했다가
// 자식이 어떻게 끝나든(확인·취소·Esc·프로그램이 닫음) 부모를 그대로 다시 보여 준다.
// 각 대화상자의 결과(Promise)는 끝나는 길이 무엇이든 정확히 한 번 정해진다.
const dlgStack = []; // 보관한 부모: { entry, form, width }
let activeDlg = null; // { resolve, settled, form }
export function dialog({ title, body, buttons = [{ label: '닫기', value: 'close' }], onOpen, wide }) {
  const dlg = $('#dlg');
  const old = $('#dlgForm');
  const form = old.cloneNode(false);
  if (dlg.open && activeDlg && !activeDlg.settled && activeDlg.form === old) {
    // 부모 보관: 폼을 떼어 두기만 하고 대화상자는 닫지 않는다
    activeDlg.detach();
    dlgStack.push({ entry: activeDlg, form: old, width: dlg.style.width });
    old.replaceWith(form);
  } else {
    if (dlg.open) dlg.close('close');
    old.replaceWith(form);
  }
  dlg.style.width = wide ? 'min(860px, calc(100vw - 24px))' : '';
  form.innerHTML = `
    <div class="dlg-head"><h2>${h(title)}</h2><button value="close" class="icon-btn" title="닫기" formnovalidate>✕</button></div>
    <div class="dlg-body">${body}</div>
    ${buttons.length ? `<div class="dlg-foot">${buttons.map((b) => `<button value="${b.value}" class="${b.primary ? 'primary' : ''} ${b.left ? 'left' : ''}" ${b.value === 'close' || b.left ? 'formnovalidate' : ''}>${h(b.label)}</button>`).join('')}</div>` : ''}`;
  return new Promise((resolve) => {
    const entry = { settled: false, form };
    const cleanup = () => {
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
    };
    // 결과를 정한다. 부모 대화상자로 돌아가면 true
    const settle = (value) => {
      if (entry.settled) return false;
      entry.settled = true;
      cleanup();
      if (activeDlg === entry) activeDlg = null;
      resolve({ value, form });
      const top = dlgStack[dlgStack.length - 1];
      if (!top || $('#dlgForm') !== form) return false;
      dlgStack.pop();
      form.replaceWith(top.form);
      dlg.style.width = top.width;
      activeDlg = top.entry;
      top.entry.reattach();
      if (!dlg.open) dlg.showModal();
      return true;
    };
    entry.resolve = settle;
    entry.detach = cleanup;
    // Esc: 이 대화상자만 끝낸다 (부모가 있으면 부모로 돌아간다)
    const onCancel = (e) => {
      if ($('#dlgForm') !== form) return;
      e.preventDefault();
      if (!settle('close')) dlg.close('close');
    };
    // 프로그램이 dlg.close를 부른 경우 등 어떤 길로든 닫힘. 다른 대화상자로 바뀐 뒤의 늦은 이벤트는 무시
    // (닫자마자 새 대화상자를 열면 앞의 close 이벤트가 새 것이 열린 뒤에 도착한다: 열려 있는 동안 온 close는 앞의 것)
    const onClose = () => {
      if (!form.isConnected) settle('close');
      else if ($('#dlgForm') === form && !dlg.open) settle(dlg.returnValue || 'close');
    };
    entry.reattach = () => { dlg.addEventListener('cancel', onCancel); dlg.addEventListener('close', onClose); };
    entry.reattach();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = e.submitter?.value || 'close';
      if (!settle(v) && dlg.open && $('#dlgForm') === form) dlg.close(v);
    });
    // 입력 칸에서 Enter는 '확인'(주 단추)으로 (기본 동작이면 맨 앞의 ✕가 눌린다)
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT' || ['checkbox', 'radio', 'file', 'button'].includes(e.target.type)) return;
      const p = form.querySelector('.dlg-foot button.primary');
      e.preventDefault();
      if (p) form.requestSubmit(p);
    });
    activeDlg = entry;
    dlg.returnValue = '';
    if (!dlg.open) dlg.showModal();
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

/** 원고 옆 여백 카드(주석·교정)가 한쪽에만 있어도 종이가 화면 가운데에 오게 양쪽 여백을 같게 둔다 (화면이 넉넉할 때). 바뀌었으면 true */
export function symRails() {
  const b = document.body, sc = document.getElementById('paperScroll');
  const any = b.classList.contains('has-anno-rail') || b.classList.contains('has-proof-rail');
  // 넓으면 양쪽 대칭. 쪽 보기에서는 종이가 한쪽으로 치우쳐 보이지 않게 조금 좁아도 대칭으로 둔다 (pageview.js railReserve와 같은 기준)
  const on = !!(any && sc && (sc.clientWidth >= 1120 || (b.classList.contains('pageview') && sc.clientWidth >= 860)));
  const was = b.classList.contains('rail-sym');
  b.classList.toggle('rail-sym', on);
  return was !== on;
}
