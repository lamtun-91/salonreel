'use strict';
// "Your AI Twin" path (M1): templates, prompt blocklist, avatar-library operations (stub data), draft cleaning, approval checks,
// and the stub ffmpeg assembly (slates + captions + brand + mandatory "AI-generated" label + music / no-music).
// Reuses pipeline.js buildAss / cleanSegments / noEmoji / zones (wrapped, never changed) and music.js. No vendor calls here.
const P = require('./pipeline');
const MUSIC = require('./music');
const SP = require('./speech');

const PATH = 'full_gen_ai';
const SALON_SLUG = 'olya-atelier';
const DEFAULT_SALON = 'Olya Atelier';
const AI_LABEL = 'AI-generated';
// Twin reels: ~18s (about 55 words at the shared ~3 words/s calibration); 30s hard cap matches the HeyGen cost guard.
const DURATION = { min: 15, max: 30, target: SP.SPEECH.targetSeconds, words: SP.SPEECH.targetWords,
  minWords: 50, maxWords: Math.floor(30 * SP.SPEECH.wordsPerSec * 0.85) }; // maxWords (~76) is the existing prompt cap; it keeps the cost-guard estimate inside 30s / $0.50
const TEMPLATES = [
  { id: 'tip', name: 'Tip', blurb: 'Share one quick hair-care tip.', example: 'A 30s tip: how often should I trim if I am growing my hair out?' },
  { id: 'faq', name: 'FAQ', blurb: 'Answer a question clients ask a lot.', example: 'FAQ: does balayage need toning between appointments, and how long does it last?' },
  { id: 'promo', name: 'Promo', blurb: 'Announce an offer or a new service.', example: 'Promo: our gloss + blowout pairing is back for November, weekday mornings only.' },
  { id: 'booking', name: 'Booking reminder', blurb: 'Remind clients to book ahead.', example: 'Booking reminder: holiday weekends fill fast, book your December color now.' },
];
const ROLES = ['owner', 'stylist'];

// ---------- guardrails: prompt blocklist (script + B-roll), checked before any vendor call ----------
const BLOCK = [
  { rx: /\b(before[\s-]*(and|&|\/)?[\s-]*after|after[\s-]*shot|after\s+photo|transformation\s+reveal|big\s+reveal|the\s+result|results?\s+shot|finished\s+(cut|look|bob|hair(style)?|color|colour)|new\s+(bob|cut|hairstyle|color|colour)\s+(reveal|result))\b/i,
    fix: 'AI Twin reels cannot show a hair result as the salon\'s work. Use the Hair Reveal path with real footage for results; keep B-roll to the salon, tools and atmosphere.' },
  { rx: /\b(my|our|a|the)\s+client'?s?\s+(new\s+)?(hair|bob|cut|color|colour|look)\b/i,
    fix: 'Don\'t describe or generate a client\'s hair. Talk about the topic in general terms, or film the real client in Hair Reveal (with consent).' },
  { rx: /\b(treat(s|ment of)?\s+(hair\s*loss|alopecia|dandruff|psoriasis|dermatitis)|cures?|diagnos\w*|scalp\s+disease|alopecia|clinically\s+proven|medical(ly)?|prescription|heal(s|ing)?\s+(your\s+)?scalp|regrow(s|th)?)\b/i,
    fix: 'No medical or clinical claims. Say what the service feels like or how to care for hair, and suggest seeing a dermatologist for scalp conditions.' },
  { rx: /\b(celebrity|look(s)?\s+like\s+[A-Z][a-z]+|as\s+seen\s+on|famous\s+(singer|actress|actor|star))\b/,
    fix: 'No celebrity likeness or endorsements. Describe the style itself instead.' },
  { rx: /\b(child(ren)?|kids?|minors?|teen(ager)?s?|toddler|baby|babies|little\s+girl|little\s+boy)\b/i,
    fix: 'No minors in AI Twin content.' },
];
function checkText(text, where = 'prompt') {
  const t = String(text || '');
  for (const b of BLOCK) { const m = t.match(b.rx); if (m) return { ok: false, where, match: m[0], fix: b.fix }; }
  return { ok: true };
}
// Check everything that could reach a vendor: brief prompt, spoken script, captions, B-roll prompts.
function checkAll({ prompt, script, captions, broll } = {}) {
  const items = [['prompt', prompt], ['script', script], ...(captions || []).map((c, i) => [`caption ${i + 1}`, c.text]), ...(broll || []).map((b, i) => [`B-roll ${i + 1}`, b.prompt])];
  for (const [w, t] of items) { const r = checkText(t, w); if (!r.ok) return r; }
  return { ok: true };
}
class BlockedError extends Error { constructor(r) { super(`Blocked (${r.where}: "${r.match}"). ${r.fix}`); this.status = 400; this.blocked = r; } }

