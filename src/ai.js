// 글 AI: 대사 판정·인물 찾기·AI 교정에 쓰는 글 모델. Google Gemini · OpenAI GPT · Anthropic Claude 중에서 고른다.
// 키는 회사마다 이 기기에만 저장한다 (백업 파일·드라이브 동기화·설정에 들어가지 않는다). Gemini 키는 낭독과 같은 키.
import { app, saveSettings } from './app.js';
import { $, h, toast, dialog } from './ui.js';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini', short: 'Gemini', ls: 'nw-gemini-key', site: 'https://aistudio.google.com/apikey', siteName: 'Google AI Studio',
    def: 'gemini-flash-latest', hint: 'AI Studio에서 받은 키 (낭독 키와 같아요)',
    suggest: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'],
  },
  openai: {
    label: 'OpenAI GPT', short: 'GPT', ls: 'nw-openai-key', site: 'https://platform.openai.com/api-keys', siteName: 'OpenAI Platform',
    def: '', hint: 'OpenAI Platform에서 받은 키', suggest: [],
  },
  anthropic: {
    label: 'Anthropic Claude', short: 'Claude', ls: 'nw-anthropic-key', site: 'https://console.anthropic.com/settings/keys', siteName: 'Anthropic Console',
    def: '', hint: 'Anthropic Console에서 받은 키', suggest: [],
  },
};
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI = 'https://api.openai.com/v1';
const ANTHROPIC = 'https://api.anthropic.com/v1';

export class AiError extends Error {
  constructor(msg, { status = 0, retry = 0, fatal = false } = {}) { super(msg); Object.assign(this, { status, retry, fatal }); }
}

// ---------- 설정·키 ----------
export function aiCfg() {
  const a = (app.settings.ai ||= {});
  a.provider ||= 'gemini';
  a.models ||= {};
  // 예전 설정(낭독의 판정 모델)을 옮겨 온다
  if (!a.models.gemini) a.models.gemini = app.settings.tts?.castModel || PROVIDERS.gemini.def;
  return a;
}
export const modelOf = (p = aiCfg().provider) => aiCfg().models[p] || PROVIDERS[p].def;
export const aiLabel = (p = aiCfg().provider) => `${PROVIDERS[p].short} · ${modelOf(p) || '모델 고르기 전'}`;

export function aiKey(p = aiCfg().provider) {
  try { return sessionStorage.getItem(PROVIDERS[p].ls) || localStorage.getItem(PROVIDERS[p].ls) || ''; } catch { return ''; }
}
export function setAiKey(p, k, remember) {
  const n = PROVIDERS[p].ls;
  try {
    localStorage.removeItem(n); sessionStorage.removeItem(n);
    if (k) (remember ? localStorage : sessionStorage).setItem(n, k);
  } catch { /* 저장소를 쓸 수 없으면 이번 창에서만 */ }
}
const keyRemembered = (p) => { try { return !!localStorage.getItem(PROVIDERS[p].ls); } catch { return false; } };
const maskKey = (k) => (k ? k.slice(0, 4) + '…' + k.slice(-4) : '');
// 쓸 준비가 됐는지: 빈 문자열이면 준비됨, 아니면 무엇이 빠졌는지
export function aiMissing(p = aiCfg().provider) {
  if (!aiKey(p)) return `${PROVIDERS[p].short} API 키가 없어요. 설정 → AI 글 모델에서 넣어 주세요.`;
  if (!modelOf(p)) return `${PROVIDERS[p].short} 모델을 아직 고르지 않았어요. 설정 → AI 글 모델에서 골라 주세요.`;
  return '';
}

