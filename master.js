'use strict';
// Final-mix loudness mastering: ~-14 LUFS integrated, true peak <= -1 dBTP. Two-pass loudnorm on the audio only;
// the video stream is copied untouched (same frames, same timing). Silent mixes (no-music exports) are left alone.
const { spawn } = require('child_process');
const fs = require('fs');
const TARGET = { I: -14, TP: -1.5, LRA: 11, maxTP: -1.0, silentBelow: -60 };
function ff(args) {
  return new Promise((res, rej) => { const p = spawn('ffmpeg', args); let err = '';
    p.stderr.on('data', d => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
    p.on('error', rej); p.on('close', c => c === 0 ? res(err) : rej(new Error('ffmpeg failed: ' + err.slice(-400)))); });
}
function parseLoudnorm(stderr) {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g); if (!m) throw new Error('loudnorm stats missing');
  return JSON.parse(m[m.length - 1]);
}
const num = v => (v === '-inf' || v === 'inf' || v == null) ? -Infinity : +v;
async function measure(file) {
  const j = parseLoudnorm(await ff(['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}:print_format=json`, '-f', 'null', '-']));
  return { i: num(j.input_i), tp: num(j.input_tp), lra: num(j.input_lra), thresh: num(j.input_thresh), offset: num(j.target_offset), raw: j };
}
function pass2Filter(m, tp = TARGET.TP) {
  const r = m.raw;
  return `loudnorm=I=${TARGET.I}:TP=${tp}:LRA=${TARGET.LRA}:measured_I=${r.input_i}:measured_TP=${r.input_tp}:measured_LRA=${r.input_lra}:measured_thresh=${r.input_thresh}:offset=${r.target_offset}:linear=true:print_format=json,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
}
// Returns { skipped?, before:{i,tp}, after:{i,tp} }. Rewrites `file` in place.
async function masterFile(file, { tmp = file + '.master.mp4' } = {}) {
  const before = await measure(file);
  if (!isFinite(before.i) || before.i < TARGET.silentBelow) return { skipped: 'silent', before: { i: before.i, tp: before.tp } };
  let tp = TARGET.TP, after;
  for (let k = 0; k < 3; k++) {
    await ff(['-y', '-hide_banner', '-nostats', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', pass2Filter(before, tp), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', tmp]);
    after = await measure(tmp);
    if (after.tp <= TARGET.maxTP) break;
    tp -= 1; // AAC re-encode overshoot: aim lower and redo
  }
  fs.renameSync(tmp, file);
  return { target: { i: TARGET.I, tp_max: TARGET.maxTP }, before: { i: before.i, tp: before.tp }, after: { i: after.i, tp: after.tp }, tp_aim: tp };
}
module.exports = { TARGET, measure, masterFile, parseLoudnorm, pass2Filter };
