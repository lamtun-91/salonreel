// SalonReel Studio: shot list -> guided filming -> QC -> edit plan -> render
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const P = require('./pipeline');
const r1 = n => Math.round(n * 10) / 10, r2 = n => Math.round(n * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, +v || 0));
const SHOT_TYPES = ['before', 'consult', 'sectioning', 'cutting', 'color', 'washing', 'blowdry', 'styling', 'detail', 'reveal'];
// Only true two-image transitions (xfade) or hard cuts. Nothing that fades through a solid colour (fadeblack/fadewhite).
const TRANSITIONS = ['cut', 'fade', 'dissolve', 'slideup', 'slideleft', 'smoothleft', 'smoothup', 'circleopen', 'zoomin', 'wipeleft'];
const TRANSITION_ALIAS = { fadewhite: 'fade', fadeblack: 'fade', fadegrays: 'fade', crossfade: 'fade', xfade: 'fade' };
const normTransition = t => { t = String(t || 'cut').toLowerCase(); t = TRANSITION_ALIAS[t] || t; return TRANSITIONS.includes(t) ? t : 'cut'; };
// Reel styles that only show the finished look: no process shots.
const PROCESS_TYPES = ['before', 'consult', 'sectioning', 'cutting', 'color', 'washing', 'blowdry'];
const FINISHED_TYPES = ['reveal', 'detail', 'styling'];
const styleTypes = style => style === 'Reveal-only' ? FINISHED_TYPES : SHOT_TYPES;
const requiredTypes = () => ['reveal'];
const STYLES = ['Transformation', 'Process', 'Reveal-only', 'Tutorial'];
const MOODS = ['Luxe', 'Fun', 'Minimal'];
const MUSIC = require('./music');
const TRACK_BPM = new Proxy({}, { get: (_, k) => typeof k === 'string' ? MUSIC.bpmFor(k) : undefined });

// ---------- 1. shot list ----------
function shotPrompt({ profile: p = {}, style, mood, music }) {
  return `Plan a 15-30 second Instagram Reel for a hair salon, to be filmed on a phone in the salon today.
Salon: ${p.salon || '-'} | Stylist: ${p.stylist || '-'} | Services: ${p.services || '-'} | City: ${p.city || '-'} | Language: ${p.language || 'English'}
Brand notes: ${p.brandNotes || '-'}
Reel style: ${style}. Mood: ${mood}. Music: ${music} (${TRACK_BPM[music] || 100} bpm).
Return JSON only:
{"concept":"one sentence",
 "shots":[{"id":"s1","name":"short name","type":one of ${JSON.stringify(styleTypes(style))},"framing":"camera angle/distance and orientation (always vertical 9:16)","tips":"one practical filming tip (light, motion, what to capture)","target_s":seconds 2-8}],
 "draft_script":["4-5 short on-screen lines, no emoji, each under 40 chars, first is a hook, last is the booking CTA: ${p.booking || 'Book via link in bio'}"]}
Rules: 4-6 shots in story order; ${style === 'Transformation' ? 'start with a before shot and end with the reveal' : 'end with the reveal'}; total target 15-30s.${style === 'Reveal-only' ? `
Reveal-only: the hair is already finished. Plan ONLY finished-look shots (types ${FINISHED_TYPES.join(', ')}): front reveal, side profile, back/length, movement or texture detail. No before, consult, sectioning, cutting, color, washing or blow-dry shots.` : ''}`;
}
const REVEAL_ONLY_FILL = [
  { name: 'Front reveal', type: 'reveal', framing: 'Front, chest-up, vertical, slow push-in', tips: 'Client faces the window light and turns her head slowly', target_s: 5 },
  { name: 'Side profile', type: 'detail', framing: 'Side profile, head and shoulders, vertical', tips: 'Walk a slow half-circle to show the shape and line', target_s: 4 },
  { name: 'Back and length', type: 'detail', framing: 'Back view, full length of hair, vertical', tips: 'Stylist runs fingers through once to show movement', target_s: 4 },
  { name: 'Final turn', type: 'reveal', framing: 'Front, head-and-shoulders, vertical', tips: 'Client turns to camera and smiles; hold for 2 seconds', target_s: 5 }];
