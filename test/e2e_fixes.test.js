'use strict';
// Regression tests for the 2026-11-18 live E2E findings (projects fa506846b2ab, 59fcaf352564).
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../studio'), P = require('../pipeline');

// ---- #2 transitions + duration ----
test('no fade-through-colour transitions survive cleaning', () => {
  assert.equal(S.TRANSITIONS.includes('fadewhite'), false);
  assert.equal(S.normTransition('fadewhite'), 'fade');
  assert.equal(S.normTransition('fadeblack'), 'fade');
  assert.equal(S.normTransition('nonsense'), 'cut');
});
test('xfadePlan: total = sum(segments) - sum(overlaps), pieces cover the timeline exactly', () => {
  const segs = [{ transition_in: { type: 'cut' } }, { transition_in: { type: 'dissolve', duration: 0.4 } }, { transition_in: { type: 'smoothup', duration: 0.35 } }, { transition_in: { type: 'fade', duration: 0.54 } }];
  const durs = [3.75, 2.253, 1.35, 6.75];
  const pl = S.xfadePlan(durs, segs);
  assert.deepEqual(pl.ds, [0, 0.4, 0.35, 0.54]);
  assert.ok(Math.abs(pl.total - 12.81) <= 0.01, String(pl.total));
  const sum = pl.pieces.reduce((a, p) => a + p.dur, 0);
  assert.ok(Math.abs(sum - pl.total) <= 0.01);
  assert.ok(pl.pieces.filter(p => p.kind === 'xfade').every(p => p.transition !== 'fadewhite' && p.transition !== 'fadeblack'));
});
test('cleanEdit total equals xfadePlan total and stays in 15-30s when footage allows', () => {
  const clips = Object.fromEntries(['s1', 's2', 's3', 's4'].map(k => [k, { duration: 8, src_start: 0 }]));
  const qc = { clips: Object.keys(clips).map(k => ({ shot_id: k, flags: [] })) };
  const e = S.cleanEdit({ segments: [
    { shot_id: 's1', in_s: 0.8, out_s: 3.8, speed: 0.8, transition_in: { type: 'cut' } },
    { shot_id: 's2', in_s: 0.8, out_s: 4.2, speed: 1.5, transition_in: { type: 'dissolve', duration: 0.4 } },
    { shot_id: 's3', in_s: 0.8, out_s: 2.2, speed: 1, transition_in: { type: 'fadewhite', duration: 0.4 } },
    { shot_id: 's4', in_s: 0.8, out_s: 4.8, speed: 0.6, transition_in: { type: 'fade', duration: 0.5 } }] }, { clips, qc, music: 'velvet' });
  const SS = require('../shotstack');
  const pl = S.xfadePlan(e.segments.map(SS.segmentTimelineDuration), e.segments);
  assert.ok(Math.abs(pl.total - e.total) <= 0.05, `${pl.total} vs ${e.total}`);
  assert.ok(e.total >= 15 && e.total <= 30, String(e.total));
  assert.equal(e.segments[2].transition_in.type, 'fade');
});

// ---- #4 brief type + readiness ----
test('Reveal-only shot list drops process shots and keeps a reveal', () => {
  const j = { shots: [{ name: 'Color glide', type: 'color' }, { name: 'Bob line', type: 'cutting' }, { name: 'Air lift', type: 'blowdry' }, { name: 'Finish pass', type: 'styling' }, { name: 'The reveal', type: 'reveal' }] };
  const r = S.cleanShots(j, 'Reveal-only');
  assert.ok(r.shots.length >= 4);
  assert.ok(r.shots.every(s => !S.PROCESS_TYPES.includes(s.type)), JSON.stringify(r.shots.map(s => s.type)));
  assert.ok(r.shots.some(s => s.type === 'reveal'));
  assert.ok(S.shotPrompt({ style: 'Reveal-only', mood: 'Luxe', music: 'velvet' }).includes('No before'));
  assert.ok(S.mockShots({ style: 'Reveal-only' }).shots.every(s => !S.PROCESS_TYPES.includes(s.type)));
  // other styles unchanged
  assert.equal(S.cleanShots(j, 'Process').shots[0].type, 'color');
});
test('gate passes when a reveal clip exists and QC saw the finished cut, even if framing advice says reshoot', () => {
  const shots = [{ id: 's1', name: 'A', type: 'detail' }, { id: 's2', name: 'B', type: 'detail' }, { id: 's5', name: 'The reveal', type: 'reveal' }];
  const clips = { s1: {}, s2: {}, s5: {} };
  const mk = (id, extra = {}) => ({ shot_id: id, reshoot: true, issues: ['close-up not full upper-body'], metrics: { brightness: 90, duration: 5 }, ...extra });
  let g = S.gapReport(shots, clips, { has_haircut: true, clips: ['s1', 's2', 's5'].map(id => mk(id)) }, 'Reveal-only');
  assert.equal(g.ready, true, g.note); assert.equal(g.reshoot.length, 3); // advice still shown
  g = S.gapReport(shots, clips, { has_haircut: false, clips: ['s1', 's2', 's5'].map(id => mk(id)) }, 'Reveal-only');
  assert.equal(g.ready, false);
  g = S.gapReport(shots, { s1: {}, s2: {} }, { has_haircut: true, clips: ['s1', 's2'].map(id => mk(id)) }, 'Reveal-only');
  assert.equal(g.ready, false); assert.match(g.note, /reveal/);
  g = S.gapReport(shots, clips, { has_haircut: true, clips: [mk('s1'), mk('s2'), mk('s5', { metrics: { brightness: 20, duration: 5 } })] }, 'Reveal-only');
  assert.equal(g.ready, false, 'a too-dark reveal is not usable');
});

