// AI 낭독: Gemini 음성 모델(또는 기기 목소리)로 원고를 읽어 준다.
// 원고를 문단 단위로 묶어 조각으로 나누고, 지금 조각을 읽는 동안 다음 조각을 미리 만들어 끊김 없이 이어 읽는다.
// API 키는 이 기기에만 저장한다 (백업 파일·드라이브 동기화·설정에 들어가지 않는다).
import { app, saveSettings, openChapter } from './app.js';
import { $, h, toast, dialog } from './ui.js';
import { download } from './io/index.js';
import { openDB } from 'idb';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY_LS = 'nw-gemini-key';

// 음성 모델 (가격은 100만 토큰당 달러: [글 입력, 음성 출력]. 2026년 말까지 값, 2027년부터 두 번째 값)
// 음성 1초 = 25토큰 (3.x 모델 기준)
export const MODELS = [
  { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS', hint: '기본 · 가장 자연스러움', price: [[0.5, 9], [1, 18]] },
  { id: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash-Lite TTS', hint: '빠르고 더 저렴함', price: [[0.5, 6], [1, 12]] },
  { id: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS (미리보기)', hint: '', price: [[1, 20], [1, 20]] },
  { id: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS (이전 세대)', hint: '', price: null },
  { id: 'gemini-2.5-pro-preview-tts', label: 'Gemini 2.5 Pro TTS (이전 세대)', hint: '', price: null },
];
// 기본 제공 목소리 30개 (구글이 붙인 성격 + 대략의 성별. 미리 듣기로 확인하는 것이 가장 정확하다)
export const VOICES = [
  ['Sulafat', '따뜻한', '여'], ['Vindemiatrix', '온화한', '여'], ['Achernar', '여린', '여'], ['Despina', '부드러운', '여'],
  ['Kore', '단단한', '여'], ['Aoede', '산뜻한', '여'], ['Leda', '젊은', '여'], ['Zephyr', '밝은', '여'],
  ['Callirrhoe', '느긋한', '여'], ['Autonoe', '밝은', '여'], ['Erinome', '맑은', '여'], ['Laomedeia', '경쾌한', '여'],
  ['Gacrux', '원숙한', '여'], ['Pulcherrima', '힘 있는', '여'],
  ['Charon', '또렷한 설명조', '남'], ['Schedar', '고른', '남'], ['Iapetus', '맑은', '남'], ['Algieba', '부드러운', '남'],
  ['Achird', '다정한', '남'], ['Umbriel', '느긋한', '남'], ['Enceladus', '숨결 섞인', '남'], ['Algenib', '거친', '남'],
  ['Orus', '단단한', '남'], ['Alnilam', '단단한', '남'], ['Rasalgethi', '또렷한 설명조', '남'], ['Sadaltager', '박식한', '남'],
  ['Puck', '경쾌한', '남'], ['Fenrir', '들뜬', '남'], ['Sadachbia', '생기 있는', '남'], ['Zubenelgenubi', '편안한', '남'],
];
const STYLES = [
  ['audiobook', '오디오북', '차분하고 따뜻한 오디오북 낭독. 문장을 또렷하게 끝맺고, 쉼표와 문단 사이에서 자연스럽게 쉰다.'],
  ['drama', '드라마', '장면의 분위기와 인물의 감정을 살려 몰입감 있게 읽는다.'],
  ['tension', '긴장감', '낮고 조용한 목소리로, 긴장감 있게 천천히 읽는다.'],
  ['story', '동화 구연', '아이에게 들려주듯 생생하고 다정하게 읽는다.'],
  ['proof', '퇴고용', '감정을 싣지 않고 또박또박, 조금 빠르게 읽는다. 오탈자와 어색한 문장이 잘 들리도록.'],
  ['custom', '직접 쓰기', ''],
];
const DEF = {
  engine: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Sulafat', voice2: '', styleId: 'audiobook', style: STYLES[0][2],
  style2: '인물의 감정을 살려 자연스럽게 연기하듯', rate: 1, chunk: 700, prefetch: 2, follow: true, nextChapter: true,
  cache: true, breakPause: 1.2, gap: 0.35, spc: 0.2, usage: null,
};
// 같은 객체를 돌려준다 (설정 창이 고친 값이 그대로 저장되도록). 새 항목이 생기면 기본값으로 채운다
export function cfg() {
  const t = (app.settings.tts ||= {});
  for (const k in DEF) if (!(k in t)) t[k] = DEF[k];
  return t;
}

// ---------- API 키 (이 기기에만) ----------
export function getKey() {
  try { return sessionStorage.getItem(KEY_LS) || localStorage.getItem(KEY_LS) || ''; } catch { return ''; }
}
function setKey(k, remember) {
  try {
    localStorage.removeItem(KEY_LS); sessionStorage.removeItem(KEY_LS);
    if (k) (remember ? localStorage : sessionStorage).setItem(KEY_LS, k);
  } catch { /* 저장소를 쓸 수 없으면 이번 창에서만 */ }
}
const keyRemembered = () => { try { return !!localStorage.getItem(KEY_LS); } catch { return false; } };
const maskKey = (k) => (k ? k.slice(0, 4) + '…' + k.slice(-4) : '');

// ---------- 가격·사용량 ----------
function priceOf(model) {
  const m = MODELS.find((x) => x.id === model);
  if (!m?.price) return null;
  return new Date() < new Date('2027-01-01T00:00:00') ? m.price[0] : m.price[1];
}
export function estimate(chars, model = cfg().model) {
  const secs = chars * cfg().spc;
  const p = priceOf(model);
  const usd = p ? (chars * 1.2 * p[0] + secs * 25 * p[1]) / 1e6 : null;
  return { secs, usd };
}
const fmtSecs = (s) => (s < 60 ? `${Math.max(1, Math.round(s))}초` : s < 3600 ? `${Math.round(s / 60)}분` : `${Math.floor(s / 3600)}시간 ${Math.round((s % 3600) / 60)}분`);
const fmtUsd = (u) => (u == null ? '가격 정보 없음' : u < 0.01 ? '1센트 미만' : `약 $${u.toFixed(2)}`);
const nchars = (t) => t.replace(/\s/g, '').length;
function addUsage(chars, secs) {
  const c = cfg(), month = new Date().toISOString().slice(0, 7);
  if (c.usage?.month !== month) c.usage = { month, chars: 0, secs: 0, usd: 0 };
  c.usage.chars += chars; c.usage.secs += secs;
  const p = priceOf(c.model);
  if (p) c.usage.usd += (chars * 1.2 * p[0] + secs * 25 * p[1]) / 1e6;
  // 글자당 걸리는 시간을 실제로 재서 다음 예상을 고친다
  if (chars > 30 && secs > 0) c.spc = Math.min(0.6, Math.max(0.08, c.spc * 0.8 + (secs / chars) * 0.2));
  saveSettings();
}

// ---------- 음성 캐시 (같은 글·같은 목소리를 다시 들을 때 요금 없이) ----------
let cdb;
const cacheDb = () => (cdb ||= openDB('nw-tts', 1, { upgrade: (d) => d.createObjectStore('audio').createIndex('at', 'at') }));
const CACHE_MAX = 300 * 1024 * 1024;
async function cacheKey(parts) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function cacheGet(k) { try { const r = await (await cacheDb()).get('audio', k); if (r) { r.at = Date.now(); (await cacheDb()).put('audio', r, k); } return r; } catch { return null; } }
async function cachePut(k, rec) {
  try {
    const d = await cacheDb();
    await d.put('audio', { ...rec, at: Date.now() }, k);
    // 너무 커지면 오래 안 들은 것부터 지운다
    let total = 0;
    const all = await d.getAllFromIndex('audio', 'at');
    for (const r of all) total += r.wav.byteLength;
    for (let i = 0; total > CACHE_MAX && i < all.length; i++) {
      total -= all[i].wav.byteLength;
      await d.delete('audio', await cacheKey(all[i].parts));
    }
  } catch { /* 캐시는 없어도 된다 */ }
}
export async function cacheSize() {
  try { let n = 0, b = 0; for (const r of await (await cacheDb()).getAll('audio')) { n++; b += r.wav.byteLength; } return { n, b }; } catch { return { n: 0, b: 0 }; }
}
async function cacheClear() { try { await (await cacheDb()).clear('audio'); } catch { /* 무시 */ } }

// ---------- WAV ----------
const RATE = 24000;
function b64ToBytes(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function wavHeader(dataLen, rate = RATE) {
  const b = new DataView(new ArrayBuffer(44));
  const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, rate, true);
  b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, dataLen, true);
  return new Uint8Array(b.buffer);
}
// WAV에서 PCM 부분과 표본 빈도를 꺼낸다 (fmt·data 덩어리를 찾아서)
function pcmOf(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF') return { pcm: bytes, rate: RATE };
  let o = 12, rate = RATE;
  while (o + 8 <= bytes.length) {
    const id = tag(o), len = v.getUint32(o + 4, true);
    if (id === 'fmt ') rate = v.getUint32(o + 12, true);
    if (id === 'data') return { pcm: bytes.subarray(o + 8, Math.min(bytes.length, o + 8 + (len || bytes.length))), rate };
    o += 8 + len + (len & 1);
  }
  return { pcm: bytes.subarray(44), rate };
}
const toWav = (pcm, rate = RATE) => { const out = new Uint8Array(44 + pcm.length); out.set(wavHeader(pcm.length, rate)); out.set(pcm, 44); return out; };
const silence = (secs, rate = RATE) => new Uint8Array(Math.round(secs * rate) * 2);

// ---------- Gemini 요청 ----------
// 3.x 모델은 Interactions API, 2.x 모델은 generateContent. 한쪽이 거절하면 다른 쪽으로 한 번 더 시도하고 기억한다
const route = new Map();
const legacy = (model) => (route.has(model) ? route.get(model) : /^gemini-2\./.test(model));

// 해설과 대사(따옴표 안)를 나눈다 → 두 목소리로 읽을 때
const QUOTE = /“[^”]*”|"[^"\n]*"|「[^」]*」|『[^』]*』|‘[^’]*’/g;
export function splitVoices(text) {
  const segs = [];
  const push = (who, t) => {
    if (!t.trim()) { if (segs.length) segs[segs.length - 1].text += t; return; }
    const last = segs[segs.length - 1];
    if (last && last.who === who) last.text += t; else segs.push({ who, text: t });
  };
  for (const para of text.split('\n')) {
    let i = 0;
    for (const m of para.matchAll(QUOTE)) {
      // 작은따옴표는 짧은 강조(‘이것’)가 많아 열 글자가 넘을 때만 대사로 본다
      if (m[0][0] === '‘' && m[0].length < 12) continue;
      push('N', para.slice(i, m.index)); push('C', m[0]); i = m.index + m[0].length;
    }
    push('N', para.slice(i));
    if (segs.length) segs[segs.length - 1].text += '\n';
  }
  return segs.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
}

function requestFor(text, c, useLegacy) {
  const two = !!(c.voice2 && c.voice2 !== c.voice);
  const segs = two ? splitVoices(text) : [{ who: 'N', text }];
  const multi = two && segs.some((s) => s.who === 'C') && segs.some((s) => s.who === 'N');
  const name = { N: 'Narrator', C: 'Character' };
  if (!useLegacy) {
    const content = segs.map((s) => ({
      type: 'text', text: s.text,
      annotations: [{ type: 'speech_metadata', ...(multi ? { speaker: name[s.who] } : {}), ...((s.who === 'C' ? c.style2 : c.style) ? { style: s.who === 'C' ? c.style2 : c.style } : {}) }],
    }));
    const voice = multi ? c.voice : (two && segs[0].who === 'C' ? c.voice2 : c.voice);
    return {
      url: `${API}/interactions`,
      body: {
        model: c.model,
        input: [{ type: 'user_input', content }],
        response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: RATE },
        generation_config: { speech_config: multi ? { mode: 'conversational', speakers: [{ speaker: 'Narrator', voice: c.voice }, { speaker: 'Character', voice: c.voice2 }] } : [{ voice }] },
      },
    };
  }
  const trim = (s) => (s || '').trim().replace(/[.。]+$/, '');
  const how = [trim(c.style) && `해설: ${trim(c.style)}`, multi && trim(c.style2) && `대사: ${trim(c.style2)}`].filter(Boolean).join(' / ');
  const prompt = multi
    ? `다음 소설 원고를 한국어로 낭독하세요. Narrator는 해설, Character는 따옴표 안의 대사입니다.${how ? ` (${how})` : ''} 이름표는 읽지 마세요.\n\n` + segs.map((s) => `${name[s.who]}: ${s.text}`).join('\n')
    : `다음 소설 원고를 한국어로 낭독하세요.${how ? ` (${how})` : ''} 글은 고치거나 빼지 말고 그대로 읽으세요.\n\n${text}`;
  const vc = (v) => ({ prebuiltVoiceConfig: { voiceName: v } });
  return {
    url: `${API}/models/${encodeURIComponent(c.model)}:generateContent`,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: multi
          ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: [{ speaker: 'Narrator', voiceConfig: vc(c.voice) }, { speaker: 'Character', voiceConfig: vc(c.voice2) }] } }
          : { voiceConfig: vc(c.voice) },
      },
    },
  };
}

