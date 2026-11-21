'use strict';
// HeyGen v3 API client (M2). The only file in the Twin path that talks to HeyGen.
// Docs: https://developers.heygen.com/llms.txt, OpenAPI https://developers.heygen.com/openapi/external-api.json (checked 2026-11-20).
//
// TEST MODE: the v3 API has NO test/sandbox flag. CreateVideoFromAvatar (POST /v3/videos, type "avatar") is
// additionalProperties:false and lists no `test` field; v1/v2 (where `test: true` lived) were sunset 2026-10-31.
// Every v3 render is billed (wallet balance or free credits) and POST /v3/videos returns 402 insufficient_credit
// when the workspace cannot cover it. So createAvatarVideo() refuses to run unless spend is explicitly allowed
// (opts.allowSpend === true or HEYGEN_ALLOW_SPEND=1). Read-only calls (users/me, looks, voices, video status) are free.
//
// The API key is read from process.env.HEYGEN_API_KEY at call time and only ever sent as the X-Api-Key header.
// It is never logged, returned or written anywhere; errors carry HeyGen's code/message only.
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const SP = require('./speech');

const BASE = 'https://api.heygen.com';
const DEFAULT_TIMEOUT_MS = 30000;

// ---------- engine + cost guard ----------
// HeyGen API self-serve prices, USD per minute, billed by actual seconds generated
// (https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained, read 2026-11-20).
const RATES_PER_MIN = {
  avatar_iii: { digital_twin: 0.60, studio_avatar: 0.99, photo_avatar: 0.99 },
  avatar_iv: { photo_avatar: 2.31, digital_twin: 4.83, studio_avatar: 4.83 },
  avatar_v: { digital_twin: 7.20 },
};
const DEFAULT_ENGINE = 'avatar_iii'; // cheapest; avatar_iv / avatar_v only via explicit HEYGEN_ENGINE
const GUARD = Object.freeze({ maxUsd: 0.50, maxSeconds: 30 });
// Conservative spoken length from the shared calibration (speech.js): ~3 w/s, +15% and +0.5s so the estimate errs high.
const estimateSeconds = script => SP.guardSeconds(script);
function engineFor(o = {}, env = process.env) {
  const e = String(o.engine || env.HEYGEN_ENGINE || DEFAULT_ENGINE).trim();
  if (!RATES_PER_MIN[e]) throw new HeyGenError(`Unsupported HeyGen engine "${e}" (allowed: ${Object.keys(RATES_PER_MIN).join(', ')})`, { code: 'bad_engine' });
  // production pin: only Avatar III unless an explicit override is set (never set in Render without owner approval)
  if (env.NODE_ENV === 'production' && e !== DEFAULT_ENGINE && env.ALLOW_ENGINE_OVERRIDE !== '1') throw new HeyGenError(`HeyGen engine is pinned to ${DEFAULT_ENGINE} in production`, { code: 'bad_engine' });
  return e;
}
// Rate for engine + look type; an unknown look type is priced at the engine's most expensive row (errs high).
function ratePerMin(engine, avatarType) { const r = RATES_PER_MIN[engine]; return r[avatarType] ?? Math.max(...Object.values(r)); }
function estimateCost({ script, engine, avatar_type = 'studio_avatar' }) {
  const seconds = estimateSeconds(script), rate = ratePerMin(engine, avatar_type);
  return { engine, avatar_type, seconds, rate_per_min: rate, usd: Math.round(seconds / 60 * rate * 10000) / 10000 };
}
class CostGuardError extends Error { constructor(msg, est) { super(msg); this.name = 'CostGuardError'; this.status = 400; this.code = 'cost_guard'; this.estimate = est; } }
function checkCost(est) {
  if (est.seconds > GUARD.maxSeconds) throw new CostGuardError(`Script is about ${est.seconds}s; HeyGen renders are capped at ${GUARD.maxSeconds}s. Shorten the script.`, est);
  if (est.usd > GUARD.maxUsd) throw new CostGuardError(`Estimated HeyGen cost $${est.usd.toFixed(2)} is over the $${GUARD.maxUsd.toFixed(2)} per-render cap (${est.engine}, ${est.seconds}s).`, est);
  return est;
}

class HeyGenError extends Error {
  constructor(message, { status = 0, code = 'heygen_error', param = null } = {}) { super(message); this.name = 'HeyGenError'; this.status = status; this.code = code; this.param = param; }
}
class SpendBlockedError extends HeyGenError {
  constructor() {
    super('HeyGen renders are billed (the v3 API has no free test mode). Set HEYGEN_ALLOW_SPEND=1 only after the owner approves spend.', { status: 402, code: 'spend_not_allowed' });
    this.name = 'SpendBlockedError';
  }
}
const FRIENDLY = {
  401: 'HeyGen rejected the API key (401). Check HEYGEN_API_KEY.',
  402: 'HeyGen needs credit for this render (402 insufficient_credit). Nothing was charged.',
  429: 'HeyGen rate limit hit (429). Try again shortly.',
};

