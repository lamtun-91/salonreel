'use strict';
// Runway API client (M3): image_to_video create -> poll GET /v1/tasks/{id} -> download output. The only Twin file that talks to Runway.
// Docs (read 2026-11-20): https://docs.dev.runwayml.com/llms.txt, /api.md (request shapes), /guides/pricing.md (credits),
// /errors/errors (HTTP codes). Every request carries X-Runway-Version. Credits cost $0.01 each.
// The key is read from process.env.RUNWAYML_API_SECRET at call time and only sent as the Authorization header; never logged.
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const BASE = 'https://api.dev.runwayml.com';
const API_VERSION = '2024-11-06';
const DEFAULT_TIMEOUT_MS = 30000;
const USD_PER_CREDIT = 0.01;
// credits per output second, from https://docs.dev.runwayml.com/guides/pricing.md
const CREDITS_PER_SEC = { gen4_turbo: 5, 'gen4.5': 12 };
// allowed request values per model (from /api.md, POST /v1/image_to_video)
const MODELS = {
  gen4_turbo: { ratios: ['1280:720', '720:1280', '1104:832', '832:1104', '960:960', '1584:672'], minS: 2, maxS: 10, promptMax: 1000 },
  'gen4.5': { ratios: ['1280:720', '720:1280', '1104:832', '832:1104', '960:960', '1584:672'], minS: 2, maxS: 10, promptMax: 1000 },
};
const DEFAULT_MODEL = 'gen4_turbo'; // cheapest Runway model ($0.05/s); gen4.5 only via RUNWAY_MODEL
const GUARD = Object.freeze({ maxSeconds: 10, maxUsd: 1.00 });
const DEFAULT_SESSION_CAP_USD = 5.00;

class RunwayError extends Error {
  constructor(message, { status = 0, code = 'runway_error' } = {}) { super(message); this.name = 'RunwayError'; this.status = status; this.code = code; }
}
class SpendBlockedError extends RunwayError {
  constructor() { super('Runway generations are billed. Set RUNWAY_LIVE=1 and RUNWAY_ALLOW_SPEND=1 only after the owner approves spend.', { status: 402, code: 'spend_not_allowed' }); this.name = 'SpendBlockedError'; }
}
class CostGuardError extends RunwayError {
  constructor(msg, est) { super(msg, { status: 400, code: 'cost_guard' }); this.name = 'CostGuardError'; this.estimate = est; }
}
const FRIENDLY = {
  400: 'Runway rejected the request (400).',
  401: 'Runway rejected the API key (401). Check RUNWAYML_API_SECRET.',
  402: 'Runway needs credits for this generation (402). Add credits in the developer portal; nothing was generated.',
  429: 'Runway rate limit or tier limit hit (429). Try again later.',
};

const key = (env = process.env) => String(env.RUNWAYML_API_SECRET || '').trim();
const liveEnabled = (env = process.env) => !!key(env) && env.RUNWAY_LIVE === '1';
const spendAllowed = (o = {}, env = process.env) => o.allowSpend === true || env.RUNWAY_ALLOW_SPEND === '1';
function modelFor(o = {}, env = process.env) {
  const m = String(o.model || env.RUNWAY_MODEL || DEFAULT_MODEL).trim();
  if (!MODELS[m]) throw new RunwayError(`Unsupported Runway model "${m}" (allowed: ${Object.keys(MODELS).join(', ')})`, { code: 'bad_model' });
  if (env.NODE_ENV === 'production' && m !== DEFAULT_MODEL && env.ALLOW_ENGINE_OVERRIDE !== '1') throw new RunwayError(`Runway model is pinned to ${DEFAULT_MODEL} in production`, { code: 'bad_model' });
  return m;
}
function estimateCost({ model, duration }) {
  const credits = CREDITS_PER_SEC[model] * duration;
  return { model, duration, credits, usd: Math.round(credits * USD_PER_CREDIT * 100) / 100 };
}
function checkCost(est) {
  if (!(est.duration > 0) || est.duration > GUARD.maxSeconds) throw new CostGuardError(`Runway clip is ${est.duration}s; the cap is ${GUARD.maxSeconds}s per clip.`, est);
  if (est.usd > GUARD.maxUsd) throw new CostGuardError(`Estimated Runway cost $${est.usd.toFixed(2)} is over the $${GUARD.maxUsd.toFixed(2)} per-clip cap (${est.model}, ${est.duration}s).`, est);
  return est;
}
// Session spend tracker: refuses a generation once the cumulative estimate would pass the cap.
function spendTracker(capUsd = +(process.env.RUNWAY_SESSION_CAP_USD || DEFAULT_SESSION_CAP_USD)) {
  let spent = 0; const items = [];
  return {
    cap: capUsd, get spent() { return Math.round(spent * 100) / 100; }, items,
    reserve(est) { if (spent + est.usd > capUsd + 1e-9) throw new CostGuardError(`Session cap $${capUsd.toFixed(2)} would be exceeded ($${spent.toFixed(2)} so far + $${est.usd.toFixed(2)}).`, est); spent += est.usd; items.push(est); return est; },
    release(est) { const i = items.indexOf(est); if (i >= 0) { items.splice(i, 1); spent -= est.usd; } },
  };
}
const defaultTracker = spendTracker();