// 응답 어디에 있든 음성 데이터(base64)를 찾는다: Interactions(steps[].content[].data) · generateContent(inlineData)
function findAudio(o) {
  let found = null;
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.inlineData?.data || x.inline_data?.data) { const d = x.inlineData || x.inline_data; found = { data: d.data, mime: d.mimeType || d.mime_type || '' }; }
    else if (x.type === 'audio' && typeof x.data === 'string') found = { data: x.data, mime: x.mime_type || x.mimeType || '' };
    for (const [k, v] of Object.entries(x)) if (k !== 'data' && typeof v === 'object') walk(v);
  };
  walk(o);
  return found;
}

export class TtsError extends Error {
  constructor(msg, { status = 0, retry = 0, fatal = false } = {}) { super(msg); Object.assign(this, { status, retry, fatal }); }
}
function explain(status, body) {
  const m = body?.error?.message || '';
  const reason = JSON.stringify(body?.error?.details || '');
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(m + reason)) return new TtsError('API 키가 맞지 않아요. 낭독 설정에서 키를 다시 넣어 주세요.', { status, fatal: true });
  if (status === 401 || status === 403) {
    if (/location|region|country/i.test(m)) return new TtsError('지금 있는 나라·지역에서는 이 모델을 쓸 수 없다고 해요.', { status, fatal: true });
    if (/SERVICE_DISABLED|has not been used|disabled/i.test(m + reason)) return new TtsError('이 키의 구글 프로젝트에서 Gemini API가 꺼져 있어요. AI Studio에서 새 키를 만들어 주세요.', { status, fatal: true });
    return new TtsError('이 API 키로는 음성 모델을 쓸 수 없어요 (권한 없음). 키를 확인해 주세요.', { status, fatal: true });
  }
  if (status === 404) return new TtsError(`모델 ‘${cfg().model}’을 찾을 수 없어요. 낭독 설정에서 다른 모델을 골라 주세요.`, { status, fatal: true });
  if (status === 429) {
    const d = (body?.error?.details || []).find((x) => x.retryDelay)?.retryDelay;
    const quota = /quota|limit: 0|billing/i.test(m) && /per day|daily|limit: 0/i.test(m);
    if (quota) return new TtsError('오늘 쓸 수 있는 양(무료 한도)을 다 썼어요. 내일 다시 하거나 AI Studio에서 결제를 켜 주세요.', { status, fatal: true });
    return new TtsError('요청이 많아 잠시 기다리는 중이에요.', { status, retry: (parseFloat(d) || 0) * 1000 });
  }
  if (status >= 500) return new TtsError('구글 서버가 잠시 응답하지 않아요.', { status, retry: 0 });
  if (status === 400 && /safety|blocked|prohibited/i.test(m)) return new TtsError('이 부분은 구글이 음성으로 만들기를 거절했어요.', { status, fatal: false });
  return new TtsError(`음성을 만들지 못했어요 (${status}${m ? ': ' + m.slice(0, 120) : ''}).`, { status, fatal: status === 400 });
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('멈춤', 'AbortError')); }, { once: true });
});

