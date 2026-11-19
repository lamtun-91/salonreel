'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const S = require('../studio'), P = require('../pipeline'), SS = require('../shotstack'), MUSIC = require('../music'), MASTER = require('../master');

const sixShots = [{ id: 's1', type: 'detail' }, { id: 's2', type: 'styling' }, { id: 's3', type: 'detail' }, { id: 's4', type: 'styling' }, { id: 's6', type: 'reveal' }, { id: 's5', type: 'reveal' }];
const sixClips = Object.fromEntries(sixShots.map(s => [s.id, { duration: 8.04 }]));
const sixQC = { clips: sixShots.map(s => ({ shot_id: s.id, flags: [], best: { start_s: 1, end_s: 4 } })) };

test('(a) master.js: loud mix -> about -14 LUFS, true peak <= -1 dBTP, video copied, same duration', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-')), f = path.join(d, 'loud.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x568:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=110:r=48000:d=6,volume=6',
    '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink:a=0.9:r=48000', '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo,aresample=48000[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', f]);
  const before = await MASTER.measure(f);
  const r = await MASTER.masterFile(f);
  const after = await MASTER.measure(f);
  assert.ok(before.i > -12.5 && before.tp > -1, 'test input is loud and peaky: ' + before.i + ' ' + before.tp);
  assert.ok(Math.abs(after.i - -14) <= 1.0, 'integrated ' + after.i);
  assert.ok(after.tp <= -1.0, 'true peak ' + after.tp);
  assert.equal(r.after.tp, after.tp);
  const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString();
  assert.ok(Math.abs(dur - 6) < 0.1, 'duration ' + dur);
});

test('(a) master.js leaves a silent (no-music) mix alone', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-')), f = path.join(d, 'silent.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x568:r=30:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', f]);
  const r = await MASTER.masterFile(f);
  assert.equal(r.skipped, 'silent');
});

test('(a) Shotstack music bed is lowered and trimmed with ms precision', () => {
  const edit = { segments: [{ shot_id: 'a', in_s: 0, out_s: 3, speed: 1, transition_in: { type: 'cut' }, zoom: { type: 'none' } },
    { shot_id: 'b', in_s: 0, out_s: 3, speed: 1, transition_in: { type: 'cut' }, zoom: { type: 'none' } }], overlays: [], total: 6, music_start_s: 3.0155 };
  const { edit: pl } = SS.buildEditPayload({ edit, clips: { a: {}, b: {} }, clipUrls: { a: 'https://x/a.mp4', b: 'https://x/b.mp4' }, musicUrl: 'https://x/m.m4a', profile: { salon: 'Olya Atelier' } });
  const m = pl.timeline.tracks.flatMap(t => t.clips).find(c => c.asset.type === 'audio');
  assert.ok(m.asset.volume <= 0.6); assert.equal(m.asset.trim, 3.016);
});

test('(b) reveal clips never play below 1.0x; the planner is told so', () => {
  const e = S.cleanEdit({ segments: [{ shot_id: 's1', in_s: 0, out_s: 4, speed: 1 }, { shot_id: 's2', in_s: 0, out_s: 4, speed: 1.2 },
    { shot_id: 's5', in_s: 0, out_s: 5, speed: 0.6, ramp_to: 0.8, transition_in: { type: 'fade', duration: 0.4 } }] },
    { shots: sixShots, clips: sixClips, qc: sixQC, music: 'velvet-house' });
  const rev = e.segments[e.segments.length - 1];
  assert.equal(rev.shot_id, 's5'); assert.ok(rev.speed >= 1); assert.ok(!rev.ramp_to || rev.ramp_to >= 1);
  assert.equal(e.reveal_speed_clamped[0].speed, 0.6);
  assert.ok(e.segments.every(s => sixShots.find(x => x.id === s.shot_id).type !== 'reveal' || s.speed >= 1));
  assert.match(S.editPrompt({ shots: sixShots, clips: sixClips, qc: sixQC, mood: 'Luxe', music: 'house-reveal', style: 'Reveal-only' }), /never slow-mo/);
});