async function request(method, path, { body, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const k = key(env); if (!k) throw new RunwayError('RUNWAYML_API_SECRET is not set', { code: 'no_key' });
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  const headers = { Authorization: `Bearer ${k}`, 'X-Runway-Version': env.RUNWAY_API_VERSION || API_VERSION, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let r;
  try { r = await fetchImpl(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal }); }
  catch (e) { throw new RunwayError(e.name === 'AbortError' ? `Runway ${method} ${path} timed out after ${timeoutMs}ms` : `Runway ${method} ${path} failed: ${e.message}`, { code: e.name === 'AbortError' ? 'timeout' : 'network' }); }
  finally { clearTimeout(t); }
  const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const detail = j && (typeof j.error === 'string' ? j.error : j.error?.message || j.message) || text.slice(0, 200);
    const msg = FRIENDLY[r.status] ? `${FRIENDLY[r.status]}${detail ? ' Runway: ' + detail : ''}` : `Runway ${method} ${path} -> ${r.status}: ${detail}`;
    throw new RunwayError(String(msg).split(key(env)).join('[redacted]'), { status: r.status, code: r.status === 402 ? 'insufficient_credits' : 'http_' + r.status });
  }
  return j;
}

// Free read: org tier + credit balance (GET /v1/organization).
async function organization(o = {}) {
  const j = await request('GET', '/v1/organization', o) || {};
  return { creditBalance: j.creditBalance ?? null, usd: j.creditBalance == null ? null : Math.round(j.creditBalance * USD_PER_CREDIT * 100) / 100, tier: j.tier || null };
}