const key = (env = process.env) => String(env.HEYGEN_API_KEY || '').trim();
const spendAllowed = (opts = {}, env = process.env) => opts.allowSpend === true || env.HEYGEN_ALLOW_SPEND === '1';

async function request(method, path, { body, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, env = process.env, idempotencyKey } = {}) {
  const k = key(env); if (!k) throw new HeyGenError('HEYGEN_API_KEY is not set', { code: 'no_key' });
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  const headers = { 'X-Api-Key': k, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let r;
  try { r = await fetchImpl(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal }); }
  catch (e) { throw new HeyGenError(e.name === 'AbortError' ? `HeyGen ${method} ${path} timed out after ${timeoutMs}ms` : `HeyGen ${method} ${path} failed: ${e.message}`, { code: e.name === 'AbortError' ? 'timeout' : 'network' }); }
  finally { clearTimeout(t); }
  const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const e = (j && j.error) || {};
    const msg = FRIENDLY[r.status] ? `${FRIENDLY[r.status]}${e.message ? ' HeyGen: ' + e.message : ''}` : `HeyGen ${method} ${path} -> ${r.status}: ${e.message || text.slice(0, 200)}`;
    throw new HeyGenError(msg, { status: r.status, code: e.code || (r.status === 402 ? 'insufficient_credit' : 'http_' + r.status), param: e.param || null });
  }
  return j;
}

// Account / billing snapshot. GET /v3/users/me returns billing_type plus ONE of wallet / subscription / usage_based.
async function me(o = {}) {
  const d = (await request('GET', '/v3/users/me', o))?.data || {};
  return { billing_type: d.billing_type || null, wallet: d.wallet || null, subscription: d.subscription || null, usage_based: d.usage_based || null };
}
async function listPublicLooks({ limit = 50, avatar_type = 'studio_avatar', ...o } = {}) {
  const j = await request('GET', `/v3/avatars/looks?ownership=public&avatar_type=${encodeURIComponent(avatar_type)}&limit=${limit}`, o);
  return (j?.data || []).map(a => ({ id: a.id, name: a.name, gender: a.gender, group_id: a.group_id, default_voice_id: a.default_voice_id, engines: a.supported_api_engines || [], orientation: a.preferred_orientation, preview_image_url: a.preview_image_url }));
}
async function listVoices({ language = 'en', gender, limit = 20, ...o } = {}) {
  const q = new URLSearchParams({ type: 'public', language, limit: String(limit), ...(gender ? { gender } : {}) });
  return ((await request('GET', `/v3/models/audio/voices?${q}`, o))?.data || []).map(v => ({ voice_id: v.voice_id, name: v.name, language: v.language, gender: v.gender }));
}

