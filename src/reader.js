// AI 낭독: Gemini 음성 모델(또는 기기 목소리)로 원고를 읽어 준다.
// 원고를 문단 단위로 묶어 조각으로 나누고, 지금 조각을 읽는 동안 다음 조각을 미리 만들어 끊김 없이 이어 읽는다.
// API 키는 이 기기에만 저장한다 (백업 파일·드라이브 동기화·설정에 들어가지 않는다).
import { app, saveSettings, openChapter, htmlParagraphs } from './app.js';
import * as S from './store.js';
import { askJSON, aiLabel, aiMissing, showAiSettings } from './ai.js';
import { $, h, toast, dialog } from './ui.js';
import { download, withDate } from './io/index.js';
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
  // 구글 클라우드 Text-to-Speech: 목소리 이름은 Gemini와 같고, 연기 지시 없이 빠르고 고르게 읽는다 (100만 자당 약 30달러)
  { id: 'chirp3-hd', label: 'Chirp 3 HD (구글 클라우드 TTS)', hint: '빠르고 고름 · 연기 지시 없음 · Cloud TTS API 필요', price: null, perChar: 30 },
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
  cast: false, castModel: 'gemini-flash-latest',
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
// Chirp(구글 클라우드 TTS)용 키: 따로 넣지 않으면 Gemini 키를 쓴다. 이 기기에만 저장
const CLOUD_LS = 'nw-gcloud-key';
export const isChirp = (m) => /^chirp/i.test(m || '');
export function cloudKey() { try { return localStorage.getItem(CLOUD_LS) || ''; } catch { return ''; } }
function setCloudKey(k) { try { if (k) localStorage.setItem(CLOUD_LS, k); else localStorage.removeItem(CLOUD_LS); } catch { /* 무시 */ } }
export const keyFor = (c = cfg()) => (isChirp(c.model) ? cloudKey() || getKey() : getKey());
function setKey(k, remember) {
  try {
    localStorage.removeItem(KEY_LS); sessionStorage.removeItem(KEY_LS);
    if (k) (remember ? localStorage : sessionStorage).setItem(KEY_LS, k);
  } catch { /* 저장소를 쓸 수 없으면 이번 창에서만 */ }
}
const keyRemembered = () => { try { return !!localStorage.getItem(KEY_LS); } catch { return false; } };
const maskKey = (k) => (k ? k.slice(0, 4) + '…' + k.slice(-4) : '');

