'use strict';
// M3.1 contextual product B-roll for AI Twin Promo. Off unless PROMO_BROLL_MODE=contextual.
// Default production path (fixed BROLL_PROMPTS.a + countertop still) is unchanged when the flag is off.
// No network of its own: callers inject llm / Runway / ffmpeg. Never call paid providers from tests.
const fs = require('fs'), path = require('path'), { execFile } = require('child_process'), { promisify } = require('util');
const exec = promisify(execFile);
const RWC = require('./runway_client');

const MODE_ENV = 'PROMO_BROLL_MODE';
const MODE_VALUE = 'contextual';
const enabled = (env = process.env) => String(env[MODE_ENV] || '').trim().toLowerCase() === MODE_VALUE;

const TYPES = Object.freeze(['shampoo', 'serum', 'oil', 'mask', 'spray', 'styling cream', 'conditioner', 'leave-in', 'gloss', 'treatment']);
const ALIASES = Object.freeze({
  'styling cream': 'styling cream', 'styling-cream': 'styling cream', cream: 'styling cream', creme: 'styling cream',
  pomade: 'styling cream', gel: 'styling cream', mousse: 'styling cream',
  serum: 'serum', serums: 'serum', pump: 'serum',
  mask: 'mask', masque: 'mask', jar: 'mask',
  oil: 'oil', oils: 'oil',
  spray: 'spray', mist: 'spray', spritz: 'spray',
  shampoo: 'shampoo',
  conditioner: 'conditioner',
  'leave-in': 'leave-in', leavein: 'leave-in', 'leave in': 'leave-in',
  gloss: 'gloss', glaze: 'gloss',
  treatment: 'treatment',
});
const GENERIC = 'generic';
const CLIP_SECONDS = 5;
const MAX_CLIPS = 2;
const LABEL_SSIM_MIN = 0.84; // below this, the label is treated as warped and we fall back to a static push-in
const SURFACE = path.join(__dirname, 'assets', 'broll_countertop.jpg');
// Placement on the 720x1280 marble countertop: base sits on the slab (~y=960), not off the front edge.
const COMPOSE = Object.freeze({ width: 720, height: 1280, maxW: 360, maxH: 500, baseY: 960, shadowAlpha: 0.45, shadowBlur: 12 });