// ---------- avatar library (pure helpers; storage lives in routes_avatar.js) ----------
const cardStatus = st => (st === 'training' || st === 'pending_consent') ? 'training' : st === 'ready' ? 'ready' : 'failed';
const selectable = a => !!a && a.status === 'ready';
function stubSeed(now = new Date().toISOString()) {
  // M1 stub data: no HeyGen. Thumbnails are neutral initials tiles (never a hairstyle result).
  return [
    { id: 'av_owner01', name: 'Olya', role: 'owner', kind: 'salon', status: 'ready', thumbnail: '/twin/thumb-owner.svg', preview: null, stub: true,
      heygen_avatar_id: null, group_id: null, voice_id: null, consent: { status: 'accepted', url: null, record_ref: 'stub-consent-owner', at: now }, created_at: now, updated: now },
    { id: 'av_stylist1', name: 'Mira', role: 'stylist', kind: 'salon', status: 'training', train_ready_at: null, thumbnail: '/twin/thumb-stylist.svg', preview: null, stub: true,
      heygen_avatar_id: null, group_id: null, voice_id: null, consent: { status: 'pending', url: null, record_ref: null, at: null }, created_at: now, updated: now },
    { id: 'av_sample01', name: 'Studio host', role: 'sample', kind: 'sample', status: 'ready', thumbnail: '/twin/thumb-sample.svg', preview: null, stub: true,
      heygen_avatar_id: null, group_id: null, voice_id: null, consent: null, created_at: now, updated: now },
  ];
}
function cardView(a, lib, opts = {}) {
  return { id: a.id, name: a.name, role: a.role, kind: a.kind, status: a.status, card_status: cardStatus(a.status), sample: a.kind === 'sample',
    label: a.kind === 'sample' ? 'Sample' : a.role === 'owner' ? 'Owner' : 'Stylist', thumbnail: a.thumbnail, preview: a.preview || null,
    selectable: selectable(a), is_default: lib.default_avatar_id === a.id, is_last_used: lib.last_used_avatar_id === a.id,
    stub: Object.prototype.hasOwnProperty.call(opts, 'stub') ? !!opts.stub : !!a.stub, error: a.error || null };
}
// last-used if still ready, else default if ready, else none
function preselect(lib, avatars) {
  const by = Object.fromEntries(avatars.map(a => [a.id, a]));
  if (selectable(by[lib.last_used_avatar_id])) return lib.last_used_avatar_id;
  if (selectable(by[lib.default_avatar_id])) return lib.default_avatar_id;
  return null;
}
function newAvatar({ name, role }, id, now = new Date().toISOString(), trainMs = 8000) {
  const nm = P.noEmoji(String(name || '').trim()).slice(0, 40); if (!nm) throw Object.assign(new Error('Give the avatar a name'), { status: 400 });
  const r = ROLES.includes(role) ? role : 'stylist';
  return { id, name: nm, role: r, kind: 'salon', status: 'training', train_ready_at: new Date(Date.parse(now) + trainMs).toISOString(), stub: true,
    thumbnail: r === 'owner' ? '/twin/thumb-owner.svg' : '/twin/thumb-stylist.svg', preview: null, heygen_avatar_id: null, group_id: null, voice_id: null,
    consent: { status: 'stub', url: null, record_ref: 'stub-' + id, at: null }, created_at: now, updated: now };
}
// stub training: a card created by "+ Add avatar" flips to ready once its train_ready_at passes (no HeyGen in M1)
function advanceStub(a, now = Date.now()) {
  if (a.stub && a.status === 'training' && a.train_ready_at && Date.parse(a.train_ready_at) <= now) { a.status = 'ready'; a.updated = new Date(now).toISOString(); if (a.consent) a.consent.status = 'stub-accepted'; return true; }
  return false;
}