// ---------- 가격·사용량 ----------
// 이 키로 쓸 수 있는 음성(TTS) 모델 이름들 (구글 모델 목록에서)
export async function ttsModels(key = getKey()) {
  const r = await fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  if (!r.ok) throw new Error(r.status === 400 || r.status === 403 ? 'API 키를 확인해 주세요.' : `모델 목록을 불러오지 못했어요 (${r.status}).`);
  const j = await r.json();
  return (j.models || []).map((m) => m.name.replace(/^models\//, '')).filter((id) => /tts/i.test(id)).sort();
}
function priceOf(model) {
  const m = MODELS.find((x) => x.id === model);
  if (!m?.price) return null;
  return new Date() < new Date('2027-01-01T00:00:00') ? m.price[0] : m.price[1];
}
const perChar = (model) => MODELS.find((x) => x.id === model)?.perChar || 0;
export function estimate(chars, model = cfg().model) {
  const secs = chars * cfg().spc;
  const p = priceOf(model);
  const usd = perChar(model) ? chars * perChar(model) / 1e6 : p ? (chars * 1.2 * p[0] + secs * 25 * p[1]) / 1e6 : null;
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
  if (perChar(c.model)) c.usage.usd += chars * perChar(c.model) / 1e6;
  else if (p) c.usage.usd += (chars * 1.2 * p[0] + secs * 25 * p[1]) / 1e6;
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
// apart: 이어진 대사도 하나씩 따로 둔다 (인물마다 목소리를 나눌 때 — 말한 사람이 다를 수 있다)
export function splitVoices(text, apart = false) {
  const segs = [];
  const push = (who, t) => {
    if (!t.trim()) { if (segs.length) segs[segs.length - 1].text += t; return; }
    const last = segs[segs.length - 1];
    if (last && last.who === who && !(apart && who === 'C')) last.text += t; else segs.push({ who, text: t });
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
    else if (typeof x.audioContent === 'string') found = { data: x.audioContent, mime: 'audio/wav' }; // 클라우드 TTS
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

async function callOnce(req, key, signal) {
  const { url, body } = req;
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
export function synth(text, { signal, onWait, c = cfg(), key = keyFor(c) } = {}) {
  if (isChirp(c.model)) {
    const two = c.voice2 && c.voice2 !== c.voice;
    const lines = two ? splitVoices(text).map((x) => ({ spk: x.who === 'C' ? c.voice2 : c.voice, text: x.text })) : [{ spk: c.voice, text }];
    return chirpSay(lines, { signal, onWait, c, key });
  }
  const parts = [c.model, c.voice, c.voice2 || '', c.style || '', c.voice2 ? c.style2 || '' : '', text];
  return runSynth(parts, (L) => requestFor(text, c, L), { signal, onWait, c, key, chars: nchars(text) });
}
// 요청 하나를 보내 음성을 받는다: 저장해 둔 음성 확인 → 보내기 → 실패하면 기다렸다 다시
async function runSynth(parts, mk, { signal, onWait, c, key, chars }) {
  if (!key) throw new TtsError('Gemini API 키를 먼저 넣어 주세요.', { fatal: true, status: -1 });
  const k = c.cache ? await cacheKey(parts) : null;
  if (k) { const hit = await cacheGet(k); if (hit) return { wav: new Uint8Array(hit.wav), secs: hit.secs, rate: hit.rate || RATE, cached: true }; }
  let tries = 0, switched = false;
  for (;;) {
    try {
      const { pcm, rate } = await callOnce(mk(legacy(c.model)), key, signal);
      const secs = pcm.length / 2 / rate;
      const wav = toWav(pcm, rate);
      addUsage(chars, secs);
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

// ---------- Chirp 3 HD (구글 클라우드 Text-to-Speech) ----------
// 한 요청에 한 목소리, 5000바이트까지라 문장 단위로 잘라 보낸다
const CLOUD = 'https://texttospeech.googleapis.com/v1/text:synthesize';
function chirpPieces(text, max = 1400) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  for (const s of text.match(/[^.!?。…\n]+[.!?。…]*[”’"']*\s*|\n+/g) || [text]) {
    if (cur && cur.length + s.length > max) { out.push(cur); cur = ''; }
    cur += s.length > max ? '' : s;
    if (s.length > max) for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  }
  if (cur.trim()) out.push(cur);
  return out.filter((x) => x.trim());
}
const chirpReq = (text, voice) => ({
  url: CLOUD,
  body: { input: { text }, voice: { languageCode: 'ko-KR', name: `ko-KR-Chirp3-HD-${voice}` }, audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: RATE } },
});
async function chirpSay(lines, { signal, onWait, c, key }) {
  const pcms = [];
  let secs = 0, cached = true;
  for (const l of lines) {
    for (const t of chirpPieces(l.text.trim())) {
      let r;
      try {
        r = await runSynth(['chirp', c.model, l.spk, t], () => chirpReq(t, l.spk), { signal, onWait, c, key, chars: nchars(t) });
      } catch (e) {
        if (e.status === 403) throw new TtsError('Chirp를 쓰려면 구글 클라우드 콘솔에서 이 키의 프로젝트에 ‘Cloud Text-to-Speech API’를 사용 설정해 주세요. (낭독 설정에서 클라우드 키를 따로 넣을 수도 있어요)', { status: 403, fatal: true });
        throw e;
      }
      const p = pcmOf(r.wav);
      pcms.push(p.pcm); secs += r.secs; cached &&= r.cached;
    }
  }
  const pcm = new Uint8Array(pcms.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of pcms) { pcm.set(p, o); o += p.length; }
  return { wav: toWav(pcm, RATE), secs, rate: RATE, cached };
}

// ---------- 인물마다 다른 목소리 ----------
// AI(글 모델)가 대사마다 누가 말했는지 판정하고, 인물마다 정한 목소리로 읽는다.
// 등장인물 목록은 작품에 저장한다 (백업·동기화에 함께). 해설은 '해설 목소리', 누군지 모르는 대사는 '대사 목소리'.
export const MAX_CAST = VOICES.length - 1; // 목소리 30개 중 해설 하나를 뺀 만큼
export const castOf = (p = app.project) => (p.cast ||= { chars: [] });
const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
export function charOf(name, cast = castOf()) {
  const n = norm(name);
  if (!n) return null;
  return cast.chars.find((x) => norm(x.name) === n || String(x.alias || '').split(/[,，、]/).some((a) => norm(a) && norm(a) === n)) || null;
}
// 아직 안 쓴 목소리를 성별에 맞춰 고른다
export function autoVoice(gender, cast = castOf(), c = cfg()) {
  const used = new Set([c.voice, ...cast.chars.map((x) => x.voice)]);
  const pool = VOICES.filter((v) => !used.has(v[0]));
  const pick = pool.find((v) => !gender || gender === '모름' || v[2] === gender) || pool[0];
  return pick ? pick[0] : VOICES[(cast.chars.length + 1) % VOICES.length][0];
}
let castSaveT;
const saveCast = () => { clearTimeout(castSaveT); castSaveT = setTimeout(() => S.putProject(app.project).catch(() => {}), 400); };
const NOBODY = /^(내레이션|해설|서술|내레이터|narrator|모름|알수없음|unknown|none|)$/i;
const ME = /^(나|저|내|제|본인|화자|서술자)$/;

// ---------- 시점: 1인칭이면 해설(서술)도 화자인 인물의 목소리로 ----------
export const POVS = [['auto', '자동 (AI가 장마다 판정)'], ['1', '1인칭 — 화자가 등장인물'], ['3', '3인칭·전지적 — 해설 목소리 따로']];
const chapterText = (id) => (id === app.cur ? app.editor.getText() : htmlParagraphs(app.chapters.get(id)?.html || '').join('\n'));
const povWait = new Map();
// → { pov: '1'|'3', narrator: 인물 이름 }
export async function povOf(chId = app.cur, { signal } = {}) {
  const cast = castOf();
  if (cast.pov === '1') return { pov: '1', narrator: cast.narrator || '나' };
  if (cast.pov === '3') return { pov: '3', narrator: '' };
  const by = (cast.povBy ||= {});
  if (by[chId]) return by[chId];
  if (povWait.has(chId)) return povWait.get(chId);
  const text = chapterText(chId).slice(0, 6000);
  if (!text.trim() || aiMissing()) return { pov: '3', narrator: '' };
  const roster = cast.chars.map((x) => x.name + (x.alias ? ` (${x.alias})` : '')).join(', ') || '(없음)';
  const prompt = `다음 소설 원고의 서술 시점을 판정하세요.
- pov: 서술자가 ‘나’·‘저’로 자기 이야기를 하거나 이야기 속에 직접 있는 인물이면 ‘1인칭’(주인공 시점·관찰자 시점 모두), 아니면 ‘3인칭’.
- narrator: 1인칭이면 서술자 ‘나’가 누구인지. 등장인물 목록에 있으면 그 이름을 그대로, 없으면 원고에서 부르는 이름, 이름이 끝까지 안 나오면 ‘나’. 3인칭이면 빈칸.
- gender: 서술자의 성별 (여·남·모름).
등장인물: ${roster}

원고:
${text}`;
  const schema = { type: 'OBJECT', properties: { pov: { type: 'STRING', enum: ['1인칭', '3인칭'] }, narrator: { type: 'STRING' }, gender: { type: 'STRING', enum: ['여', '남', '모름'] } }, required: ['pov'] };
  const p = askJSON(prompt, schema, { signal }).then((r) => {
    const v = { pov: r.pov === '1인칭' ? '1' : '3', narrator: r.pov === '1인칭' ? String(r.narrator || '나').trim() || '나' : '', gender: r.gender || '모름' };
    by[chId] = v; saveCast();
    return v;
  }).catch((e) => { if (e.name === 'AbortError' || e.fatal) throw e; return { pov: '3', narrator: '' }; })
    .finally(() => povWait.delete(chId));
  povWait.set(chId, p);
  return p;
}
// 1인칭 화자를 등장인물에서 찾고, 없으면 넣는다
function narratorChar(pv, cast, c) {
  if (pv?.pov !== '1' || !pv.narrator) return null;
  let ch = charOf(pv.narrator, cast);
  if (!ch && ME.test(pv.narrator)) ch = cast.chars.find((x) => x.narrator) || null;
  if (!ch && cast.chars.length < MAX_CAST) {
    const name = ME.test(pv.narrator) ? '나 (화자)' : pv.narrator;
    ch = { name, alias: '나', gender: pv.gender || '모름', voice: autoVoice(pv.gender, cast, c), style: '', auto: true, narrator: true };
    cast.chars.push(ch);
    saveCast();
  }
  return ch;
}

// 조각 → [{who: ''(해설) | 인물 이름 | '*'(모르는 대사), text}]
async function attribute(text, { signal, key, c, ctx = '', onWait, nar = null }) {
  const segs = splitVoices(text, true);
  if (!segs.some((x) => x.who === 'C')) return segs.map((x) => ({ who: '', text: x.text }));
  const cast = castOf();
  const roster = cast.chars.map((x) => `${x.name}${x.alias ? ` (다른 호칭: ${x.alias})` : ''}${x.gender && x.gender !== '모름' ? ` [${x.gender}]` : ''}`).join('\n') || '(아직 없음)';
  const parts = ['attr', aiLabel(), roster, nar?.name || '', ctx.slice(-500), text];
  const k = await cacheKey(parts);
  const hit = c.cache ? await cacheGet(k) : null;
  let lines = hit?.attr;
  if (!lines) {
    let n = 0;
    const marked = segs.map((x) => (x.who === 'C' ? `[Q${++n}]${x.text}` : x.text)).join('\n');
    const prompt = `소설 원고에서 따옴표로 묶인 대사마다 누가 말했는지 판정하세요.
- 대사 앞에 [Q1], [Q2] 같은 번호를 붙여 두었습니다. 번호마다 말한 인물을 하나씩 답하세요.
- 아래 '등장인물'에 있는 인물이면 그 이름을 그대로 쓰세요. 다른 호칭으로 불려도 같은 인물이면 목록의 이름으로 답하세요.
- 목록에 없는 인물이면 원고에서 부르는 이름을 쓰고, 이름이 없으면 ‘노인’, ‘점원’처럼 짧게 부르세요. 성별도 적으세요.
- 생각·속말·인용처럼 아무도 소리 내어 말하지 않은 것이면 speaker를 ‘해설’로 답하세요.
${nar ? `- 이 원고는 1인칭 시점이고 서술자 ‘나’는 ${nar.name}입니다. ‘나’가 소리 내어 한 말은 speaker를 ‘${nar.name}’로 답하세요.\n` : ''}
등장인물:
${roster}

바로 앞 내용:
${ctx.slice(-500) || '(없음)'}

원고:
${marked}`;
    const schema = { type: 'OBJECT', properties: { lines: { type: 'ARRAY', items: { type: 'OBJECT', properties: { q: { type: 'INTEGER' }, speaker: { type: 'STRING' }, gender: { type: 'STRING', enum: ['여', '남', '모름'] } }, required: ['q', 'speaker'] } } }, required: ['lines'] };
    for (let tries = 0; ; tries++) {
      try { lines = (await askJSON(prompt, schema, { signal })).lines || []; break; } catch (e) {
        if (e.name === 'AbortError' || e.fatal || tries >= 2) throw e;
        const wait = e.retry || 2000 * 2 ** tries;
        onWait?.(e, wait);
        await sleep(wait, signal);
      }
    }
    if (c.cache) cachePut(k, { parts, wav: new ArrayBuffer(0), secs: 0, attr: lines });
  }
  // 새 인물은 목록에 넣고 목소리를 정해 둔다
  const byQ = new Map();
  for (const l of lines) {
    const name = String(l.speaker || '').trim();
    if (NOBODY.test(name.replace(/\s/g, ''))) { byQ.set(l.q, ''); continue; }
    let ch = nar && ME.test(name.replace(/\s/g, '')) ? nar : charOf(name, cast);
    if (!ch && cast.chars.length < MAX_CAST) {
      ch = { name, alias: '', gender: l.gender || '모름', voice: autoVoice(l.gender, cast, c), style: '', auto: true };
      cast.chars.push(ch);
      saveCast();
    }
    byQ.set(l.q, ch ? ch.name : '*');
  }
  let q = 0;
  return segs.map((x) => (x.who === 'C' ? { who: byQ.has(++q) ? byQ.get(q) : '*', text: x.text } : { who: '', text: x.text }));
}

// 한 요청에 목소리 두 개까지: [{spk, text, style}] (spk는 목소리 이름)
function requestGroup(lines, c, useLegacy) {
  const spks = [...new Set(lines.map((l) => l.spk))];
  const multi = spks.length === 2;
  const label = (v) => (v === spks[0] ? 'Speaker1' : 'Speaker2');
  if (!useLegacy) {
    return {
      url: `${API}/interactions`,
      body: {
        model: c.model,
        input: [{ type: 'user_input', content: lines.map((l) => ({ type: 'text', text: l.text, annotations: [{ type: 'speech_metadata', ...(multi ? { speaker: label(l.spk) } : {}), ...(l.style ? { style: l.style } : {}) }] })) }],
        response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: RATE },
        generation_config: { speech_config: multi ? { mode: 'conversational', speakers: spks.map((v) => ({ speaker: label(v), voice: v })) } : [{ voice: spks[0] }] },
      },
    };
  }
  const trim = (x) => (x || '').trim().replace(/[.。]+$/, '');
  const how = [...new Map(lines.filter((l) => trim(l.style)).map((l) => [l.spk, `${multi ? label(l.spk) + ': ' : ''}${trim(l.style)}`])).values()].join(' / ');
  const prompt = multi
    ? `다음 소설 원고를 한국어로 낭독하세요.${how ? ` (${how})` : ''} 이름표는 읽지 말고, 글은 고치거나 빼지 마세요.\n\n` + lines.map((l) => `${label(l.spk)}: ${l.text}`).join('\n')
    : `다음 소설 원고를 한국어로 낭독하세요.${how ? ` (${how})` : ''} 글은 고치거나 빼지 말고 그대로 읽으세요.\n\n${lines.map((l) => l.text).join('\n')}`;
  const vc = (v) => ({ prebuiltVoiceConfig: { voiceName: v } });
  return {
    url: `${API}/models/${encodeURIComponent(c.model)}:generateContent`,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: multi ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: spks.map((v) => ({ speaker: label(v), voiceConfig: vc(v) })) } } : { voiceConfig: vc(spks[0]) },
      },
    },
  };
}

async function castSynth(text, { signal, onWait, c = cfg(), key = keyFor(c), ctx = '', chapter = app.cur } = {}) {
  if (!key) throw new TtsError('Gemini API 키를 먼저 넣어 주세요.', { fatal: true, status: -1 });
  const miss = aiMissing();
  if (miss) throw new TtsError('대사 판정: ' + miss, { fatal: true, status: -1 });
  const cast = castOf();
  // 1인칭이면 서술(해설)도 화자인 인물의 목소리로 읽는다: 해설과 ‘나’의 대사가 같은 사람 목소리
  const nar = narratorChar(await povOf(chapter, { signal }), cast, c);
  const segs = await attribute(text, { signal, key, c, ctx, onWait, nar });
  const narStyle = nar ? [c.style, `1인칭 화자(${nar.name})가 자기 이야기를 들려주듯`, nar.style].filter(Boolean).join(' / ') : c.style;
  const pick = (who) => {
    if (!who) return nar ? { voice: nar.voice, style: narStyle } : { voice: c.voice, style: c.style };
    const ch = who === '*' ? null : charOf(who, cast);
    return { voice: ch?.voice || c.voice2 || c.voice, style: ch?.style || c.style2 || c.style };
  };
  if (isChirp(c.model)) {
    // Chirp는 한 요청에 목소리 하나: 같은 목소리가 이어지는 줄끼리 묶어 차례로 만든다
    const lines = [];
    for (const x of segs) { const { voice } = pick(x.who); const last = lines.at(-1); if (last && last.spk === voice) last.text += ' ' + x.text; else lines.push({ spk: voice, text: x.text }); }
    return chirpSay(lines, { signal, onWait, c, key });
  }
  // 목소리가 두 개를 넘으면 요청을 나눈다. 같은 목소리가 이어지면 한 줄로 합친다
  const groups = [];
  let g = null;
  for (const x of segs) {
    const { voice, style } = pick(x.who);
    if (!g || (!g.v.has(voice) && g.v.size >= 2)) { g = { v: new Set(), lines: [] }; groups.push(g); }
    g.v.add(voice);
    const last = g.lines.at(-1);
    if (last && last.spk === voice && last.style === style) last.text += ' ' + x.text;
    else g.lines.push({ spk: voice, text: x.text, style });
  }
  const pcms = [];
  let secs = 0, rate = RATE, cached = true;
  for (const gr of groups) {
    const parts = ['cast', c.model, gr.lines];
    const r = await runSynth(parts, (L) => requestGroup(gr.lines, c, L), { signal, onWait, c, key, chars: nchars(gr.lines.map((l) => l.text).join('')) });
    const p = pcmOf(r.wav);
    rate = p.rate; pcms.push(p.pcm); secs += r.secs; cached &&= r.cached;
  }
  const len = pcms.reduce((a, p) => a + p.length, 0);
  const pcm = new Uint8Array(len);
  let o = 0;
  for (const p of pcms) { pcm.set(p, o); o += p.length; }
  return { wav: toWav(pcm, rate), secs, rate, cached };
}
// 낭독·음성 파일에서 쓰는 입구: 인물마다 다른 목소리가 켜져 있으면 판정을 거친다
export function speak(text, opts = {}) {
  const c = opts.c || cfg();
  return c.cast ? castSynth(text, opts) : synth(text, opts);
}

// 원고에서 등장인물 찾기 → [{name, alias, gender, desc}]
export async function findCast(text, { signal } = {}) {
  const miss = aiMissing();
  if (miss) throw new TtsError(miss, { fatal: true });
  const known = castOf().chars.map((x) => x.name).join(', ');
  const prompt = `다음 소설 원고에서 대사를 하는 등장인물을 모두 찾으세요. 많이 말하는 인물부터, 최대 ${MAX_CAST}명.
- name: 원고에서 가장 자주 부르는 이름. alias: 같은 인물을 부르는 다른 호칭(쉼표로).
- gender: 여·남·모름. desc: 나이대와 말투를 짧게 (예: ‘50대 남자, 무뚝뚝한 말투’).
${known ? `이미 아는 인물: ${known} (같은 인물이면 같은 이름으로)\n` : ''}
원고:
${text.slice(0, 300000)}`;
  const schema = { type: 'OBJECT', properties: { chars: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, alias: { type: 'STRING' }, gender: { type: 'STRING', enum: ['여', '남', '모름'] }, desc: { type: 'STRING' } }, required: ['name'] } } }, required: ['chars'] };
  return ((await askJSON(prompt, schema, { signal })).chars || []).filter((x) => x.name && !NOBODY.test(x.name.replace(/\s/g, '')));
}

// 작품 전체를 읽고 인물마다 어울리는 목소리와 연기 지시(목소리 설계)를 정한다. 시점·화자·해설 분위기도 함께.
export async function designCast(text, { signal } = {}) {
  const miss = aiMissing();
  if (miss) throw new TtsError(miss, { fatal: true });
  const voices = VOICES.map(([n, d, g]) => `${n} (${g}, ${d})`).join(', ');
  const prompt = `당신은 오디오북 캐스팅 감독입니다. 아래 소설 원고 전체를 읽고, 낭독에 쓸 목소리를 설계하세요.
1) 작품: 장르와 분위기를 파악하세요. pov는 서술자가 ‘나’로 이야기 속에 있으면 ‘1인칭’(주인공·관찰자 모두), 아니면 ‘3인칭’. 1인칭이면 narrator에 서술자 ‘나’의 이름(이름이 안 나오면 ‘나’).
2) 해설: narrationVoice는 아래 목소리 중 작품 분위기에 가장 맞는 하나. narrationStyle은 해설을 읽는 연기 지시(빠르기·톤·감정·쉼, 80~160자). 1인칭이면 화자가 자기 이야기를 하는 느낌으로.
3) 등장인물: 대사를 하는 인물을 많이 말하는 순서로 최대 ${MAX_CAST}명. 인물마다
 - name(원고에서 가장 자주 부르는 이름), alias(다른 호칭, 쉼표로), gender(여·남·모름)
 - voice: 아래 목소리 중 그 인물의 나이·성격·성별에 가장 맞는 것. 인물끼리, 그리고 해설과 되도록 겹치지 않게.
 - style: 그 인물의 목소리를 만드는 연기 지시. 나이대, 음색(허스키·맑음 등), 높낮이, 말 빠르기, 말투·사투리, 버릇, 이 작품에서 주로 드러나는 감정을 구체적으로 (60~160자). 인물의 이름이나 줄거리는 넣지 말고 소리만 설명하세요.
목소리 목록: ${voices}

원고:
${text.slice(0, 400000)}`;
  const names = VOICES.map((v) => v[0]);
  const schema = {
    type: 'OBJECT',
    properties: {
      genre: { type: 'STRING' }, pov: { type: 'STRING', enum: ['1인칭', '3인칭'] }, narrator: { type: 'STRING' },
      narrationVoice: { type: 'STRING', enum: names }, narrationStyle: { type: 'STRING' },
      chars: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, alias: { type: 'STRING' }, gender: { type: 'STRING', enum: ['여', '남', '모름'] }, voice: { type: 'STRING', enum: names }, style: { type: 'STRING' } }, required: ['name', 'voice', 'style'] } },
    },
    required: ['pov', 'narrationVoice', 'narrationStyle', 'chars'],
  };
  const r = await askJSON(prompt, schema, { signal });
  r.chars = (r.chars || []).filter((x) => x.name && !NOBODY.test(x.name.replace(/\s/g, '')));
  return r;
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
  audio: null, url: null, engine: 'gemini', lastTyping: 0, userScroll: 0, onlySel: false, cur: null,
};
const audio = () => (P.audio ||= Object.assign(new Audio(), { preservesPitch: true }));