test('(c) captions get each clip speed; server strips speed claims that contradict it', () => {
  const edit = { segments: [{ speed: 1.5 }, { speed: 0.8 }, { speed: 1 }], timeline: [{ shot_id: 'a', start_s: 0, end_s: 3 }, { shot_id: 'b', start_s: 3, end_s: 6 }, { shot_id: 'c', start_s: 6, end_s: 9 }], total: 9 };
  const bd = S.breakdownFor(edit, { clips: [] });
  assert.deepEqual(bd.map(b => [b.speed, b.playback]), [['1.5x', 'sped up'], ['0.8x', 'slow motion'], ['1x', 'normal speed']]);
  const txt = P.copyPrompt({ look: { has_haircut: true, clip_breakdown: bd }, tone: 'Luxe', profile: { salon: 'Olya Atelier' }, duration: 9 });
  assert.match(txt, /"speed":"1.5x","playback":"sped up"/); assert.match(txt, /no "slow"\/"slow-mo" over a sped-up clip/);
  const r = S.fixSpeedClaims([{ text: 'Slow blow-dry, natural movement', clip: 1 }, { text: 'A quick flick of the ends', clip: 2 }, { text: 'Waves in slow motion', clip: 3 }, { text: 'Soft waves, crown to ends', clip: 3 }], edit);
  assert.deepEqual(r.lines.map(l => l.text), ['Blow-dry, natural movement', 'A flick of the ends', 'Waves', 'Soft waves, crown to ends']);
  assert.equal(r.fixes.length, 3);
  for (const l of r.lines) { const sp = parseFloat(l.speed); if (sp > 1) assert.doesNotMatch(l.text, /slow/i); if (sp < 1) assert.doesNotMatch(l.text, /fast|quick/i); }
});

test('(d) every usable clip is used (v2: 6 x 8s clips, planner skipped the mirror) and the reel stays in 18-25s', () => {
  const plan = { segments: ['s1', 's2', 's3', 's4', 's5'].map((id, i) => ({ shot_id: id, in_s: 1, out_s: i === 4 ? 6 : 4.5, speed: id === 's4' ? 1.5 : 1, transition_in: { type: i ? 'cut' : 'cut' } })) };
  const e = S.cleanEdit(plan, { shots: sixShots, clips: sixClips, qc: sixQC, music: 'house-reveal' });
  assert.deepEqual([...e.segments.map(s => s.shot_id)].sort(), ['s1', 's2', 's3', 's4', 's5', 's6']);
  assert.equal(e.segments[e.segments.length - 1].shot_id, 's5', 'the planned reveal stays last');
  assert.deepEqual(e.included_unused, ['s6']);
  assert.ok(e.total >= 18 && e.total <= 25, 'total ' + e.total);
});

test('drop sync: hard cut into the reveal, drop lands exactly on the cut frame', () => {
  const plan = { segments: ['s1', 's2', 's3', 's4', 's6', 's5'].map((id, i) => ({ shot_id: id, in_s: 1, out_s: i === 5 ? 7 : 4, speed: 1, transition_in: { type: i ? 'fade' : 'cut', duration: 0.4 } })) };
  const e = S.cleanEdit(plan, { shots: sixShots, clips: sixClips, qc: sixQC, music: 'house-reveal' });
  const rev = e.segments[e.segments.length - 1], start = e.timeline[e.timeline.length - 1].start_s;
  assert.equal(rev.transition_in.type, 'cut');
  assert.equal(e.music_start_source, 'drop');
  const cut = S.frameCeil(start); assert.ok(Math.abs(cut * 30 - Math.round(cut * 30)) < 1e-6, 'cut on a frame');
  assert.ok(Math.abs(e.music_start_s + cut - MUSIC.dropFor('house-reveal')) < 0.0011, `drop ${MUSIC.dropFor('house-reveal')} vs ${e.music_start_s}+${cut}`);
  assert.equal(e.reveal_cut_s, Math.round(cut * 1000) / 1000);
});

test('addShot adds a slot (e.g. mirror) before a given shot with a fresh id', () => {
  const plan = { shots: [{ id: 's1', type: 'detail' }, { id: 's5', type: 'reveal' }] };
  const sh = S.addShot(plan, { name: 'Mirror moment', type: 'reveal', before: 's5' }, 'Reveal-only');
  assert.equal(sh.id, 's6'); assert.deepEqual(plan.shots.map(s => s.id), ['s1', 's6', 's5']);
  assert.equal(S.addShot(plan, { type: 'cutting' }, 'Reveal-only').type, 'detail'); // process types not allowed in Reveal-only
});
