'use strict';
// M2: real Twin render from a HeyGen Sample (stock) avatar. Dependencies are injected so tests run with the network mocked.
// Flow: create HeyGen avatar video (9:16) -> poll -> download raw -> retime captions to the real spoken length ->
// assemble in avatar.js (crop 1080x1920, captions, brand, AI-generated label, product photo, music bed) -> master.
// A stored raw clip is reused on re-render / export variants so captions or music edits never pay for a second HeyGen render.
const fs = require('fs'), path = require('path');
const A = require('./avatar');

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

async function renderHeygen(p, { hg, run, probeDuration, master, dir, getProduct, musicOn = p.musicOn, env = process.env, hgOpts = {}, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, 'heygen_raw.mp4');
  let hgInfo = p.heygen && p.heygen.video_id && fs.existsSync(raw) ? p.heygen : null;
  if (!hgInfo) {
    const ids = heygenIds(p, hg, env);
    const c = await hg.createVideo({ ...ids, script: p.script.text, engine: hg.engine(), aspect_ratio: '9:16', title: `SalonReel twin ${p.id}` }, hgOpts);
    log({ created: c.video_id });
    const v = await hg.waitForVideo(c.video_id, { ...hgOpts, onPoll: x => log({ poll: x.status }) });
    await hg.download(v.video_url, raw, hgOpts);
    hgInfo = { video_id: c.video_id, ...ids, engine: c.engine || hg.engine(), estimate: c.estimate || null, heygen_duration: v.duration, at: new Date().toISOString() };
  }
  const clip = await probeDuration(raw);
  const total = A.twinTotal(clip);
  const planned = +p.total_s || A.estimateDuration(p.script.text);
  const captions = retimeCaptions(p.script.captions, planned, total);
  let product = null;
  if (p.product?.key) { const k = total / planned; product = { slot_start_s: Math.round(p.product.slot_start_s * k * 100) / 100, slot_end_s: Math.round(Math.min(total, p.product.slot_end_s * k) * 100) / 100 }; }
  const assPath = path.join(dir, 'twin_live.ass');
  fs.writeFileSync(assPath, A.buildTwinAss({ lines: captions, salon: p.profile.salon, duration: total, tone: p.inputs?.mood === 'Luxe' ? 'luxe' : 'clean', solidCaptions: true }));
  const productFile = product ? await getProduct(p.product.key, dir) : null;
  const musicFile = A.musicFor(p.inputs?.music, musicOn);
  const out = path.join(dir, `twin_live_${Date.now()}${musicFile ? '' : '_nomusic'}.mp4`);
  await run('ffmpeg', A.twinAssembleArgs({ talking: raw, total, assPath, productFile, product, musicFile, out }));
  // speech is always present, so master both variants
  const loudness = await master(out).catch(e => ({ error: String(e.message).slice(0, 200) }));
  return { out, raw, heygen: hgInfo, duration: total, captions, product, music: !!musicFile, track: musicFile ? p.inputs.music : 'none', loudness, ai_label: A.AI_LABEL };
}
module.exports = { retimeCaptions, heygenIds, renderHeygen };
