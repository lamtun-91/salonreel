'use strict';
// M3.1 contextual product B-roll for AI Twin Promo. Off unless PROMO_BROLL_MODE=contextual.
// Default production path (fixed BROLL_PROMPTS.a + countertop still) is unchanged when the flag is off.
// No network of its own: callers inject llm / Runway / ffmpeg. Never call paid providers from tests.
const fs = require('fs'), path = require('path'), os = require('os'), { execFile } = require('child_process'), { promisify } = require('util');
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
const IN_USE_SURFACE = path.join(__dirname, 'assets', 'broll_in_use.jpg');
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

// Fallback beats when the vision writer fails. Index 0 is the product scene; index 1 is the in-use scene.
const STILL = 'The product stays upright and stationary on the marble counter, label facing the camera and sharp.';
function productBeat(detail) {
  return `The camera eases forward as soft window light drifts across ${detail} standing upright on a marble salon counter. ${STILL}`;
}
function inUseBeat(action) {
  return `The camera holds as a stylist's hands ${action}.`;
}
const BEATS = Object.freeze({
  serum: [
    productBeat('a pump serum bottle'),
    inUseBeat('smooth a drop of serum through the mid-lengths of a seated customer\'s hair'),
  ],
  mask: [
    productBeat('a cream hair-mask jar'),
    inUseBeat('work a cream mask through the mid-lengths of a seated customer\'s hair'),
  ],
  spray: [
    productBeat('a spray bottle'),
    inUseBeat('mist the mid-lengths of a seated customer\'s hair'),
  ],
  oil: [
    productBeat('a dropper oil bottle'),
    inUseBeat('smooth a drop of oil through the mid-lengths of a seated customer\'s hair'),
  ],
  shampoo: [
    productBeat('a shampoo bottle'),
    inUseBeat('work a lather through the hair lengths of a seated customer'),
  ],
  'styling cream': [
    productBeat('a styling-cream jar or tube'),
    inUseBeat('smooth styling cream through the mid-lengths of a seated customer\'s hair'),
  ],
  conditioner: [
    productBeat('a conditioner bottle'),
    inUseBeat('smooth conditioner through the mid-lengths of a seated customer\'s hair'),
  ],
  'leave-in': [
    productBeat('a leave-in bottle'),
    inUseBeat('smooth leave-in care through the mid-lengths of a seated customer\'s hair'),
  ],
  gloss: [
    productBeat('a gloss bottle'),
    inUseBeat('smooth a gloss through the mid-lengths of a seated customer\'s hair'),
  ],
  treatment: [
    productBeat('a treatment bottle'),
    inUseBeat('smooth a treatment through the mid-lengths of a seated customer\'s hair'),
  ],
  generic: [
    productBeat('a hair-care bottle or jar'),
    inUseBeat('smooth the product through the mid-lengths of a seated customer\'s hair'),
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

// 1-2 beats for this reel. Scene 1 is always the product still; scene 2 is always in-use on the customer. Always blocklist-checked.
function beatsFor({ type, script, name, count = MAX_CLIPS, checkAll } = {}) {
  const t = normalizeType(type) || typeFromName(name) || GENERIC;
  const library = BEATS[t] || BEATS.generic;
  const scenes = ['product', 'in-use'];
  const out = [];
  const n = Math.min(MAX_CLIPS, Math.max(1, count));
  for (let i = 0; i < n && i < library.length; i++) {
    const prompt = cleanBeatPrompt(library[i], checkAll);
    if (prompt) out.push({ id: 'p' + (out.length + 1), type: t, prompt, start_s: 0, end_s: CLIP_SECONDS, duration: CLIP_SECONDS, status: 'planned', scene: scenes[i] || 'product' });
  }
  if (!out.length) {
    const prompt = cleanBeatPrompt((BEATS.generic[0]), checkAll);
    if (prompt) out.push({ id: 'p1', type: t, prompt, start_s: 0, end_s: CLIP_SECONDS, duration: CLIP_SECONDS, status: 'planned', scene: 'product' });
  }
  return out;
}


// Tung's Runway prompt-writer rules, kept verbatim, plus the required two-scene structure.
const TUNG_PROMPT_RULES = `You write Runway Gen-4.5 image-to-video prompts for salon product B-roll.
Rules:
- Describe ONLY motion: camera movement, subject action, environmental motion.
- Do not re-describe objects already visible in the image.
- Positive phrasing only. Never write "no", "don't", "avoid".
- One scene per clip. Max 2 sentences.
- Structure: "The camera [motion] as [subject/environment action]."
- Keep the product upright and stationary; let light, liquid, or
  environment move instead.
- Motion must not contradict cues in the image.
Return JSON: {"prompt", "duration": 5|10, "ratio": "720:1280",
"rationale"}`;

const PROMPT_SYSTEM = `${TUNG_PROMPT_RULES}

Scenes (exactly two clips per promo):
- Scene 1 (product): Keep the product upright and stationary; let light, liquid, or the environment move instead. The first attached image is this scene's first frame.
- Scene 2 (in-use): A stylist's hands apply the product through the customer's hair lengths. Show only that application. The bottle or jar belongs in scene 1. The second attached image is this scene's first frame, with no bottle or jar in the shot.
Reply with JSON: {"clips":[{"prompt", "duration": 5|10, "ratio": "720:1280", "rationale", "scene": "product"|"in-use"}]} for scene 1 then scene 2.`;

const BROLL_MODEL_ENV = 'RUNWAY_BROLL_MODEL';
const NEGATION_RE = /\b(no|not|don't|dont|do not|never|avoid|without)\b/i;
const hasNegation = (s) => NEGATION_RE.test(String(s || ''));

function sentenceCount(s) {
  const parts = String(s || '').trim().split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(x => /[A-Za-z]/.test(x));
  return parts.length;
}

function defaultParseJSON(s) {
  const text = String(s || '').trim();
  const start = text.indexOf('{') >= 0 && (text.indexOf('[') === -1 || text.indexOf('{') < text.indexOf('[')) ? text.indexOf('{') : text.indexOf('[');
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error('no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

function parsePromptReply(raw, parseJSON = defaultParseJSON) {
  const j = parseJSON(raw);
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.clips)) return j.clips;
  if (j && typeof j.prompt === 'string') return [j];
  throw new Error('unexpected JSON shape');
}

// Default gen4_turbo. gen4.5 only when RUNWAY_BROLL_MODEL requests it and the $1/clip cap (and optional spend ledger remainder) allow a 5s clip.
function brollModel(env = process.env, { ledgerStatus } = {}) {
  const requested = String(env[BROLL_MODEL_ENV] || '').trim() || RWC.DEFAULT_MODEL;
  if (requested === RWC.DEFAULT_MODEL) return RWC.DEFAULT_MODEL;
  if (requested !== 'gen4.5') return RWC.DEFAULT_MODEL;
  const est = RWC.estimateCost({ model: 'gen4.5', duration: CLIP_SECONDS });
  try { RWC.checkCost(est); } catch { return RWC.DEFAULT_MODEL; }
  if (ledgerStatus && ledgerStatus.remaining_usd != null && Number(ledgerStatus.remaining_usd) + 1e-9 < est.usd) return RWC.DEFAULT_MODEL;
  return 'gen4.5';
}

function clampClipDuration(duration, model = RWC.DEFAULT_MODEL) {
  let d = +duration;
  if (d !== 5 && d !== 10) d = CLIP_SECONDS;
  if (d === 10) {
    try { RWC.checkCost(RWC.estimateCost({ model, duration: 10 })); } catch { d = CLIP_SECONDS; }
  }
  return d;
}

function assessWrittenClip(obj, { model, checkAll } = {}) {
  if (!obj || typeof obj.prompt !== 'string' || !String(obj.prompt).trim()) return { ok: false, reason: 'shape' };
  const prompt = String(obj.prompt).replace(/\s+/g, ' ').trim();
  const duration = clampClipDuration(obj.duration, model);
  const ratio = '720:1280';
  const rationale = obj.rationale == null ? '' : String(obj.rationale);
  if (sentenceCount(prompt) < 1 || sentenceCount(prompt) > 2) return { ok: false, reason: 'sentences', prompt, duration, ratio, rationale };
  if (hasNegation(prompt)) return { ok: false, reason: 'negation', prompt, duration, ratio, rationale };
  const cleaned = cleanBeatPrompt(prompt, checkAll);
  if (!cleaned) return { ok: false, reason: 'blocklist', prompt, duration, ratio, rationale };
  return { ok: true, reason: null, prompt: cleaned, duration, ratio, rationale };
}

function toBeat(v, i, { type, model, source }) {
  const scene = v.scene === 'in-use' || v.scene === 'product' ? v.scene : (i === 0 ? 'product' : 'in-use');
  return {
    id: 'p' + (i + 1), type, prompt: v.prompt, start_s: 0, end_s: v.duration, duration: v.duration,
    ratio: v.ratio || '720:1280', rationale: v.rationale || null, model, source, status: 'planned', scene,
  };
}

async function jpegBase64(file) {
  if (!file || !fs.existsSync(file)) return null;
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return fs.readFileSync(file).toString('base64');
  const tmp = `${file}.${process.pid}.${Date.now()}.llm.jpg`;
  try {
    await ff(['-y', '-i', file, '-frames:v', '1', '-q:v', '3', tmp]);
    return fs.existsSync(tmp) ? fs.readFileSync(tmp).toString('base64') : null;
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function promptUserText(ctx, count, extra = '') {
  const lines = [
    `Product name: ${ctx.name || 'unknown'}.`,
    `Product type: ${ctx.type || 'unknown'}.`,
    `Reel script: ${ctx.script || ''}`,
    '',
  ];
  if (count >= 2) {
    lines.push('The first attached image is the product-scene first frame that will be sent to Runway (the product on the counter).');
    lines.push('The second attached image, when present, is the in-use first frame: a stylist\'s hands applying the product through the customer\'s hair lengths. This frame does not include the bottle or jar.');
    lines.push('A further attached image, when present, is the original product photo.');
    lines.push('Write exactly two distinct scenes. Scene 1 is the product scene. Scene 2 is the in-use scene on the customer. Reply with JSON only as {"clips":[{"prompt":"...","duration":5,"ratio":"720:1280","rationale":"...","scene":"product"},{"prompt":"...","duration":5,"ratio":"720:1280","rationale":"...","scene":"in-use"}]}');
  } else {
    lines.push('The first attached image is the composited first frame that will be sent to Runway. The second attached image, when present, is the original product photo.');
    lines.push('Write 1 scene for this promo. Reply with JSON only as {"clips":[{"prompt":"...","duration":5,"ratio":"720:1280","rationale":"...","scene":"product"}]} with exactly 1 clip object, following the system schema.');
  }
  if (extra) lines.push('', extra);
  return lines.join('\n');
}

// Vision LLM writes 1-2 Runway prompts from the composited first frame. On failure / invalid JSON, retry once, then fall back to BEATS.
// A negation-word or blocklist miss also re-prompts once, then falls back.
async function writeRunwayPrompts(ctx = {}, opts = {}) {
  const env = opts.env || process.env;
  const count = Math.min(MAX_CLIPS, Math.max(1, ctx.count || MAX_CLIPS));
  const type = normalizeType(ctx.type) || typeFromName(ctx.name) || GENERIC;
  const model = brollModel(env, { ledgerStatus: opts.ledgerStatus });
  const checkAll = opts.checkAll || checkFn();
  const parseJSON = opts.parseJSON || defaultParseJSON;
  const fallback = () => ({
    clips: beatsFor({ type, name: ctx.name, script: ctx.script, count, checkAll }).map((b, i) => toBeat({ prompt: b.prompt, duration: b.duration, ratio: '720:1280', rationale: null }, i, { type, model, source: 'template' })),
    source: 'template',
    model,
    calls: 0,
  });
  if (typeof opts.llm !== 'function') return fallback();

  let images = Array.isArray(opts.images) ? opts.images.slice() : [];
  if (!images.length) {
    const a = await jpegBase64(ctx.firstFrame);
    if (a) images.push(a);
    if (ctx.inUseFirstFrame && ctx.inUseFirstFrame !== ctx.firstFrame) {
      const u = await jpegBase64(ctx.inUseFirstFrame);
      if (u) images.push(u);
    }
    if (ctx.productFile && ctx.productFile !== ctx.firstFrame && ctx.productFile !== ctx.inUseFirstFrame) {
      const b = await jpegBase64(ctx.productFile);
      if (b) images.push(b);
    }
  }
  if (!images.length) return fallback();

  const call = async (extra) => {
    const raw = await opts.llm({ system: PROMPT_SYSTEM, effort: 'low', images, text: promptUserText(ctx, count, extra) });
    const arr = parsePromptReply(raw, parseJSON);
    if (!Array.isArray(arr) || arr.length < count) throw new Error('expected ' + count + ' clips');
    return arr.slice(0, count);
  };

  const assessAll = (arr) => arr.map(obj => assessWrittenClip(obj, { model, checkAll }));
  const allOk = rows => rows.length === count && rows.every(r => r.ok);

  let calls = 0, rows, reason;
  try {
    calls += 1;
    rows = assessAll(await call());
  } catch {
    try {
      calls += 1;
      rows = assessAll(await call('Your last reply was not valid JSON in the required shape. Reply with JSON only as {"clips":[...]} with exactly ' + count + ' clip objects.'));
    } catch {
      const fb = fallback(); fb.calls = calls; return fb;
    }
  }
  if (!allOk(rows)) {
    reason = (rows.find(r => !r.ok) || {}).reason;
    const hint = reason === 'negation'
      ? 'Your last prompt used a negation word (no, not, don\'t, never, avoid, without). Rewrite with positive phrasing only. Reply with JSON only.'
      : reason === 'blocklist'
        ? 'Your last prompt was blocked by the content rules. Rewrite the motion description. Reply with JSON only.'
        : 'Your last reply did not meet the schema (shape, at most two sentences, ratio 720:1280). Reply with JSON only.';
    try {
      calls += 1;
      rows = assessAll(await call(hint));
    } catch {
      const fb = fallback(); fb.calls = calls; return fb;
    }
  }
  if (!allOk(rows)) {
    const fb = fallback(); fb.calls = calls; return fb;
  }
  return {
    clips: rows.map((r, i) => toBeat(r, i, { type, model, source: 'llm' })),
    source: 'llm',
    model,
    calls,
  };
}

function draftBrollSchema(ctx = {}) {
  const t = normalizeType(ctx.productType) || typeFromName(ctx.productName);
  if (!t) return null;
  return {
    jsonExample: `{"prompt":"product-in-use beat for a ${t}: scene 1 features the ${t} on the counter; scene 2 shows a stylist's hands working the ${t} through hair lengths","start_s":n,"end_s":n}`,
    rules: `Rules: 1-2 product B-roll beats of 3-5s each, tied to this script. Scene 1 features the product on the counter, upright and still. Scene 2 shows a stylist's hands applying the product through the customer's hair lengths. Do not show a completed style, a transformation, or a comparison.`,
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
async function composeFirstFrame({ productFile, surfaceFile = SURFACE, out, width = COMPOSE.width, height = COMPOSE.height, baseY = COMPOSE.baseY, maxW = COMPOSE.maxW, maxH = COMPOSE.maxH, x: xOpt } = {}) {
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
  const x = Math.max(0, Math.min(width - tw, Number.isFinite(+xOpt) ? Math.round(+xOpt) : Math.round((width - tw) / 2)));
  const y = Math.round(baseY - th);
  const shH = Math.max(8, Math.round(th * 0.12));
  const shW = Math.round(tw * 1.06);
  const shX = Math.round(x - (shW - tw) / 2);
  const shY = Math.round(baseY - shH * 0.45);
  const blur = Math.min(COMPOSE.shadowBlur, Math.max(1, Math.floor(Math.min(shW, shH) / 2) - 1));
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

function inUseSurfaceAvailable(file = IN_USE_SURFACE) {
  return !!(file && fs.existsSync(file));
}

// Scene 2 uses the bare in-use still (no product composited). The 9:16 asset is scaled to the 720x1280 first-frame size.
async function prepareInUseFirstFrame({ out, surfaceFile = IN_USE_SURFACE, width = COMPOSE.width, height = COMPOSE.height } = {}) {
  if (!inUseSurfaceAvailable(surfaceFile)) {
    throw new Error('in-use first frame surface is missing (assets/broll_in_use.jpg)');
  }
  if (!out) throw new Error('in-use output path is required');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await ff(['-y', '-i', surfaceFile, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`, '-frames:v', '1', '-update', '1', out]);
  return { file: out, width, height, label: null, product: null };
}

function parseSsim(stderr) {
  const m = String(stderr || '').match(/SSIM.*All:([0-9.]+)/);
  return m ? Number(m[1]) : null;
}

const LABEL_SEARCH = Object.freeze({
  // Search around the original box, and across a scale range, so a camera push-in is followed
  // instead of being scored against a stale crop.
  margin: 220,
  scales: [0.80, 0.86, 0.92, 0.96, 1.00, 1.04, 1.08, 1.12, 1.16, 1.18, 1.20, 1.22, 1.24, 1.28, 1.32, 1.36, 1.42, 1.50, 1.58, 1.66, 1.76],
  downscale: 4,
});

async function probeWxH(file) {
  const probe = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [w, h] = String(probe.stdout).trim().split(',').map(Number);
  if (!(w > 0 && h > 0)) throw new Error('probe failed for ' + file);
  return { w, h };
}

async function readGray(file) {
  const { w, h } = await probeWxH(file);
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-frames:v', '1', 'pipe:1'], { encoding: 'buffer', maxBuffer: w * h + 4096, timeout: 30000 });
  const data = Buffer.from(stdout);
  if (data.length < w * h) throw new Error('short gray read');
  return { w, h, data: data.subarray(0, w * h) };
}

function cropGray(img, box) {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  const ww = Math.max(1, Math.min(w, img.w - x));
  const hh = Math.max(1, Math.min(h, img.h - y));
  const data = Buffer.alloc(ww * hh);
  for (let row = 0; row < hh; row++) {
    img.data.copy(data, row * ww, (y + row) * img.w + x, (y + row) * img.w + x + ww);
  }
  return { w: ww, h: hh, data };
}

function resizeGray(img, nw, nh) {
  nw = Math.max(1, Math.round(nw));
  nh = Math.max(1, Math.round(nh));
  if (nw === img.w && nh === img.h) return img;
  const data = Buffer.alloc(nw * nh);
  const xScale = img.w / nw, yScale = img.h / nh;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(img.h - 1, y * yScale);
    const y0 = Math.floor(sy), y1 = Math.min(img.h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(img.w - 1, x * xScale);
      const x0 = Math.floor(sx), x1 = Math.min(img.w - 1, x0 + 1), fx = sx - x0;
      const a = img.data[y0 * img.w + x0];
      const b = img.data[y0 * img.w + x1];
      const c = img.data[y1 * img.w + x0];
      const d = img.data[y1 * img.w + x1];
      data[y * nw + x] = Math.round(a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy);
    }
  }
  return { w: nw, h: nh, data };
}

function templateStats(tmpl) {
  const n = tmpl.w * tmpl.h;
  let sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) { const v = tmpl.data[i]; sum += v; sum2 += v * v; }
  return { mean: sum / n, varT: sum2 - (sum * sum) / n, n };
}

function nccAt(img, tmpl, stats, x, y) {
  const tw = tmpl.w, th = tmpl.h;
  if (x < 0 || y < 0 || x + tw > img.w || y + th > img.h) return -1;
  let sumI = 0, sumI2 = 0, sumIT = 0;
  for (let row = 0; row < th; row++) {
    const iOff = (y + row) * img.w + x;
    const tOff = row * tw;
    for (let col = 0; col < tw; col++) {
      const iv = img.data[iOff + col];
      const tv = tmpl.data[tOff + col];
      sumI += iv;
      sumI2 += iv * iv;
      sumIT += iv * tv;
    }
  }
  const cov = sumIT - stats.mean * sumI;
  const varI = sumI2 - (sumI * sumI) / stats.n;
  const den = Math.sqrt(Math.max(0, varI) * Math.max(0, stats.varT));
  if (den < 1e-6) return 0;
  return cov / den;
}

function matchTemplate(img, tmpl, box, opts = {}) {
  const margin = opts.margin == null ? LABEL_SEARCH.margin : opts.margin;
  const scales = opts.scales || LABEL_SEARCH.scales;
  const factor = opts.downscale || LABEL_SEARCH.downscale;
  const imgS = resizeGray(img, Math.max(1, Math.floor(img.w / factor)), Math.max(1, Math.floor(img.h / factor)));
  let best = { score: -Infinity, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), scale: 1 };

  function consider(score, x, y, w, h, scale) {
    if (score > best.score) best = { score, x, y, w, h, scale };
  }

  // Always score the original box at scale 1 so an unchanged frame stays put.
  const origX = Math.max(0, Math.min(img.w - Math.round(box.w), Math.round(box.x)));
  const origY = Math.max(0, Math.min(img.h - Math.round(box.h), Math.round(box.y)));
  if (origX + Math.round(box.w) <= img.w && origY + Math.round(box.h) <= img.h) {
    const origT = (Math.round(box.w) === tmpl.w && Math.round(box.h) === tmpl.h) ? tmpl : resizeGray(tmpl, Math.round(box.w), Math.round(box.h));
    consider(nccAt(img, origT, templateStats(origT), origX, origY), origX, origY, origT.w, origT.h, 1);
  }

  for (const scale of scales) {
    const tw = Math.max(4, Math.round(box.w * scale));
    const th = Math.max(4, Math.round(box.h * scale));
    if (tw >= img.w || th >= img.h) continue;
    const tmplScaled = (tw === tmpl.w && th === tmpl.h) ? tmpl : resizeGray(tmpl, tw, th);
    const tmplCoarse = resizeGray(tmplScaled, Math.max(2, Math.floor(tw / factor)), Math.max(2, Math.floor(th / factor)));
    const statsC = templateStats(tmplCoarse);
    const extraX = Math.max(margin, Math.abs(tw - box.w) + 16);
    const extraY = Math.max(margin, Math.abs(th - box.h) + 16);
    const x0 = Math.max(0, Math.floor(box.x - extraX));
    const y0 = Math.max(0, Math.floor(box.y - extraY));
    const x1 = Math.min(img.w - tw, Math.ceil(box.x + extraX));
    const y1 = Math.min(img.h - th, Math.ceil(box.y + extraY));
    const cx0 = Math.max(0, Math.floor(x0 / factor));
    const cy0 = Math.max(0, Math.floor(y0 / factor));
    const cx1 = Math.max(cx0, Math.min(imgS.w - tmplCoarse.w, Math.floor(x1 / factor)));
    const cy1 = Math.max(cy0, Math.min(imgS.h - tmplCoarse.h, Math.floor(y1 / factor)));
    let coarse = { score: -Infinity, cx: cx0, cy: cy0 };
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const sc = nccAt(imgS, tmplCoarse, statsC, cx, cy);
        if (sc > coarse.score) coarse = { score: sc, cx, cy };
      }
    }
    const statsF = templateStats(tmplScaled);
    const pad = factor * 2;
    const fx0 = Math.max(0, coarse.cx * factor - pad);
    const fy0 = Math.max(0, coarse.cy * factor - pad);
    const fx1 = Math.min(img.w - tw, coarse.cx * factor + pad);
    const fy1 = Math.min(img.h - th, coarse.cy * factor + pad);
    for (let y = fy0; y <= fy1; y++) {
      for (let x = fx0; x <= fx1; x++) {
        consider(nccAt(img, tmplScaled, statsF, x, y), x, y, tw, th, scale);
      }
    }
  }
  // Refine scale around the best coarse hit so a push-in that sits between grid steps still aligns.
  if (best.score > -Infinity) {
    const refine = [];
    for (let d = -4; d <= 4; d++) {
      const sc = Math.round((best.scale + d * 0.01) * 100) / 100;
      if (sc >= 0.75 && sc <= 1.85 && !scales.includes(sc) && !refine.includes(sc)) refine.push(sc);
    }
    for (const scale of refine) {
      const tw = Math.max(4, Math.round(box.w * scale));
      const th = Math.max(4, Math.round(box.h * scale));
      if (tw >= img.w || th >= img.h) continue;
      const tmplScaled = resizeGray(tmpl, tw, th);
      const statsF = templateStats(tmplScaled);
      const fx0 = Math.max(0, best.x - 8);
      const fy0 = Math.max(0, best.y - 8);
      const fx1 = Math.min(img.w - tw, best.x + 8);
      const fy1 = Math.min(img.h - th, best.y + 8);
      for (let y = fy0; y <= fy1; y++) {
        for (let x = fx0; x <= fx1; x++) {
          consider(nccAt(img, tmplScaled, statsF, x, y), x, y, tw, th, scale);
        }
      }
    }
  }
  return best;
}

async function locateLabel(firstFrame, other, label, opts = {}) {
  const box = label || { x: 200, y: 400, w: 320, h: 200 };
  const a = await readGray(firstFrame);
  let b = await readGray(other);
  const scaleX = b.w / a.w, scaleY = b.h / a.h;
  if (b.w !== a.w || b.h !== a.h) b = resizeGray(b, a.w, a.h);
  const tmpl = cropGray(a, box);
  const match = matchTemplate(b, tmpl, box, opts);
  return { ...match, srcScaleX: scaleX, srcScaleY: scaleY };
}

async function ssimFiles(a, b) {
  const args = ['-i', a, '-i', b, '-filter_complex', '[0:v]format=gray[a];[1:v]format=gray[b];[a][b]ssim', '-f', 'null', '-'];
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stderr || '') + String(stdout || '');
      if (parseSsim(text) != null) return resolve({ stdout, stderr: text });
      if (err) return reject(err);
      resolve({ stdout, stderr: text });
    });
  });
  const ssim = parseSsim(stderr || stdout);
  return { ssim, warped: ssim == null ? false : ssim < LABEL_SSIM_MIN, threshold: LABEL_SSIM_MIN };
}

async function ssimFixedCrop(firstFrame, other, box) {
  const crop = `crop=${box.w}:${box.h}:${box.x}:${box.y},format=gray`;
  const args = ['-i', firstFrame, '-i', other, '-filter_complex', `[0:v]${crop}[a];[1:v]${crop}[b];[a][b]ssim`, '-f', 'null', '-'];
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stderr || '') + String(stdout || '');
      if (parseSsim(text) != null) return resolve({ stdout, stderr: text });
      if (err) return reject(err);
      resolve({ stdout, stderr: text });
    });
  });
  const ssim = parseSsim(stderr || stdout);
  return { ssim, warped: ssim == null ? false : ssim < LABEL_SSIM_MIN, threshold: LABEL_SSIM_MIN, match: { x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, score: null, tracked: false } };
}

async function ssimAligned(firstFrame, box, other, match) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelssim-'));
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  try {
    const sx = match.srcScaleX || 1, sy = match.srcScaleY || 1;
    const ox = Math.max(0, Math.round(match.x * sx));
    const oy = Math.max(0, Math.round(match.y * sy));
    const ow = Math.max(2, Math.round(match.w * sx));
    const oh = Math.max(2, Math.round(match.h * sy));
    await ff(['-y', '-i', firstFrame, '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y},scale=${box.w}:${box.h},format=gray`, '-frames:v', '1', a]);
    await ff(['-y', '-i', other, '-vf', `crop=${ow}:${oh}:${ox}:${oy},scale=${box.w}:${box.h}:flags=bicubic,format=gray`, '-frames:v', '1', b]);
    return await ssimFiles(a, b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Compare the label crop on the composed first frame with later frames from a clip. Low SSIM => warped label.
async function labelSimilarity({ firstFrame, other, label, track = true } = {}) {
  if (!firstFrame || !other || !fs.existsSync(firstFrame) || !fs.existsSync(other)) throw new Error('labelSimilarity needs two image files');
  return ssimOnPair(firstFrame, other, label, { track });
}

async function ssimOnPair(firstFrame, other, label, opts = {}) {
  const box = label || { x: 200, y: 400, w: 320, h: 200 };
  const track = opts.track !== false;
  if (!track) return ssimFixedCrop(firstFrame, other, box);
  const match = await locateLabel(firstFrame, other, box, opts);
  const compared = await ssimAligned(firstFrame, box, other, match);
  return { ...compared, match: { ...match, tracked: true } };
}

async function extractFrame(video, dest, t = 2.5) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await ff(['-y', '-ss', String(t), '-i', video, '-frames:v', '1', dest]);
  return dest;
}

async function checkLabelWarp({ firstFrame, video, label, times = [1.5, 4.0], track = true } = {}) {
  if (!video || !fs.existsSync(video)) return { warped: false, samples: [] };
  const samples = [];
  let worst = 1;
  for (const t of times) {
    const frame = firstFrame + `.t${t}.png`;
    await extractFrame(video, frame, t);
    const r = await ssimOnPair(firstFrame, frame, label, { track });
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
async function buildClips(promo, opts = {}) {
  const { rw, dir, rwOpts = {}, log = () => {}, runwayClip, checkWarp = checkLabelWarp, pushIn = staticPushIn } = opts;
  if (!dir) throw new Error('buildClips needs a work dir');
  fs.mkdirSync(dir, { recursive: true });
  const env = opts.env || process.env;
  const model = brollModel(env, { ledgerStatus: opts.ledgerStatus });
  const still0 = path.join(dir, 'broll_a_still.png');
  const still1 = path.join(dir, 'broll_b_still.png');
  const composed0 = promo.skipCompose && fs.existsSync(still0)
    ? { file: still0, label: promo.labelBoxes && promo.labelBoxes[0] }
    : await composeFirstFrame({ productFile: promo.productFile, surfaceFile: promo.styleAStill || SURFACE, out: still0 });
  let beats = (promo.beats && promo.beats.length ? promo.beats : []).slice(0, MAX_CLIPS);
  const needsWrite = typeof opts.llm === 'function' && (!beats.length || beats.some(b => b.source !== 'llm' || !b.prompt));
  const willBeTwo = needsWrite || beats.length > 1 || !beats.length;
  let composed1 = null;
  if (willBeTwo) {
    if (promo.skipCompose && fs.existsSync(still1)) composed1 = { file: still1, label: promo.labelBoxes && promo.labelBoxes[1] };
    else composed1 = await prepareInUseFirstFrame({ out: still1 });
  }
  if (needsWrite) {
    const written = await writeRunwayPrompts({
      firstFrame: composed0.file, inUseFirstFrame: composed1 && composed1.file, productFile: promo.productFile,
      name: promo.name, type: promo.type, script: promo.script, count: MAX_CLIPS,
    }, { llm: opts.llm, parseJSON: opts.parseJSON, env, ledgerStatus: opts.ledgerStatus, checkAll: opts.checkAll });
    beats = written.clips;
  }
  if (!beats.length) beats = beatsFor({ type: promo.type, name: promo.name, script: promo.script });
  const out = [];
  for (let i = 0; i < beats.length; i++) {
    const dest = path.join(dir, CLIP_NAMES[i]);
    const still = path.join(dir, `broll_${i === 0 ? 'a' : 'b'}_still.png`);
    let composed = i === 0 ? composed0 : (composed1 || composed0);
    if (i > 0 && composed.file !== still && fs.existsSync(composed.file)) {
      if (!fs.existsSync(still)) fs.copyFileSync(composed.file, still);
      composed = { ...composed, file: still };
    }
    const scene = beats[i].scene || (i === 0 ? 'product' : 'in-use');
    const dur = clampClipDuration(beats[i].duration || promo.clipSeconds || CLIP_SECONDS, beats[i].model || model);
    const clipModel = beats[i].model || model;
    const clipFn = runwayClip || (async ({ dest: d }) => ({ file: d, reused: fs.existsSync(d) }));
    const c = await clipFn({ rw, still: composed.file, prompt: beats[i].prompt, duration: dur, dest, rwOpts, log, model: clipModel });
    let fallback = null, warp = null;
    // Scene 2 has no product label, so skip the SSIM check. Scene 1 keeps the check and the static push-in fallback.
    if (scene !== 'in-use' && !c.reused && c.file && fs.existsSync(c.file)) {
      warp = await checkWarp({ firstFrame: composed.file, video: c.file, label: composed.label });
      if (warp.warped) {
        await pushIn({ still: composed.file, dest, duration: dur });
        fallback = 'static_push_in';
      }
    }
    out.push({
      ...c, file: dest, style: i === 0 ? 'a' : 'b', dur, composite: false,
      prompt: beats[i].prompt, still: composed.file, label: composed.label || null,
      fallback, warp, reused: !!c.reused, rationale: beats[i].rationale || null,
      model: clipModel, source: beats[i].source || null, scene,
    });
  }
  return out;
}

module.exports = {
  MODE_ENV, MODE_VALUE, TYPES, GENERIC, CLIP_SECONDS, MAX_CLIPS, LABEL_SSIM_MIN, SURFACE, IN_USE_SURFACE, COMPOSE, CLIP_NAMES, BEATS,
  TUNG_PROMPT_RULES, PROMPT_SYSTEM, BROLL_MODEL_ENV, NEGATION_RE,
  enabled, normalizeType, typeFromName, typeFromMeta, inferType, beatsFor, cleanBeatPrompt, draftBrollSchema,
  plannedClipCount, clipEstimate, maxPromoUsd, cutoutProduct, composeFirstFrame, inUseSurfaceAvailable, prepareInUseFirstFrame, parseSsim, ssimOnPair, ssimFixedCrop, locateLabel, labelSimilarity,
  extractFrame, checkLabelWarp, staticPushIn, buildClips, LABEL_SEARCH,
  hasNegation, sentenceCount, parsePromptReply, brollModel, clampClipDuration, assessWrittenClip, jpegBase64,
  writeRunwayPrompts, promptUserText,
};