function job(i) {
  if (i >= P.chunks.length) return null;
  if (P.jobs.has(i)) return P.jobs.get(i);
  const ch = P.chunks[i];
  const c = cfg();
  const p = ch.brk
    ? Promise.resolve({ wav: toWav(silence(c.breakPause)), secs: c.breakPause, brk: true })
    : speak(ch.text, { ctx: P.chunks[i - 1]?.text || '', chapter: P.chapter, signal: P.ctrl.signal, onWait: (e, ms) => i === P.i && status(`${e.message} ${Math.ceil(ms / 1000)}초 뒤 다시 시도할게요…`) });
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
  try { view.dispatch(view.state.tr.setMeta(readKey, p ? { from: p.from } : null).setMeta('addToHistory', false)); } catch { /* 위치가 바뀌었으면 건너뛴다 */ }
}
// 조각 안에서 지금 몇 번째 문단의 어디쯤인지 (글자 수 비율로 짐작, 문단 사이 쉼도 조금 넣는다)
function paraAt(ch, frac) {
  const lens = ch.paras.map((p) => (p.text.length || 1) + 6), sum = lens.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let k = 0; k < lens.length; k++) {
    if (frac * sum < acc + lens[k]) return { p: ch.paras[k], in: Math.max(0, Math.min(1, (frac * sum - acc) / lens[k])) };
    acc += lens[k];
  }
  return { p: ch.paras.at(-1), in: 1 };
}