// Optional salon interior behind the stock avatar. Off unless TWIN_SALON_BACKGROUND=1.
// HeyGen CreateVideoFromAvatar uses BackgroundSetting: { type: "image", url } or { type: "image", asset_id }
// (not the studio-scene { type, source } shape). remove_background needs a matting-trained look or native alpha.
const SALON_BG_PUBLIC_PATH = '/twin/salon_interior.jpg';
const DEFAULT_PUSH_IN = 0.04; // 4% slow ffmpeg push-in over the clip (allowed range 3–5%, cap 8%)
function salonBackgroundEnabled(env = process.env) { return env.TWIN_SALON_BACKGROUND === '1'; }
function salonBackground(env = process.env) {
  if (!salonBackgroundEnabled(env)) return null;
  const asset_id = String(env.TWIN_SALON_BACKGROUND_ASSET_ID || '').trim();
  if (asset_id) return { type: 'image', asset_id };
  const explicit = String(env.TWIN_SALON_BACKGROUND_URL || '').trim();
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const url = explicit || (base ? base + SALON_BG_PUBLIC_PATH : '');
  if (!/^https:\/\//i.test(url)) throw new HeyGenError('TWIN_SALON_BACKGROUND=1 needs a public HTTPS image URL (TWIN_SALON_BACKGROUND_URL or PUBLIC_BASE_URL).', { code: 'bad_request' });
  return { type: 'image', url };
}
function pushInAmount(env = process.env) {
  if (!salonBackgroundEnabled(env) || env.TWIN_SALON_PUSH_IN === '0') return 0;
  const n = env.TWIN_SALON_PUSH_IN == null || env.TWIN_SALON_PUSH_IN === '' ? DEFAULT_PUSH_IN : Number(env.TWIN_SALON_PUSH_IN);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PUSH_IN;
  return Math.min(0.08, n);
}

// Build the POST /v3/videos body for a stock avatar speaking a script. No `test` field: v3 rejects unknown fields.
function avatarVideoBody({ avatar_id, voice_id, script, engine = DEFAULT_ENGINE, title, aspect_ratio = '9:16', resolution = '1080p', background, remove_background }) {
  if (!avatar_id) throw new HeyGenError('avatar_id is required', { code: 'bad_request' });
  if (!voice_id) throw new HeyGenError('voice_id is required', { code: 'bad_request' });
  const s = String(script || '').trim(); if (!s) throw new HeyGenError('script is required', { code: 'bad_request' });
  if (s.length > 5000) throw new HeyGenError('script is over HeyGen\'s 5,000 character limit', { code: 'bad_request' });
  const b = { type: 'avatar', avatar_id, voice_id, script: s, aspect_ratio, resolution, ...(title ? { title: String(title).slice(0, 100) } : {}) };
  if (!RATES_PER_MIN[engine]) throw new HeyGenError(`Unsupported HeyGen engine "${engine}"`, { code: 'bad_engine' });
  b.engine = { type: engine };
  if (background) b.background = background;
  if (remove_background) b.remove_background = true;
  return b;
}
async function createAvatarVideo(args, o = {}) {
  if (!spendAllowed(o, o.env)) throw new SpendBlockedError();
  const env = o.env || process.env;
  const engine = engineFor({ engine: args.engine }, env);
  const extra = {};
  const bg = args.background !== undefined ? args.background : salonBackground(env);
  if (bg) { extra.background = bg; extra.remove_background = args.remove_background !== false; }
  else if (args.remove_background) extra.remove_background = true;
  const body = avatarVideoBody({ ...args, ...extra, engine });
  const est = estimateCost({ script: body.script, engine, avatar_type: args.avatar_type });
  const log = o.log || (m => console.log(m));
  try { checkCost(est); } catch (e) { log(`[heygen] REFUSED engine=${engine} est_s=${est.seconds} est_usd=${est.usd.toFixed(4)}: ${e.message}`); throw e; }
  log(`[heygen] create avatar=${body.avatar_id} engine=${engine} est_s=${est.seconds} est_usd=${est.usd.toFixed(4)} rate_per_min=${est.rate_per_min}${body.remove_background ? ' salon_bg=1' : ''}`);
  const j = await request('POST', '/v3/videos', { ...o, body, idempotencyKey: o.idempotencyKey });
  const d = j?.data || {}; if (!d.video_id) throw new HeyGenError('HeyGen did not return a video_id', { code: 'bad_response' });
  return { video_id: d.video_id, status: d.status || 'pending', engine, estimate: est };
}
async function getVideo(video_id, o = {}) {
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(String(video_id))) throw new HeyGenError('bad video_id', { code: 'bad_request' });
  const d = (await request('GET', `/v3/videos/${video_id}`, o))?.data || {};
  return { id: d.id || video_id, status: d.status, video_url: d.video_url || null, duration: d.duration ?? null, failure_code: d.failure_code || null, failure_message: d.failure_message || null, thumbnail_url: d.thumbnail_url || null };
}
// Poll until completed / failed, or give up after timeoutMs (renders typically take a few minutes).
async function waitForVideo(video_id, { timeoutMs = 15 * 60e3, intervalMs = 10e3, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, onPoll, ...o } = {}) {
  const t0 = now();
  for (;;) {
    const v = await getVideo(video_id, o); if (onPoll) onPoll(v);
    if (v.status === 'completed') { if (!v.video_url) throw new HeyGenError('HeyGen completed without a video_url', { code: 'bad_response' }); return v; }
    if (v.status === 'failed') throw new HeyGenError(`HeyGen render failed: ${v.failure_message || v.failure_code || 'unknown reason'}`, { code: v.failure_code || 'render_failed' });
    if (now() - t0 > timeoutMs) throw new HeyGenError(`HeyGen render ${video_id} still ${v.status} after ${Math.round(timeoutMs / 1000)}s`, { code: 'timeout' });
    await sleep(intervalMs);
  }
}
// Download the presigned result (no API key sent: it is a public presigned URL).
async function download(url, dest, { timeoutMs = 5 * 60e3, fetchImpl = globalThis.fetch } = {}) {
  if (!/^https:\/\//.test(String(url))) throw new HeyGenError('bad download url', { code: 'bad_request' });
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ac.signal });
    if (!r.ok || !r.body) throw new HeyGenError(`HeyGen download failed: ${r.status}`, { status: r.status, code: 'download_failed' });
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  } catch (e) { if (e instanceof HeyGenError) throw e; throw new HeyGenError(e.name === 'AbortError' ? 'HeyGen download timed out' : `HeyGen download failed: ${e.message}`, { code: 'download_failed' }); }
  finally { clearTimeout(t); }
  return dest;
}

module.exports = { BASE, RATES_PER_MIN, DEFAULT_ENGINE, GUARD, estimateSeconds, engineFor, ratePerMin, estimateCost, checkCost, CostGuardError, HeyGenError, SpendBlockedError, key, spendAllowed, request, me, listPublicLooks, listVoices, SALON_BG_PUBLIC_PATH, DEFAULT_PUSH_IN, salonBackgroundEnabled, salonBackground, pushInAmount, avatarVideoBody, createAvatarVideo, getVideo, waitForVideo, download };