async function callOnce(text, c, useLegacy, key, signal) {
  const { url, body } = requestFor(text, c, useLegacy);
  let res;
  try {
    // 키는 주소(URL)가 아니라 머리글로 보낸다 (주소는 기록에 남기 쉽다)
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal, referrerPolicy: 'no-referrer' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new TtsError(navigator.onLine === false ? '인터넷에 연결되어 있지 않아요.' : '구글 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.', { retry: 0 });
  }
  let json = null;
  try { json = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok) throw explain(res.status, json);
  const a = findAudio(json);
  if (!a) {
    const why = json?.candidates?.[0]?.finishReason || json?.status || '';
    throw new TtsError(`음성이 오지 않았어요${why ? ` (${why})` : ''}.`, { status: 200, retry: 0 });
  }
  const bytes = b64ToBytes(a.data);
  const isWav = /wav/i.test(a.mime) || (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46);
  const rate = +(a.mime.match(/rate=(\d+)/)?.[1] || RATE);
  return isWav ? pcmOf(bytes) : { pcm: bytes, rate };
}

// 글 한 조각 → { wav(Uint8Array), secs, cached }
export async function synth(text, { signal, onWait, c = cfg(), key = getKey() } = {}) {
  if (!key) throw new TtsError('Gemini API 키를 먼저 넣어 주세요.', { fatal: true, status: -1 });
  const parts = [c.model, c.voice, c.voice2 || '', c.style || '', c.voice2 ? c.style2 || '' : '', text];
  const k = c.cache ? await cacheKey(parts) : null;
  if (k) { const hit = await cacheGet(k); if (hit) return { wav: new Uint8Array(hit.wav), secs: hit.secs, rate: hit.rate || RATE, cached: true }; }
  let tries = 0, switched = false;
  for (;;) {
    try {
      const { pcm, rate } = await callOnce(text, c, legacy(c.model), key, signal);
      const secs = pcm.length / 2 / rate;
      const wav = toWav(pcm, rate);
      addUsage(nchars(text), secs);
      if (k) cachePut(k, { parts, wav: wav.buffer, secs, rate });
      return { wav, secs, rate, cached: false };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 모델이 다른 방식의 요청만 받는 경우: 한 번 바꿔 본다
      if (!switched && (e.status === 404 || (e.status === 400 && /interactions|not supported|unknown name|invalid json/i.test(e.message)))) {
        switched = true; route.set(c.model, !legacy(c.model)); continue;
      }
      if (switched && route.has(c.model)) route.delete(c.model);
      if (e.fatal || tries >= 4) throw e;
      const wait = e.retry || Math.min(30000, 2000 * 2 ** tries);
      tries++;
      onWait?.(e, wait);
      await sleep(wait, signal);
    }
  }
}