// 화면 따라가기: 읽는 자리를 화면 위쪽 40% 높이에 두도록 매 프레임 조금씩 다가간다.
// 빠르기에 맞춰 더 빨리 따라가고(1.1배 이상에서 늦게 따라오던 문제), 긴 문단은 읽는 만큼 조금씩 내려간다.
// 손으로 스크롤하거나 글을 고치는 동안에는 잠시 멈춘다.
const LEAD = 0.25; // 초: 목소리보다 조금 먼저 움직여 눈이 따라오기 쉽게
let followRaf = 0, followLast = 0;
function scrollerOf(el) {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement;
}
function follow(where, now) {
  const view = app.editor?.view;
  const dt = Math.min(100, now - (followLast || now)); followLast = now;
  if (!where || !view || !cfg().follow || app.cur !== P.chapter) return;
  if (Date.now() - P.lastTyping < 4000 || Date.now() - P.userScroll < 3000) return;
  let el = null;
  try { el = view.nodeDOM(where.p.from); } catch { return; }
  if (!(el instanceof HTMLElement)) return;
  const sc = scrollerOf(el);
  const r = el.getBoundingClientRect();
  const top = sc === document.scrollingElement ? 0 : sc.getBoundingClientRect().top;
  const h = sc === document.scrollingElement ? innerHeight : sc.clientHeight;
  // 짧은 문단은 가운데쯤, 화면보다 긴 문단은 읽는 줄이 40% 높이에 오게
  const y = r.height < h * 0.5 ? r.top + r.height / 2 : r.top + r.height * where.in;
  const diff = y - (top + h * 0.4);
  if (Math.abs(diff) < 4) return;
  const rate = +cfg().rate || 1;
  const k = Math.min(1, (dt / 1000) * 5 * Math.max(1, rate)); // 1초에 남은 거리의 약 5배 속도로 (빠르기에 비례)
  sc.scrollTop += Math.abs(diff) > h * 2 ? diff : diff * k; // 너무 멀면 한 번에
}
function track(tok, prog) {
  cancelAnimationFrame(followRaf);
  followLast = 0;
  const step = (now) => {
    if (tok !== P.token || !P.on) return;
    const w = prog();
    if (w) { mark(w.p); if (!P.paused) follow(w, now); }
    followRaf = requestAnimationFrame(step);
  };
  followRaf = requestAnimationFrame(step);
}

