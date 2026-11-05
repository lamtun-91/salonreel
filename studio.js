// SalonReel Studio: shot list -> guided filming -> QC -> edit plan -> render
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const P = require('./pipeline');
const r1 = n => Math.round(n * 10) / 10, r2 = n => Math.round(n * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, +v || 0));
const SHOT_TYPES = ['before', 'consult', 'sectioning', 'cutting', 'color', 'washing', 'blowdry', 'styling', 'detail', 'reveal'];
const TRANSITIONS = ['cut', 'fade', 'dissolve', 'slideup', 'slideleft', 'smoothleft', 'smoothup', 'circleopen', 'zoomin', 'wipeleft', 'fadewhite'];
const STYLES = ['Transformation', 'Process', 'Reveal-only', 'Tutorial'];
const MOODS = ['Luxe', 'Fun', 'Minimal'];
const TRACK_BPM = { velvet: 80, glow: 120, silk: 60, none: 100 };

// ---------- 1. shot list ----------
function shotPrompt({ profile: p = {}, style, mood, music }) {
  return `Plan a 15-30 second Instagram Reel for a hair salon, to be filmed on a phone in the salon today.
Salon: ${p.salon || '-'} | Stylist: ${p.stylist || '-'} | Services: ${p.services || '-'} | City: ${p.city || '-'} | Language: ${p.language || 'English'}
Brand notes: ${p.brandNotes || '-'}
Reel style: ${style}. Mood: ${mood}. Music: ${music} (${TRACK_BPM[music] || 100} bpm).
Return JSON only:
{"concept":"one sentence",
 "shots":[{"id":"s1","name":"short name","type":one of ${JSON.stringify(SHOT_TYPES)},"framing":"camera angle/distance and orientation (always vertical 9:16)","tips":"one practical filming tip (light, motion, what to capture)","target_s":seconds 2-8}],
 "draft_script":["4-5 short on-screen lines, no emoji, each under 40 chars, first is a hook, last is the booking CTA: ${p.booking || 'Book via link in bio'}"]}
Rules: 4-6 shots in story order; ${style === 'Transformation' ? 'start with a before shot and end with the reveal' : 'end with the reveal'}; total target 15-30s.`;
}
function cleanShots(j) {
  let shots = (Array.isArray(j.shots) ? j.shots : []).slice(0, 6).map((s, i) => ({
    id: 's' + (i + 1), name: String(s.name || s.type || 'Shot ' + (i + 1)).slice(0, 40),
    type: SHOT_TYPES.includes(s.type) ? s.type : 'detail', framing: String(s.framing || '').slice(0, 200),
    tips: String(s.tips || '').slice(0, 200), target_s: r1(clamp(s.target_s || 4, 2, 8)) }));
  if (shots.length < 4) throw new Error('AI returned fewer than 4 shots; try again');
  const tot = shots.reduce((a, s) => a + s.target_s, 0);
  if (tot > 30) shots.forEach(s => s.target_s = r1(Math.max(2, s.target_s * 30 / tot)));
  return { concept: String(j.concept || '').slice(0, 300), shots, draft_script: (j.draft_script || []).map(P.noEmoji).filter(Boolean).slice(0, 6) };
}
function mockShots({ profile: p = {}, style }) {
  return cleanShots({ concept: `${style} reel for ${p.salon || 'the salon'}`, shots: [
    { name: 'Before', type: 'before', framing: 'Front, chest-up, phone at eye level', tips: 'Face the window light; client looks into camera', target_s: 3 },
    { name: 'Cutting', type: 'cutting', framing: 'Close-up on hands and scissors, side angle', tips: 'Hold the phone steady with both hands or a tripod', target_s: 4 },
    { name: 'Blow-dry', type: 'blowdry', framing: 'Medium shot, 45 degrees behind', tips: 'Capture movement and volume, avoid the dryer blocking the face', target_s: 4 },
    { name: 'Reveal front', type: 'reveal', framing: 'Front, chest-up, slow push-in', tips: 'Client turns head slowly left to right', target_s: 4 },
    { name: 'Reveal back', type: 'reveal', framing: 'Back view, full length of hair', tips: 'Shake out the hair once for movement', target_s: 3 }],
    draft_script: ['Ready for a change?', 'Precision layers', 'Volume that moves', 'The reveal', p.booking || 'Book via link in bio'] });
}