// ---------- 오류 ----------
function explain(p, status, body, res) {
  const name = PROVIDERS[p].short;
  const m = body?.error?.message || body?.message || '';
  const code = body?.error?.code || body?.error?.type || '';
  const retryAfter = +(res?.headers?.get?.('retry-after') || 0) * 1000;
  if (status === 401 || (status === 400 && /API_KEY_INVALID|API key not valid|invalid x-api-key|Incorrect API key/i.test(m))) return new AiError(`${name} API 키가 맞지 않아요. 설정 → AI 글 모델에서 키를 확인해 주세요.`, { status, fatal: true });
  if (status === 403) return new AiError(`이 ${name} 키로는 이 모델을 쓸 수 없어요 (권한 없음).${m ? ' ' + m.slice(0, 100) : ''}`, { status, fatal: true });
  if (status === 404) return new AiError(`${name} 모델 ‘${modelOf(p)}’을 찾을 수 없어요. 설정 → AI 글 모델에서 다른 모델을 골라 주세요.`, { status, fatal: true });
  if (/insufficient_quota|credit balance|billing/i.test(code + m)) return new AiError(`${name} 계정의 남은 크레딧·한도가 없어요. 결제 설정을 확인해 주세요.`, { status, fatal: true });
  if (status === 429) {
    const d = (body?.error?.details || []).find((x) => x.retryDelay)?.retryDelay;
    if (p === 'gemini' && /per day|daily|limit: 0/i.test(m)) return new AiError('오늘 쓸 수 있는 Gemini 무료 한도를 다 썼어요.', { status, fatal: true });
    return new AiError(`${name} 요청이 많아 잠시 기다리는 중이에요.`, { status, retry: retryAfter || (parseFloat(d) || 0) * 1000 });
  }
  if (status >= 500) return new AiError(`${name} 서버가 잠시 응답하지 않아요.`, { status, retry: retryAfter });
  return new AiError(`${name}에서 답을 받지 못했어요 (${status}${m ? ': ' + m.slice(0, 140) : ''}).`, { status, fatal: status === 400 });
}

async function call(p, url, init, signal) {
  let res;
  try {
    res = await fetch(url, { ...init, signal, referrerPolicy: 'no-referrer' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new AiError(navigator.onLine === false ? '인터넷에 연결되어 있지 않아요.' : `${PROVIDERS[p].short} 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.`, { retry: 0 });
  }
  let json = null;
  try { json = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok) throw explain(p, res.status, json, res);
  return json;
}
const headers = (p, key) => (p === 'gemini'
  ? { 'Content-Type': 'application/json', 'x-goog-api-key': key }
  : p === 'openai'
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
    : { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });

// Gemini 꼴 스키마(type: 'OBJECT' …) → JSON Schema
function jsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const o = { type: String(s.type || '').toLowerCase() };
  if (s.enum) o.enum = s.enum;
  if (s.properties) o.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, jsonSchema(v)]));
  if (s.items) o.items = jsonSchema(s.items);
  if (s.required) o.required = s.required;
  return o;
}
const parse = (t) => {
  const s = String(t || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(s); } catch { throw new AiError('AI 답을 읽지 못했어요.', { retry: 0 }); }
};