// ---------- draft (script + captions + B-roll plan + product slot) ----------
function draftPrompt({ template, prompt, mood, language, salon, avatar, hasProduct }) {
  const t = TEMPLATES.find(x => x.id === template) || TEMPLATES[0];
  return `You write short talking-head Reels for a hair salon called ${salon}. Template: ${t.name} (${t.blurb}). Brief: ${prompt || t.example}
Speaker: the salon's AI twin "${avatar?.name || 'host'}" (${avatar?.role || 'host'}), speaking to camera. Mood: ${mood}. Language: ${language}.
Return JSON only: {"script":"spoken words, about ${DURATION.words} words (~${DURATION.target}s at a natural pace; at least ${DURATION.minWords}, never over ${DURATION.maxWords} words)","captions":[{"start_s":n,"end_s":n,"text":"short on-screen line"}],
"broll":[{"prompt":"generic salon atmosphere or process shot (station, dryer, foam, tools, interior) - no people's faces, no finished hairstyle","start_s":n,"end_s":n}],
"product":${hasProduct ? '{"start_s":n,"end_s":n} (when the salon\'s real product photo is shown)' : 'null'},"caption":"Instagram caption","hashtags":["..."]}
Rules: 1-3 B-roll beats of 3-5s each. Captions in order, 1-4s each, punchy, no emoji. Never describe a hair result, a before/after, a client's hair, medical claims, celebrities or minors. End with a booking CTA.`;
}
const r2 = x => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.min(b, Math.max(a, +x || 0));
function estimateDuration(script) { return r2(clamp(SP.spokenSeconds(script), DURATION.min, DURATION.max)); }
function expandPrompt(ctx, previous) {
  const n = SP.words(previous);
  return `${draftPrompt(ctx)}

The last script was ${n} words, which is too short. Rewrite the complete spoken script to about ${DURATION.words} words (at least ${DURATION.minWords}, never over ${DURATION.maxWords}) so it runs about ${DURATION.target}s at a natural pace. Keep the same idea, tone, language, and a booking CTA. Return JSON only, same schema.`;
}
// Safe, deterministic sentences used only when an LLM draft is still under the 50-word floor after one re-prompt.
const LENGTH_FILLERS = [
  'A little regular care between visits makes a real difference in how your hair feels day to day.',
  'We are happy to talk through a simple at-home routine that fits your week.',
  'Come see us and we will find a time that works for you.',
  'Please visit us soon so we can take good care of your hair.',
];
function trimScript(text, max = DURATION.maxWords) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  return parts.length <= max ? parts.join(' ') : parts.slice(0, max).join(' ');
}
function expandScript(text, { min = DURATION.minWords, max = DURATION.maxWords } = {}) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (SP.words(t) > max) return trimScript(t, max);
  if (SP.words(t) >= min) return t;
  const ctaRe = /(?:\.\s*)?(?:Book|Tap(?: the link)?|Link in bio)[^]*$/i;
  let head = t, tail = '';
  const m = t.match(ctaRe);
  if (m && m.index > 10) {
    head = t.slice(0, m.index).trim();
    tail = m[0].trim();
    if (head && !/[.!?]$/.test(head)) head += '.';
  }
  let i = 0;
  const joined = () => (head + (tail ? ' ' + tail : '')).replace(/\s+/g, ' ').trim();
  while (SP.words(joined()) < min && i < LENGTH_FILLERS.length * 3) {
    head = (head + ' ' + LENGTH_FILLERS[i % LENGTH_FILLERS.length]).trim();
    i++;
  }
  t = joined();
  if (SP.words(t) > max) t = trimScript(t, max);
  if (SP.words(t) < min) {
    while (SP.words(t) < min) t = (t + ' ' + LENGTH_FILLERS[LENGTH_FILLERS.length - 1]).trim();
    if (SP.words(t) > max) t = trimScript(t, max);
  }
  return t;
}
function applyScriptLength(d, ctx = {}) {
  const text = expandScript(d.script?.text || '');
  return cleanDraft({
    script: text,
    captions: d.script?.captions,
    broll: d.broll?.clips,
    product: d.product_slot ? { start_s: d.product_slot.slot_start_s, end_s: d.product_slot.slot_end_s } : undefined,
    caption: d.copy?.caption,
    hashtags: d.copy?.hashtags,
  }, ctx);
}
// LLM draft with a 50-word floor: one re-prompt if short, then a deterministic expansion. Never returns under minWords.
async function writeAiDraft(ctx, llm, parseJSON) {
  const accept = d => {
    if (!d?.script?.text) return null;
    const r = checkAll({ script: d.script.text, captions: d.script.captions, broll: d.broll.clips });
    return r.ok ? d : null;
  };
  const once = async text => accept(cleanDraft(parseJSON(await llm({ system: 'You write short-form salon video scripts. Reply with JSON only.', effort: 'low', text })), ctx));
  let first = null, second = null;
  try { first = await once(draftPrompt(ctx)); } catch (e) { first = null; }
  if (first && SP.words(first.script.text) >= DURATION.minWords) {
    const d = applyScriptLength(first, ctx); d.mode = 'ai'; return d;
  }
  try { second = await once(expandPrompt(ctx, first?.script?.text || '')); } catch (e) { second = null; }
  if (second && SP.words(second.script.text) >= DURATION.minWords) {
    const d = applyScriptLength(second, ctx); d.mode = 'ai'; return d;
  }
  const base = second || first;
  if (base) { const d = applyScriptLength(base, ctx); d.mode = 'ai'; return d; }
  const d = mockDraft(ctx); d.mode = 'template'; return d;
}
function cleanDraft(j, { hasProduct } = {}) {
  const script = P.noEmoji(String(j.script || '')).slice(0, 1200);
  const total = estimateDuration(script);
  const captions = P.cleanSegments((j.captions || []).map(c => ({ ...c, text: P.noEmoji(c.text).slice(0, 80) })), total, 'text');
  const broll = (Array.isArray(j.broll) ? j.broll : []).slice(0, 3).map((b, i) => { const a = clamp(b.start_s, 0, total - 3), len = clamp((+b.end_s || a + 4) - a, 3, 5);
    return { id: 'b' + (i + 1), prompt: P.noEmoji(String(b.prompt || '')).slice(0, 300), start_s: r2(a), end_s: r2(Math.min(total, a + len)), duration: r2(len), key: null, status: 'planned' }; });
  const product = hasProduct && j.product ? { slot_start_s: r2(clamp(j.product.start_s, 0, total - 2)), slot_end_s: r2(clamp(j.product.end_s, (+j.product.start_s || 0) + 2, total)) } : null;
  return { script: { text: script, captions, approved: false }, broll: { clips: broll }, product_slot: product, total_s: total,
    copy: { caption: String(j.caption || '').slice(0, 2200), hashtags: (Array.isArray(j.hashtags) ? j.hashtags : []).map(h => '#' + String(h).replace(/^#/, '').replace(/[^\w]/g, '')).filter(h => h.length > 1).slice(0, 15) } };
}
function mockDraft({ template, prompt, salon, avatar, hasProduct }) {
  const name = avatar?.name || 'your stylist';
  const S = {
    tip: `Hi, I'm ${name} from ${salon}. Growing your hair out? You still need trims. Every ten to twelve weeks we take off just the split ends, so your length actually looks healthy. Ask for a dusting, not a cut, sleep on silk, and use heat protectant. Book your next trim via the link in bio.`,
    faq: `Hi, I'm ${name} from ${salon}. A question we hear every week: does balayage need toning? Usually a gloss every eight to ten weeks keeps the tone fresh and the shine up. Between visits, purple shampoo once a week is plenty. Want a color plan? Book a consult via the link in bio.`,
    promo: `Hi, I'm ${name} from ${salon}. Our gloss and blowout pairing is back for November, weekday mornings only, while spots last. You get a shine gloss, a deep conditioning rinse, and a smooth blowout in one visit. Bring a friend and you both get extra care. Book now through the link in bio.`,
    booking: `Hi, it's ${name} from ${salon}. Quick reminder: holiday weekends fill up fast. If you want color or a fresh trim before December parties, book now so you get a time that works. Weekday evenings are open this week. Tap the link in bio and we'll see you soon at ${salon}.`,
  };
  const script = S[template] || S.tip, total = estimateDuration(script);
  const lines = { tip: ['Growing it out? Still trim', 'Every 10-12 weeks', 'Ask for a dusting', 'Silk + heat protectant', 'Book via link in bio'],
    faq: ['Does balayage need toning?', 'Gloss every 8-10 weeks', 'Purple shampoo, once a week', 'Book a color consult', 'Link in bio'],
    promo: ['Gloss + blowout is back', 'Weekday mornings only', 'Shine, care, smooth finish', 'Bring a friend', 'Book via link in bio'],
    booking: ['Holiday weekends fill fast', 'Color or trim before parties?', 'Weekday evenings open', 'Book now', 'Link in bio'] }[template] || [];
  const step = total / lines.length;
  const d = cleanDraft({ script, captions: lines.map((t, i) => ({ start_s: r2(i * step + 0.2), end_s: r2((i + 1) * step - 0.2), text: t })),
    broll: [{ prompt: 'Slow pan across an empty, softly lit salon styling station with brushes and a hairdryer', start_s: r2(total * 0.3), end_s: r2(total * 0.3 + 4) },
      { prompt: 'Close-up of warm foam lather in a backwash bowl, no faces', start_s: r2(total * 0.6), end_s: r2(total * 0.6 + 4) }],
    product: hasProduct ? { start_s: r2(total * 0.45), end_s: r2(total * 0.45 + 3) } : null,
    caption: `${(TEMPLATES.find(t => t.id === template) || TEMPLATES[0]).name} from ${salon}. Book via link in bio.`, hashtags: ['hairtips', 'salonlife', 'olyaatelier'] }, { hasProduct });
  return applyScriptLength(d, { hasProduct });
}
// approval payload -> validated script/captions/broll/product (blocklist again)
function cleanApproval(body, p) {
  if (body.approved !== true) throw Object.assign(new Error('Tick "I approve this script" to continue'), { status: 400 });
  const text = P.noEmoji(String(body.script ?? p.script?.text ?? '')).slice(0, 1200);
  if (!text.trim()) throw Object.assign(new Error('The script is empty'), { status: 400 });
  const total = estimateDuration(text);
  const captions = P.cleanSegments((body.captions ?? p.script?.captions ?? []).map(c => ({ ...c, text: P.noEmoji(c.text).slice(0, 80) })), total, 'text');
  const broll = (body.broll ?? p.broll?.clips ?? []).slice(0, 3).map((b, i) => ({ id: b.id || 'b' + (i + 1), prompt: P.noEmoji(String(b.prompt || '')).slice(0, 300),
    start_s: r2(clamp(b.start_s, 0, total - 2)), end_s: r2(clamp(b.end_s, (+b.start_s || 0) + 2, total)), duration: r2(clamp((+b.end_s) - (+b.start_s), 2, 10)), key: null, status: 'planned' }));
  const r = checkAll({ script: text, captions, broll }); if (!r.ok) throw new BlockedError(r);
  return { text, captions, broll, total };
}

// ---------- stub assembly ----------
// Twin layout (1080x1920), top -> bottom. Hair Reveal keeps pipeline.js BRAND_ZONE / CAPTION_ZONE untouched; only the
// Twin ASS restyles the brand and adds the label.
// Both burned-in overlays are per-project toggles, OFF by default (Tung, 2026-11-20); the IG "AI info" reminder at export stays.
//   AI label   (overlays.ai_label): top-left, text 222-256 (box with 8px border ~214-264) - below IG's top UI (~0-200), above the hair
//   captions   : pipeline CAPTION_ZONE, box bottom at y=1230 (always on)
//   brand pill (overlays.brand)   : centred, dark translucent rounded pill 1654-1732 behind the salon name (text ~1670-1716), never on the face
// No product card on avatar segments: the salon's product photo is stored for M3 B-roll only.
const AI_LABEL_ZONE = { x: 70, topY: 222, size: 34 };
const TWIN_BRAND_ZONE = { bottomY: 1716, size: 46 };
const BRAND_PILL = { h: 78, padX: 34, radius: 39, alpha: '80', charW: 0.62, spacing: 4, maxW: 960 }; // alpha 80 hex = ~50% opaque black
function brandPill(salon) {
  const n = [...String(salon || '')].length;
  const w = Math.min(BRAND_PILL.maxW, Math.round(n * (TWIN_BRAND_ZONE.size * BRAND_PILL.charW + BRAND_PILL.spacing) + 2 * BRAND_PILL.padX));
  const h = BRAND_PILL.h, r = Math.min(BRAND_PILL.radius, h / 2), cy = TWIN_BRAND_ZONE.bottomY - TWIN_BRAND_ZONE.size / 2, x0 = Math.round(540 - w / 2), y0 = Math.round(cy - h / 2);
  return { x: x0, y: y0, w, h, r, bottom: y0 + h };
}
// ASS vector drawing of a rounded rectangle (bezier corners), absolute coords via \pos(0,0)
function pillPath({ x, y, w, h, r }) {
  const k = r * 0.5523, X = x + w, Y = y + h, f = v => Math.round(v);
  return `m ${f(x + r)} ${y} l ${f(X - r)} ${y} b ${f(X - r + k)} ${y} ${X} ${f(y + r - k)} ${X} ${f(y + r)} l ${X} ${f(Y - r)} b ${X} ${f(Y - r + k)} ${f(X - r + k)} ${Y} ${f(X - r)} ${Y} `
    + `l ${f(x + r)} ${Y} b ${f(x + r - k)} ${Y} ${x} ${f(Y - r + k)} ${x} ${f(Y - r)} l ${x} ${f(y + r)} b ${x} ${f(y + r - k)} ${f(x + r - k)} ${y} ${f(x + r)} ${y}`;
}
function assTime(t) { const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = (t % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${s}`; }
const assEsc = s => String(s).replace(/[{}\\]/g, '').replace(/\n/g, '\\N');
// wraps pipeline.buildAss (unchanged) with an always-on AI label and optional stub slate text
const DEFAULT_OVERLAYS = Object.freeze({ brand: false, ai_label: false });
const cleanOverlays = (o = {}, prev = DEFAULT_OVERLAYS) => ({ brand: typeof o.brand === 'boolean' ? o.brand : !!prev.brand, ai_label: typeof o.ai_label === 'boolean' ? o.ai_label : !!prev.ai_label });
function buildTwinAss({ lines, salon, duration, tone, slates = [], solidCaptions = false, overlays = DEFAULT_OVERLAYS }) {
  const ov = cleanOverlays(overlays);
  let a = P.buildAss({ lines, salon, duration, tone });
  // Twin brand: bottom band, soft shadow only (the pill gives contrast on white clothing)
  a = a.replace(/\nStyle: Brand,[^\n]*/, `\nStyle: Brand,DejaVu Sans,${TWIN_BRAND_ZONE.size},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,4,0,1,0,1,2,90,90,${1920 - TWIN_BRAND_ZONE.bottomY},1`);
  // live avatar footage is often a bright studio backdrop: make the caption box near-opaque so white text stays legible
  if (solidCaptions) a = a.replace(/(\nStyle: Cap,[^\n]*?)&H50000000,&H50000000/, '$1&H20000000,&H20000000');
  const styles = `Style: AILabel,DejaVu Sans,${AI_LABEL_ZONE.size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,1,0,3,8,0,7,${AI_LABEL_ZONE.x},60,${AI_LABEL_ZONE.topY},1
Style: Slate,DejaVu Sans,44,&H00F3E3E7,&H00F3E3E7,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,120,120,0,1
Style: Pill,DejaVu Sans,20,&H${BRAND_PILL.alpha}000000,&H${BRAND_PILL.alpha}000000,&HFF000000,&HFF000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`;
  a = a.replace(/(\nStyle: Brand[^\n]*)/, `$1\n${styles}`);
  if (ov.ai_label) a += `\nDialogue: 2,${assTime(0)},${assTime(duration)},AILabel,,0,0,0,,${AI_LABEL}`;
  if (!ov.brand) a = a.replace(/\nDialogue: 0,[^,]+,[^,]+,Brand,[^\n]*/, '');
  else if (salon) a = a.replace(/\nDialogue: 0,([^,]+),([^,]+),Brand,/, (m0, st, en) => `\nDialogue: 0,${st},${en},Pill,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\p1}${pillPath(brandPill(salon))}{\\p0}${m0.replace(/^\nDialogue: 0,/, '\nDialogue: 1,')}`);
  for (const s of slates) a += `\nDialogue: 0,${assTime(s.start_s)},${assTime(s.end_s)},Slate,,0,0,0,,${assEsc(s.text)}`;
  return a + '\n';
}
// timeline of stub slates: avatar holds, B-roll windows, product window (product composited from the real photo when present)
function stubTimeline({ total, avatarName, broll = [], product }) {
  const wins = [...broll.map(b => ({ kind: 'broll', a: b.start_s, b: b.end_s, text: `AI B-roll (stub)\n${String(b.prompt).slice(0, 70)}` })),
    ...(product ? [{ kind: 'product', a: product.slot_start_s, b: product.slot_end_s, text: '' }] : [])].sort((x, y) => x.a - y.a);
  const out = []; let t = 0;
  for (const w of wins) { if (w.a > t + 0.05) out.push({ kind: 'avatar', start_s: r2(t), end_s: r2(w.a), text: `AI Twin · ${avatarName} (stub)` });
    const a = Math.max(t, w.a); if (w.b > a) { out.push({ kind: w.kind, start_s: r2(a), end_s: r2(w.b), text: w.text }); t = w.b; } }
  if (t < total - 0.05) out.push({ kind: 'avatar', start_s: r2(t), end_s: r2(total), text: `AI Twin · ${avatarName} (stub)` });
  return out;
}
const COLORS = { avatar: '0x2b2125', broll: '0x5a4650', product: '0xf3e9e4' };
// ffmpeg args for the stub render: 1080x1920 color holds per slate kind, real product photo fit into its window, ASS on top, music or silent bed
function stubFfmpegArgs({ total, timeline, assPath, productFile, musicFile, musicStart = 0, out, fontsdir = '/usr/share/fonts/truetype/dejavu', ffEsc = s => s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'") }) {
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=${COLORS.avatar}:s=1080x1920:r=30:d=${total.toFixed(3)}`];
  let vi = 1, fc = '[0:v]';
  const boxes = timeline.filter(x => x.kind !== 'avatar').map(x => `drawbox=x=0:y=0:w=iw:h=ih:color=${COLORS[x.kind]}:t=fill:enable='between(t,${x.start_s},${x.end_s})'`);
  fc += (boxes.length ? boxes.join(',') : 'null') + '[bg]'; let last = '[bg]';
  const prod = timeline.find(x => x.kind === 'product');
  if (productFile && prod) { args.push('-loop', '1', '-t', total.toFixed(3), '-i', productFile);
    fc += `;[${vi}:v]scale=760:900:force_original_aspect_ratio=decrease,format=rgba[pr];${last}[pr]overlay=(W-w)/2:440:enable='between(t,${prod.start_s},${prod.end_s})'[bp]`; last = '[bp]'; vi++; }
  fc += `;${last}subtitles='${ffEsc(assPath)}':fontsdir=${fontsdir},format=yuv420p[vout]`;
  if (musicFile) { args.push('-ss', String(musicStart), '-i', musicFile); fc += `;[${vi}:a]apad,atrim=0:${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 1).toFixed(3)}:d=1[aout]`; }
  else { args.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo'); fc += `;[${vi}:a]anull[aout]`; }
  args.push('-filter_complex', fc, '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out);
  return args;
}
const musicFor = (track, musicOn) => (musicOn === false || !track || track === 'none') ? null : MUSIC.fileFor(track);

// M2: assemble a HeyGen talking-head (any aspect) into the 1080x1920 reel: cover-crop to 9:16, ASS (brand pill + captions +
// always-on AI label), HeyGen speech kept with the music bed ducked underneath (or speech only when music is off).
// No product photo is composited onto avatar segments (Tung, 2026-11-20); the photo is kept for M3 B-roll.
const MUSIC_UNDER_SPEECH_DB = -20;
// metadata stored with the salon's product photo: kept for future B-roll (M3, Runway), never rendered on the avatar
const PRODUCT_META = Object.freeze({ use: 'broll', milestone: 'M3', provider: 'runway', render_in_avatar: false, status: 'stored_for_broll' });
function twinAssembleArgs({ talking, total, assPath, musicFile, musicStart = 0, out, pushIn = 0, fontsdir = '/usr/share/fonts/truetype/dejavu', ffEsc = s => s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'") }) {
  if (!talking) throw new Error('talking-head file is required');
  const T = (+total).toFixed(3);
  const args = ['-y', '-i', talking];
  let vi = 1;
  const z = Number(pushIn) || 0;
  // Default cover-crop is unchanged when pushIn is 0. When set (typically 0.03–0.05), slowly zoom in over the clip, biased toward the upper frame (face).
  const cover = z > 0
    ? `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,scale='1080*(1+${z}*t/${T})':'1920*(1+${z}*t/${T})':eval=frame,crop=1080:1920:'(iw-1080)/2':'(ih-1920)*0.25',setsar=1`
    : 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30';
  let fc = `[0:v]${cover}[bg]`; let last = '[bg]';
  fc += `;${last}subtitles='${ffEsc(assPath)}':fontsdir=${fontsdir},format=yuv420p[vout]`;
  fc += `;[0:a]aformat=sample_rates=44100:channel_layouts=stereo,apad,atrim=0:${T}[sp]`;
  if (musicFile) { args.push('-ss', String(musicStart), '-i', musicFile);
    fc += `;[${vi}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${MUSIC_UNDER_SPEECH_DB}dB,apad,atrim=0:${T},afade=t=out:st=${Math.max(0, total - 1).toFixed(3)}:d=1[mu];[sp][mu]amix=inputs=2:duration=first:normalize=0[aout]`; }
  else fc += ';[sp]anull[aout]';
  args.push('-filter_complex', fc, '-map', '[vout]', '-map', '[aout]', '-t', T, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-movflags', '+faststart', out);
  return args;
}
// Reel length for a HeyGen clip: the spoken clip's own length, capped at the Twin max.
const twinTotal = (clipDuration, cap = DURATION.max) => r2(Math.max(1, Math.min(cap, +clipDuration || 0)));

// ---------- M3: Promo = avatar segment -> Runway B-roll clip(s) -> product end card ----------
// Prompt (Gen-4 Turbo image_to_video). The still is a clean, people-free salon surface; the clip ends on an empty spot
// before the salon's real product photo appears on the end card. Presenter-holding-product clips are not generated (removed in prod).
const BROLL_PROMPTS = Object.freeze({
  // validated on a live gen4_turbo render (task ba8ca5c9, 2026-11-20): clean counter, no invented objects
  a: 'A slow, smooth push-in toward the empty marble countertop, soft natural light, the counter stays completely clear and empty, no objects appear, photorealistic.',
});
const PROMO_FADE = 0.4;
// Segment order + crossfade offsets. segments: [{kind:'avatar'|'broll'|'endcard', dur}] -> starts, xfade offsets, total
function promoTimeline(segments, fade = PROMO_FADE) {
  if (!segments.length || segments[0].kind !== 'avatar') throw new Error('Promo must start with the avatar segment');
  const ends = segments[segments.length - 1].kind === 'endcard'; if (!ends) throw new Error('Promo must end with the product end card');
  if (segments.slice(1, -1).some(x => x.kind !== 'broll')) throw new Error('Only B-roll clips may sit between the avatar and the end card');
  let t = 0; const out = [];
  segments.forEach((sg, i) => { const start = i === 0 ? 0 : t - fade; out.push({ ...sg, start_s: r2(start), end_s: r2(start + sg.dur), xfade_offset: i === 0 ? null : r2(start) }); t = start + sg.dur; });
  return { segments: out, total: r2(t), fade };
}
const PRODUCT_ON_SURFACE = { w: 520, h: 620, y: 1060, fadeIn: 0.6 };   // style a composite (lower centre, on the empty surface)
const END_CARD = { bg: '0xf3ece6', w: 760, h: 900, y: 420, shadowH: 72, shadowAlpha: 0.5, shadowBlur: 18 }; // soft contact shadow under the product           // product photo end card
function promoAssembleArgs({ avatar, brolls = [], productFile, endCardDur = 2.5, assPath, musicFile, musicStart = 0, out, fade = PROMO_FADE, fontsdir = '/usr/share/fonts/truetype/dejavu',
  ffEsc = s => s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'") }) {
  if (!avatar?.file || !(avatar.dur > 0)) throw new Error('avatar segment is required');
  if (!productFile) throw new Error('product photo is required for the end card');
  const tl = promoTimeline([{ kind: 'avatar', dur: avatar.dur }, ...brolls.map(b => ({ kind: 'broll', dur: b.dur, style: b.style })), { kind: 'endcard', dur: endCardDur }], fade);
  const T = tl.total.toFixed(3), N = s => `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p`;
  const args = ['-y', '-i', avatar.file]; let fc = `[0:v]trim=0:${avatar.dur},setpts=PTS-STARTPTS,${N()}[s0]`; let vi = 1;
  brolls.forEach((b, i) => { args.push('-i', b.file); const bi = vi++;
    fc += `;[${bi}:v]trim=0:${b.dur},setpts=PTS-STARTPTS,${N()}[br${i}]`;
    if (b.composite) { args.push('-loop', '1', '-t', String(b.dur), '-i', productFile); const pi = vi++; const at = Math.max(0, b.dur - (b.compositeLast || 2.2)).toFixed(2);
      const S = { ...PRODUCT_ON_SURFACE, ...(b.surface || {}) }; // per-clip override when the empty spot lands elsewhere
      fc += `;[${pi}:v]scale=${S.w}:${S.h}:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=${at}:d=${S.fadeIn}:alpha=1[pc${i}];[br${i}][pc${i}]overlay=${S.x != null ? `${S.x}-w/2` : '(W-w)/2'}:${S.y}-h/2:enable='gte(t,${at})',format=yuv420p[s${i + 1}]`; }
    else fc += `;[br${i}]null[s${i + 1}]`; });
  args.push('-f', 'lavfi', '-t', String(endCardDur), '-i', `color=c=${END_CARD.bg}:s=1080x1920:r=30`); const bgi = vi++;
  args.push('-loop', '1', '-t', String(endCardDur), '-i', productFile); const ei = vi++;
  const E = brolls.length + 1;
  // end card: product photo centred, with a soft contact shadow under its base (built from the cutout's own alpha, so it follows the silhouette width)
  const SH = END_CARD.shadowH;
  const SB = END_CARD.shadowBlur, S3 = Math.round(SH / 3);
  fc += `;[${ei}:v]scale=${END_CARD.w}:${END_CARD.h}:force_original_aspect_ratio=decrease,format=rgba,split[ep][es]` +
    `;[es]crop=iw:ih*0.04:0:ih*0.96,colorchannelmixer=rr=0:gg=0:bb=0:aa=${END_CARD.shadowAlpha},scale=iw*0.95:${S3},pad=iw+80:${SH}:40:${S3}:black@0,boxblur=${SB}:2:${SB}:2:${SB}:2[esh]` +
    `;[ep]pad=iw+80:ih+${SH}:40:0:black@0,split[pa][pb];[pb]colorchannelmixer=aa=0[blank];[blank][esh]overlay=(W-w)/2:H-${Math.round(SH * 1.5)}:format=rgb[shc];[shc][pa]overlay=0:0:format=rgb[epc]` +
    `;[${bgi}:v][epc]overlay=(W-w)/2:${END_CARD.y}+(${END_CARD.h}+${SH}-h)/2,setsar=1,fps=30,format=yuv420p[s${E}]`;
  let last = '[s0]';
  for (let i = 1; i <= E; i++) { fc += `;${last}[s${i}]xfade=transition=fade:duration=${fade}:offset=${tl.segments[i].xfade_offset}[x${i}]`; last = `[x${i}]`; }
  fc += `;${last}subtitles='${ffEsc(assPath)}':fontsdir=${fontsdir},format=yuv420p[vout]`;
  fc += `;[0:a]atrim=0:${avatar.dur},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,afade=t=out:st=${Math.max(0, avatar.dur - 0.3).toFixed(2)}:d=0.3,apad,atrim=0:${T}[sp]`;
  if (musicFile) { args.push('-ss', String(musicStart), '-i', musicFile); const mi = vi++;
    // music sits under the voice, then comes up for the B-roll and end card
    fc += `;[${mi}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume='if(lt(t,${avatar.dur}),${Math.pow(10, MUSIC_UNDER_SPEECH_DB / 20).toFixed(3)},0.35)':eval=frame,apad,atrim=0:${T},afade=t=out:st=${Math.max(0, tl.total - 1).toFixed(3)}:d=1[mu];[sp][mu]amix=inputs=2:duration=first:normalize=0[aout]`; }
  else fc += ';[sp]anull[aout]';
  args.push('-filter_complex', fc, '-map', '[vout]', '-map', '[aout]', '-t', T, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-movflags', '+faststart', out);
  return { args, timeline: tl };
}

module.exports = { PATH, SALON_SLUG, DEFAULT_SALON, AI_LABEL, AI_LABEL_ZONE, DURATION, TEMPLATES, ROLES, BLOCK, checkText, checkAll, BlockedError,
  cardStatus, selectable, stubSeed, cardView, preselect, newAvatar, advanceStub, draftPrompt, expandPrompt, expandScript, applyScriptLength, writeAiDraft, cleanDraft, mockDraft, cleanApproval, estimateDuration,
  buildTwinAss, stubTimeline, stubFfmpegArgs, musicFor, COLORS, twinAssembleArgs, twinTotal, MUSIC_UNDER_SPEECH_DB, DEFAULT_OVERLAYS, cleanOverlays, TWIN_BRAND_ZONE, BRAND_PILL, brandPill, pillPath, PRODUCT_META, BROLL_PROMPTS, PROMO_FADE, promoTimeline, promoAssembleArgs, PRODUCT_ON_SURFACE, END_CARD };