async function playAt(i) {
  const tok = ++P.token;
  P.i = i;
  bar();
  if (i >= P.chunks.length) { await finished(); return; }
  const ch = P.chunks[i];
  mark(ch.paras[0]);
  track(tok, () => ({ p: ch.paras[0], in: 0 })); // 음성을 기다리는 동안에도 읽을 자리로 화면을 옮긴다
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
  a.defaultPlaybackRate = a.playbackRate = +cfg().rate || 1;
  a.onended = () => {
    if (tok !== P.token) return;
    P.jobs.delete(i); // 지난 조각은 메모리에서 뺀다 (캐시에는 남아 있다)
    const gap = ch.brk ? 0 : +cfg().gap || 0;
    if (gap) sleep(gap * 1000 / (+cfg().rate || 1), P.ctrl.signal).then(() => tok === P.token && playAt(i + 1), () => {});
    else playAt(i + 1);
  };
  // timeupdate는 1초에 몇 번뿐이라 매 프레임 재생 위치를 읽는다
  track(tok, () => (a.duration ? paraAt(ch, Math.min(1, (a.currentTime + LEAD * a.playbackRate) / a.duration)) : { p: ch.paras[0], in: 0 }));
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
  let at = { p: ch.paras[0], in: 0 };
  u.onboundary = (e) => { if (tok === P.token) at = paraAt(ch, e.charIndex / ch.text.length); };
  track(tok, () => at);
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
function begin(fromPos, { keepOpen = false, range = null } = {}) {
  const ed = app.editor;
  const c = cfg();
  let { from, to, empty } = ed.state.selection;
  if (range) { [from, to] = range; empty = false; fromPos = null; }
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
  P.engine = c.engine === 'gemini' && keyFor(c) ? 'gemini' : 'browser';
  if (c.engine === 'gemini' && !keyFor(c) && !keepOpen) toast('Gemini 키가 없어 기기 목소리로 읽어요. 도구 › 낭독 설정에서 키를 넣을 수 있어요.', 6000);
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
// 커서가 있는 문장 하나만 (고른 글이 있으면 그 부분만)
export function sentenceRange(state = app.editor.state) {
  const { $from, empty, from, to } = state.selection;
  if (!empty) return [from, to];
  const para = $from.parent;
  if (!para.isTextblock || !para.textContent.trim()) return null;
  const text = para.textContent, off = $from.parentOffset, start = $from.start();
  const re = /[^.!?。…]*[.!?。…]+[”’"'」』)]*\s*|[^.!?。…]+$/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const a = m.index, b = m.index + m[0].length;
    if (off < b || b >= text.length) {
      const lead = m[0].length - m[0].trimStart().length;
      return [start + a + lead, start + a + m[0].trimEnd().length];
    }
  }
  return [start, start + text.length];
}
export function readSentence() {
  if (P.on) stop();
  const r = sentenceRange();
  if (!r) { toast('커서를 문장 안에 두고 다시 눌러 주세요.'); return; }
  begin(null, { range: r });
}
export function readParagraph() {
  if (P.on) stop();
  const { $from } = app.editor.state.selection;
  if (!$from.parent.isTextblock || !$from.parent.textContent.trim()) { toast('커서를 문단 안에 두고 다시 눌러 주세요.'); return; }
  begin(null, { range: [$from.start(), $from.end()] });
}
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
  cancelAnimationFrame(followRaf);
  mark(null);
  bar();
}
export const isReading = () => P.on;

// 읽는 중에 다른 문단으로 옮기기: 그 문단부터 이어 읽는다 (조각 첫 문단이면 만들어 둔 음성을 그대로 쓴다)
export function jumpTo(pos) {
  if (!P.on || app.cur !== P.chapter) return false;
  const doc = app.editor.state.doc;
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  let start = pos;
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).isTextblock) { start = $p.before(d); break; }
  const i = P.onlySel ? -1 : P.chunks.findIndex((ch) => ch.paras[0] && !ch.brk && ch.paras[0].from === start);
  if (P.engine === 'browser') speechSynthesis.cancel(); else P.audio?.pause();
  P.paused = false;
  if (i >= 0) { playAt(i); return true; }
  const wasSel = P.onlySel;
  begin(start, { keepOpen: false });
  if (wasSel) toast('고른 부분 대신 이 문단부터 끝까지 읽어요.', 2500);
  return true;
}

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
  if (!keyFor()) { toast('음성 파일은 Gemini 목소리로만 만들 수 있어요. 낭독 설정에서 키를 넣어 주세요.', 6000); showReaderSettings(); return; }
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
    if (sec.title) chunks.push({ text: sec.title, title: true, chId: sec.chId }, { brk: true });
    for (const ch of chunksOf(sec.paras, Math.max(200, Math.min(3000, +c.chunk || 700)))) chunks.push({ ...ch, chId: sec.chId });
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
    let prev = '';
    for (const ch of chunks) {
      if (ctrl.signal.aborted) throw new DOMException('멈춤', 'AbortError');
      if (ch.brk) pcms.push(silence(c.breakPause));
      else {
        const ctx = prev;
        prev = ch.text;
        const r = await speak(ch.text, { ctx, chapter: ch.chId, signal: ctrl.signal, onWait: (e, ms) => { const m = $('#axMsg'); if (m) m.textContent = `${e.message} ${Math.ceil(ms / 1000)}초 뒤 다시 시도…`; } });
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
  download(new Blob([out], { type: 'audio/wav' }), withDate(`${name || '낭독'}.wav`, app.settings.nameDate));
  toast(`음성 파일을 저장했어요 (${fmtSecs(len / 2 / RATE)}).`, 5000);
}
// 범위 → [{title?, paras}]
function rangeText(range, { from, to }) {
  const ed = app.editor;
  if (range === 'sel') {
    const ps = paragraphs(ed.state.doc, from, to, true);
    return [{ chId: app.cur, paras: ps.filter((p) => p.brk || p.text), text: ps.map((p) => p.text).join('\n') }];
  }
  if (range === 'ch') { const ps = paragraphs(ed.state.doc); return [{ chId: app.cur, paras: ps, text: ps.map((p) => p.text).join('\n') }]; }
  const out = [];
  for (const id of app.project.order) {
    const ch = app.chapters.get(id);
    const html = id === app.cur ? null : ch?.html || '';
    const ps = html == null ? paragraphs(ed.state.doc) : paragraphsOfHtml(html);
    out.push({ chId: id, title: ch?.title || '', paras: ps, text: (ch?.title || '') + '\n' + ps.map((p) => p.text).join('\n') });
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
  const mine = (c.myModels || []).filter((id) => !MODELS.some((m) => m.id === id));
  const known = MODELS.some((m) => m.id === c.model) || mine.includes(c.model);
  const modelOpts = (sel) => MODELS.map((m) => opt(m.id, m.label + (m.hint ? ` — ${m.hint}` : ''), sel)).join('') +
    (mine.length ? `<optgroup label="불러오거나 직접 넣은 모델">${mine.map((id) => opt(id, id, sel)).join('')}</optgroup>` : '') + opt('custom', '직접 입력…', known ? '' : 'custom');
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
        <details class="rd-cloud" ${isChirp(c.model) ? 'open' : ''}><summary>Chirp 3 HD용 구글 클라우드 키 <small>(Chirp 모델을 고를 때만 · 비우면 위 키를 써요)</small></summary>
          <p class="hint" style="margin:0">Chirp 3 HD는 구글 클라우드의 Text-to-Speech API로 읽어요. <a href="https://console.cloud.google.com/apis/library/texttospeech.googleapis.com" target="_blank" rel="noopener">클라우드 콘솔</a>에서 키의 프로젝트에 ‘Cloud Text-to-Speech API’를 사용 설정하면 위 Gemini 키로도 돼요. 다른 프로젝트 키를 쓰려면 여기에 넣으세요.</p>
          <div class="rd-key"><input name="cloudKey" type="password" autocomplete="off" spellcheck="false" placeholder="${cloudKey() ? h(maskKey(cloudKey())) + ' (저장됨)' : '구글 클라우드 API 키 (선택)'}" aria-label="구글 클라우드 API 키">${cloudKey() ? '<button type="button" class="small danger" data-x="forgetCloud">지우기</button>' : ''}</div>
        </details>
        <p id="rdTest" class="hint" style="margin:0" aria-live="polite"></p>
      </section>
      <section class="rd-gem">
        <h3>모델과 목소리</h3>
        <div class="row2">
          <label class="field"><span>모델</span><select name="model">${modelOpts(c.model)}</select></label>
          <label class="field rd-custom" ${known ? 'hidden' : ''}><span>모델 이름 <small>(AI Studio에 나오는 이름 그대로, 예: 새로 나온 TTS·튜닝한 모델)</small></span><input name="modelId" value="${known ? '' : h(c.model)}" placeholder="gemini-…-tts" spellcheck="false" list="rdModelList"></label>
        </div>
        <div class="rd-cast"><button type="button" class="small" data-x="models">내 키로 쓸 수 있는 TTS 모델 불러오기</button><span id="rdModels" class="hint" aria-live="polite"></span></div>
        <datalist id="rdModelList">${mine.map((id) => `<option value="${h(id)}">`).join('')}</datalist>
        <div class="row2">
          <label class="field"><span>해설 목소리</span><span class="rd-voice"><select name="voice">${voiceOpts(c.voice)}</select><button type="button" class="small" data-x="pv1" title="미리 듣기">▶ 듣기</button></span></label>
          <label class="field"><span>대사 목소리 (따옴표 안)</span><span class="rd-voice"><select name="voice2">${voiceOpts(c.voice2, '해설과 같은 목소리')}</select><button type="button" class="small" data-x="pv2" title="미리 듣기">▶ 듣기</button></span></label>
        </div>
        <p class="hint" style="margin:0">대사 목소리를 고르면 “ ” 「 」 안의 말은 그 목소리로 읽어요. 인물마다 다른 목소리를 켜면 누가 말했는지 모르는 대사에만 이 목소리를 씁니다.</p>
        <div class="rd-cast">
          <label class="check"><input type="checkbox" name="cast" ${c.cast ? 'checked' : ''}> <b>인물마다 다른 목소리</b> <small>AI가 대사마다 누가 말하는지 판정 · 인물 ${castOf().chars.length}명 등록 · 최대 ${MAX_CAST}명</small></label>
          <button type="button" class="small" data-x="cast">등장인물 목소리 정하기…</button>
        </div>
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
    buttons: [{ label: '취소', value: 'close' }, { label: '등장인물', value: 'cast' }, { label: '저장하고 여기부터 읽기', value: 'read' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f) => {
      f.querySelector('.dlg-foot button[value=cast]').hidden = true;
      const keyNow = () => (isChirp(f.model.value === 'custom' ? f.modelId.value : f.model.value) ? f.cloudKey.value.trim() || cloudKey() : '') || f.key.value.trim() || getKey();
      const draft = () => ({
        ...c, model: f.model.value === 'custom' ? f.modelId.value.trim() : f.model.value, voice: f.voice.value, voice2: f.voice2.value,
        style: f.styleTxt.value.trim(), style2: f.style2.value.trim(), cache: f.cache.checked,
      });
      const engine = () => f.querySelectorAll('.rd-gem').forEach((e) => e.classList.toggle('off', f.engine.value !== 'gemini'));
      f.querySelectorAll('[name=engine]').forEach((x) => x.addEventListener('change', engine)); engine();
      f.model.addEventListener('change', () => {
        f.querySelector('.rd-custom').hidden = f.model.value !== 'custom'; if (f.model.value === 'custom') f.modelId.focus();
        if (isChirp(f.model.value)) { f.querySelector('.rd-cloud').open = true; out.textContent = 'Chirp 3 HD는 연기 지시(분위기)를 쓰지 않고 목소리만 바꿔 읽어요.'; }
      });
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
        else if (x === 'forgetCloud') { setCloudKey(''); e.target.remove(); out.textContent = '클라우드 키를 지웠어요.'; }
        else if (x === 'forget') { setKey(''); f.key.placeholder = 'AI Studio에서 받은 키'; e.target.remove(); out.textContent = '키를 지웠어요.'; }
        else if (x === 'clear') { await cacheClear(); e.target.disabled = true; out.textContent = '저장해 둔 음성을 비웠어요.'; }
        else if (x === 'cast') f.requestSubmit(f.querySelector('.dlg-foot button[value=cast]'));
        else if (x === 'models') {
          const m = $('#rdModels');
          const k = keyNow();
          if (!k) { m.textContent = '먼저 API 키를 넣어 주세요.'; f.key.focus(); return; }
          m.textContent = '불러오는 중…';
          try {
            const got = await ttsModels(k);
            const fresh = got.filter((id) => !MODELS.some((x) => x.id === id));
            c.myModels = [...new Set([...(c.myModels || []), ...fresh])];
            saveSettings();
            const cur = f.model.value;
            f.model.innerHTML = MODELS.map((x) => opt(x.id, x.label + (x.hint ? ` — ${x.hint}` : ''), cur)).join('') +
              (c.myModels.length ? `<optgroup label="불러오거나 직접 넣은 모델">${c.myModels.filter((id) => !MODELS.some((x) => x.id === id)).map((id) => opt(id, id, cur)).join('')}</optgroup>` : '') + opt('custom', '직접 입력…', cur);
            f.model.value = cur;
            $('#rdModelList').innerHTML = c.myModels.map((id) => `<option value="${h(id)}">`).join('');
            m.textContent = got.length ? `TTS 모델 ${got.length}개를 찾았어요${fresh.length ? ` (목록에 없던 ${fresh.length}개를 더함)` : ''}. 모델 칸에서 고르세요.` : '이 키로 쓸 수 있는 TTS 모델을 찾지 못했어요.';
          } catch (err) { m.textContent = '✕ ' + err.message; }
        }
      });
      f.key.addEventListener('input', () => {
        const v = f.key.value.trim();
        out.textContent = v && !/^[\w-]{20,}$/.test(v) ? '키 모양이 조금 이상해요. 앞뒤 빈칸이나 다른 글자가 섞이지 않았는지 확인해 주세요.' : '';
      });
      f.addEventListener('submit', () => { busy?.abort(); previewAudio?.pause(); }, { once: true });
    },
  });
  previewAudio?.pause();
  if (r.value !== 'ok' && r.value !== 'read' && r.value !== 'cast') return;
  const f = r.form;
  const newKey = f.key.value.trim();
  if (f.cloudKey.value.trim()) setCloudKey(f.cloudKey.value.trim());
  if (newKey) setKey(newKey, f.remember.checked);
  else if (getKey()) setKey(getKey(), f.remember.checked);
  const model = f.model.value === 'custom' ? f.modelId.value.trim() || DEF.model : f.model.value;
  // 직접 넣은 모델은 다음에도 고를 수 있게 남긴다
  if (f.model.value === 'custom' && f.modelId.value.trim() && !MODELS.some((m) => m.id === model)) c.myModels = [...new Set([...(c.myModels || []), model])];
  Object.assign(c, {
    engine: f.engine.value, model, voice: f.voice.value, voice2: f.voice2.value, styleId: f.styleId.value,
    style: f.styleTxt.value.trim(), style2: f.style2.value.trim(), rate: +f.rate.value || 1, gap: +f.gap.value, breakPause: +f.breakPause.value,
    chunk: +f.chunk.value || 700, prefetch: +f.prefetch.value || 2, follow: f.follow.checked, nextChapter: f.nextChapter.checked, cache: f.cache.checked,
    cast: f.cast.checked,
  });
  saveSettings();
  if (r.value === 'cast') { showCast({ back: true }); return; }
  if (c.engine === 'gemini' && !keyFor(c)) toast('키가 없으면 기기 목소리로 읽어요.', 4000);
  if (P.on) { const i = P.i; stop(); begin(P.chunks[i]?.paras[0]?.from ?? 0); }
  else if (r.value === 'read') readAloud();
  else toast('낭독 설정을 저장했어요.', 1800);
}
// ---------- 등장인물 목소리 창 ----------
const optH = (v, l, sel) => `<option value="${h(v)}" ${v === sel ? 'selected' : ''}>${h(l)}</option>`;
const voiceOptions = (sel, none) => (none ? optH('', none, sel) : '') +
  ['여', '남'].map((g) => `<optgroup label="${g === '여' ? '여성 목소리' : '남성 목소리'}">${VOICES.filter((v) => v[2] === g).map(([n, d]) => optH(n, `${n} · ${d}`, sel)).join('')}</optgroup>`).join('');