// ---- #5 QC flags enforced in the edit ----
test('issue text becomes whole-clip flags; QC ranges are kept', () => {
  const f = S.cleanFlags({ flags: [{ kind: 'blur', start_s: 1, end_s: 2 }] }, ['garbled text overlay', 'black letterbox bars'], 5);
  assert.deepEqual(f.map(x => x.kind).sort(), ['blur', 'letterbox', 'text_overlay']);
  assert.deepEqual(S.avoidRanges({ flags: f }).sort(), [[0, 5], [1, 2]]);
});
test('freeWindow picks the largest unflagged span', () => {
  assert.deepEqual(S.freeWindow(0, 5, [[1, 2]]), [2, 5]);
  assert.equal(S.freeWindow(0, 5, [[0, 5]]), null);
});
test('cleanEdit trims out flagged ranges and drops clips that are fully flagged', () => {
  const clips = Object.fromEntries(['s1', 's2', 's3', 's4'].map(k => [k, { duration: 5, src_start: 0 }]));
  const qc = { clips: [
    { shot_id: 's1', flags: [] },
    { shot_id: 's2', flags: [{ kind: 'text_overlay', start_s: 0, end_s: 5 }] },
    { shot_id: 's3', flags: [{ kind: 'text_overlay', start_s: 0, end_s: 2 }], crop: { top: 0.16, bottom: 0.18 } },
    { shot_id: 's4', flags: [{ kind: 'letterbox', start_s: 0, end_s: 5 }] }] };
  const e = S.cleanEdit({ segments: ['s1', 's2', 's3', 's4'].map(id => ({ shot_id: id, in_s: 0.5, out_s: 4.5, speed: 1, transition_in: { type: 'fade', duration: 0.4 } })) }, { clips, qc, music: 'velvet' });
  assert.deepEqual(e.segments.map(s => s.shot_id), ['s1', 's3', 's4']);
  const s3 = e.segments.find(s => s.shot_id === 's3'); assert.ok(s3.in_s >= 2, 'starts after the flagged text');
  assert.equal(e.qc_enforced.dropped[0].shot_id, 's2');
  assert.deepEqual(e.qc_enforced.cropped, ['s3']);
  // letterbox crop reaches the ffmpeg filter
  assert.match(S.segFilter({ ...s3, crop: { top: 0.16, bottom: 0.18 } }), /^\[0:v\]crop=/);
  assert.equal(S.editPrompt({ shots: ['s1', 's2'].map(id => ({ id, name: id, type: 'detail' })), clips, qc, mood: 'Luxe', music: 'velvet', style: 'Reveal-only' }).includes('avoid_ranges_s'), true);
});
test('analyzeBars finds a blurred-fill seam and flat bars, ignores normal frames', () => {
  const W = 40, H = 100, mk = fn => { const b = Buffer.alloc(W * H * 2); for (let k = 0; k < 2; k++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) b[k * W * H + y * W + x] = fn(x, y, k); return b; };
  const noise = (x, y, k) => Math.round(110 + 60 * Math.sin(x / 4 + k) + y * 0.4);
  assert.equal(S.analyzeBars(mk(noise), W, H, 2), null);
  const flat = S.analyzeBars(mk((x, y, k) => y < 10 || y >= 90 ? 5 : noise(x, y, k)), W, H, 2);
  assert.ok(flat && flat.top >= 0.1 && flat.bottom >= 0.1, JSON.stringify(flat));
  const seam = S.analyzeBars(mk((x, y, k) => y < 16 ? 60 + (x % 3) : y >= 84 ? 40 + (x % 3) : 200), W, H, 2);
  assert.ok(seam && seam.top >= 0.16 && seam.bottom >= 0.15, JSON.stringify(seam));
});