const TYPE_RE = new RegExp('\\b(' + Object.keys(ALIASES).sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');

function normalizeType(s) {
  const t = String(s || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!t) return null;
  if (ALIASES[t]) return ALIASES[t];
  if (TYPES.includes(t)) return t;
  const m = t.match(TYPE_RE);
  return m ? ALIASES[m[1].toLowerCase()] || null : null;
}
function typeFromName(name) { return normalizeType(name); }

function typeFromMeta(product = {}) {
  return normalizeType(product.type) || typeFromName(product.name) || null;
}

// At most one llm/vision call. Prefer the stored type or a name keyword; fall back to "generic".
async function inferType(product = {}, { llm, image, maxCalls = 1 } = {}) {
  const known = typeFromMeta(product);
  if (known) return { type: known, source: 'meta', calls: 0 };
  if (!llm || maxCalls < 1) return { type: GENERIC, source: 'fallback', calls: 0 };
  const typesList = TYPES.join(', ');
  const text = `Classify this hair-salon product as one of: ${typesList}. Reply with the type only, no punctuation. Name: ${product.name || 'unknown'}.`;
  try {
    const raw = await llm({ system: 'You classify salon hair-care products. Reply with a single type word.', effort: 'low', text, ...(image ? { images: [image] } : {}) });
    const t = normalizeType(raw) || typeFromName(String(raw || ''));
    return { type: t || GENERIC, source: t ? 'llm' : 'fallback', calls: 1 };
  } catch {
    return { type: GENERIC, source: 'fallback', calls: 1 };
  }
}

// Product-in-use beats: hands + product + hair texture/lengths only. Bottle stays still or barely moves.
const RULES = 'Only hands, the product, and hair texture or lengths are visible. Do not show a face or a completed style. Do not show a transformation or a comparison.';
const STILL = 'The product stays still or barely moves on the marble counter, label facing the camera and sharp.';
const BEATS = Object.freeze({
  serum: [
    `Close-up of a pump serum bottle standing on a marble salon counter. A hand presses the pump once and a drop of serum lands in the palm. ${STILL} ${RULES}`,
    `Close-up of hands smoothing a drop of serum over hair lengths and mid-lengths, soft window light. The pump bottle remains at the edge of the frame on the counter. ${STILL} ${RULES}`,
  ],
  mask: [
    `Close-up of a cream hair-mask jar on a marble salon counter. Fingers scoop a small amount of mask from the open jar. ${STILL} ${RULES}`,
    `Close-up of hands working a cream mask through hair lengths, mid-lengths only, soft light. The jar stays on the counter at the edge of the frame. ${STILL} ${RULES}`,
  ],
  spray: [
    `Close-up of a spray bottle standing on a marble salon counter. A hand mists the mid-lengths of hair, fine droplets in soft light. ${STILL} ${RULES}`,
    `Close-up of hands lifting hair lengths while a light mist settles on the mid-lengths. The spray bottle remains on the counter, label sharp. ${STILL} ${RULES}`,
  ],
  oil: [
    `Close-up of a dropper oil bottle on a marble salon counter. A hand draws a drop of oil into the palm. ${STILL} ${RULES}`,
    `Close-up of hands smoothing a drop of oil over hair lengths, mid-lengths only. The bottle stays on the counter at the edge of the frame. ${STILL} ${RULES}`,
  ],
  shampoo: [
    `Close-up of a shampoo bottle on a marble salon counter. A hand dispenses a small amount of shampoo into the palm. ${STILL} ${RULES}`,
    `Close-up of hands working a lather through hair lengths at a backwash-style bowl, no face in frame. The bottle remains on the counter. ${STILL} ${RULES}`,
  ],
  'styling cream': [
    `Close-up of a styling-cream jar or tube on a marble salon counter. Fingers take a small amount of cream. ${STILL} ${RULES}`,
    `Close-up of hands smoothing styling cream through hair lengths, mid-lengths only, soft light. The jar stays on the counter. ${STILL} ${RULES}`,
  ],
  conditioner: [
    `Close-up of a conditioner bottle on a marble salon counter. A hand dispenses a small amount into the palm. ${STILL} ${RULES}`,
    `Close-up of hands smoothing conditioner through hair lengths, mid-lengths only. The bottle remains on the counter. ${STILL} ${RULES}`,
  ],
  'leave-in': [
    `Close-up of a leave-in bottle on a marble salon counter. A hand dispenses a small amount into the palm. ${STILL} ${RULES}`,
    `Close-up of hands smoothing leave-in care over hair lengths, mid-lengths only. The bottle stays on the counter. ${STILL} ${RULES}`,
  ],
  gloss: [
    `Close-up of a gloss bottle on a marble salon counter. A hand dispenses a small amount into the palm. ${STILL} ${RULES}`,
    `Close-up of hands smoothing a gloss through hair lengths, mid-lengths only, soft shine. The bottle remains on the counter. ${STILL} ${RULES}`,
  ],
  treatment: [
    `Close-up of a treatment bottle on a marble salon counter. A hand dispenses a small amount into the palm. ${STILL} ${RULES}`,
    `Close-up of hands smoothing a treatment through hair lengths, mid-lengths only. The bottle stays on the counter. ${STILL} ${RULES}`,
  ],
  generic: [
    `Close-up of a hair-care bottle or jar standing on a marble salon counter. A hand dispenses a small amount of product into the palm. ${STILL} ${RULES}`,
    `Close-up of hands smoothing the product over hair lengths and mid-lengths, soft window light. The bottle or jar remains on the counter, label sharp. ${STILL} ${RULES}`,
  ],
});

function checkFn() {
  // Late require so avatar.js can mention contextual beats without a load cycle if it ever imports this file at the top.
  return require('./avatar').checkAll;
}

function cleanBeatPrompt(prompt, checkAll = checkFn()) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const r = checkAll({ broll: [{ prompt: text }] });
  return r.ok ? text : null;
}