// ---------- 묻기: 글 → 정해진 꼴의 JSON ----------
export async function askJSON(prompt, schema, { signal, provider, model } = {}) {
  const p = provider || aiCfg().provider;
  const mdl = model || modelOf(p);
  const key = aiKey(p);
  const miss = !key || !mdl ? aiMissing(p) : '';
  if (miss) throw new AiError(miss, { fatal: true, status: -1 });
  if (p === 'gemini') {
    const json = await call(p, `${GEMINI}/models/${encodeURIComponent(mdl)}:generateContent`, {
      method: 'POST', headers: headers(p, key),
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema } }),
    }, signal);
    return parse(json?.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join(''));
  }
  if (p === 'openai') {
    const json = await call(p, `${OPENAI}/chat/completions`, {
      method: 'POST', headers: headers(p, key),
      body: JSON.stringify({ model: mdl, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_schema', json_schema: { name: 'result', schema: jsonSchema(schema) } } }),
    }, signal);
    const msg = json?.choices?.[0]?.message;
    if (msg?.refusal) throw new AiError('GPT가 이 글에 답하기를 거절했어요.', { retry: 0 });
    return parse(msg?.content);
  }
  // Anthropic: 도구 하나를 꼭 쓰게 해서 정해진 꼴로 받는다
  const json = await call(p, `${ANTHROPIC}/messages`, {
    method: 'POST', headers: headers(p, key),
    body: JSON.stringify({
      model: mdl, max_tokens: 8192, messages: [{ role: 'user', content: prompt }],
      tools: [{ name: 'answer', description: '결과를 이 꼴로 돌려줍니다.', input_schema: jsonSchema(schema) }],
      tool_choice: { type: 'tool', name: 'answer' },
    }),
  }, signal);
  const use = (json?.content || []).find((x) => x.type === 'tool_use');
  if (use?.input) return use.input;
  return parse((json?.content || []).map((x) => x.text || '').join(''));
}

// ---------- 모델 목록 (키로 불러온다) ----------
const SKIP = /tts|audio|realtime|transcribe|image|imagen|veo|embed|moderation|search|instruct|dall|whisper|computer|aqa|live|robotics|gemma|codex|babbage|davinci/i;
export async function listModels(p, key = aiKey(p), signal) {
  if (!key) throw new AiError(`${PROVIDERS[p].short} API 키를 먼저 넣어 주세요.`, { fatal: true });
  if (p === 'gemini') {
    const json = await call(p, `${GEMINI}/models?pageSize=1000`, { headers: headers(p, key) }, signal);
    return (json.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && !SKIP.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || '' }));
  }
  if (p === 'openai') {
    const json = await call(p, `${OPENAI}/models`, { headers: headers(p, key) }, signal);
    return (json.data || []).filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !SKIP.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0)).map((m) => ({ id: m.id, name: '' }));
  }
  const json = await call(p, `${ANTHROPIC}/models?limit=100`, { headers: headers(p, key) }, signal);
  return (json.data || []).map((m) => ({ id: m.id, name: m.display_name || '' }));
}
// 목록에서 값싸고 빠른 모델을 먼저 권한다
export const lightFirst = (list) => list.find((m) => /mini|haiku|flash|lite|small/i.test(m.id) && !/nano|preview|exp/i.test(m.id)) || list[0];

