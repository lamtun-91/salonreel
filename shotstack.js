// Shotstack Edit API: convert SalonReel edit plans and render via sandbox/stage or v1.
'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const r2 = n => Math.round((+n || 0) * 100) / 100;
const r1 = n => Math.round((+n || 0) * 10) / 10;

const TRANSITION_MAP = {
  cut: null,
  fade: 'fade',
  dissolve: 'fade',
  fadewhite: 'fade',
  slideup: 'slideUp',
  slideleft: 'slideLeft',
  smoothleft: 'slideLeft',
  smoothup: 'slideUp',
  wipeleft: 'wipeLeft',
  zoomin: 'zoom',
  circleopen: 'fade', // no clean Shotstack match; fade approx, recorded in meta
};

function resolveProvider(env = process.env) {
  const raw = String(env.RENDER_PROVIDER || 'auto').toLowerCase();
  const hasKey = !!(env.SHOTSTACK_API_KEY && String(env.SHOTSTACK_API_KEY).trim());
  if (raw === 'ffmpeg') return { provider: 'ffmpeg', reason: 'RENDER_PROVIDER=ffmpeg' };
  if (raw === 'shotstack') {
    if (!hasKey) throw new Error('RENDER_PROVIDER=shotstack but SHOTSTACK_API_KEY is not set');
    return { provider: 'shotstack', reason: 'RENDER_PROVIDER=shotstack' };
  }
  // auto (default): Shotstack when key present, else ffmpeg
  if (hasKey) return { provider: 'shotstack', reason: 'auto: SHOTSTACK_API_KEY present' };
  return { provider: 'ffmpeg', reason: 'auto: no SHOTSTACK_API_KEY' };
}

function apiBase(env = process.env) {
  const stage = String(env.SHOTSTACK_ENV || env.SHOTSTACK_STAGE || 'stage').toLowerCase();
  const version = stage === 'v1' || stage === 'production' || stage === 'prod' ? 'v1' : 'stage';
  return { version, base: `https://api.shotstack.io/edit/${version}` };
}

function segmentTimelineDuration(seg) {
  const srcLen = Math.max(0, (+seg.out_s || 0) - (+seg.in_s || 0));
  const speed = Math.max(0.01, +seg.speed || 1);
  if (seg.ramp_to != null && +seg.ramp_to > 0 && Math.abs(+seg.ramp_to - speed) > 0.001) {
    const ramp = Math.max(0.01, +seg.ramp_to);
    return srcLen / 2 / speed + srcLen / 2 / ramp;
  }
  return srcLen / speed;
}

function buildSpeedAsset(seg, srcLen, timelineLen) {
  const speed = Math.max(0.01, +seg.speed || 1);
  if (seg.ramp_to == null || +seg.ramp_to <= 0 || Math.abs(+seg.ramp_to - speed) <= 0.001) {
    return speed === 1 ? undefined : speed;
  }
  // Half of SOURCE at speed, half at ramp_to — matches studio.outDur / ffmpeg segFilter.
  const ramp = Math.max(0.01, +seg.ramp_to);
  const t1 = r2(srcLen / 2 / speed);
  const t2 = r2(Math.max(0.01, timelineLen - t1));
  return [
    { from: speed, to: speed, start: 0, length: t1 },
    { from: ramp, to: ramp, start: t1, length: t2 },
  ];
}

function zoomEffect(seg) {
  if (!seg.zoom || seg.zoom.type === 'none') return { effect: undefined, note: null };
  if (seg.zoom.type === 'push_in') return { effect: 'zoomInSlow', note: 'push_in→effect:zoomInSlow (clip-length zoom; at_s ignored)' };
  if (seg.zoom.type === 'punch_in') return { effect: 'zoomInFast', note: 'punch_in→effect:zoomInFast (approx; at_s not keyed)' };
  return { effect: undefined, note: null };
}

function mapTransitionIn(seg) {
  const type = seg.transition_in?.type || 'cut';
  if (type === 'cut' || !TRANSITION_MAP[type]) {
    return { mapped: null, approx: type !== 'cut' && !TRANSITION_MAP[type] ? `unmapped transition ${type}` : null };
  }
  return { mapped: TRANSITION_MAP[type], approx: type === 'circleopen' ? 'circleopen→fade' : null };
}