// ---------- 원고 → 조각 ----------
const BREAK = /^[\s*·•◇◆#~—\-=＊]+$/;
// 지금 장의 문단 목록 [{from, to, text, brk}] (장면 전환·구분선은 brk: 소리 없이 쉰다)
function paragraphs(doc, from = 0, to = doc.content.size, clip = false) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'horizontalRule') { if (pos + node.nodeSize > from && pos < to) out.push({ from: pos, to: pos + node.nodeSize, text: '', brk: true }); return false; }
    if (!node.isTextblock) return true;
    const end = pos + node.nodeSize;
    if (end <= from || pos >= to) return false;
    const a = clip ? Math.max(from, pos + 1) : pos + 1, b = clip ? Math.min(to, end - 1) : end - 1;
    const text = doc.textBetween(a, b, ' ', ' ').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    out.push({ from: pos, to: end, text, brk: BREAK.test(text) });
    return false;
  });
  return out;
}
// 문단을 묶어 조각으로. 첫 조각은 짧게 해서 빨리 시작한다. 아주 긴 문단은 문장 단위로 쪼갠다
function chunksOf(paras, size) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (const p of paras) {
    if (p.brk) { flush(); out.push({ text: '', brk: true, paras: [p] }); continue; }
    const limit = out.length ? size : Math.min(size, 260);
    const pieces = p.text.length > size * 1.5 ? p.text.match(/[^.!?。…]+[.!?。…]+[”’"']*\s*|[^.!?。…]+$/g) || [p.text] : [p.text];
    for (const s of pieces) {
      if (cur && cur.text.length + s.length > limit) flush();
      cur ||= { text: '', paras: [] };
      cur.text += (cur.text ? (cur.paras.at(-1) === p ? ' ' : '\n') : '') + s.trim();
      if (cur.paras.at(-1) !== p) cur.paras.push(p);
    }
  }
  flush();
  return out;
}

// ---------- 재생기 ----------
const P = {
  on: false, paused: false, i: 0, chunks: [], jobs: new Map(), ctrl: null, token: 0, chapter: null,
  audio: null, url: null, engine: 'gemini', lastTyping: 0, onlySel: false, cur: null,
};
const audio = () => (P.audio ||= Object.assign(new Audio(), { preservesPitch: true }));

function job(i) {
  if (i >= P.chunks.length) return null;
  if (P.jobs.has(i)) return P.jobs.get(i);
  const ch = P.chunks[i];
  const c = cfg();
  const p = ch.brk
    ? Promise.resolve({ wav: toWav(silence(c.breakPause)), secs: c.breakPause, brk: true })
    : synth(ch.text, { signal: P.ctrl.signal, onWait: (e, ms) => i === P.i && status(`${e.message} ${Math.ceil(ms / 1000)}초 뒤 다시 시도할게요…`) });
  p.catch(() => {}); // 처리는 재생할 때
  P.jobs.set(i, p);
  return p;
}
function prefetch(i) { const n = Math.max(0, Math.min(4, +cfg().prefetch || 0)); for (let k = 1; k <= n; k++) job(i + k); }

function status(t) { const s = $('#rdStatus'); if (s) s.textContent = t; }
function bar() {
  const b = $('#readBar');
  if (!b) return;
  b.hidden = !P.on;
  document.body.classList.toggle('reading', P.on);
  $('#rdPlay').textContent = P.paused ? '▶' : '❚❚';
  $('#rdPlay').title = P.paused ? '이어 읽기' : '잠깐 멈춤';
  $('#rdRate').value = String(cfg().rate);
  const total = P.chunks.length;
  $('#rdPos').textContent = total ? `${Math.min(P.i + 1, total)}/${total}` : '';
}

// 지금 읽는 문단 표시: 편집기 꾸밈(decoration)으로 칠한다 (DOM에 직접 붙이면 편집기가 다시 그릴 때 지워진다)
const readKey = new PluginKey('readAloud');
const readPlugin = new Plugin({
  key: readKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const m = tr.getMeta(readKey);
      if (m === undefined) return set.map(tr.mapping, tr.doc);
      if (!m) return DecorationSet.empty;
      const node = tr.doc.nodeAt(m.from);
      return node ? DecorationSet.create(tr.doc, [Decoration.node(m.from, m.from + node.nodeSize, { class: 'ra-cur' })]) : DecorationSet.empty;
    },
  },
  props: { decorations(state) { return P.on && app.cur === P.chapter ? readKey.getState(state) : null; } },
});
function mark(p) {
  const view = app.editor?.view;
  if (!view || (p && (P.cur === p || app.cur !== P.chapter))) return;
  P.cur = p;
  try { view.dispatch(view.state.tr.setMeta(readKey, p ? { from: p.from } : null).setMeta('addToHistory', false)); } catch { return; }
  if (!p || !cfg().follow || Date.now() - P.lastTyping < 4000) return;
  let el = null;
  try { el = view.nodeDOM(p.from); } catch { /* 위치가 바뀌었으면 건너뛴다 */ }
  if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
// 조각 안에서 지금 몇 번째 문단인지 (글자 수 비율로 짐작)
function paraAt(ch, frac) {
  const lens = ch.paras.map((p) => p.text.length || 1), sum = lens.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let k = 0; k < lens.length; k++) { acc += lens[k]; if (frac * sum < acc) return ch.paras[k]; }
  return ch.paras.at(-1);
}

async function playAt(i) {
  const tok = ++P.token;
  P.i = i;
  bar();
  if (i >= P.chunks.length) { await finished(); return; }
  const ch = P.chunks[i];
  mark(ch.paras[0]);
  if (P.engine === 'browser') { browserSay(ch, tok); return; }
  job(i);
  prefetch(i);
  const ready = await Promise.race([job(i).then(() => true, () => true), sleep(150).then(() => false)]);
  if (!ready && tok === P.token) status(`음성을 만드는 중… (${i + 1}/${P.chunks.length})`);
  let r;
  try { r = await job(i); } catch (e) {
    if (tok !== P.token || e.name === 'AbortError') return;
    if (e.fatal) { stop(); toast(e.message, 8000); if (e.status === -1 || /키/.test(e.message)) showReaderSettings(); return; }
    toast(`${e.message} 이 부분은 건너뛸게요.`, 6000);
    P.jobs.delete(i);
    playAt(i + 1);
    return;
  }
  if (tok !== P.token) return;
  const a = audio();
  if (P.url) URL.revokeObjectURL(P.url);
  P.url = URL.createObjectURL(new Blob([r.wav], { type: 'audio/wav' }));
  a.src = P.url;
  a.playbackRate = +cfg().rate || 1;
  a.onended = () => {
    if (tok !== P.token) return;
    P.jobs.delete(i); // 지난 조각은 메모리에서 뺀다 (캐시에는 남아 있다)
    const gap = ch.brk ? 0 : +cfg().gap || 0;
    if (gap) sleep(gap * 1000 / (+cfg().rate || 1), P.ctrl.signal).then(() => tok === P.token && playAt(i + 1), () => {});
    else playAt(i + 1);
  };
  a.ontimeupdate = () => { if (tok === P.token && a.duration) mark(paraAt(ch, a.currentTime / a.duration)); };
  status(ch.brk ? '장면 전환' : `읽는 중${r.cached ? ' (저장해 둔 음성)' : ''}`);
  try {
    if (!P.paused) await a.play();
  } catch (e) {
    if (tok !== P.token) return;
    P.paused = true; bar(); status('▶를 누르면 읽기 시작해요.');
  }
  media();
}

// 기기 목소리 (Gemini 키가 없을 때 · 인터넷 없이)
async function browserSay(ch, tok) {
  if (!('speechSynthesis' in window)) { stop(); toast('이 브라우저는 기기 목소리 읽기를 지원하지 않아요.'); return; }
  speechSynthesis.cancel();
  // 목소리 목록은 늦게 오기도 한다: 잠깐 기다려 보고 그래도 없으면 알린다
  if (!speechSynthesis.getVoices().length) {
    await new Promise((res) => { speechSynthesis.addEventListener('voiceschanged', res, { once: true }); setTimeout(res, 1200); });
    if (tok !== P.token) return;
    if (!speechSynthesis.getVoices().length) { stop(); toast('이 기기에는 읽어 줄 목소리가 설치되어 있지 않아요. 낭독 설정에서 Gemini 키를 넣으면 AI 목소리로 읽을 수 있어요.', 8000); return; }
  }
  if (ch.brk) { sleep(cfg().breakPause * 1000, P.ctrl.signal).then(() => tok === P.token && playAt(P.i + 1), () => {}); return; }
  const u = new SpeechSynthesisUtterance(ch.text);
  u.lang = 'ko-KR';
  u.rate = +cfg().rate || 1;
  const kos = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith('ko'));
  const ko = kos.find((v) => v.localService) || kos[0];
  if (ko) u.voice = ko;
  u.onboundary = (e) => { if (tok === P.token) mark(paraAt(ch, e.charIndex / ch.text.length)); };
  u.onend = () => { if (tok === P.token && !P.paused) playAt(P.i + 1); };
  u.onerror = (e) => { if (tok === P.token && e.error !== 'interrupted' && e.error !== 'canceled') { stop(); toast('기기 목소리로 읽지 못했어요.'); } };
  status('읽는 중 (기기 목소리)');
  speechSynthesis.speak(u);
  if (P.paused) speechSynthesis.pause();
}

