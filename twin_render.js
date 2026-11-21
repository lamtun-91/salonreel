'use strict';
// M2: real Twin render from a HeyGen Sample (stock) avatar. Dependencies are injected so tests run with the network mocked.
// Flow: create HeyGen avatar video (9:16) -> poll -> download raw -> retime captions to the real spoken length ->
// assemble in avatar.js (crop 1080x1920, captions, brand pill, AI-generated label, music bed) -> master.
// The product photo is never composited here (stored for M3 B-roll).
// A stored raw clip is reused on re-render / export variants so captions or music edits never pay for a second HeyGen render.
const fs = require('fs'), path = require('path');
const A = require('./avatar');
const C = require('./heygen_client');

// Scale caption timings from the planned length to the real HeyGen clip length.
function retimeCaptions(captions = [], planned, actual) {
  const k = planned > 0 ? actual / planned : 1;
  return captions.map(c => ({ ...c, start_s: Math.round(c.start_s * k * 100) / 100, end_s: Math.round(Math.min(actual, c.end_s * k) * 100) / 100 })).filter(c => c.end_s > c.start_s);
}
function heygenIds(p, hg, env = process.env) {
  const avatar_id = p.avatar?.heygen_avatar_id || (p.avatar?.sample ? hg.stockAvatarIds()[0] : null);
  const voice_id = p.avatar?.voice_id || env.HEYGEN_STOCK_VOICE_ID || null;
  if (!avatar_id) throw Object.assign(new Error('This avatar has no HeyGen look yet. Pick a Sample avatar or finish training.'), { status: 400 });
  if (!voice_id) throw Object.assign(new Error('No HeyGen voice set for this avatar (HEYGEN_STOCK_VOICE_ID).'), { status: 400 });
  return { avatar_id, voice_id };
}

// M3: one Runway image_to_video B-roll clip (create -> poll -> download). Reuses a clip already on disk so re-renders never pay twice.
async function runwayClip({ rw, still, prompt, duration = 5, dest, rwOpts = {}, log = () => {} }) {
  if (fs.existsSync(dest)) return { file: dest, reused: true };
  const promptImage = /^(https:|data:|runway:)/.test(String(still)) ? still : require('./runway_client').dataUri(still);
  const c = await rw.imageToVideo({ promptImage, promptText: prompt, duration, ratio: '720:1280' }, rwOpts);
  log({ runway_task: c.task_id, model: c.model, est_usd: c.estimate?.usd });
  const t = await rw.waitForTask(c.task_id, { ...rwOpts, onPoll: x => log({ runway_poll: x.status }) });
  await rw.download(t.output[0], dest, rwOpts);
  return { file: dest, task_id: c.task_id, model: c.model, estimate: c.estimate, cost_credits: t.cost ?? null, reused: false };
}
// M3 Promo (production): avatar -> ONE clean-surface B-roll clip (people-free countertop push-in) -> product photo end card.
// The product is shown on the end card only; compositing it onto the moving clip is opt-in (compositeProduct) because it is
// not tracked automatically. Clips of the presenter holding a product are never generated (the model would invent the product).
// promo = { productFile, styleAStill, clipSeconds?, endCardDur?, compositeProduct?, surfaceA? }
async function buildPromoBroll(promo, { rw, dir, rwOpts = {}, log = () => {} }) {
  const dur = promo.clipSeconds || 5;
  const a = await runwayClip({ rw, still: promo.styleAStill, prompt: A.BROLL_PROMPTS.a, duration: dur, dest: path.join(dir, 'broll_a.mp4'), rwOpts, log });
  return [{ ...a, style: 'a', dur, composite: promo.compositeProduct === true, surface: promo.surfaceA || null }];
}

async function renderHeygen(p, { hg, run, probeDuration, master, dir, musicOn = p.musicOn, env = process.env, hgOpts = {}, log = () => {}, rw = null, promo = null, rwOpts = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, 'heygen_raw.mp4');
  let hgInfo = p.heygen && p.heygen.video_id && fs.existsSync(raw) ? p.heygen : null;
  if (!hgInfo) {
    const ids = heygenIds(p, hg, env);
    const c = await hg.createVideo({ ...ids, script: p.script.text, engine: hg.engine(), aspect_ratio: '9:16', title: `SalonReel twin ${p.id}` }, { ...hgOpts, env: hgOpts.env || env });
    log({ created: c.video_id });
    const v = await hg.waitForVideo(c.video_id, { ...hgOpts, onPoll: x => log({ poll: x.status }) });
    await hg.download(v.video_url, raw, hgOpts);
    hgInfo = { video_id: c.video_id, ...ids, engine: c.engine || hg.engine(), estimate: c.estimate || null, heygen_duration: v.duration, at: new Date().toISOString() };
  }
  const clip = await probeDuration(raw);
  const total = A.twinTotal(clip);
  const planned = +p.total_s || A.estimateDuration(p.script.text);
  const captions = retimeCaptions(p.script.captions, planned, total);
  const assPath = path.join(dir, 'twin_live.ass');
  fs.writeFileSync(assPath, A.buildTwinAss({ lines: captions, salon: p.profile.salon, duration: total, tone: p.inputs?.mood === 'Luxe' ? 'luxe' : 'clean', solidCaptions: true, overlays: A.cleanOverlays(p.overlays) }));
  const musicFile = A.musicFor(p.inputs?.music, musicOn);
  const out = path.join(dir, `twin_live_${Date.now()}${musicFile ? '' : '_nomusic'}.mp4`);
  let brolls = null, timeline = null;
  if (p.template === 'promo' && rw && promo?.productFile && promo?.styleAStill) {
    brolls = await buildPromoBroll(promo, { rw, dir, rwOpts, log });
    for (const b of brolls) b.dur = Math.min(b.dur, await probeDuration(b.file));
    const built = A.promoAssembleArgs({ avatar: { file: raw, dur: total }, brolls, productFile: promo.productFile, endCardDur: promo.endCardDur || 2.5, assPath, musicFile, out });
    timeline = built.timeline;
    // captions belong to the avatar segment; rewrite the ASS so overlays (if toggled on) span the full promo
    fs.writeFileSync(assPath, A.buildTwinAss({ lines: captions, salon: p.profile.salon, duration: timeline.total, tone: p.inputs?.mood === 'Luxe' ? 'luxe' : 'clean', solidCaptions: true, overlays: A.cleanOverlays(p.overlays) }));
    await run('ffmpeg', built.args);
  } else await run('ffmpeg', A.twinAssembleArgs({ talking: raw, total, assPath, musicFile, out, pushIn: C.pushInAmount(hgOpts.env || env) }));
  // speech is always present, so master both variants
  const loudness = await master(out).catch(e => ({ error: String(e.message).slice(0, 200) }));
  return { out, raw, heygen: hgInfo, duration: timeline ? timeline.total : total, timeline, broll: brolls && brolls.map(b => ({ style: b.style, task_id: b.task_id || null, reused: b.reused, model: b.model || null, estimate: b.estimate || null })), captions, product_for_broll: p.product?.key || null, music: !!musicFile, track: musicFile ? p.inputs.music : 'none', loudness, overlays: A.cleanOverlays(p.overlays), ai_label: A.cleanOverlays(p.overlays).ai_label ? A.AI_LABEL : null };
}
module.exports = { retimeCaptions, heygenIds, renderHeygen, runwayClip, buildPromoBroll };