// 1-2 beats for this reel. Prefer library beats that match words in the script; always blocklist-checked.
function beatsFor({ type, script, name, count = MAX_CLIPS, checkAll } = {}) {
  const t = normalizeType(type) || typeFromName(name) || GENERIC;
  const library = BEATS[t] || BEATS.generic;
  const s = String(script || '').toLowerCase();
  const scored = library.map((prompt, i) => {
    let n = 0;
    if (/pump|palm|drop|dispens/.test(s) && /pump|drop|dispens|palm/.test(prompt.toLowerCase())) n += 2;
    if (/smooth|lengths|mid-?length|work|through/.test(s) && /smoothing|lengths|mid-lengths/.test(prompt.toLowerCase())) n += 2;
    if (/scoop|jar|mask/.test(s) && /scoop|jar/.test(prompt.toLowerCase())) n += 2;
    if (/mist|spray|spritz/.test(s) && /mist|spray/.test(prompt.toLowerCase())) n += 2;
    return { prompt, i, n };
  });
  scored.sort((a, b) => b.n - a.n || a.i - b.i);
  const out = [];
  for (const row of scored) {
    if (out.length >= Math.min(MAX_CLIPS, Math.max(1, count))) break;
    const prompt = cleanBeatPrompt(row.prompt, checkAll);
    if (prompt) out.push({ id: 'p' + (out.length + 1), type: t, prompt, start_s: 0, end_s: CLIP_SECONDS, duration: CLIP_SECONDS, status: 'planned' });
  }
  if (!out.length) {
    const prompt = cleanBeatPrompt((BEATS.generic[0]), checkAll);
    if (prompt) out.push({ id: 'p1', type: t, prompt, start_s: 0, end_s: CLIP_SECONDS, duration: CLIP_SECONDS, status: 'planned' });
  }
  return out;
}

function draftBrollSchema(ctx = {}) {
  const t = normalizeType(ctx.productType) || typeFromName(ctx.productName);
  if (!t) return null;
  return {
    jsonExample: `{"prompt":"product-in-use beat for a ${t}: only hands, the ${t}, and hair texture or lengths; the bottle or jar stays still; do not show a face or a completed style","start_s":n,"end_s":n}`,
    rules: `Rules: 1-2 product-in-use B-roll beats of 3-5s each, tied to this script (for example a serum pumped into the palm, then smoothed over the lengths; a spray misting the mid-lengths; a mask scooped from a jar with fingers). Show only hands, the ${t}, and hair texture or lengths. Keep the bottle or jar still or barely moving while the hands act. Do not show a face, a completed style, a transformation, or a comparison.`,
  };
}

function plannedClipCount(p, env = process.env) {
  if (!enabled(env)) return 1;
  const n = Array.isArray(p?.broll?.clips) && p.broll.clips.length ? p.broll.clips.length : beatsFor({ type: p?.product?.type, name: p?.product?.name, script: p?.script?.text }).length;
  return Math.min(MAX_CLIPS, Math.max(1, n));
}

function clipEstimate(model = RWC.DEFAULT_MODEL) {
  return RWC.estimateCost({ model, duration: CLIP_SECONDS });
}
function maxPromoUsd(model = RWC.DEFAULT_MODEL) {
  return Math.round(clipEstimate(model).usd * MAX_CLIPS * 100) / 100;
}