// ---- #3 caption zones (ffmpeg/ASS) ----
test('ASS: salon name top band and captions in a separate boxed lower band, inside Reels safe area', () => {
  const ass = P.buildAss({ lines: [{ start_s: 0, end_s: 2, text: 'Book via link in bio' }], salon: 'Olya Atelier', duration: 5, tone: 'luxe' });
  const st = n => ass.split('\n').find(l => l.startsWith('Style: ' + n)).split(',');
  const cap = st('Cap'), brand = st('Brand');
  assert.equal(cap[15], '3', 'caption uses an opaque backing box (BorderStyle 3)');
  assert.equal(cap[18], '2'); assert.equal(brand[18], '8');
  assert.ok(1920 - +cap[21] <= 1920 * 0.65, 'caption bottom above the bottom 35%');
  assert.ok(+brand[21] >= 1920 * 0.14, 'brand below the top 14%');
  assert.ok(+brand[16] > 0 || +brand[17] > 0, 'brand outline/shadow');
});

// ---- #6 caption alignment + summary ----
test('alignOverlays snaps lines to the clip on screen (59fcaf352564 case)', () => {
  const edit = { total: 13.5, timeline: [{ shot_id: 's1', start_s: 0, end_s: 3.45 }, { shot_id: 's2', start_s: 3, end_s: 5.25 }, { shot_id: 's4', start_s: 4.85, end_s: 7.35 }, { shot_id: 's5', start_s: 6.75, end_s: 13.5 }] };
  const lines = [{ text: 'A finished balayage bob?', start_s: 0, end_s: 3.4, clip: 1 }, { text: 'The line from every side', start_s: 3.4, end_s: 5.2, clip: 2 },
    { text: 'Color melt through the wave', start_s: 5.2, end_s: 7.3, clip: 3 }, { text: 'From the chair to standing', start_s: 7.3, end_s: 11, clip: 4 }, { text: 'Book via link in bio', start_s: 11, end_s: 13.5 }];
  const out = S.alignOverlays(lines, edit), wins = S.clipWindows(edit.timeline, edit.total);
  for (const l of out) { const w = wins.find(x => x.clip === l.clip); assert.ok(l.start_s >= w.start_s - 1e-9 && l.end_s <= w.end_s + 1e-9, JSON.stringify(l)); }
  assert.equal(out.find(l => l.text.startsWith('From the chair')).shot_id, 's5');
  const cta = out[out.length - 1]; assert.equal(cta.text, 'Book via link in bio'); assert.equal(cta.end_s, 13.5); assert.equal(cta.shot_id, 's5');
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start_s >= out[i - 1].end_s);
  assert.ok(out.every(l => l.end_s - l.start_s >= 1));
  // without clip numbers it falls back to max overlap
  assert.equal(S.alignOverlays(lines.map(({ clip, ...l }) => l), edit).find(l => l.text.startsWith('Color')).shot_id, 's4');
});
test('copy prompt asks for clip numbers and specific lines; QC summary is one short sentence', () => {
  const pr = P.copyPrompt({ look: { clip_breakdown: [{ clip: 1, start_s: 0, end_s: 3, what_is_visible: 'front' }] }, tone: 'luxe', profile: { salon: 'Olya Atelier' }, duration: 12 });
  assert.match(pr, /"clip" number/); assert.match(pr, /Posed in the salon/);
  const s = S.shortSummary('Only the before close-up is slot-ready; reshoot the balayage clip for the garbled text, the detail clip for letterboxing and a tighter end shot, and the reveal as a steady head-and-shoulders half-turn.');
  assert.ok(s.length <= 91, s);
});