async function finished() {
  const c = cfg();
  const o = app.project?.order || [];
  const next = o[o.indexOf(P.chapter) + 1];
  if (!P.onlySel && c.nextChapter && next) {
    await openChapter(next);
    toast(`다음 장 ‘${app.chapters.get(next)?.title || ''}’을 이어서 읽어요.`, 3000);
    begin(0, { keepOpen: true });
    return;
  }
  stop();
  toast(P.onlySel ? '고른 부분을 다 읽었어요.' : '끝까지 다 읽었어요.');
}

function media() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: app.chapters.get(P.chapter)?.title || '', artist: app.settings.author || '', album: app.project?.title || '' });
    navigator.mediaSession.setActionHandler('play', () => toggle());
    navigator.mediaSession.setActionHandler('pause', () => toggle());
    navigator.mediaSession.setActionHandler('previoustrack', () => skip(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => skip(1));
    navigator.mediaSession.setActionHandler('stop', () => stop());
  } catch { /* 지원하지 않으면 그만 */ }
}

// 읽기 시작: 고른 글이 있으면 그 부분만, 없으면 커서가 있는 문단부터 장 끝까지 (from=0이면 장 처음부터)
function begin(fromPos, { keepOpen = false } = {}) {
  const ed = app.editor;
  const c = cfg();
  const { from, to, empty } = ed.state.selection;
  P.onlySel = !keepOpen && !empty && fromPos == null;
  // 고른 부분만 읽을 때는 문단 안에서 고른 글자만, 아니면 커서가 있는 문단의 처음부터
  let paras = P.onlySel ? paragraphs(ed.state.doc, from, to, true) : paragraphs(ed.state.doc, fromPos ?? from);
  // 커서가 글 끝에 있으면 장 처음부터
  if (!P.onlySel && !keepOpen && !paras.some((p) => !p.brk) && (fromPos ?? from) > 0) {
    paras = paragraphs(ed.state.doc, 0);
    if (paras.some((p) => !p.brk)) toast('커서 뒤에 글이 없어 이 장 처음부터 읽어요.', 2500);
  }
  const list = paras.filter((p) => p.brk || p.text);
  if (!list.some((p) => !p.brk)) { if (!keepOpen) toast('읽을 글이 없어요.'); if (keepOpen) finished(); return; }
  P.ctrl?.abort();
  P.ctrl = new AbortController();
  P.jobs.clear();
  P.engine = c.engine === 'gemini' && getKey() ? 'gemini' : 'browser';
  if (c.engine === 'gemini' && !getKey() && !keepOpen) toast('Gemini 키가 없어 기기 목소리로 읽어요. 도구 › 낭독 설정에서 키를 넣을 수 있어요.', 6000);
  P.chunks = chunksOf(list, Math.max(200, Math.min(3000, +c.chunk || 700)));
  P.chapter = app.cur;
  P.on = true; P.paused = false; P.cur = undefined;
  playAt(0);
}