// ---------- 설정 창 ----------
export async function showAiSettings({ back } = {}) {
  const a = aiCfg();
  const cur = a.provider;
  const panel = (p) => {
    const P = PROVIDERS[p], key = aiKey(p);
    return `<section class="ai-panel" data-p="${p}" ${p === cur ? '' : 'hidden'}>
      <label class="field"><span>${h(P.label)} API 키 <small><a href="${P.site}" target="_blank" rel="noopener">${h(P.siteName)}에서 받기 ↗</a></small></span>
        <input name="key_${p}" type="password" autocomplete="off" spellcheck="false" placeholder="${key ? h(maskKey(key)) + ' (저장됨 · 바꾸려면 새 키 붙여넣기)' : h(P.hint)}" aria-label="${h(P.label)} API 키"></label>
      <label class="check"><input type="checkbox" name="remember_${p}" ${!key || keyRemembered(p) ? 'checked' : ''}> 이 기기에 키 기억하기 <small>끄면 이 창을 닫을 때까지만 씁니다</small></label>
      <label class="field"><span>모델</span>
        <span class="ai-model"><input name="model_${p}" list="aiList_${p}" value="${h(modelOf(p))}" placeholder="목록 불러오기를 누르거나 모델 이름을 적어 주세요" spellcheck="false" autocomplete="off"><button type="button" class="small" data-a="list" data-p="${p}">목록 불러오기</button></span>
        <datalist id="aiList_${p}">${P.suggest.map((m) => `<option value="${h(m)}">`).join('')}</datalist></label>
    </section>`;
  };
  const r = await dialog({
    title: 'AI 글 모델',
    body: `<div class="rd-set ai-set">
      <p class="hint" style="margin:0">낭독할 때 <b>대사마다 누가 말했는지 판정</b>하고, <b>등장인물을 찾고</b>, <b>AI 교정</b>을 할 때 쓰는 모델이에요. 음성은 그대로 Gemini가 만들어요.</p>
      <div class="seg seg-lg ai-prov" role="radiogroup" aria-label="AI 회사">${Object.entries(PROVIDERS).map(([p, P]) => `<label><input type="radio" name="provider" value="${p}" ${p === cur ? 'checked' : ''}><span>${h(P.label)}</span></label>`).join('')}</div>
      ${Object.keys(PROVIDERS).map(panel).join('')}
      <div class="ai-test"><button type="button" class="small" data-a="test">연결 시험</button><span id="aiOut" class="hint" aria-live="polite"></span></div>
      <p class="hint" style="margin:0">키는 회사마다 이 기기에만 저장되고 백업·동기화에 들어가지 않아요. 판정·교정할 원고 글은 고른 회사로 보내지고, 요금은 그 회사 계정에서 나가요.</p>
    </div>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f) => {
      const out = $('#aiOut');
      const prov = () => f.querySelector('input[name=provider]:checked').value;
      const keyIn = (p) => f[`key_${p}`].value.trim() || aiKey(p);
      f.addEventListener('change', (e) => {
        if (e.target.name === 'provider') { f.querySelectorAll('.ai-panel').forEach((s) => { s.hidden = s.dataset.p !== prov(); }); out.textContent = ''; }
      });
      let busy = null;
      f.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        busy?.abort(); busy = new AbortController();
        const p = b.dataset.p || prov();
        if (b.dataset.a === 'list') {
          out.textContent = '모델 목록을 불러오는 중…';
          try {
            const list = await listModels(p, keyIn(p), busy.signal);
            $(`#aiList_${p}`).innerHTML = [...new Set([...list.map((m) => m.id), ...PROVIDERS[p].suggest])].map((id) => {
              const m = list.find((x) => x.id === id);
              return `<option value="${h(id)}">${h(m?.name || '')}</option>`;
            }).join('');
            const inp = f[`model_${p}`];
            if (!inp.value && list.length) inp.value = lightFirst(list).id;
            out.textContent = list.length ? `모델 ${list.length}개를 불러왔어요. 모델 칸을 눌러 고르세요.` : '쓸 수 있는 모델이 없어요.';
            inp.focus();
          } catch (err) { if (err.name !== 'AbortError') out.textContent = '✕ ' + err.message; }
        }
        if (b.dataset.a === 'test') {
          const model = f[`model_${p}`].value.trim();
          const k = keyIn(p);
          if (!k) { out.textContent = '✕ 키를 먼저 넣어 주세요.'; return; }
          if (!model) { out.textContent = '✕ 모델을 먼저 골라 주세요.'; return; }
          out.textContent = '시험하는 중…';
          const old = aiKey(p);
          const t0 = performance.now();
          try {
            if (k !== old) setAiKey(p, k, false); // 시험할 동안만
            const r = await askJSON('다음 문장에서 말한 사람을 답하세요: 철수가 말했다. “안녕.”', { type: 'OBJECT', properties: { speaker: { type: 'STRING' } }, required: ['speaker'] }, { signal: busy.signal, provider: p, model });
            out.textContent = `✓ 연결됐어요 (${((performance.now() - t0) / 1000).toFixed(1)}초, 답: ${String(r.speaker || '').slice(0, 20)})`;
          } catch (err) { if (err.name !== 'AbortError') out.textContent = '✕ ' + err.message; } finally {
            if (k !== old) setAiKey(p, old, keyRemembered(p) || !old);
          }
        }
      });
      f.addEventListener('submit', () => busy?.abort(), { once: true });
    },
  });
  if (r.value === 'ok') {
    const f = r.form;
    const keyErr = [];
    for (const p of Object.keys(PROVIDERS)) {
      const k = f[`key_${p}`].value.trim();
      if (k && /\s/.test(k)) keyErr.push(PROVIDERS[p].short);
      else if (k) setAiKey(p, k, f[`remember_${p}`].checked);
      else if (aiKey(p)) setAiKey(p, aiKey(p), f[`remember_${p}`].checked);
      a.models[p] = f[`model_${p}`].value.trim();
    }
    a.provider = f.querySelector('input[name=provider]:checked').value;
    if (!a.models.gemini) a.models.gemini = PROVIDERS.gemini.def;
    saveSettings();
    const miss = aiMissing(a.provider);
    toast(keyErr.length ? `${keyErr.join('·')} 키에 빈칸이 있어 저장하지 않았어요.` : miss || `AI 글 모델: ${aiLabel()}`, 3600);
  }
  if (back) await back();
}