// ---- #7 no-music export ----
test('no-music Shotstack payload omits only the soundtrack; video/text timing identical', () => {
  const SS = require('../shotstack');
  const clips = { s1: { duration: 6, src_start: 0 }, s2: { duration: 6, src_start: 0 } };
  const edit = { segments: [
    { shot_id: 's1', in_s: 0, out_s: 5, speed: 1, zoom: { type: 'none' }, transition_in: { type: 'cut', duration: 0 } },
    { shot_id: 's2', in_s: 0, out_s: 5, speed: 1, zoom: { type: 'none' }, transition_in: { type: 'fade', duration: 0.4 } }],
    overlays: [{ text: 'Hook', start_s: 0, end_s: 2 }], music_start_s: 3, track: 'velvet' };
  const urls = { s1: 'https://x.example/s1.mp4', s2: 'https://x.example/s2.mp4' };
  const withM = SS.buildEditPayload({ edit, clips, clipUrls: urls, musicUrl: 'https://x.example/m.m4a', profile: { salon: 'Olya Atelier' } });
  const noM = SS.buildEditPayload({ edit, clips, clipUrls: urls, musicUrl: null, profile: { salon: 'Olya Atelier' } });
  const audio = pl => pl.timeline.tracks.filter(t => t.clips.some(c => c.asset.type === 'audio'));
  assert.equal(audio(withM.edit).length, 1); assert.equal(audio(noM.edit).length, 0);
  assert.deepEqual(noM.edit.timeline.tracks, withM.edit.timeline.tracks.filter(t => !audio(withM.edit).includes(t)));
  assert.equal(noM.meta.total, withM.meta.total);
});

// ---- #8 frame-based captioning ----
test('captionFrameStamps samples the used, on-screen part of each clip in final order', () => {
  const edit = { total: 12.81, segments: [
    { shot_id: 's1', in_s: 0.8, out_s: 3.8, speed: 0.8, transition_in: { type: 'cut' } },
    { shot_id: 's2', in_s: 0.8, out_s: 4.18, speed: 1.5, transition_in: { type: 'dissolve', duration: 0.4 } },
    { shot_id: 's4', in_s: 0.8, out_s: 2.15, speed: 1, transition_in: { type: 'smoothup', duration: 0.35 } },
    { shot_id: 's5', in_s: 0.8, out_s: 4.85, speed: 0.6, transition_in: { type: 'fade', duration: 0.54 } }],
    timeline: [{ shot_id: 's1', start_s: 0, end_s: 3.75 }, { shot_id: 's2', start_s: 3.35, end_s: 5.6 }, { shot_id: 's4', start_s: 5.25, end_s: 6.6 }, { shot_id: 's5', start_s: 6.06, end_s: 12.81 }] };
  const clips = { s1: { src_start: 0 }, s2: { src_start: 0 }, s4: { src_start: 10 }, s5: { src_start: 0 } };
  const fm = S.captionFrameStamps(edit, clips);
  assert.deepEqual(fm.map(c => c.shot_id), ['s1', 's2', 's4', 's5']);
  fm.forEach((c, i) => { const sg = edit.segments[i], base = clips[sg.shot_id].src_start;
    assert.ok(c.frames.length >= 1 && c.frames.length <= 2);
    for (const f of c.frames) { assert.ok(f.on_s >= c.start_s && f.on_s <= c.end_s); assert.ok(f.src_s >= base + sg.in_s - 1e-9 && f.src_s <= base + sg.out_s + 1e-9, JSON.stringify([f, sg])); } });
  assert.equal(fm[2].frames.length, 1, 'short on-screen window gets one frame');
  assert.ok(P.visionCaptionAddendum(fm).includes('clip 4 (on screen'));
});
test('validateOverlays flags windows outside clip bounds or overlapping', () => {
  const edit = { total: 10, timeline: [{ shot_id: 'a', start_s: 0, end_s: 5 }, { shot_id: 'b', start_s: 5, end_s: 10 }] };
  assert.equal(S.validateOverlays(S.alignOverlays([{ text: 'x', start_s: 0, end_s: 4, clip: 1 }, { text: 'cta', start_s: 6, end_s: 10 }], edit), edit).ok, true);
  const bad = S.validateOverlays([{ text: 'x', start_s: 3, end_s: 7, clip: 1 }, { text: 'y', start_s: 6.5, end_s: 9, clip: 2 }], edit);
  assert.equal(bad.ok, false); assert.equal(bad.problems.length, 2);
});