// ---------- 2. auto-split one video ----------
function splitPrompt(shots, stamps, duration) {
  return `These ${stamps.length} frames come from ONE ${duration.toFixed(1)}s salon video, sampled at: ${stamps.map((t, i) => `#${i + 1}=${t.toFixed(1)}s`).join(', ')}.
Planned shots: ${JSON.stringify(shots.map(s => ({ id: s.id, name: s.name, type: s.type })))}.
Split the video into segments that best match each planned shot (skip shots that are not in the video). Return JSON only:
{"segments":[{"shot_id":"s1","start_s":number,"end_s":number,"what_is_visible":"short"}]} in time order, non-overlapping, within 0..${duration.toFixed(1)}.`;
}
function cleanSplit(j, shots, duration) {
  const ids = new Set(shots.map(s => s.id)), seen = new Set();
  return P.cleanSegments((j.segments || []).filter(s => ids.has(s.shot_id)), duration, 'shot_id')
    .filter(s => s.end_s - s.start_s >= 1 && !seen.has(s.shot_id) && seen.add(s.shot_id));
}
function mockSplit(shots, duration) {
  const n = shots.length, per = duration / n;
  return shots.map((s, i) => ({ shot_id: s.id, start_s: r1(i * per), end_s: r1((i + 1) * per), what_is_visible: s.name }));
}

// ---------- 3. QC ----------
function qcThresholds(m, shot, clip) {
  const issues = [];
  if (m.yavg < 45) issues.push('Too dark — add light or face a window');
  if (m.yavg > 215) issues.push('Overexposed — move away from direct light');
  if (m.ydif > 14) issues.push('Shaky or very fast motion — steady the phone');
  if (clip.duration < shot.target_s * 0.6) issues.push(`Too short (${clip.duration.toFixed(1)}s, aim for ${shot.target_s}s)`);
  if (clip.width > clip.height) issues.push('Filmed horizontally — vertical 9:16 works best (will be cropped)');
  return issues;
}
function qcPrompt(items) {
  return `You are checking phone clips filmed for a salon Reel. Frames are given in order, grouped per clip:
${items.map(it => `- ${it.shot.id} "${it.shot.name}" (${it.shot.type}, framing: ${it.shot.framing}): frames ${it.frameNums.join(', ')} at ${it.stamps.map(t => t.toFixed(1) + 's').join(', ')} of a ${it.clip.duration.toFixed(1)}s clip`).join('\n')}
For each clip return JSON only:
{"clips":[{"shot_id":"s1","matches_slot":boolean,"what_is_visible":"short description","lighting":"good|dim|harsh","steadiness":"steady|shaky","issues":["short"],"reshoot":boolean,"best_start_s":number,"best_end_s":number}],
 "has_haircut":boolean (a finished haircut is visible in at least one reveal clip),"overall":"one sentence"}`;
}
function cleanQC(j, items, metrics) {
  const by = Object.fromEntries((j.clips || []).map(c => [c.shot_id, c]));
  const clips = items.map(({ shot, clip }) => {
    const c = by[shot.id] || {}, m = metrics[shot.id], auto = qcThresholds(m, shot, clip);
    const issues = [...new Set([...(c.issues || []).map(String), ...auto])].slice(0, 6);
    const bs = clamp(c.best_start_s, 0, clip.duration), be = clamp(c.best_end_s || clip.duration, 0, clip.duration);
    return { shot_id: shot.id, matches_slot: c.matches_slot !== false, what_is_visible: String(c.what_is_visible || shot.name),
      lighting: c.lighting || (m.yavg < 45 ? 'dim' : m.yavg > 215 ? 'harsh' : 'good'), steadiness: c.steadiness || (m.ydif > 14 ? 'shaky' : 'steady'),
      metrics: { brightness: Math.round(m.yavg), motion: r1(m.ydif), duration: r1(clip.duration) }, issues,
      reshoot: !!c.reshoot || c.matches_slot === false || m.yavg < 40 || clip.duration < 1,
      best: be - bs >= 1 ? { start_s: r1(bs), end_s: r1(be) } : { start_s: 0, end_s: r1(clip.duration) } };
  });
  return { clips, has_haircut: j.has_haircut !== false, overall: String(j.overall || '') };
}
function mockQC(items, metrics) { return cleanQC({ clips: [], has_haircut: true, overall: 'Demo QC: automatic checks only (brightness, motion, length).' }, items, metrics); }
function gapReport(shots, clips, qc) {
  const missing = shots.filter(s => !clips[s.id]).map(s => ({ shot_id: s.id, name: s.name, issue: 'Not filmed yet' }));
  const reshoot = (qc?.clips || []).filter(c => c.reshoot).map(c => ({ shot_id: c.shot_id, name: shots.find(s => s.id === c.shot_id)?.name, issue: c.issues[0] || 'Does not match the planned shot' }));
  const hasReveal = shots.some(s => s.type === 'reveal' && clips[s.id] && !reshoot.find(r => r.shot_id === s.id));
  return { missing, reshoot, ready: hasReveal && Object.keys(clips).length >= 2, note: hasReveal ? '' : 'A usable reveal shot is required.' };
}

// ---------- 4. edit plan ----------
function beatGrid(track, total) { const step = 60 / (TRACK_BPM[track] || 100); const b = []; for (let t = 0; t <= total + 0.01; t += step) b.push(r2(t)); return b; }
function editPrompt({ shots, clips, qc, mood, music, style }) {
  const usable = shots.filter(s => clips[s.id]).map(s => { const q = qc.clips.find(c => c.shot_id === s.id) || {};
    return { shot_id: s.id, name: s.name, type: s.type, clip_duration_s: r1(clips[s.id].duration), best: q.best, visible: q.what_is_visible, issues: q.issues }; });
  return `You are a short-form video editor. Build an edit plan for a ${style} hair salon Reel, mood ${mood}, music ${music} at ${TRACK_BPM[music] || 100} bpm (beat every ${(60 / (TRACK_BPM[music] || 100)).toFixed(2)}s).
Available clips: ${JSON.stringify(usable)}
Return JSON only:
{"segments":[{"shot_id":"s1","in_s":number,"out_s":number (within clip),"speed":0.5-2 (1 = normal; use >1 for cutting/blow-dry, slow-mo 0.6-0.8 for reveal),"ramp_to":optional speed for the second half,"zoom":{"type":"none|punch_in|push_in","at_s":seconds into segment,"scale":1.0-1.3},"transition_in":{"type":one of ${JSON.stringify(TRANSITIONS)},"duration":0.2-0.8}}],
 "beat_markers":[seconds on the final timeline where cuts should land],"music_start_s":0-20}
Rules: total 12-30s; story order; the reveal last and longest; cuts on beats; first segment transition_in is "cut".`;
}
function cleanEdit(j, { shots, clips, qc, music }) {
  const segs = [];
  for (const s of (Array.isArray(j.segments) ? j.segments : [])) {
    const c = clips[s.shot_id]; if (!c || segs.length >= 8) continue;
    let a = clamp(s.in_s, 0, c.duration), b = clamp(s.out_s || c.duration, 0, c.duration);
    if (b - a < 0.8) { a = 0; b = c.duration; }
    const speed = r2(clamp(s.speed || 1, 0.5, 2)), ramp_to = s.ramp_to ? r2(clamp(s.ramp_to, 0.5, 2)) : null;
    const zt = ['punch_in', 'push_in'].includes(s.zoom?.type) ? s.zoom.type : 'none';
    const tr = TRANSITIONS.includes(s.transition_in?.type) ? s.transition_in.type : 'cut';
    segs.push({ shot_id: s.shot_id, in_s: r2(a), out_s: r2(b), speed, ramp_to: ramp_to && ramp_to !== speed ? ramp_to : null,
      zoom: { type: zt, at_s: r2(clamp(s.zoom?.at_s, 0, 10)), scale: r2(clamp(s.zoom?.scale || 1.15, 1, 1.3)) },
      transition_in: { type: segs.length ? tr : 'cut', duration: r2(clamp(s.transition_in?.duration || 0.4, 0.2, 0.8)) } });
  }
  if (segs.length < 2) throw new Error('Edit plan needs at least 2 usable clips');
  // fit length: scale trims if over 30s
  const outDur = s => { const len = s.out_s - s.in_s; return s.ramp_to ? len / 2 / s.speed + len / 2 / s.ramp_to : len / s.speed; };
  let tot = segs.reduce((a, s) => a + outDur(s), 0);
  if (tot > 30) segs.forEach(s => { s.out_s = r2(s.in_s + (s.out_s - s.in_s) * 30 / tot); });
  const timeline = layout(segs, outDur);
  // snap transition starts to beats (adjust previous segment's out point)
  const beats = beatGrid(music, timeline.total);
  for (let i = 1; i < segs.length; i++) {
    const t = layout(segs, outDur).starts[i], nb = beats.reduce((x, y) => Math.abs(y - t) < Math.abs(x - t) ? y : x, beats[0]), d = nb - t;
    const p = segs[i - 1], c = clips[p.shot_id];
    if (Math.abs(d) <= 0.3 && Math.abs(d) > 0.02) { const no = r2(p.out_s + d * (p.ramp_to || p.speed)); if (no <= c.duration && no - p.in_s >= 0.8) p.out_s = no; }
  }
  const tl = layout(segs, outDur);
  return { segments: segs, timeline: tl.starts.map((st, i) => ({ shot_id: segs[i].shot_id, start_s: r2(st), end_s: r2(st + tl.durs[i]) })), total: r2(tl.total),
    beat_markers: beats.filter(b => b <= tl.total), music_start_s: r1(clamp(j.music_start_s, 0, 20)), track: music };
}
function layout(segs, outDur) {
  const starts = [], durs = segs.map(outDur); let t = 0;
  segs.forEach((s, i) => { if (i) { const td = s.transition_in.type === 'cut' ? 0 : Math.min(s.transition_in.duration, durs[i] * 0.4, durs[i - 1] * 0.4); s.transition_in.duration = s.transition_in.type === 'cut' ? 0 : r2(td); t -= td; } starts.push(t); t += durs[i]; });
  return { starts, durs, total: t };
}
function mockEdit(ctx) {
  const { shots, clips, qc } = ctx;
  return cleanEdit({ segments: shots.filter(s => clips[s.id]).map((s, i) => { const q = qc.clips.find(c => c.shot_id === s.id);
    return { shot_id: s.id, in_s: q?.best.start_s || 0, out_s: Math.min(q?.best.end_s || 99, (q?.best.start_s || 0) + s.target_s * (s.type === 'reveal' ? 0.8 : 1.3)),
      speed: s.type === 'reveal' ? 0.8 : ['cutting', 'blowdry'].includes(s.type) ? 1.3 : 1, zoom: { type: s.type === 'reveal' ? 'push_in' : i === 1 ? 'punch_in' : 'none', at_s: 0.5, scale: 1.15 },
      transition_in: { type: s.type === 'reveal' ? 'fadewhite' : 'cut', duration: 0.4 } }; }) }, ctx);
}
function breakdownFor(edit, qc) {
  return edit.timeline.map(t => ({ start_s: t.start_s, end_s: t.end_s, what_is_visible: qc.clips.find(c => c.shot_id === t.shot_id)?.what_is_visible || t.shot_id }));
}

// ---------- 5. render ----------
const ffEsc = s => String(s).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
function segFilter(s) {
  const len = s.out_s - s.in_s, f = [];
  const cover = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1';
  let z = '';
  if (s.zoom.type === 'punch_in') z = `(1+${(s.zoom.scale - 1).toFixed(3)}*min(1,max(0,(t-${s.zoom.at_s})/0.25)))`;
  if (s.zoom.type === 'push_in') z = `(1+${(s.zoom.scale - 1).toFixed(3)}*min(1,t/${Math.max(1, len / s.speed).toFixed(2)}))`;
  const zf = z ? `,scale=w='trunc(1080*${z}/2)*2':h='trunc(1920*${z}/2)*2':eval=frame,crop=1080:1920` : '';
  if (s.ramp_to) { const h = (len / 2).toFixed(3);
    return `[0:v]${cover},split[a][b];[a]trim=0:${h},setpts=(PTS-STARTPTS)/${s.speed}[a1];[b]trim=${h},setpts=(PTS-STARTPTS)/${s.ramp_to}[b1];[a1][b1]concat=n=2:v=1:a=0,fps=30${zf},format=yuv420p[v]`; }
  return `[0:v]${cover},setpts=(PTS-STARTPTS)/${s.speed},fps=30${zf},format=yuv420p[v]`;
}

// Explicit human override of the "no finished haircut" QC gate. Requires confirm===true; never silently skips.
function haircutOverride(body, qc, now = new Date()) {
  if (!qc || qc.has_haircut !== false) return null;
  const o = body && body.override_qc;
  if (!o || o.confirm !== true) return null;
  return { gate: 'no_haircut', confirmed: true, statement: 'Salon owner confirmed the finished cut is clearly visible in the real footage.',
    reason: String(o.reason || '').slice(0, 300), by: String(o.by || 'salon owner').slice(0, 80), at: now.toISOString(), qc_overall: qc.overall || '' };
}
module.exports = { haircutOverride, STYLES, MOODS, TRACK_BPM, shotPrompt, cleanShots, mockShots, splitPrompt, cleanSplit, mockSplit, qcPrompt, cleanQC, mockQC, gapReport,
  editPrompt, cleanEdit, mockEdit, breakdownFor, segFilter, ffEsc, beatGrid };