function cleanShots(j, style) {
  const allowed = styleTypes(style);
  let raw = (Array.isArray(j.shots) ? j.shots : []);
  if (style === 'Reveal-only') { // drop process shots the model planned anyway; top up with finished-look shots
    raw = raw.filter(s => !PROCESS_TYPES.includes(s.type));
    for (const f of REVEAL_ONLY_FILL) { if (raw.length >= 4) break; if (!raw.some(s => s.name === f.name)) raw.push(f); }
    if (!raw.some(s => s.type === 'reveal')) raw.push(REVEAL_ONLY_FILL[3]);
  }
  let shots = raw.slice(0, 6).map((s, i) => ({
    id: 's' + (i + 1), name: String(s.name || s.type || 'Shot ' + (i + 1)).slice(0, 40),
    type: allowed.includes(s.type) ? s.type : 'detail', framing: String(s.framing || '').slice(0, 200),
    tips: String(s.tips || '').slice(0, 200), target_s: r1(clamp(s.target_s || 4, 2, 8)) }));
  if (style === 'Reveal-only' && !shots.some(s => s.type === 'reveal')) shots[shots.length - 1].type = 'reveal';
  if (shots.length < 4) throw new Error('AI returned fewer than 4 shots; try again');
  const tot = shots.reduce((a, s) => a + s.target_s, 0);
  if (tot > 30) shots.forEach(s => s.target_s = r1(Math.max(2, s.target_s * 30 / tot)));
  return { concept: String(j.concept || '').slice(0, 300), shots, draft_script: (j.draft_script || []).map(P.noEmoji).filter(Boolean).slice(0, 6) };
}
function mockShots({ profile: p = {}, style }) {
  if (style === 'Reveal-only') return cleanShots({ concept: `Reveal-only reel for ${p.salon || 'the salon'}`, shots: REVEAL_ONLY_FILL,
    draft_script: ['Fresh from the chair', 'The line from the side', 'Movement through the ends', p.booking || 'Book via link in bio'] }, style);
  return cleanShots({ concept: `${style} reel for ${p.salon || 'the salon'}`, shots: [
    { name: 'Before', type: 'before', framing: 'Front, chest-up, phone at eye level', tips: 'Face the window light; client looks into camera', target_s: 3 },
    { name: 'Cutting', type: 'cutting', framing: 'Close-up on hands and scissors, side angle', tips: 'Hold the phone steady with both hands or a tripod', target_s: 4 },
    { name: 'Blow-dry', type: 'blowdry', framing: 'Medium shot, 45 degrees behind', tips: 'Capture movement and volume, avoid the dryer blocking the face', target_s: 4 },
    { name: 'Reveal front', type: 'reveal', framing: 'Front, chest-up, slow push-in', tips: 'Client turns head slowly left to right', target_s: 4 },
    { name: 'Reveal back', type: 'reveal', framing: 'Back view, full length of hair', tips: 'Shake out the hair once for movement', target_s: 3 }],
    draft_script: ['Ready for a change?', 'Precision layers', 'Volume that moves', 'The reveal', p.booking || 'Book via link in bio'] }, style);
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
{"clips":[{"shot_id":"s1","matches_slot":boolean,"what_is_visible":"short description","lighting":"good|dim|harsh","steadiness":"steady|shaky","issues":["short"],"reshoot":boolean,"best_start_s":number,"best_end_s":number,
   "flags":[{"kind":"letterbox|text_overlay|blur|other","start_s":number,"end_s":number}] (seconds within the clip where a problem is visible: black/grey bars, burned-in or garbled text, heavy blur; [] if none)}],
 "has_haircut":boolean (a finished haircut is visible in at least one reveal clip),"overall":"one short sentence, max 15 words"}`;
}
// ---- QC flags that the edit must respect ----
const TEXT_RX = /garbled|illegible|text overlay|burned-in text|on-screen text|watermark|caption text|\btext\b.*(cover|over)/i;
const BAR_RX = /letterbox|pillarbox|black bars?|grey bars?|gray bars?|\bbars\b/i;
function cleanFlags(c, issues, duration) {
  const out = [];
  for (const f of (Array.isArray(c.flags) ? c.flags : [])) {
    const kind = ['letterbox', 'text_overlay', 'blur', 'other'].includes(f.kind) ? f.kind : 'other';
    let a = clamp(f.start_s, 0, duration), b = clamp(f.end_s == null ? duration : f.end_s, 0, duration); if (b < a) [a, b] = [b, a];
    if (b - a >= 0.1) out.push({ kind, start_s: r2(a), end_s: r2(b), source: 'qc' });
  }
  // an issue that names text/bars without a time range counts for the whole clip (QC only samples 3 frames)
  if (issues.some(i => TEXT_RX.test(i)) && !out.some(f => f.kind === 'text_overlay')) out.push({ kind: 'text_overlay', start_s: 0, end_s: r2(duration), source: 'issue' });
  if (issues.some(i => BAR_RX.test(i)) && !out.some(f => f.kind === 'letterbox')) out.push({ kind: 'letterbox', start_s: 0, end_s: r2(duration), source: 'issue' });
  return out;
}
// Time ranges the edit must not use. Letterbox is fixed by cropping, so it is not avoided.
const avoidRanges = q => (q?.flags || []).filter(f => f.kind === 'text_overlay' || f.kind === 'blur').map(f => [f.start_s, f.end_s]);
// largest sub-interval of [a,b] that does not touch any avoid range
// The unflagged stretch of a clip that contains [a,b] (a,b already outside flagged ranges).
function spanAround(a, b, dur, ranges) {
  let lo = 0, hi = dur;
  for (const [x, y] of ranges) { if (y <= a + 0.01) lo = Math.max(lo, y); if (x >= b - 0.01) hi = Math.min(hi, x); }
  return [lo, hi];
}
function freeWindow(a, b, ranges) {
  let parts = [[a, b]];
  for (const [x, y] of ranges) parts = parts.flatMap(([p, q]) => (y <= p || x >= q) ? [[p, q]] : [[p, Math.min(q, x)], [Math.max(p, y), q]].filter(([u, v]) => v - u > 0.01));
  return parts.sort((m, n) => (n[1] - n[0]) - (m[1] - m[0]))[0] || null;
}
// Letterbox detection from per-row luma stats (rows top->bottom, each {mean, sd}) averaged over sampled frames.
function barsFromRows(rows, { maxMean = 70, maxSd = 9, min = 0.02 } = {}) {
  const n = rows.length, flat = r => r.mean <= maxMean && r.sd <= maxSd;
  let t = 0; while (t < n && flat(rows[t])) t++;
  let b = 0; while (b < n - t && flat(rows[n - 1 - b])) b++;
  const top = t / n, bottom = b / n;
  if (top + bottom > 0.6) return null; // whole frame dark/flat: not bars
  const pad = 0.005, crop = { top: top >= min ? r2(top + pad) : 0, bottom: bottom >= min ? r2(bottom + pad) : 0 };
  return crop.top || crop.bottom ? crop : null;
}
// Letterbox / blurred-fill detection on raw gray frames (n frames of W x H). Static bars show either as flat dark rows
// at the edges, or as a straight full-width seam (e.g. a sharp picture over a blurred copy of itself) present in every frame.
function analyzeBars(buf, W, H, n) {
  const rows = [], frac = new Array(H).fill(1);
  for (let y = 0; y < H; y++) { let m = 0, sd = 0;
    for (let k = 0; k < n; k++) { let s1 = 0, s2 = 0; for (let x = 0; x < W; x++) { const v = buf[k * W * H + y * W + x]; s1 += v; s2 += v * v; }
      const mu = s1 / W; m += mu; sd += Math.sqrt(Math.max(0, s2 / W - mu * mu)); }
    rows.push({ mean: m / n, sd: sd / n }); }
  for (let k = 0; k < n; k++) for (let y = 1; y < H - 1; y++) { let c = 0;
    for (let x = 0; x < W; x++) { const i = k * W * H + y * W + x; if (Math.abs(buf[i + W] - buf[i - W]) > 10) c++; }
    frac[y] = Math.min(frac[y], c / W); }
  frac[0] = frac[H - 1] = 0;
  const flat = barsFromRows(rows) || { top: 0, bottom: 0 };
  let top = 0, bottom = 0;
  for (let y = Math.floor(H * 0.02); y <= Math.floor(H * 0.35); y++) if (frac[y] >= 0.7) top = (y + 2) / H;
  for (let y = Math.ceil(H * 0.98); y >= Math.ceil(H * 0.65); y--) if (frac[y] >= 0.7) bottom = 1 - (y - 1) / H;
  const crop = { top: r2(Math.max(flat.top, top)), bottom: r2(Math.max(flat.bottom, bottom)) };
  return crop.top || crop.bottom ? { ...crop, method: top || bottom ? 'seam' : 'flat' } : null;
}
function shortSummary(text, max = 90) {
  let s = String(text || '').trim().split(/(?<=[.!?])\s/)[0].trim();
  if (s.length > max) { s = s.slice(0, max).replace(/[\s,;:]+\S*$/, ''); s = s.replace(/[,;:]$/, '') + '…'; }
  return s;
}
function cleanQC(j, items, metrics) {
  const by = Object.fromEntries((j.clips || []).map(c => [c.shot_id, c]));
  const clips = items.map(({ shot, clip }) => {
    const c = by[shot.id] || {}, m = metrics[shot.id], auto = qcThresholds(m, shot, clip);
    const issues = [...new Set([...(c.issues || []).map(String), ...auto])].slice(0, 6);
    const bs = clamp(c.best_start_s, 0, clip.duration), be = clamp(c.best_end_s || clip.duration, 0, clip.duration);
    const flags = cleanFlags(c, issues, clip.duration);
    if (m.bars) { const lb = flags.find(f => f.kind === 'letterbox'); if (lb) lb.detected = true; else flags.push({ kind: 'letterbox', start_s: 0, end_s: r2(clip.duration), source: 'detector', detected: true }); }
    return { shot_id: shot.id, matches_slot: c.matches_slot !== false, what_is_visible: String(c.what_is_visible || shot.name), flags, crop: m.bars || null,
      lighting: c.lighting || (m.yavg < 45 ? 'dim' : m.yavg > 215 ? 'harsh' : 'good'), steadiness: c.steadiness || (m.ydif > 14 ? 'shaky' : 'steady'),
      metrics: { brightness: Math.round(m.yavg), motion: r1(m.ydif), duration: r1(clip.duration) }, issues,
      reshoot: !!c.reshoot || c.matches_slot === false || m.yavg < 40 || clip.duration < 1,
      best: be - bs >= 1 ? { start_s: r1(bs), end_s: r1(be) } : { start_s: 0, end_s: r1(clip.duration) } };
  });
  const overall = String(j.overall || '');
  return { clips, has_haircut: j.has_haircut !== false, overall, summary: shortSummary(overall) };
}
function mockQC(items, metrics) { return cleanQC({ clips: [], has_haircut: true, overall: 'Demo QC: automatic checks only (brightness, motion, length).' }, items, metrics); }
// A clip is unusable only for hard technical reasons. Framing/action mismatches are advice, not blockers.
const hardFail = c => !c || (c.metrics?.brightness ?? 255) < 40 || (c.metrics?.duration ?? 9) < 1;
function gapReport(shots, clips, qc, style) {
  const missing = shots.filter(s => !clips[s.id]).map(s => ({ shot_id: s.id, name: s.name, issue: 'Not filmed yet' }));
  const reshoot = (qc?.clips || []).filter(c => c.reshoot).map(c => ({ shot_id: c.shot_id, name: shots.find(s => s.id === c.shot_id)?.name, issue: c.issues[0] || 'Does not match the planned shot' }));
  const qcBy = Object.fromEntries((qc?.clips || []).map(c => [c.shot_id, c]));
  // The reveal requirement is met when a reveal slot has real footage that is technically usable and QC saw the finished cut.
  const revealCovered = shots.some(s => requiredTypes(style).includes(s.type) && clips[s.id] && !hardFail(qcBy[s.id]) && qc?.has_haircut !== false
    && (!reshoot.find(r => r.shot_id === s.id) || qc?.has_haircut === true));
  const usable = Object.keys(clips).filter(id => !hardFail(qcBy[id])).length;
  const ready = revealCovered && usable >= 2;
  return { missing, reshoot, ready, required: requiredTypes(style), note: ready ? '' : !revealCovered ? 'A usable reveal shot is required.' : 'At least 2 usable clips are required.' };
}

// ---------- 4. edit plan ----------
// Duration policy: ~18s default, up to ~25s when there is plenty of usable (unflagged) footage, floor ~15s when footage allows,
// hard cap 30s. Length comes only from real footage at the planned speeds; never from extra slow-mo or freeze/hold padding.
const DURATION = { target: 18, stretch: 25, floor: 15, cap: 30 };
function usableSeconds(clips, qc) {
  const qcBy = Object.fromEntries((qc?.clips || []).map(c => [c.shot_id, c]));
  let tot = 0;
  for (const [id, c] of Object.entries(clips || {})) {
    let free = [[0, +c.duration || 0]];
    for (const [x, y] of avoidRanges(qcBy[id])) free = free.flatMap(([p, q]) => (y <= p || x >= q) ? [[p, q]] : [[p, Math.min(q, x)], [Math.max(p, y), q]].filter(([u, v]) => v - u > 0.01));
    tot += free.reduce((a, [p, q]) => a + q - p, 0);
  }
  return r1(tot);
}
function durationPolicy(usable) {
  const max = r1(Math.min(DURATION.stretch, Math.max(DURATION.target, DURATION.target + (usable - 25) * 0.7)));
  return { usable_s: r1(usable), target_s: DURATION.target, max_s: max, floor_s: DURATION.floor, cap_s: DURATION.cap };
}
function beatGrid(track, total) { const step = 60 / (TRACK_BPM[track] || 100); const b = []; for (let t = 0; t <= total + 0.01; t += step) b.push(r2(t)); return b; }
function editPrompt({ shots, clips, qc, mood, music, style }) {
  const pol = durationPolicy(usableSeconds(Object.fromEntries(shots.filter(s => clips[s.id]).map(s => [s.id, clips[s.id]])), qc));
  const usable = shots.filter(s => clips[s.id]).map(s => { const q = qc.clips.find(c => c.shot_id === s.id) || {};
    return { shot_id: s.id, name: s.name, type: s.type, clip_duration_s: r1(clips[s.id].duration), best: q.best, visible: q.what_is_visible, issues: q.issues,
      avoid_ranges_s: avoidRanges(q), cropped_letterbox: !!q.crop }; });
  return `You are a short-form video editor. Build an edit plan for a ${style} hair salon Reel, mood ${mood}, music ${music} at ${TRACK_BPM[music] || 100} bpm (beat every ${(60 / (TRACK_BPM[music] || 100)).toFixed(2)}s).
Available clips: ${JSON.stringify(usable)}
Return JSON only:
{"segments":[{"shot_id":"s1","in_s":number,"out_s":number (within clip),"speed":0.5-2 (1 = normal; use >1 for cutting/blow-dry, slow-mo 0.6-0.8 for reveal),"ramp_to":optional speed for the second half,"zoom":{"type":"none|punch_in|push_in","at_s":seconds into segment,"scale":1.0-1.3},"transition_in":{"type":one of ${JSON.stringify(TRANSITIONS)},"duration":0.2-0.8}}],
 "beat_markers":[seconds on the final timeline where cuts should land],"music_start_s":0-20}
Rules: total about ${pol.target_s}s (usable footage ${pol.usable_s}s; up to ${pol.max_s}s only if there is enough good footage; never over 30s; at least ${pol.floor_s}s when the footage allows). Never slow clips down or hold frames just to reach a length; a shorter reel is fine when footage is thin. Story order; the reveal last and longest; cuts on beats; first segment transition_in is "cut". Never use any part of a clip inside its avoid_ranges_s (garbled text, blur); skip a clip if nothing usable is left. Transitions are crossfades or cuts only.`;
}
// Lengthen a segment by `src` seconds of source footage: first past its out point, then before its in point (within unflagged footage).
function grow(s, src) {
  const o = Math.min(s.max_out, s.out_s + src); src -= o - s.out_s; s.out_s = r2(o);
  if (src > 0.01) s.in_s = r2(Math.max(s.min_in ?? s.in_s, s.in_s - src));
}
function cleanEdit(j, { shots, clips, qc, music }) {
  const segs = [], dropped = [], qcBy = Object.fromEntries((qc?.clips || []).map(c => [c.shot_id, c]));
  for (const s of (Array.isArray(j.segments) ? j.segments : [])) {
    const c = clips[s.shot_id]; if (!c || segs.length >= 8) continue;
    let a = clamp(s.in_s, 0, c.duration), b = clamp(s.out_s || c.duration, 0, c.duration);
    if (b - a < 0.8) { a = 0; b = c.duration; }
    // server-side enforcement of QC flags: trim out flagged ranges, drop the clip if nothing usable is left
    const avoid = avoidRanges(qcBy[s.shot_id]);
    if (avoid.length) {
      let w = freeWindow(a, b, avoid);
      if (!w || w[1] - w[0] < 0.8) w = freeWindow(0, c.duration, avoid);
      if (!w || w[1] - w[0] < 0.8) { dropped.push({ shot_id: s.shot_id, reason: 'QC flagged the whole clip (' + (qcBy[s.shot_id].flags || []).map(f => f.kind).join(', ') + ')' }); continue; }
      [a, b] = w;
    }
    const [lo, lim] = spanAround(a, b, c.duration, avoid); // how far this segment may be extended (both ways) without touching flagged footage
    const speed = r2(clamp(s.speed || 1, 0.5, 2)), ramp_to = s.ramp_to ? r2(clamp(s.ramp_to, 0.5, 2)) : null;
    const zt = ['punch_in', 'push_in'].includes(s.zoom?.type) ? s.zoom.type : 'none';
    const tr = normTransition(s.transition_in?.type);
    segs.push({ shot_id: s.shot_id, in_s: r2(a), out_s: r2(b), min_in: r2(Math.min(a, lo)), max_out: r2(Math.max(b, lim)), speed, ramp_to: ramp_to && ramp_to !== speed ? ramp_to : null,
      zoom: { type: zt, at_s: r2(clamp(s.zoom?.at_s, 0, 10)), scale: r2(clamp(s.zoom?.scale || 1.15, 1, 1.3)) },
      transition_in: { type: segs.length ? tr : 'cut', duration: r2(clamp(s.transition_in?.duration || 0.4, 0.2, 0.8)) } });
  }
  // the AI sometimes returns too few segments (or skips usable clips): fill from the remaining usable clips (story order, reveal last), at normal speed
  const order = Object.fromEntries((shots || []).map((sh, i) => [sh.id, (sh.type === 'reveal' ? 1000 : 0) + i]));
  const fillOne = () => {
    const have = new Set(segs.map(x => x.shot_id));
    for (const sh of shots || []) {
      const c = clips[sh.id]; if (!c || have.has(sh.id) || dropped.some(d => d.shot_id === sh.id)) continue;
      const q = qcBy[sh.id] || {}; if (q.has_haircut === false) continue;
      const w = freeWindow(0, c.duration, avoidRanges(q)); if (!w || w[1] - w[0] < 0.8) continue;
      const pref = q.best && q.best.end_s - q.best.start_s >= 0.8 ? freeWindow(q.best.start_s, q.best.end_s, avoidRanges(q)) : null;
      const [a, b] = pref && pref[1] - pref[0] >= 0.8 ? pref : w;
      const seg = { shot_id: sh.id, in_s: r2(a), out_s: r2(b), min_in: r2(w[0]), max_out: r2(w[1]), speed: 1, ramp_to: null, zoom: { type: 'none', at_s: 0, scale: 1 },
        transition_in: { type: 'fade', duration: 0.4 }, filled: true };
      // insert in story order (before the first planned segment that comes later in the shot list)
      const k = segs.findIndex(x => (order[x.shot_id] ?? 500) > (order[sh.id] ?? 500)); segs.splice(k < 0 ? segs.length : k, 0, seg);
      segs.forEach((x, i) => { if (!i) x.transition_in = { type: 'cut', duration: x.transition_in.duration }; else if (x.transition_in.type === 'cut' && x.filled) x.transition_in.type = 'fade'; });
      return true;
    }
    return false;
  };
  while (segs.length < 2 && fillOne());
  if (segs.length < 2) throw new Error('Edit plan needs at least 2 usable clips' + (dropped.length ? ' (QC removed: ' + dropped.map(d => d.shot_id).join(', ') + ')' : ''));
  const outDur = s => { const len = s.out_s - s.in_s; return s.ramp_to ? len / 2 / s.speed + len / 2 / s.ramp_to : len / s.speed; };
  const pol = durationPolicy(usableSeconds(clips, qc));
  // over the allowed max: trim every clip proportionally (speeds untouched)
  let tot = layout(segs, outDur).total;
  if (tot > pol.max_s) { const k = pol.max_s / tot; segs.forEach(s => { s.out_s = r2(s.in_s + Math.max(0.8, (s.out_s - s.in_s) * k)); }); }
  // under the target: lengthen clips into unused, unflagged footage at their planned speed (reveal first). No slow-mo, no holds.
  // Slow-mo > 1s of screen time per 1s of footage is not used for growth: only clips at speed >= 1 or the reveal may grow.
  for (const s of [...segs].reverse()) { const need = pol.target_s - layout(segs, outDur).total; if (need <= 0.05) break;
    const rate = s.ramp_to || s.speed; if (rate < 1 && s !== segs[segs.length - 1]) continue;
    grow(s, need * rate); }
  // still under the floor with every planned clip at full length: bring in usable clips the planner skipped (real footage, normal speed)
  while (layout(segs, outDur).total < pol.floor_s - 0.05 && segs.length < 8 && fillOne())
    for (const s of [...segs].reverse()) { const need = pol.target_s - layout(segs, outDur).total; if (need <= 0.05) break; if (s.filled) grow(s, need); }
  const timeline = layout(segs, outDur);
  // snap transition starts to beats (adjust previous segment's out point)
  const beats = beatGrid(music, timeline.total);
  for (let i = 1; i < segs.length; i++) {
    const t = layout(segs, outDur).starts[i], nb = beats.reduce((x, y) => Math.abs(y - t) < Math.abs(x - t) ? y : x, beats[0]), d = nb - t;
    const p = segs[i - 1], c = clips[p.shot_id];
    if (Math.abs(d) <= 0.3 && Math.abs(d) > 0.02) { const no = r2(p.out_s + d * (p.ramp_to || p.speed)); if (no <= c.duration && no - p.in_s >= 0.8) p.out_s = no; }
  }
  { const last = segs[segs.length - 1], need = pol.floor_s + 0.05 - layout(segs, outDur).total; // beat snapping may trim a little; top up the reveal tail only
    if (need > 0) grow(last, need * (last.ramp_to || last.speed));
    // still short: let any normal-speed clip give more real footage (never slow-mo)
    for (const s of [...segs].reverse()) { const n2 = pol.floor_s + 0.05 - layout(segs, outDur).total; if (n2 <= 0) break; if ((s.ramp_to || s.speed) >= 1) grow(s, n2 * (s.ramp_to || s.speed)); } }
  if (layout(segs, outDur).total > pol.cap_s) throw new Error('Edit plan over 30s');
  const tl = layout(segs, outDur); const added = segs.filter(x => x.filled).map(x => x.shot_id); segs.forEach(x => { delete x.max_out; delete x.min_in; delete x.filled; });
  return { segments: segs, timeline: tl.starts.map((st, i) => ({ shot_id: segs[i].shot_id, start_s: r2(st), end_s: r2(st + tl.durs[i]) })), total: r2(tl.total),
    beat_markers: beats.filter(b => b <= tl.total), ...musicStart(j.music_start_s, music, tl.starts[tl.starts.length - 1]), track: music,
    duration_policy: pol,
    added_for_length: added, qc_enforced: { dropped, trimmed: segs.filter(x => avoidRanges(qcBy[x.shot_id]).length).map(x => x.shot_id), cropped: segs.filter(x => qcBy[x.shot_id]?.crop).map(x => x.shot_id) } };
}
// Default music start: put the track's drop on the reveal (last clip) start. Beat-aligned excerpts start on a beat, the drop is
// on a beat and the reveal start is snapped to the beat grid, so the result stays on the grid. Falls back to the planner's value.
function musicStart(planned, track, revealStart) {
  const drop = MUSIC.dropFor(track), dur = MUSIC.TRACKS[MUSIC.resolve(track)]?.duration_s || 60, p = 60 / MUSIC.bpmFor(track);
  if (drop != null && track !== 'none') { let ms = drop - revealStart; ms = Math.round(ms / p) * p;
    if (ms >= 0 && ms <= dur - 31) return { music_start_s: r2(ms), music_start_source: 'drop', music_drop_at_s: r2(drop - ms) }; }
  const ms = Math.round(clamp(planned, 0, 20) / p) * p;
  return { music_start_s: r2(ms), music_start_source: 'plan' };
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
      transition_in: { type: s.type === 'reveal' ? 'fade' : 'cut', duration: 0.4 } }; }) }, ctx);
}
// On-screen window of each timeline clip: transition overlaps are split at their midpoint.
function clipWindows(timeline, total) {
  return timeline.map((t, i) => ({ clip: i + 1, shot_id: t.shot_id,
    start_s: r2(i ? (t.start_s + timeline[i - 1].end_s) / 2 : 0), end_s: r2(i < timeline.length - 1 ? (timeline[i + 1].start_s + t.end_s) / 2 : (total ?? t.end_s)) }));
}
function breakdownFor(edit, qc) {
  return clipWindows(edit.timeline, edit.total).map(w => ({ clip: w.clip, start_s: w.start_s, end_s: w.end_s,
    what_is_visible: qc.clips.find(c => c.shot_id === w.shot_id)?.what_is_visible || w.shot_id }));
}
// Snap script lines to the clip actually on screen. Uses line.clip (1-based) when the writer gave it, else max time overlap.
// The last line is the CTA and sits at the end of the final clip. Every line gets >= 1.0s.
function alignOverlays(lines, edit, { minLen = 1.0 } = {}) {
  const wins = clipWindows(edit.timeline, edit.total), n = wins.length; if (!lines?.length || !n) return [];
  const ov = (l, w) => Math.max(0, Math.min(l.end_s, w.end_s) - Math.max(l.start_s, w.start_s));
  const body = lines.length > 1 ? lines.slice(0, -1) : lines, cta = lines.length > 1 ? lines[lines.length - 1] : null;
  let idx = body.map(l => { const k = Math.round(+l.clip); if (k >= 1 && k <= n) return k - 1;
    let best = 0; wins.forEach((w, i) => { if (ov(l, w) > ov(l, wins[best])) best = i; }); return best; });
  for (let i = 1; i < idx.length; i++) if (idx[i] < idx[i - 1]) idx[i] = idx[i - 1]; // keep story order
  const groups = wins.map(() => []); body.forEach((l, i) => groups[idx[i]].push(l));
  if (cta) groups[n - 1].push({ ...cta, cta: true });
  const out = [];
  groups.forEach((g, i) => { if (!g.length) return; const w = wins[i];
    let keep = g; const fit = Math.max(1, Math.floor((w.end_s - w.start_s) / minLen));
    if (keep.length > fit) keep = [...g.filter(x => !x.cta).slice(0, fit - (g.some(x => x.cta) ? 1 : 0)), ...g.filter(x => x.cta)];
    const step = (w.end_s - w.start_s) / keep.length;
    keep.forEach((l, k) => { const s0 = w.start_s + k * step, e0 = s0 + step, lastLine = i === n - 1 && k === keep.length - 1;
      out.push({ text: l.text, start_s: r2(i === 0 && k === 0 ? s0 : s0 + 0.05), end_s: r2(lastLine ? e0 : e0 - 0.05),
      clip: w.clip, shot_id: w.shot_id, ...(l.cta ? { cta: true } : {}) }); });
  });
  return out.filter(l => l.end_s - l.start_s >= 0.5);
}
// Keyframes for caption writing, in FINAL timeline order, taken from the part of each clip that is actually on screen.
// Returns [{clip, shot_id, start_s, end_s, frames:[{on_s, src_s}]}]; src_s is absolute in the source file (src_start + in_s + ...).
function captionFrameStamps(edit, clips, { perClip = 2 } = {}) {
  const wins = clipWindows(edit.timeline, edit.total);
  return wins.map((w, i) => {
    const sg = edit.segments[i], c = clips[sg.shot_id] || {}, tl = edit.timeline[i];
    const len = w.end_s - w.start_s, fr = len < 1.5 || perClip < 2 ? [0.5] : [0.3, 0.75];
    const frames = fr.map(f => { const on = w.start_s + f * len, local = Math.max(0, on - tl.start_s); // seconds into the segment output
      const half = (sg.out_s - sg.in_s) / 2, d1 = half / sg.speed;
      const srcOff = sg.ramp_to ? (local <= d1 ? local * sg.speed : half + (local - d1) * sg.ramp_to) : local * sg.speed;
      return { on_s: r2(on), src_s: r2((+c.src_start || 0) + sg.in_s + Math.min(sg.out_s - sg.in_s - 0.05, srcOff)) }; });
    return { clip: w.clip, shot_id: sg.shot_id, start_s: w.start_s, end_s: w.end_s, frames };
  });
}
// Server-side check of final overlay windows: inside the on-screen clip window, ordered, non-overlapping, >= 1s.
function validateOverlays(lines, edit) {
  const wins = clipWindows(edit.timeline, edit.total), problems = [];
  lines.forEach((l, i) => {
    const w = wins.find(x => x.clip === l.clip);
    if (!w) problems.push(`line ${i + 1}: no clip`); else if (l.start_s < w.start_s - 0.001 || l.end_s > w.end_s + 0.001) problems.push(`line ${i + 1}: outside clip ${l.clip}`);
    if (i && l.start_s < lines[i - 1].end_s - 0.001) problems.push(`line ${i + 1}: overlaps previous`);
    if (l.end_s - l.start_s < 0.999) problems.push(`line ${i + 1}: shorter than 1s`);
  });
  return { ok: !problems.length, problems };
}
// ffmpeg xfade assembly plan: each transition overlaps the two neighbouring segments by d, so total = sum(durs) - sum(d).
function xfadePlan(durs, segments) {
  const ds = durs.map((d, i) => { if (!i) return 0; const tr = segments[i].transition_in || {}; if (normTransition(tr.type) === 'cut') return 0;
    return r2(Math.min(+tr.duration || 0.4, d * 0.4, durs[i - 1] * 0.4)); });
  const pieces = [];
  for (let i = 0; i < durs.length; i++) {
    const din = ds[i], dout = ds[i + 1] || 0;
    if (din > 0) pieces.push({ kind: 'xfade', from: i - 1, to: i, ss: durs[i - 1] - din, dur: din, transition: normTransition(segments[i].transition_in.type) });
    const body = durs[i] - din - dout; if (body > 0.001) pieces.push({ kind: 'body', seg: i, ss: din, dur: body });
  }
  return { ds, pieces, total: r2(durs.reduce((a, b) => a + b, 0) - ds.reduce((a, b) => a + b, 0)) };
}

// ---------- 5. render ----------
const ffEsc = s => String(s).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
function segFilter(s) {
  const len = s.out_s - s.in_s, f = [];
  const k = s.crop || {}, pre = (k.top || k.bottom || k.left || k.right)
    ? `crop=trunc(iw*${(1 - (k.left || 0) - (k.right || 0)).toFixed(4)}/2)*2:trunc(ih*${(1 - (k.top || 0) - (k.bottom || 0)).toFixed(4)}/2)*2:trunc(iw*${(k.left || 0).toFixed(4)}):trunc(ih*${(k.top || 0).toFixed(4)}),` : '';
  const cover = pre + 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1';
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
module.exports = { DURATION, usableSeconds, durationPolicy, musicStart, TRANSITIONS, normTransition, PROCESS_TYPES, cleanFlags, avoidRanges, freeWindow, barsFromRows, analyzeBars, shortSummary, clipWindows, alignOverlays, captionFrameStamps, validateOverlays, xfadePlan, layout, haircutOverride, STYLES, MOODS, TRACK_BPM, shotPrompt, cleanShots, mockShots, splitPrompt, cleanSplit, mockSplit, qcPrompt, cleanQC, mockQC, gapReport,
  editPrompt, cleanEdit, mockEdit, breakdownFor, segFilter, ffEsc, beatGrid };