/**
 * Build a pure Shotstack Edit payload from a SalonReel edit plan.
 * @param {object} opts
 * @param {object} opts.edit - cleaned edit plan (segments, overlays, music_start_s, track, total)
 * @param {object} opts.clips - project.clips keyed by shot_id
 * @param {Record<string,string>} opts.clipUrls - shot_id -> public HTTPS URL
 * @param {string|null} opts.musicUrl - public HTTPS URL for the track (null if none)
 * @param {object} [opts.profile]
 * @returns {{ edit: object, meta: object }}
 */
function buildEditPayload({ edit, clips, clipUrls, musicUrl, profile = {} }) {
  const approximations = [];
  const videoClips = [];
  let t = 0;
  const segs = Array.isArray(edit.segments) ? edit.segments : [];
  if (segs.length < 1) throw new Error('edit plan has no segments');

  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    const c = clips[sg.shot_id];
    if (!c) throw new Error(`missing clip for shot ${sg.shot_id}`);
    const src = clipUrls[sg.shot_id];
    if (!src || !/^https:\/\//i.test(src)) throw new Error(`clip URL for ${sg.shot_id} must be a public https URL`);

    const srcStart = (+c.src_start || 0) + (+sg.in_s || 0);
    const srcLen = Math.max(0.05, (+sg.out_s || 0) - (+sg.in_s || 0));
    const length = r2(segmentTimelineDuration(sg));
    const speedVal = buildSpeedAsset(sg, srcLen, length);
    const { effect, note: zoomNote } = zoomEffect(sg);
    if (zoomNote) approximations.push({ shot_id: sg.shot_id, kind: 'zoom', detail: zoomNote });
    if (Array.isArray(speedVal)) approximations.push({ shot_id: sg.shot_id, kind: 'speed_ramp', detail: 'ramp via Shotstack speed tween (half-source at each rate)' });

    const asset = {
      type: 'video',
      src,
      trim: r2(srcStart),
      volume: 0,
    };
    if (speedVal !== undefined) asset.speed = speedVal;

    const clip = {
      asset,
      start: r2(t),
      length,
      fit: 'crop',
    };

    const tr = mapTransitionIn(sg);
    if (tr.approx) approximations.push({ shot_id: sg.shot_id, kind: 'transition', detail: tr.approx });
    if (i === 0) {
      clip.transition = { in: 'fade' };
    } else if (tr.mapped) {
      clip.transition = { in: tr.mapped };
    }
    if (i === segs.length - 1) {
      clip.transition = { ...(clip.transition || {}), out: 'fade' };
    }
    if (effect) clip.effect = effect;

    videoClips.push(clip);
    t += length;
  }

  const total = r2(t);
  approximations.push({
    kind: 'timeline',
    detail: 'non-overlapping sequential clips; Shotstack transition.in/out fades through background (not ffmpeg xfade crossfade)',
  });

  const textClips = [];
  const salon = String(profile.salon || '').trim();
  if (salon) {
    textClips.push({
      asset: {
        type: 'rich-text',
        text: salon.slice(0, 60),
        font: { family: 'Roboto', size: 42, weight: '700', color: '#ffffff' },
        align: { horizontal: 'left', vertical: 'top' },
      },
      start: 0,
      length: total,
      width: 900,
      height: 100,
      position: 'top',
      offset: { x: -0.05, y: -0.38 },
    });
  }

  const overlays = Array.isArray(edit.overlays) ? edit.overlays : [];
  for (const line of overlays) {
    const start = r2(Math.max(0, +line.start_s || 0));
    const end = r2(Math.min(total, +line.end_s || start + 1));
    const len = r2(Math.max(0.5, end - start));
    if (start >= total) continue;
    textClips.push({
      asset: {
        type: 'rich-text',
        text: String(line.text || '').slice(0, 80),
        font: { family: 'Roboto', size: 64, weight: '700', color: '#ffffff' },
        align: { horizontal: 'center', vertical: 'middle' },
      },
      start,
      length: Math.min(len, r2(total - start)),
      width: 920,
      height: 280,
      position: 'center',
      offset: { x: 0, y: 0.12 },
      transition: { in: 'fade', out: 'fade' },
    });
  }

  const tracks = [];
  if (textClips.length) tracks.push({ clips: textClips });
  tracks.push({ clips: videoClips });

  if (musicUrl) {
    if (!/^https:\/\//i.test(musicUrl)) throw new Error('music URL must be a public https URL');
    tracks.push({
      clips: [{
        asset: {
          type: 'audio',
          src: musicUrl,
          trim: r1(Math.max(0, +edit.music_start_s || 0)),
          volume: 0.85,
          effect: 'fadeInFadeOut',
        },
        start: 0,
        length: total,
      }],
    });
  }

  const payload = {
    timeline: {
      background: '#000000',
      tracks,
    },
    output: {
      format: 'mp4',
      size: { width: 1080, height: 1920 },
      fps: 30,
    },
  };

  return {
    edit: payload,
    meta: {
      provider: 'shotstack',
      total,
      segmentCount: videoClips.length,
      approximations,
      // beat_markers / shot ids / QC stay out of the Shotstack payload
      omitted: ['beat_markers', 'shot_id', 'qc'],
    },
  };
}

function createClient({ env = process.env, fetchImpl } = {}) {
  const key = String(env.SHOTSTACK_API_KEY || '').trim();
  if (!key) throw new Error('SHOTSTACK_API_KEY is required');
  const { version, base } = apiBase(env);
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) throw new Error('fetch is not available');
  const timeoutMs = Math.max(10_000, +(env.SHOTSTACK_TIMEOUT_MS || 300_000) || 300_000);
  const pollMs = Math.max(500, +(env.SHOTSTACK_POLL_MS || 2500) || 2500);

  async function request(method, urlPath, body) {
    const res = await fetchFn(`${base}${urlPath}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = json?.message || json?.response || text || res.statusText;
      const err = new Error(`Shotstack ${method} ${urlPath} failed (${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  async function submit(editPayload) {
    const json = await request('POST', '/render', editPayload);
    const id = json?.response?.id;
    if (!id) throw new Error('Shotstack submit returned no render id');
    return { id, raw: json };
  }

  async function status(renderId) {
    const json = await request('GET', `/render/${encodeURIComponent(renderId)}`);
    const r = json.response || {};
    return {
      id: r.id || renderId,
      status: r.status,
      url: r.url || null,
      error: r.error || r.message || null,
      raw: json,
    };
  }

  /**
   * Poll until done/failed. Does not re-submit.
   * @param {string} renderId
   * @param {{ onTick?: Function, signal?: { aborted?: boolean } }} [opts]
   */
  async function waitForRender(renderId, opts = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
      if (opts.signal?.aborted) throw new Error('Shotstack poll aborted');
      last = await status(renderId);
      if (opts.onTick) opts.onTick(last);
      if (last.status === 'done') {
        if (!last.url) throw new Error('Shotstack render done but no url');
        return last;
      }
      if (last.status === 'failed') {
        throw new Error(`Shotstack render failed: ${last.error || 'unknown error'}`);
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error(`Shotstack render timed out after ${timeoutMs}ms (last status: ${last?.status || 'n/a'})`);
  }

  async function downloadToFile(url, dest) {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Failed to download Shotstack output (${res.status})`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = res.body;
    if (body && typeof body.pipe === 'function') {
      await pipeline(body, fs.createWriteStream(dest));
    } else if (body && typeof Readable.fromWeb === 'function') {
      await pipeline(Readable.fromWeb(body), fs.createWriteStream(dest));
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buf);
    }
    return dest;
  }

  return { version, base, submit, status, waitForRender, downloadToFile, timeoutMs, pollMs };
}

function strictMode(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.SHOTSTACK_STRICT || ''));
}

module.exports = {
  TRANSITION_MAP,
  resolveProvider,
  apiBase,
  segmentTimelineDuration,
  buildEditPayload,
  createClient,
  strictMode,
};