export async function showCast({ back = false } = {}) {
  const c = cfg();
  const cast = castOf();
  const list = cast.chars.map((x) => ({ ...x }));
  const row = (x, i) => `<div class="cast-row" data-i="${i}">
      <input name="n${i}" value="${h(x.name)}" placeholder="이름" aria-label="이름" required>
      <input name="a${i}" value="${h(x.alias || '')}" placeholder="다른 호칭 (쉼표로)" aria-label="다른 호칭">
      <select name="g${i}" aria-label="성별">${['여', '남', '모름'].map((g) => optH(g, g, x.gender || '모름')).join('')}</select>
      <span class="rd-voice"><select name="v${i}" aria-label="목소리">${voiceOptions(x.voice)}</select><button type="button" class="small" data-c="pv" data-i="${i}" title="미리 듣기" aria-label="미리 듣기">▶</button></span>
      <input name="s${i}" value="${h(x.style || '')}" placeholder="연기 지시 (예: 50대 남자, 무뚝뚝하게)" aria-label="연기 지시" maxlength="200">
      <button type="button" class="small cast-del" data-c="del" data-i="${i}" title="지우기" aria-label="${h(x.name)} 지우기">✕</button></div>`;
  const r = await dialog({
    title: '등장인물 목소리',
    wide: true,
    body: `<div class="rd-set cast-set">
      <label class="check"><input type="checkbox" name="on" ${c.cast ? 'checked' : ''}> <b>인물마다 다른 목소리로 읽기</b> <small>AI가 조각마다 대사를 누가 말했는지 판정해요. 판정 요금은 음성보다 훨씬 적어요.</small></label>
      <div class="row2">
        <label class="field"><span>해설(내레이션) 목소리</span><span class="rd-voice"><select name="nv">${voiceOptions(c.voice)}</select><button type="button" class="small" data-c="pvn" title="미리 듣기">▶</button></span></label>
        <label class="field"><span>누군지 모르는 대사</span><select name="dv">${voiceOptions(c.voice2, '해설과 같은 목소리')}</select></label>
      </div>
      <div class="row2">
        <label class="field"><span>소설의 시점</span><select name="pov">${POVS.map(([v, l]) => optH(v, l, cast.pov || 'auto')).join('')}</select></label>
        <label class="field cast-nar"><span>화자 ‘나’ <small>(1인칭일 때 해설도 이 인물 목소리로)</small></span><input name="narrator" value="${h(cast.narrator || '')}" placeholder="예: 민준 · 비우면 ‘나’" list="castNames"></label>
      </div>
      <p class="hint" id="povNow" style="margin:0"></p>
      <datalist id="castNames"></datalist>
      <input type="hidden" name="nstyle" value="">
      <section>
        <h3>등장인물 <small id="castN"></small></h3>
        <div class="cast-find"><button type="button" class="small primary" data-c="design" title="작품 전체를 읽고 인물마다 어울리는 목소리·연기 지시를 정해요">AI가 작품 전체를 읽고 목소리·연기 정하기</button><button type="button" class="small" data-c="find" data-scope="ch">AI로 이 장에서 인물 찾기</button><button type="button" class="small" data-c="find" data-scope="all">작품 전체에서 찾기</button><button type="button" class="small" data-c="add">+ 직접 추가</button><span id="castMsg" class="hint" aria-live="polite"></span></div>
        <div class="cast-head" aria-hidden="true"><span>이름</span><span>다른 호칭</span><span>성별</span><span>목소리</span><span>연기 지시</span><span></span></div>
        <div id="castList" class="cast-list"></div>
        <p class="hint" style="margin:0">읽다가 목록에 없는 인물이 나오면 AI가 알아서 넣고 아직 안 쓴 목소리를 정해 둬요. 목소리는 ${VOICES.length}개라 해설을 빼고 ${MAX_CAST}명까지 서로 다른 목소리를 줄 수 있어요.</p>
      </section>
      <div class="ai-pick"><span>판정·인물 찾기 AI</span><b>${h(aiLabel())}</b><button type="button" class="small" data-c="ai">바꾸기…</button></div>
    </div>`,
    buttons: [{ label: '취소', value: 'close' }, { label: 'AI', value: 'ai' }, { label: '저장', value: 'ok', primary: true }],
    onOpen: (f) => {
      f.querySelector('.dlg-foot button[value=ai]').hidden = true;
      const msg = $('#castMsg');
      const read = () => list.forEach((x, i) => {
        if (!f[`n${i}`]) return;
        Object.assign(x, { name: f[`n${i}`].value.trim(), alias: f[`a${i}`].value.trim(), gender: f[`g${i}`].value, voice: f[`v${i}`].value, style: f[`s${i}`].value.trim() });
      });
      const povHint = () => {
        const v = f.pov.value;
        f.querySelector('.cast-nar').hidden = v !== '1';
        const d = cast.povBy?.[app.cur];
        $('#povNow').textContent = v === 'auto' ? (d ? `이 장은 AI가 ${d.pov === '1' ? `1인칭(화자: ${d.narrator || '나'})` : '3인칭'}으로 판정했어요. 1인칭이면 해설과 화자의 대사를 같은 목소리로 읽어요.` : '읽기 시작할 때 AI가 장마다 시점과 화자를 판정해요. 1인칭이면 해설과 화자의 대사를 같은 목소리로 읽어요.') : v === '1' ? '해설(서술)과 화자 ‘나’의 대사를 화자 인물의 목소리로 읽어요.' : '해설은 해설 목소리로 따로 읽어요.';
      };
      f.pov.addEventListener('change', povHint);
      const draw = () => {
        povHint();
        $('#castNames').innerHTML = list.map((x) => `<option value="${h(x.name)}">`).join('');
        $('#castList').innerHTML = list.map(row).join('') || '<p class="hint">아직 없어요. AI로 찾거나 직접 넣어 주세요.</p>';
        const dup = list.length - new Set(list.map((x) => x.voice)).size;
        $('#castN').textContent = `${list.length}/${MAX_CAST}명${dup ? ` · 같은 목소리를 쓰는 인물 ${dup}쌍` : ''}`;
        f.querySelector('[data-c=add]').disabled = list.length >= MAX_CAST;
      };
      draw();
      let busy = null;
      const preview = async (voice, style, name) => {
        busy?.abort(); busy = new AbortController();
        msg.textContent = '만드는 중…';
        try {
          const r = await synth(`“${name ? name + '의 목소리는 이렇게 들려요.' : '해설은 이렇게 들려요.'} 오늘은 바람이 꽤 차네요.”`, { c: { ...c, voice, voice2: '', style: style || c.style }, signal: busy.signal });
          previewAudio?.pause();
          previewAudio = new Audio(URL.createObjectURL(new Blob([r.wav], { type: 'audio/wav' })));
          previewAudio.preservesPitch = true;
          await previewAudio.play().catch(() => {});
          msg.textContent = '';
        } catch (e) { if (e.name !== 'AbortError') msg.textContent = '✕ ' + e.message; }
      };
      f.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-c]');
        if (!b) return;
        read();
        const i = +b.dataset.i;
        if (b.dataset.c === 'pv') preview(list[i].voice, list[i].style, list[i].name);
        if (b.dataset.c === 'pvn') preview(f.nv.value, '', '');
        if (b.dataset.c === 'del') { list.splice(i, 1); draw(); }
        if (b.dataset.c === 'ai') { f.requestSubmit(f.querySelector('.dlg-foot button[value=ai]')); return; }
        if (b.dataset.c === 'add' && list.length < MAX_CAST) {
          list.push({ name: '', alias: '', gender: '모름', voice: autoVoice('', { chars: list }, { ...c, voice: f.nv.value }), style: '' });
          draw(); f[`n${list.length - 1}`]?.focus();
        }
        if (b.dataset.c === 'design') {
          const text = app.project.order.map((id) => chapterText(id)).join('\n\n');
          if (!text.trim()) { msg.textContent = '원고가 비어 있어요.'; return; }
          f.querySelectorAll('[data-c=find],[data-c=design]').forEach((x) => { x.disabled = true; });
          msg.textContent = `AI가 작품 전체(${text.length.toLocaleString()}자)를 읽고 목소리를 정하는 중…`;
          try {
            const d = await designCast(text);
            const used = new Set([d.narrationVoice]);
            for (const g of d.chars) {
              let x = charOf(g.name, { chars: list });
              if (!x) { if (list.length >= MAX_CAST) continue; x = { name: g.name, alias: '', gender: '모름', voice: '', style: '' }; list.push(x); }
              if (g.alias && !x.alias) x.alias = g.alias;
              if (g.gender) x.gender = g.gender;
              x.style = g.style || x.style;
              x.voice = used.has(g.voice) ? autoVoice(x.gender, { chars: list.filter((y) => y !== x && y.voice) }, { ...c, voice: d.narrationVoice }) : g.voice;
              used.add(x.voice);
            }
            f.nv.value = d.narrationVoice;
            f.nstyle.value = d.narrationStyle || '';
            if (d.pov === '1인칭') { f.pov.value = '1'; f.narrator.value = (d.narrator && !ME.test(d.narrator)) ? d.narrator : ''; } else f.pov.value = '3';
            draw();
            msg.textContent = `${d.genre ? d.genre + ' · ' : ''}${d.pov || ''} · 인물 ${d.chars.length}명의 목소리와 연기 지시를 정했어요. ▶로 들어 보고 저장하세요. 해설 분위기도 바꿔 둘게요.`;
          } catch (err) { msg.textContent = '✕ ' + err.message; }
          f.querySelectorAll('[data-c=find],[data-c=design]').forEach((x) => { x.disabled = false; });
        }
        if (b.dataset.c === 'find') {
          const all = b.dataset.scope === 'all';
          const text = all
            ? app.project.order.map((id) => (id === app.cur ? app.editor.getText() : htmlParagraphs(app.chapters.get(id)?.html || '').join('\n'))).join('\n\n')
            : app.editor.getText();
          if (!text.trim()) { msg.textContent = '원고가 비어 있어요.'; return; }
          f.querySelectorAll('[data-c=find]').forEach((x) => { x.disabled = true; });
          msg.textContent = 'AI가 인물을 찾는 중…';
          try {
            const got = await findCast(text);
            let added = 0;
            for (const g of got) {
              if (list.length >= MAX_CAST) break;
              const ex = charOf(g.name, { chars: list });
              if (ex) { if (!ex.alias && g.alias) ex.alias = g.alias; if ((!ex.gender || ex.gender === '모름') && g.gender) ex.gender = g.gender; if (!ex.style && g.desc) ex.style = g.desc; continue; }
              list.push({ name: g.name, alias: g.alias || '', gender: g.gender || '모름', voice: autoVoice(g.gender, { chars: list }, { ...c, voice: f.nv.value }), style: g.desc || '' });
              added++;
            }
            draw();
            msg.textContent = got.length ? `${got.length}명을 찾았고 ${added}명을 새로 넣었어요. 목소리와 연기 지시를 확인해 주세요.` : '대사를 하는 인물을 찾지 못했어요.';
          } catch (err) { msg.textContent = '✕ ' + err.message; }
          f.querySelectorAll('[data-c=find]').forEach((x) => { x.disabled = false; });
        }
      });
      f.addEventListener('submit', () => { busy?.abort(); previewAudio?.pause(); }, { once: true });
    },
  });
  previewAudio?.pause();
  if (r.value === 'ok' || r.value === 'ai') {
    const f = r.form;
    list.forEach((x, i) => { if (f[`n${i}`]) Object.assign(x, { name: f[`n${i}`].value.trim(), alias: f[`a${i}`].value.trim(), gender: f[`g${i}`].value, voice: f[`v${i}`].value, style: f[`s${i}`].value.trim() }); });
    cast.chars = list.filter((x) => x.name).map(({ auto, ...x }) => x);
    Object.assign(c, { cast: f.on.checked, voice: f.nv.value, voice2: f.dv.value });
    if (f.nstyle.value) Object.assign(c, { style: f.nstyle.value, styleId: 'custom' });
    // 시점·화자를 바꾸면 장마다 한 판정은 지우고 새로 한다
    if ((cast.pov || 'auto') !== f.pov.value || (cast.narrator || '') !== f.narrator.value.trim()) cast.povBy = {};
    cast.pov = f.pov.value; cast.narrator = f.narrator.value.trim();
    saveSettings();
    await S.putProject(app.project);
    if (P.on) { const i = P.i; stop(); begin(P.chunks[i]?.paras[0]?.from ?? 0); }
    if (r.value === 'ai') { await showAiSettings({ back: () => showCast({ back }) }); return; }
    toast(c.cast ? `인물 ${cast.chars.length}명의 목소리를 저장했어요. 인물마다 다른 목소리로 읽어요.` : '등장인물 목소리를 저장했어요 (지금은 꺼져 있어요).', 3000);
  }
  if (back) showReaderSettings();
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
    <button id="rdHere" class="icon-btn" title="커서가 있는 문단부터 읽기 (읽는 중에 문단을 두 번 눌러도 돼요)" aria-label="커서 문단부터 읽기">⤵</button>
    <span id="rdStatus" class="rd-status" aria-live="polite"></span><span id="rdPos" class="rd-pos"></span>
    <select id="rdRate" aria-label="빠르기">${[0.75, 0.85, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2].map((v) => `<option value="${v}">${v}×</option>`).join('')}</select>
    <button id="rdSet" class="icon-btn" title="낭독 설정" aria-label="낭독 설정">⚙</button>
    <button id="rdClose" class="icon-btn rd-close" title="낭독 끄기 (Esc)" aria-label="낭독 끄기">✕</button>`;
  document.body.appendChild(b);
  b.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'SELECT') e.preventDefault(); }); // 편집기 커서를 지킨다
  $('#rdPlay').onclick = () => toggle();
  $('#rdPrev').onclick = () => skip(-1);
  $('#rdNext').onclick = () => skip(1);
  $('#rdStop').onclick = () => stop();
  $('#rdClose').onclick = () => stop();
  $('#rdHere').onclick = () => jumpTo(app.editor.state.selection.from);
  // 읽는 중에 문단을 두 번 누르면 그 문단부터 이어 읽는다
  $('#editorHost').addEventListener('dblclick', (e) => {
    if (!P.on || app.cur !== P.chapter) return;
    const at = app.editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (at && jumpTo(at.pos)) { e.preventDefault(); status('이 문단부터 읽어요'); }
  });
  $('#rdSet').onclick = () => showReaderSettings();
  $('#rdRate').onchange = (e) => {
    cfg().rate = +e.target.value || 1; saveSettings();
    if (P.audio) P.audio.playbackRate = cfg().rate;
    if (P.engine === 'browser' && P.on && !P.paused) playAt(P.i); // 기기 목소리는 다시 시작해야 빠르기가 바뀐다
  };
  app.editor.registerPlugin(readPlugin);
  // 읽는 동안 손으로 스크롤하면 따라가기를 잠시 멈춘다
  for (const ev of ['wheel', 'touchmove']) addEventListener(ev, () => { if (P.on) P.userScroll = Date.now(); }, { passive: true, capture: true });
  addEventListener('keydown', (e) => { if (P.on && /^(PageUp|PageDown|Home|End)$/.test(e.key)) P.userScroll = Date.now(); }, true);
  app.editor.on('transaction', ({ transaction }) => mapPositions(transaction));
  // 읽는 장이 아닌 다른 장을 열면 멈춘다 (다음 장 이어 읽기는 제외)
  app.hooks.afterOpen.push(() => { if (P.on && app.cur !== P.chapter) setTimeout(() => { if (P.on && app.cur !== P.chapter) { stop(); toast('다른 장을 열어서 낭독을 멈췄어요.'); } }, 0); });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && P.on && !$('#dlg').open) stop();
  });
}