function ff(args, { timeout = 120000 } = {}) {
  return exec('ffmpeg', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
}

function dist3(r, g, b, R, G, B) { const dr = r - R, dg = g - G, db = b - B; return Math.sqrt(dr * dr + dg * dg + db * db); }

// Flood-fill a light studio backdrop from the edges so interior cream labels and white caps stay opaque, then crop to the opaque box.
async function cutoutProduct(src, dest, { tight = 10, feather = 18 } = {}) {
  const probe = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src]);
  const [w, h] = String(probe.stdout).trim().split(',').map(Number);
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-frames:v', '1', 'pipe:1'], { encoding: 'buffer', maxBuffer: w * h * 4 + 1024, timeout: 30000 });
  const buf = Buffer.from(stdout);
  if (buf.length < w * h * 4) throw new Error('cutout: short rgba read');
  const at = (x, y) => (y * w + x) * 4;
  const corners = [[2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3]];
  const bg = [0, 0, 0];
  for (const [x, y] of corners) { const i = at(x, y); bg[0] += buf[i]; bg[1] += buf[i + 1]; bg[2] += buf[i + 2]; }
  bg[0] = Math.round(bg[0] / corners.length); bg[1] = Math.round(bg[1] / corners.length); bg[2] = Math.round(bg[2] / corners.length);
  const seen = Buffer.alloc(w * h); // 1 = transparent fill
  const q = [];
  const tryPush = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const id = y * w + x; if (seen[id]) return;
    const i = id * 4;
    if (dist3(buf[i], buf[i + 1], buf[i + 2], bg[0], bg[1], bg[2]) <= tight) { seen[id] = 1; q.push(id); }
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  for (let n = 0; n < q.length; n++) {
    const id = q[n], x = id % w, y = (id - x) / w;
    tryPush(x + 1, y); tryPush(x - 1, y); tryPush(x, y + 1); tryPush(x, y - 1);
  }
  // Feather only the ring of backdrop-similar pixels that touch the fill; do not walk into the product.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const id = y * w + x; if (seen[id]) { buf[id * 4 + 3] = 0; continue; }
    const i = id * 4, d = dist3(buf[i], buf[i + 1], buf[i + 2], bg[0], bg[1], bg[2]);
    if (d >= feather) continue;
    const edge = (x > 0 && seen[id - 1]) || (x + 1 < w && seen[id + 1]) || (y > 0 && seen[id - w]) || (y + 1 < h && seen[id + w]);
    if (edge) buf[i + 3] = Math.max(0, Math.min(255, Math.round(((d - tight) / (feather - tight)) * 255)));
  }
  // Find the solid product body (color well away from the backdrop) and drop the pale studio-shadow puddle around the base.
  const SOLID = 40;
  let minSX = w, maxSX = 0, lastSolid = 0, firstSolid = h;
  const rowSolid = new Array(h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (buf[i + 3] <= 8) continue;
    if (dist3(buf[i], buf[i + 1], buf[i + 2], bg[0], bg[1], bg[2]) <= SOLID) continue;
    rowSolid[y]++; lastSolid = Math.max(lastSolid, y); firstSolid = Math.min(firstSolid, y);
  }
  const band0 = firstSolid + Math.floor((lastSolid - firstSolid) * 0.3);
  const band1 = firstSolid + Math.floor((lastSolid - firstSolid) * 0.65);
  for (let y = band0; y <= band1; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (buf[i + 3] > 8 && dist3(buf[i], buf[i + 1], buf[i + 2], bg[0], bg[1], bg[2]) > SOLID) {
      if (x < minSX) minSX = x; if (x > maxSX) maxSX = x;
    }
  }
  const bodyPad = 8;
  let baseRow = 0;
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = minSX; x <= maxSX; x++) {
      const i = (y * w + x) * 4;
      if (buf[i + 3] > 8 && dist3(buf[i], buf[i + 1], buf[i + 2], bg[0], bg[1], bg[2]) > SOLID) n++;
    }
    if (n > 20) baseRow = y;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; if (buf[i + 3] <= 8) continue;
    if (baseRow && y > baseRow + 2) { buf[i + 3] = 0; continue; }
    if (y >= band1 && (x < minSX - bodyPad || x > maxSX + bodyPad)) buf[i + 3] = 0;
  }
  let x0 = w, y0 = h, x1 = 0, y1 = 0, opaque = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (buf[(y * w + x) * 4 + 3] > 8) {
    opaque++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  if (!opaque) throw new Error('cutout: no opaque pixels (backdrop fill ate the product)');
  const pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const cropped = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) buf.copy(cropped, y * cw * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn('ffmpeg', ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${cw}x${ch}`, '-i', 'pipe:0', '-frames:v', '1', '-update', '1', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('ffmpeg write cutout failed: ' + code)));
    child.stdin.write(cropped);
    child.stdin.end();
  });
  return { file: dest, width: cw, height: ch, box: { x: x0, y: y0, w: cw, h: ch } };
}

// Cut the product off a light studio backdrop (or keep an existing alpha) and stand it on the marble counter with a contact shadow.
async function composeFirstFrame({ productFile, surfaceFile = SURFACE, out, width = COMPOSE.width, height = COMPOSE.height, baseY = COMPOSE.baseY, maxW = COMPOSE.maxW, maxH = COMPOSE.maxH } = {}) {
  if (!productFile || !fs.existsSync(productFile)) throw new Error('product photo is required');
  if (!surfaceFile || !fs.existsSync(surfaceFile)) throw new Error('surface still is required');
  if (!out) throw new Error('compose output path is required');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const cutout = out.replace(/(\.[a-z0-9]+)?$/i, '') + '_cutout.png';
  const cut = await cutoutProduct(productFile, cutout);
  const pw = cut.width, ph = cut.height;
  const scale = Math.min(maxW / (pw || maxW), maxH / (ph || maxH), 1);
  const tw = Math.max(2, Math.round((pw || maxW) * scale) & ~1);
  const th = Math.max(2, Math.round((ph || maxH) * scale) & ~1);
  const x = Math.round((width - tw) / 2);
  const y = Math.round(baseY - th);
  const shH = Math.max(8, Math.round(th * 0.12));
  const shW = Math.round(tw * 1.06);
  const shX = Math.round(x - (shW - tw) / 2);
  const shY = Math.round(baseY - shH * 0.45);
  const blur = COMPOSE.shadowBlur;
  const filter = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[bg]`,
    `[1:v]scale=${tw}:${th}:force_original_aspect_ratio=decrease,format=rgba,split[p][ps]`,
    `[ps]colorchannelmixer=rr=0:gg=0:bb=0:aa=${COMPOSE.shadowAlpha},scale=${shW}:${shH},boxblur=${blur}:1,format=rgba[sh]`,
    `[bg][sh]overlay=${shX}:${shY}[s1]`,
    `[s1][p]overlay=${x}:${y},format=rgb24[out]`,
  ].join(';');
  await ff(['-y', '-i', surfaceFile, '-i', cutout, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', out]);
  const label = {
    x: Math.max(0, Math.round(x + tw * 0.22)),
    y: Math.max(0, Math.round(y + th * 0.34)),
    w: Math.max(8, Math.round(tw * 0.56)),
    h: Math.max(8, Math.round(th * 0.36)),
  };
  return { file: out, cutout, width, height, product: { x, y, w: tw, h: th, baseY }, label };
}

function parseSsim(stderr) {
  const m = String(stderr || '').match(/SSIM.*All:([0-9.]+)/);
  return m ? Number(m[1]) : null;
}

// Compare the label crop on the composed first frame with later frames from a clip. Low SSIM => warped label.
async function labelSimilarity({ firstFrame, other, label }) {
  if (!firstFrame || !other || !fs.existsSync(firstFrame) || !fs.existsSync(other)) throw new Error('labelSimilarity needs two image files');
  const box = label || { x: 200, y: 400, w: 320, h: 200 };
  const crop = `crop=${box.w}:${box.h}:${box.x}:${box.y},format=gray`;
  try {
    await ff(['-i', firstFrame, '-i', other, '-filter_complex', `[0:v]${crop}[a];[1:v]${crop}[b];[a][b]ssim`, '-f', 'null', '-']);
    return { ssim: 1, warped: false, reason: 'ffmpeg succeeded without ssim stats; treat as similar' };
  } catch (e) {
    // ffmpeg ssim writes stats to stderr and exits 0; some builds still throw if no output file. Read stderr either way.
    const ssim = parseSsim(e.stderr || e.stdout || e.message);
    if (ssim == null && !(e.stderr || e.stdout)) throw e;
    if (ssim == null) {
      // retry capturing stderr from a resolved run by using execFile and ignoring exit
      const ssim2 = parseSsim(e.stderr);
      return { ssim: ssim2, warped: ssim2 == null ? false : ssim2 < LABEL_SSIM_MIN, threshold: LABEL_SSIM_MIN };
    }
    return { ssim, warped: ssim < LABEL_SSIM_MIN, threshold: LABEL_SSIM_MIN };
  }
}

async function ssimOnPair(firstFrame, other, label) {
  const box = label || { x: 200, y: 400, w: 320, h: 200 };
  const crop = `crop=${box.w}:${box.h}:${box.x}:${box.y},format=gray`;
  const args = ['-i', firstFrame, '-i', other, '-filter_complex', `[0:v]${crop}[a];[1:v]${crop}[b];[a][b]ssim`, '-f', 'null', '-'];
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // ssim stats live on stderr; a non-zero exit is still useful if stats printed
      const text = String(stderr || '') + String(stdout || '');
      if (parseSsim(text) != null) return resolve({ stdout, stderr: text });
      if (err) return reject(err);
      resolve({ stdout, stderr: text });
    });
  });
  const ssim = parseSsim(stderr || stdout);
  return { ssim, warped: ssim == null ? false : ssim < LABEL_SSIM_MIN, threshold: LABEL_SSIM_MIN };
}

