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

const BASE = 'https://api.heygen.com';
const DEFAULT_TIMEOUT_MS = 30000;

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

// Build the POST /v3/videos body for a stock avatar speaking a script. No `test` field: v3 rejects unknown fields.
function avatarVideoBody({ avatar_id, voice_id, script, engine, title, aspect_ratio = '9:16', resolution = '720p' }) {
  if (!avatar_id) throw new HeyGenError('avatar_id is required', { code: 'bad_request' });
  if (!voice_id) throw new HeyGenError('voice_id is required', { code: 'bad_request' });
  const s = String(script || '').trim(); if (!s) throw new HeyGenError('script is required', { code: 'bad_request' });
  if (s.length > 5000) throw new HeyGenError('script is over HeyGen\'s 5,000 character limit', { code: 'bad_request' });
  const b = { type: 'avatar', avatar_id, voice_id, script: s, aspect_ratio, resolution, ...(title ? { title: String(title).slice(0, 100) } : {}) };
  if (engine) b.engine = { type: engine };
  return b;
}
async function createAvatarVideo(args, o = {}) {
  if (!spendAllowed(o, o.env)) throw new SpendBlockedError();
  const body = avatarVideoBody(args);
  const j = await request('POST', '/v3/videos', { ...o, body, idempotencyKey: o.idempotencyKey });
  const d = j?.data || {}; if (!d.video_id) throw new HeyGenError('HeyGen did not return a video_id', { code: 'bad_response' });
  return { video_id: d.video_id, status: d.status || 'pending' };
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

module.exports = { BASE, HeyGenError, SpendBlockedError, key, spendAllowed, request, me, listPublicLooks, listVoices, avatarVideoBody, createAvatarVideo, getVideo, waitForVideo, download };