export function readAloud() {
  if (P.on) { toggle(); return; }
  begin();
}
export function readFromHere(pos) { if (P.on) stop(); begin(pos ?? app.editor.state.selection.from); }
export function readChapter() { if (P.on) stop(); begin(0); }
export function toggle() {
  if (!P.on) { readAloud(); return; }
  P.paused = !P.paused;
  if (P.engine === 'browser') { if (P.paused) speechSynthesis.pause(); else speechSynthesis.resume(); }
  else if (P.paused) audio().pause();
  else if (P.audio?.src && !P.audio.ended) audio().play().catch(() => {});
  else playAt(P.i);
  status(P.paused ? '잠깐 멈춤' : '읽는 중');
  bar();
}
export function skip(d) {
  if (!P.on) return;
  const i = Math.max(0, Math.min(P.chunks.length - 1, P.i + d));
  if (P.engine === 'browser') speechSynthesis.cancel();
  else audio().pause();
  P.paused = false;
  playAt(i);
}
export function stop() {
  P.token++;
  P.on = false; P.paused = false;
  P.ctrl?.abort();
  P.jobs.clear();
  if (P.audio) { P.audio.pause(); P.audio.removeAttribute('src'); P.audio.load(); }
  if (P.url) { URL.revokeObjectURL(P.url); P.url = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  mark(null);
  bar();
}
export const isReading = () => P.on;

// 읽는 동안 원고를 고치면 문단 위치를 따라 옮긴다
function mapPositions(tr) {
  if (!P.on || !tr.docChanged || app.cur !== P.chapter) return;
  P.lastTyping = Date.now();
  const seen = new Set();
  for (const ch of P.chunks) for (const p of ch.paras) {
    if (seen.has(p)) continue;
    seen.add(p);
    p.from = tr.mapping.map(p.from, 1); p.to = tr.mapping.map(p.to, -1);
  }
}

// ---------- 음성 파일로 저장 ----------
export async function exportAudio() {
  if (!getKey()) { toast('음성 파일은 Gemini 목소리로만 만들 수 있어요. 낭독 설정에서 키를 넣어 주세요.', 6000); showReaderSettings(); return; }
  const ed = app.editor, c = cfg();
  const { from, to, empty } = ed.state.selection;
  const r0 = await dialog({
    title: '음성 파일로 저장 (WAV)',
    body: `<label class="field"><span>범위</span><select name="range">
        ${empty ? '' : '<option value="sel">고른 부분</option>'}
        <option value="ch" selected>이 장 (${h(app.chapters.get(app.cur)?.title || '')})</option>
        <option value="all">작품 전체 (${(app.project?.order || []).length}개 장)</option></select></label>
      <p class="hint" id="axEst" style="margin:0"></p>
      <p class="hint" style="margin:0">이미 들어 본 부분은 저장해 둔 음성을 다시 써서 요금이 들지 않아요. 만드는 동안 이 창을 닫으면 멈춥니다.</p>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '만들기', value: 'ok', primary: true }],
    onOpen: (f) => {
      const upd = () => {
        const t = rangeText(f.range.value, { from, to });
        const n = t.reduce((a, x) => a + nchars(x.text || ''), 0), e = estimate(n);
        $('#axEst').textContent = `${n.toLocaleString()}자 · 음성 약 ${fmtSecs(e.secs)} · ${fmtUsd(e.usd)} (처음 만들 때 기준) · 파일 약 ${Math.max(1, Math.round(e.secs * RATE * 2 / 1048576))}MB`;
      };
      f.range.addEventListener('change', upd); upd();
    },
  });
  if (r0.value !== 'ok') return;
  const range = r0.form.range.value;
  const list = rangeText(range, { from, to });
  const chunks = [];
  for (const sec of list) {
    if (sec.title) chunks.push({ text: sec.title, title: true }, { brk: true });
    for (const ch of chunksOf(sec.paras, Math.max(200, Math.min(3000, +c.chunk || 700)))) chunks.push(ch);
    chunks.push({ brk: true });
  }
  const ctrl = new AbortController();
  let done = 0;
  const pcms = [];
  dialog({
    title: '음성 파일 만드는 중',
    body: `<div class="ax-prog"><progress id="axBar" max="${chunks.length}" value="0"></progress><p id="axMsg" class="hint">준비하는 중…</p></div>`,
    buttons: [{ label: '멈추기', value: 'close' }],
  }).then(() => ctrl.abort());
  try {
    for (const ch of chunks) {
      if (ctrl.signal.aborted) throw new DOMException('멈춤', 'AbortError');
      if (ch.brk) pcms.push(silence(c.breakPause));
      else {
        const r = await synth(ch.text, { signal: ctrl.signal, onWait: (e, ms) => { const m = $('#axMsg'); if (m) m.textContent = `${e.message} ${Math.ceil(ms / 1000)}초 뒤 다시 시도…`; } });
        pcms.push(pcmOf(r.wav).pcm, silence(c.gap));
      }
      done++;
      const b = $('#axBar'), m = $('#axMsg');
      if (b) b.value = done;
      if (m) m.textContent = `${done}/${chunks.length} 조각`;
    }
  } catch (e) {
    if ($('#dlg').open) $('#dlg').close();
    if (e.name === 'AbortError') { toast('음성 파일 만들기를 멈췄어요. 만든 부분은 저장해 두어서 다음에 이어서 만들 때 빨라요.', 6000); return; }
    toast(e.message, 8000);
    return;
  }
  if ($('#dlg').open) $('#dlg').close();
  const len = pcms.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(44 + len);
  out.set(wavHeader(len), 0);
  let o = 44;
  for (const p of pcms) { out.set(p, o); o += p.length; }
  const name = (range === 'all' ? app.project.title : `${app.project.title} - ${app.chapters.get(app.cur)?.title || ''}`).replace(/[\\/:*?"<>|]/g, '_').trim();
  download(new Blob([out], { type: 'audio/wav' }), `${name || '낭독'}.wav`);
  toast(`음성 파일을 저장했어요 (${fmtSecs(len / 2 / RATE)}).`, 5000);
}
// 범위 → [{title?, paras}]
function rangeText(range, { from, to }) {
  const ed = app.editor;
  if (range === 'sel') {
    const ps = paragraphs(ed.state.doc, from, to, true);
    return [{ paras: ps.filter((p) => p.brk || p.text), text: ps.map((p) => p.text).join('\n') }];
  }
  if (range === 'ch') { const ps = paragraphs(ed.state.doc); return [{ paras: ps, text: ps.map((p) => p.text).join('\n') }]; }
  const out = [];
  for (const id of app.project.order) {
    const ch = app.chapters.get(id);
    const html = id === app.cur ? null : ch?.html || '';
    const ps = html == null ? paragraphs(ed.state.doc) : paragraphsOfHtml(html);
    out.push({ title: ch?.title || '', paras: ps, text: (ch?.title || '') + '\n' + ps.map((p) => p.text).join('\n') });
  }
  return out;
}
function paragraphsOfHtml(html) {
  const d = new DOMParser().parseFromString(`<body>${html}`, 'text/html');
  d.querySelectorAll('script,style,template').forEach((e) => e.remove());
  const out = [];
  for (const el of d.body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,hr')) {
    if (el.tagName === 'HR') { out.push({ text: '', brk: true }); continue; }
    if (el.querySelector('p,li')) continue;
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: t, brk: BREAK.test(t) });
  }
  return out;
}

// ---------- 낭독 설정 ----------
let previewAudio = null;
export async function showReaderSettings() {
  const c = cfg();
  const key = getKey();
  const opt = (v, l, sel) => `<option value="${h(v)}" ${v === sel ? 'selected' : ''}>${h(l)}</option>`;
  const voiceOpts = (sel, none) => (none ? opt('', none, sel) : '') +
    ['여', '남'].map((g) => `<optgroup label="${g === '여' ? '여성 목소리' : '남성 목소리'}">${VOICES.filter((v) => v[2] === g).map(([n, d]) => opt(n, `${n} · ${d}`, sel)).join('')}</optgroup>`).join('');
  const known = MODELS.some((m) => m.id === c.model);
  const { n, b } = await cacheSize();
  const u = c.usage?.month === new Date().toISOString().slice(0, 7) ? c.usage : null;
  const r = await dialog({
    title: '낭독 설정 (AI 목소리)',
    wide: true,
    body: `<div class="rd-set">
      <section>
        <h3>읽는 방법</h3>
        <label class="radio"><input type="radio" name="engine" value="gemini" ${c.engine === 'gemini' ? 'checked' : ''}> <b>Gemini 목소리</b> <small>자연스러운 AI 낭독 · API 키 필요 · 원고 글이 구글로 보내집니다</small></label>
        <label class="radio"><input type="radio" name="engine" value="browser" ${c.engine === 'browser' ? 'checked' : ''}> <b>기기 목소리</b> <small>무료 · 인터넷 없이 · 기계음에 가까움</small></label>
      </section>
      <section class="rd-gem">
        <h3>Gemini API 키</h3>
        <p class="hint" style="margin:0"><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio의 API 키 화면</a>에서 ‘API 키 만들기’를 누르고, 만들어진 키를 아래에 붙여 넣으세요. 구글 계정 비밀번호는 필요 없습니다.</p>
        <div class="rd-key">
          <input name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${key ? h(maskKey(key)) + ' (저장됨 · 바꾸려면 새 키 붙여넣기)' : 'AI Studio에서 받은 키'}" aria-label="Gemini API 키">
          <button type="button" class="small" data-x="show" title="키 보기">보기</button>
          <button type="button" class="small" data-x="test">연결 시험</button>
          ${key ? '<button type="button" class="small danger" data-x="forget">키 지우기</button>' : ''}
        </div>
        <label class="check"><input type="checkbox" name="remember" ${!key || keyRemembered() ? 'checked' : ''}> 이 기기에 키 기억하기 <small>끄면 이 창을 닫을 때까지만 씁니다</small></label>
        <p class="hint" style="margin:0">키는 이 기기에만 저장되고 백업 파일·드라이브 동기화에는 들어가지 않습니다. 구글로 보낼 때도 주소가 아닌 머리글에 담아 보냅니다.</p>
        <p id="rdTest" class="hint" style="margin:0" aria-live="polite"></p>
      </section>
      <section class="rd-gem">
        <h3>모델과 목소리</h3>
        <div class="row2">
          <label class="field"><span>모델</span><select name="model">${MODELS.map((m) => opt(m.id, m.label + (m.hint ? ` — ${m.hint}` : ''), c.model)).join('')}${opt('custom', '직접 입력…', known ? '' : 'custom')}</select></label>
          <label class="field rd-custom" ${known ? 'hidden' : ''}><span>모델 이름</span><input name="modelId" value="${known ? '' : h(c.model)}" placeholder="gemini-…-tts" spellcheck="false"></label>
        </div>
        <div class="row2">
          <label class="field"><span>해설 목소리</span><span class="rd-voice"><select name="voice">${voiceOpts(c.voice)}</select><button type="button" class="small" data-x="pv1" title="미리 듣기">▶ 듣기</button></span></label>
          <label class="field"><span>대사 목소리 (따옴표 안)</span><span class="rd-voice"><select name="voice2">${voiceOpts(c.voice2, '해설과 같은 목소리')}</select><button type="button" class="small" data-x="pv2" title="미리 듣기">▶ 듣기</button></span></label>
        </div>
        <p class="hint" style="margin:0">대사 목소리를 고르면 “ ” 「 」 안의 말은 그 목소리로 읽어요. 한 번에 두 목소리까지라 모든 인물이 같은 대사 목소리를 씁니다.</p>
        <label class="field"><span>읽는 분위기</span><span class="chip-row">${STYLES.map(([id, l]) => `<label class="chip-radio"><input type="radio" name="styleId" value="${id}" ${id === c.styleId ? 'checked' : ''}><span>${l}</span></label>`).join('')}</span></label>
        <label class="field"><span>해설 연기 지시 <small>(목소리에 주는 말 · 글 자체는 바뀌지 않아요)</small></span><textarea name="styleTxt" rows="2" maxlength="300">${h(c.style)}</textarea></label>
        <label class="field rd-s2" ${c.voice2 ? '' : 'hidden'}><span>대사 연기 지시</span><input name="style2" maxlength="200" value="${h(c.style2)}"></label>
        <label class="field"><span>미리 듣기 문장</span><input name="sample" maxlength="200" value="${h(sampleText())}"></label>
      </section>
      <section>
        <h3>듣기</h3>
        <div class="row2">
          <label class="field"><span>빠르기</span><select name="rate">${[0.75, 0.85, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2].map((v) => opt(String(v), v === 1 ? '보통 (1배)' : `${v}배`, String(c.rate))).join('')}</select></label>
          <label class="field"><span>조각 사이 쉼</span><select name="gap">${[[0, '없음'], [0.2, '짧게'], [0.35, '보통'], [0.6, '길게']].map(([v, l]) => opt(String(v), l, String(c.gap))).join('')}</select></label>
          <label class="field"><span>장면 전환(* * *)에서 쉼</span><select name="breakPause">${[[0.6, '0.6초'], [1.2, '1.2초'], [2, '2초'], [3, '3초']].map(([v, l]) => opt(String(v), l, String(c.breakPause))).join('')}</select></label>
          <label class="field rd-gem"><span>한 번에 보내는 양</span><select name="chunk">${[[400, '짧게 (400자) · 빨리 시작'], [700, '보통 (700자)'], [1200, '길게 (1200자) · 흐름이 자연스러움'], [2000, '아주 길게 (2000자)']].map(([v, l]) => opt(String(v), l, String(c.chunk))).join('')}</select></label>
          <label class="field rd-gem"><span>미리 만들어 둘 조각</span><select name="prefetch">${[[1, '1개'], [2, '2개'], [3, '3개'], [4, '4개']].map(([v, l]) => opt(String(v), l, String(c.prefetch))).join('')}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="follow" ${c.follow ? 'checked' : ''}> 읽는 문단을 따라 화면 넘기기 <small>글을 고치는 동안에는 잠시 멈춤</small></label>
        <label class="check"><input type="checkbox" name="nextChapter" ${c.nextChapter ? 'checked' : ''}> 장이 끝나면 다음 장을 이어서 읽기</label>
        <label class="check rd-gem"><input type="checkbox" name="cache" ${c.cache ? 'checked' : ''}> 만든 음성을 이 기기에 저장해 두기 <small>같은 글을 다시 들을 때 요금 없음 · 최대 300MB</small></label>
      </section>
      <section class="rd-gem rd-use">
        <h3>사용량 (이 기기 기준)</h3>
        <p style="margin:0">이번 달 ${u ? `${u.chars.toLocaleString()}자 · 음성 ${fmtSecs(u.secs)} · ${fmtUsd(u.usd)}` : '아직 없음'} · 저장해 둔 음성 ${n.toLocaleString()}개 (${(b / 1048576).toFixed(1)}MB) <button type="button" class="small" data-x="clear" ${n ? '' : 'disabled'}>비우기</button></p>
        <p class="hint" style="margin:0">예상: 원고 1만 자 ≈ 음성 ${fmtSecs(10000 * c.spc)} ≈ ${fmtUsd(estimate(10000).usd)}. 무료 등급 키는 하루 사용량이 정해져 있고, 무료 등급에서 보낸 글은 구글이 서비스 개선에 쓸 수 있어요. 정확한 값은 <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noopener">구글 가격표</a>를 보세요.</p>
      </section>
    </div>`,
    buttons: [{ label: '취소', value: 'close' }, { label: '저장하고 여기부터 읽기', value: 'read' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f) => {
      const keyNow = () => f.key.value.trim() || getKey();
      const draft = () => ({
        ...c, model: f.model.value === 'custom' ? f.modelId.value.trim() : f.model.value, voice: f.voice.value, voice2: f.voice2.value,
        style: f.styleTxt.value.trim(), style2: f.style2.value.trim(), cache: f.cache.checked,
      });
      const engine = () => f.querySelectorAll('.rd-gem').forEach((e) => e.classList.toggle('off', f.engine.value !== 'gemini'));
      f.querySelectorAll('[name=engine]').forEach((x) => x.addEventListener('change', engine)); engine();
      f.model.addEventListener('change', () => { f.querySelector('.rd-custom').hidden = f.model.value !== 'custom'; if (f.model.value === 'custom') f.modelId.focus(); });
      f.voice2.addEventListener('change', () => { f.querySelector('.rd-s2').hidden = !f.voice2.value; });
      f.querySelectorAll('[name=styleId]').forEach((x) => x.addEventListener('change', () => {
        const s = STYLES.find((y) => y[0] === x.value);
        if (s && s[2]) f.styleTxt.value = s[2]; else f.styleTxt.focus();
      }));
      f.styleTxt.addEventListener('input', () => { const s = STYLES.find((y) => y[2] === f.styleTxt.value.trim()); f.querySelector(`[name=styleId][value=${s ? s[0] : 'custom'}]`).checked = true; });
      const out = $('#rdTest');
      let busy = null;
      const say = async (text, voiceField, label) => {
        const k = keyNow();
        if (!k) { out.textContent = '먼저 API 키를 넣어 주세요.'; f.key.focus(); return; }
        const d = draft();
        if (voiceField === 'voice2') { d.voice = d.voice2 || d.voice; d.voice2 = ''; d.style = d.style2 || d.style; }
        else d.voice2 = '';
        busy?.abort(); busy = new AbortController();
        out.textContent = `${label}: 만드는 중…`;
        const t0 = performance.now();
        try {
          const r = await synth(text, { c: d, key: k, signal: busy.signal, onWait: (e, ms) => { out.textContent = `${e.message} ${Math.ceil(ms / 1000)}초 뒤 다시 시도…`; } });
          previewAudio?.pause();
          previewAudio = new Audio(URL.createObjectURL(new Blob([r.wav], { type: 'audio/wav' })));
          previewAudio.playbackRate = +f.rate.value || 1;
          previewAudio.preservesPitch = true;
          await previewAudio.play().catch(() => {});
          out.textContent = `✓ ${label}: ${d.model} · ${d.voice} · ${r.cached ? '저장해 둔 음성' : `${((performance.now() - t0) / 1000).toFixed(1)}초 만에 만듦`} · ${r.secs.toFixed(1)}초 분량`;
        } catch (e) {
          if (e.name !== 'AbortError') out.textContent = `✕ ${e.message}`;
        }
      };
      f.addEventListener('click', async (e) => {
        const x = e.target.closest('[data-x]')?.dataset.x;
        if (!x) return;
        if (x === 'show') { f.key.type = f.key.type === 'password' ? 'text' : 'password'; e.target.textContent = f.key.type === 'password' ? '보기' : '숨기기'; }
        else if (x === 'test') say('안녕하세요. 연결이 잘 되었어요.', 'voice', '연결 시험');
        else if (x === 'pv1') say(f.sample.value.trim() || sampleText(), 'voice', '해설 목소리');
        else if (x === 'pv2') say(f.sample.value.trim() || sampleText(), 'voice2', '대사 목소리');
        else if (x === 'forget') { setKey(''); f.key.placeholder = 'AI Studio에서 받은 키'; e.target.remove(); out.textContent = '키를 지웠어요.'; }
        else if (x === 'clear') { await cacheClear(); e.target.disabled = true; out.textContent = '저장해 둔 음성을 비웠어요.'; }
      });
      f.key.addEventListener('input', () => {
        const v = f.key.value.trim();
        out.textContent = v && !/^[\w-]{20,}$/.test(v) ? '키 모양이 조금 이상해요. 앞뒤 빈칸이나 다른 글자가 섞이지 않았는지 확인해 주세요.' : '';
      });
      f.addEventListener('submit', () => { busy?.abort(); previewAudio?.pause(); }, { once: true });
    },
  });
  previewAudio?.pause();
  if (r.value !== 'ok' && r.value !== 'read') return;
  const f = r.form;
  const newKey = f.key.value.trim();
  if (newKey) setKey(newKey, f.remember.checked);
  else if (getKey()) setKey(getKey(), f.remember.checked);
  const model = f.model.value === 'custom' ? f.modelId.value.trim() || DEF.model : f.model.value;
  Object.assign(c, {
    engine: f.engine.value, model, voice: f.voice.value, voice2: f.voice2.value, styleId: f.styleId.value,
    style: f.styleTxt.value.trim(), style2: f.style2.value.trim(), rate: +f.rate.value || 1, gap: +f.gap.value, breakPause: +f.breakPause.value,
    chunk: +f.chunk.value || 700, prefetch: +f.prefetch.value || 2, follow: f.follow.checked, nextChapter: f.nextChapter.checked, cache: f.cache.checked,
  });
  saveSettings();
  if (c.engine === 'gemini' && !getKey()) toast('키가 없으면 기기 목소리로 읽어요.', 4000);
  if (P.on) { const i = P.i; stop(); begin(P.chunks[i]?.paras[0]?.from ?? 0); }
  else if (r.value === 'read') readAloud();
  else toast('낭독 설정을 저장했어요.', 1800);
}
function sampleText() {
  const t = app.editor?.state.selection.$from.parent.textContent.trim();
  return t && t.length > 8 ? t.slice(0, 120) : '“정말 가는 거야?” 그녀가 물었다. 창밖으로 마지막 기차가 천천히 멀어지고 있었다.';
}

// ---------- 연결 ----------
export function bindReader() {
  const b = document.createElement('div');
  b.id = 'readBar';
  b.className = 'read-bar';
  b.hidden = true;
  b.setAttribute('role', 'region');
  b.setAttribute('aria-label', '낭독');
  b.innerHTML = `<button id="rdPrev" class="icon-btn" title="앞 조각" aria-label="앞 조각">⏮</button>
    <button id="rdPlay" class="icon-btn rd-main" aria-label="재생·멈춤">❚❚</button>
    <button id="rdNext" class="icon-btn" title="다음 조각" aria-label="다음 조각">⏭</button>
    <button id="rdStop" class="icon-btn" title="그만 읽기 (Esc)" aria-label="그만 읽기">■</button>
    <span id="rdStatus" class="rd-status" aria-live="polite"></span><span id="rdPos" class="rd-pos"></span>
    <select id="rdRate" aria-label="빠르기">${[0.75, 0.85, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2].map((v) => `<option value="${v}">${v}×</option>`).join('')}</select>
    <button id="rdSet" class="icon-btn" title="낭독 설정" aria-label="낭독 설정">⚙</button>`;
  document.body.appendChild(b);
  b.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'SELECT') e.preventDefault(); }); // 편집기 커서를 지킨다
  $('#rdPlay').onclick = () => toggle();
  $('#rdPrev').onclick = () => skip(-1);
  $('#rdNext').onclick = () => skip(1);
  $('#rdStop').onclick = () => stop();
  $('#rdSet').onclick = () => showReaderSettings();
  $('#rdRate').onchange = (e) => {
    cfg().rate = +e.target.value || 1; saveSettings();
    if (P.audio) P.audio.playbackRate = cfg().rate;
    if (P.engine === 'browser' && P.on && !P.paused) playAt(P.i); // 기기 목소리는 다시 시작해야 빠르기가 바뀐다
  };
  app.editor.registerPlugin(readPlugin);
  app.editor.on('transaction', ({ transaction }) => mapPositions(transaction));
  // 읽는 장이 아닌 다른 장을 열면 멈춘다 (다음 장 이어 읽기는 제외)
  app.hooks.afterOpen.push(() => { if (P.on && app.cur !== P.chapter) setTimeout(() => { if (P.on && app.cur !== P.chapter) { stop(); toast('다른 장을 열어서 낭독을 멈췄어요.'); } }, 0); });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && P.on && !$('#dlg').open) stop();
  });
}