function imageToVideoBody({ model = DEFAULT_MODEL, promptImage, promptText, duration = 5, ratio = '720:1280', seed }) {
  const M = MODELS[model]; if (!M) throw new RunwayError(`Unsupported Runway model "${model}"`, { code: 'bad_model' });
  if (!promptImage || !/^(https:\/\/|data:image\/(png|jpeg|webp);base64,|runway:\/\/)/.test(String(promptImage))) throw new RunwayError('promptImage must be an https URL, runway:// URI or image data URI', { code: 'bad_request' });
  if (/^data:/.test(promptImage) && promptImage.length > 5 * 1024 * 1024 * 1.37) throw new RunwayError('promptImage data URI is over Runway\'s 5MB limit', { code: 'bad_request' });
  const p = String(promptText || '').trim(); if (p.length > M.promptMax) throw new RunwayError(`promptText is over ${M.promptMax} characters`, { code: 'bad_request' });
  if (model === 'gen4.5' && !p) throw new RunwayError('gen4.5 requires promptText', { code: 'bad_request' });
  if (!Number.isInteger(duration) || duration < M.minS || duration > M.maxS) throw new RunwayError(`duration must be an integer ${M.minS}-${M.maxS}s`, { code: 'bad_request' });
  if (!M.ratios.includes(ratio)) throw new RunwayError(`ratio must be one of ${M.ratios.join(', ')}`, { code: 'bad_request' });
  return { model, promptImage, ...(p ? { promptText: p } : {}), duration, ratio, ...(seed != null ? { seed } : {}) };
}
async function imageToVideo(args, o = {}) {
  const env = o.env || process.env;
  if (!spendAllowed(o, env)) throw new SpendBlockedError();
  const model = modelFor({ model: args.model }, env);
  const body = imageToVideoBody({ ...args, model });
  const est = estimateCost({ model, duration: body.duration });
  const log = o.log || (m => console.log(m)), tracker = o.tracker || defaultTracker;
  try { checkCost(est); tracker.reserve(est); }
  catch (e) { log(`[runway] REFUSED model=${model} duration=${body.duration}s est_usd=${est.usd.toFixed(2)}: ${e.message}`); throw e; }
  log(`[runway] create image_to_video model=${model} duration=${body.duration}s ratio=${body.ratio} est_credits=${est.credits} est_usd=${est.usd.toFixed(2)} session_usd=${tracker.spent.toFixed(2)}/${tracker.cap.toFixed(2)}`);
  let j; try { j = await request('POST', '/v1/image_to_video', { ...o, body, timeoutMs: o.timeoutMs || 60000 }); }
  catch (e) { if (e.status && e.status < 500 && e.status !== 0) tracker.release(est); throw e; } // a definite rejection didn't spend
  if (!j?.id) throw new RunwayError('Runway did not return a task id', { code: 'bad_response' });
  return { task_id: j.id, model, estimate: est };
}
async function task(id, o = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new RunwayError('bad task id', { code: 'bad_request' });
  const j = await request('GET', `/v1/tasks/${id}`, o) || {};
  return { id: j.id || id, status: j.status, output: j.output || [], progress: j.progress ?? null, failure: j.failure || null, failureCode: j.failureCode || null, cost: j.cost?.credits ?? null, estimatedCost: j.estimatedCost?.credits ?? null };
}
// Poll (Runway asks for no more than one poll per ~5s per task).
async function waitForTask(id, { timeoutMs = 10 * 60e3, intervalMs = 6000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, onPoll, ...o } = {}) {
  const t0 = now();
  for (;;) {
    const t = await task(id, o); if (onPoll) onPoll(t);
    if (t.status === 'SUCCEEDED') { if (!t.output.length) throw new RunwayError('Runway task succeeded without output', { code: 'bad_response' }); return t; }
    if (t.status === 'FAILED' || t.status === 'CANCELLED') throw new RunwayError(`Runway task ${t.status.toLowerCase()}: ${t.failure || t.failureCode || 'no reason given'}`, { code: t.failureCode || 'task_failed' });
    if (now() - t0 > timeoutMs) throw new RunwayError(`Runway task ${id} still ${t.status} after ${Math.round(timeoutMs / 1000)}s`, { code: 'timeout' });
    await sleep(intervalMs);
  }
}
async function download(url, dest, { timeoutMs = 5 * 60e3, fetchImpl = globalThis.fetch } = {}) {
  if (!/^https:\/\//.test(String(url))) throw new RunwayError('bad download url', { code: 'bad_request' });
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await fetchImpl(url, { signal: ac.signal }); if (!r.ok || !r.body) throw new RunwayError(`Runway download failed: ${r.status}`, { status: r.status, code: 'download_failed' });
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest)); }
  catch (e) { if (e instanceof RunwayError) throw e; throw new RunwayError(e.name === 'AbortError' ? 'Runway download timed out' : `Runway download failed: ${e.message}`, { code: 'download_failed' }); }
  finally { clearTimeout(t); }
  return dest;
}
const dataUri = (file) => { const ext = String(file).toLowerCase().endsWith('.png') ? 'png' : 'jpeg'; return `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`; };

module.exports = { BASE, API_VERSION, USD_PER_CREDIT, CREDITS_PER_SEC, MODELS, DEFAULT_MODEL, GUARD, DEFAULT_SESSION_CAP_USD, RunwayError, SpendBlockedError, CostGuardError,
  key, liveEnabled, spendAllowed, modelFor, estimateCost, checkCost, spendTracker, defaultTracker, request, organization, imageToVideoBody, imageToVideo, task, waitForTask, download, dataUri };