// ---- #10 duration policy ----
test('duration policy: ~18s default, stretch to <=25s with plenty of usable footage, never pads with slow-mo', () => {
  assert.equal(S.durationPolicy(20).max_s, 18); assert.equal(S.durationPolicy(60).max_s, 25);
  const mk = (n, d, flags = {}) => { const clips = {}, qc = { clips: [] };
    for (let i = 1; i <= n; i++) { clips['s' + i] = { duration: d, src_start: 0 }; qc.clips.push({ shot_id: 's' + i, flags: flags['s' + i] || [] }); } return { clips, qc }; };
  const plan = (n, len, speed = 1) => ({ segments: Array.from({ length: n }, (_, i) => ({ shot_id: 's' + (i + 1), in_s: 0, out_s: len, speed, transition_in: { type: i ? 'fade' : 'cut', duration: 0.4 } })) });
  // plenty of footage, LLM over-long plan -> clamped to <= 25
  let { clips, qc } = mk(6, 12); let e = S.cleanEdit(plan(6, 8), { clips, qc, music: 'velvet-house' });
  assert.ok(e.total <= 25.05 && e.total >= 15, String(e.total)); assert.equal(e.duration_policy.max_s, 25);
  // moderate footage, short plan -> grown toward ~18 from real footage at the same speed
  ({ clips, qc } = mk(4, 6)); e = S.cleanEdit(plan(4, 2.5), { clips, qc, music: 'velvet-house' });
  assert.ok(e.total >= 15 && e.total <= 18.6, String(e.total)); assert.ok(e.segments.every(s => s.speed === 1));
  // thin footage: shorter reel is fine; no slow-mo added
  ({ clips, qc } = mk(3, 3)); e = S.cleanEdit(plan(3, 3), { clips, qc, music: 'velvet-house' });
  assert.ok(e.total < 15, String(e.total)); assert.ok(e.segments.every(s => s.speed === 1 && s.out_s <= 3));
  // flagged time is not usable
  assert.equal(S.usableSeconds({ a: { duration: 5 }, b: { duration: 5 } }, { clips: [{ shot_id: 'b', flags: [{ kind: 'text_overlay', start_s: 0, end_s: 5 }] }] }), 5);
  assert.match(S.editPrompt({ shots: [{ id: 's1', name: 'a', type: 'reveal' }], clips: { s1: { duration: 6 } }, qc: { clips: [] }, mood: 'Luxe', music: 'velvet-house', style: 'Reveal-only' }), /about 18s/);
});

test('cleanEdit fills from usable clips when the AI returns a single segment', () => {
  const S = require('../studio');
  const shots = [{ id: 's1', type: 'detail' }, { id: 's2', type: 'styling' }, { id: 's5', type: 'reveal' }];
  const clips = { s1: { duration: 5 }, s2: { duration: 5 }, s5: { duration: 5 } };
  const qc = { clips: [{ shot_id: 's1', flags: [] }, { shot_id: 's2', flags: [{ kind: 'text_overlay', start_s: 0, end_s: 5 }] }, { shot_id: 's5', flags: [] }] };
  const e = S.cleanEdit({ segments: [{ shot_id: 's5', in_s: 0, out_s: 5 }] }, { shots, clips, qc, music: 'velvet-house' });
  assert.deepEqual(e.segments.map(s => s.shot_id), ['s1', 's5']);
  assert.equal(e.segments[0].transition_in.type, 'cut');
});

test('#10 growth extends clips backwards into unused footage to reach the 15s floor (live ff29b8e17c54 plan)', () => {
  const S = require('../studio');
  const shots = [{ id: 's1', type: 'detail' }, { id: 's2', type: 'styling' }, { id: 's4', type: 'styling' }, { id: 's5', type: 'reveal' }];
  const D = 5.042, clips = { s1: { duration: D }, s2: { duration: D }, s4: { duration: D }, s5: { duration: D } };
  const qc = { clips: [{ shot_id: 's1', flags: [], crop: { top: 0.16, bottom: 0.18 } }, { shot_id: 's2', flags: [{ kind: 'text_overlay', start_s: 0, end_s: 5 }] }, { shot_id: 's4', flags: [] }, { shot_id: 's5', flags: [] }] };
  const e = S.cleanEdit({ segments: [{ shot_id: 's1', in_s: 0.8, out_s: 5.04, speed: 1 }, { shot_id: 's4', in_s: 2, out_s: 5.04, speed: 1, transition_in: { type: 'cut' } },
    { shot_id: 's5', in_s: 2.5, out_s: 5.04, speed: 0.7, transition_in: { type: 'dissolve', duration: 0.4 } }] }, { shots, clips, qc, music: 'velvet-house' });
  assert.ok(e.total >= 15 && e.total <= 18.1, 'total ' + e.total);
  assert.ok(e.segments.every(s => s.in_s >= 0 && s.out_s <= D + 0.01));
  assert.equal(e.segments[0].speed, 1); assert.equal(e.segments[1].speed, 1); // growth never adds slow-mo
});

test('music library storage key passes storage.safeKey (Shotstack music upload)', () => {
  const MUSIC = require('../music'), st = require('../storage');
  for (const id of Object.keys(MUSIC.TRACKS).filter(t => t !== 'none')) assert.doesNotThrow(() => st.safeKey(MUSIC.storageKey(id)));
});