async function extractFrame(video, dest, t = 2.5) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await ff(['-y', '-ss', String(t), '-i', video, '-frames:v', '1', dest]);
  return dest;
}

async function checkLabelWarp({ firstFrame, video, label, times = [1.5, 4.0] } = {}) {
  if (!video || !fs.existsSync(video)) return { warped: false, samples: [] };
  const samples = [];
  let worst = 1;
  for (const t of times) {
    const frame = firstFrame + `.t${t}.png`;
    await extractFrame(video, frame, t);
    const r = await ssimOnPair(firstFrame, frame, label);
    samples.push({ t, ...r, frame });
    if (r.ssim != null && r.ssim < worst) worst = r.ssim;
  }
  return { warped: samples.some(s => s.warped), ssim: worst, threshold: LABEL_SSIM_MIN, samples };
}

async function staticPushIn({ still, dest, duration = CLIP_SECONDS, width = COMPOSE.width, height = COMPOSE.height } = {}) {
  if (!still || !fs.existsSync(still)) throw new Error('push-in needs a still');
  const fps = 30, frames = Math.round(duration * fps);
  const z = `min(1.08,1+0.08*in/${frames})`;
  const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},format=yuv420p`;
  await ff(['-y', '-loop', '1', '-i', still, '-vf', vf, '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', dest]);
  return { file: dest, fallback: 'static_push_in', duration };
}

const CLIP_NAMES = ['broll_a.mp4', 'broll_b.mp4'];

// Contextual Runway clips. Reuses dest files already on disk (re-edits are $0). After a new generate, check the label; if it warped, replace with a static push-in of the real composited photo.
async function buildClips(promo, { rw, dir, rwOpts = {}, log = () => {}, runwayClip, checkWarp = checkLabelWarp, pushIn = staticPushIn } = {}) {
  if (!dir) throw new Error('buildClips needs a work dir');
  fs.mkdirSync(dir, { recursive: true });
  const beats = (promo.beats && promo.beats.length ? promo.beats : beatsFor({ type: promo.type, name: promo.name, script: promo.script })).slice(0, MAX_CLIPS);
  const dur = promo.clipSeconds || CLIP_SECONDS;
  const out = [];
  for (let i = 0; i < beats.length; i++) {
    const dest = path.join(dir, CLIP_NAMES[i]);
    const still = path.join(dir, `broll_${i === 0 ? 'a' : 'b'}_still.png`);
    const composed = promo.skipCompose && fs.existsSync(still)
      ? { file: still, label: promo.labelBoxes && promo.labelBoxes[i] }
      : await composeFirstFrame({ productFile: promo.productFile, surfaceFile: promo.styleAStill || SURFACE, out: still });
    const clipFn = runwayClip || (async ({ dest: d }) => ({ file: d, reused: fs.existsSync(d) }));
    const c = await clipFn({ rw, still: composed.file, prompt: beats[i].prompt, duration: dur, dest, rwOpts, log });
    let fallback = null, warp = null;
    if (!c.reused && c.file && fs.existsSync(c.file)) {
      warp = await checkWarp({ firstFrame: composed.file, video: c.file, label: composed.label });
      if (warp.warped) {
        await pushIn({ still: composed.file, dest, duration: dur });
        fallback = 'static_push_in';
      }
    }
    out.push({
      ...c, file: dest, style: i === 0 ? 'a' : 'b', dur, composite: false,
      prompt: beats[i].prompt, still: composed.file, label: composed.label,
      fallback, warp, reused: !!c.reused,
    });
  }
  return out;
}

module.exports = {
  MODE_ENV, MODE_VALUE, TYPES, GENERIC, CLIP_SECONDS, MAX_CLIPS, LABEL_SSIM_MIN, SURFACE, COMPOSE, CLIP_NAMES, BEATS,
  enabled, normalizeType, typeFromName, typeFromMeta, inferType, beatsFor, cleanBeatPrompt, draftBrollSchema,
  plannedClipCount, clipEstimate, maxPromoUsd, cutoutProduct, composeFirstFrame, parseSsim, ssimOnPair, labelSimilarity,
  extractFrame, checkLabelWarp, staticPushIn, buildClips,
};
