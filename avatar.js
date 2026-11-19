'use strict';
// "Your AI Twin" path (M1): templates, prompt blocklist, avatar-library operations (stub data), draft cleaning, approval checks,
// and the stub ffmpeg assembly (slates + captions + brand + mandatory "AI-generated" label + music / no-music).
// Reuses pipeline.js buildAss / cleanSegments / noEmoji / zones (wrapped, never changed) and music.js. No vendor calls here.
const P = require('./pipeline');
const MUSIC = require('./music');

const PATH = 'full_gen_ai';
const SALON_SLUG = 'olya-atelier';
const DEFAULT_SALON = 'Olya Atelier';
const AI_LABEL = 'AI-generated';
const DURATION = { min: 30, max: 45, target: 36 };
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
function cardView(a, lib) {
  return { id: a.id, name: a.name, role: a.role, kind: a.kind, status: a.status, card_status: cardStatus(a.status), sample: a.kind === 'sample',
    label: a.kind === 'sample' ? 'Sample' : a.role === 'owner' ? 'Owner' : 'Stylist', thumbnail: a.thumbnail, preview: a.preview || null,
    selectable: selectable(a), is_default: lib.default_avatar_id === a.id, is_last_used: lib.last_used_avatar_id === a.id, stub: !!a.stub, error: a.error || null };
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
Return JSON only: {"script":"spoken words, ${DURATION.min}-${DURATION.max}s at a natural pace","captions":[{"start_s":n,"end_s":n,"text":"short on-screen line"}],
"broll":[{"prompt":"generic salon atmosphere or process shot (station, dryer, foam, tools, interior) - no people's faces, no finished hairstyle","start_s":n,"end_s":n}],
"product":${hasProduct ? '{"start_s":n,"end_s":n} (when the salon\'s real product photo is shown)' : 'null'},"caption":"Instagram caption","hashtags":["..."]}
Rules: 1-3 B-roll beats of 3-5s each. Captions in order, 1-4s each, punchy, no emoji. Never describe a hair result, a before/after, a client's hair, medical claims, celebrities or minors. End with a booking CTA.`;
}
const r2 = x => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.min(b, Math.max(a, +x || 0));
function estimateDuration(script) { const w = String(script || '').trim().split(/\s+/).filter(Boolean).length; return r2(clamp(w / 2.6, DURATION.min, DURATION.max)); }
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
    tip: `Hi, I'm ${name} from ${salon}. Growing your hair out? You still need trims. Every ten to twelve weeks we take off just the split ends, so the length you keep actually looks healthy. Ask for a dusting, not a cut. Sleep on silk, use heat protectant every time, and book your next trim before you leave. See you soon at ${salon}. Book via the link in bio.`,
    faq: `Hi, I'm ${name} from ${salon}. A question we hear every week: does balayage need toning? Usually a gloss every eight to ten weeks keeps the tone fresh and the shine up. Between visits, a purple shampoo once a week is plenty. Want a plan for your color? Book a consult with us at ${salon}. Link in bio.`,
    promo: `Hi, I'm ${name} from ${salon}. Our gloss and blowout pairing is back for November. Weekday mornings only, while spots last. You get a shine gloss, a deep conditioning rinse, and a smooth blowout in one visit. Bring a friend and you both get a little extra care. Book now through the link in bio.`,
    booking: `Hi, it's ${name} from ${salon}. Quick reminder: holiday weekends fill up fast. If you want color or a fresh trim before December parties, book now so you get the time that works for you. Weekday evenings are open this week. Tap the link in bio and we'll see you soon at ${salon}.`,
  };
  const script = S[template] || S.tip, total = estimateDuration(script);
  const lines = { tip: ['Growing it out? Still trim', 'Every 10-12 weeks', 'Ask for a dusting', 'Silk + heat protectant', 'Book via link in bio'],
    faq: ['Does balayage need toning?', 'Gloss every 8-10 weeks', 'Purple shampoo, once a week', 'Book a color consult', 'Link in bio'],
    promo: ['Gloss + blowout is back', 'Weekday mornings only', 'Shine, care, smooth finish', 'Bring a friend', 'Book via link in bio'],
    booking: ['Holiday weekends fill fast', 'Color or trim before parties?', 'Weekday evenings open', 'Book now', 'Link in bio'] }[template] || [];
  const step = total / lines.length;
  return cleanDraft({ script, captions: lines.map((t, i) => ({ start_s: r2(i * step + 0.2), end_s: r2((i + 1) * step - 0.2), text: t })),
    broll: [{ prompt: 'Slow pan across an empty, softly lit salon styling station with brushes and a hairdryer', start_s: r2(total * 0.3), end_s: r2(total * 0.3 + 4) },
      { prompt: 'Close-up of warm foam lather in a backwash bowl, no faces', start_s: r2(total * 0.6), end_s: r2(total * 0.6 + 4) }],
    product: hasProduct ? { start_s: r2(total * 0.45), end_s: r2(total * 0.45 + 3) } : null,
    caption: `${(TEMPLATES.find(t => t.id === template) || TEMPLATES[0]).name} from ${salon}. Book via link in bio.`, hashtags: ['hairtips', 'salonlife', 'olyaatelier'] }, { hasProduct });
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
// AI label sits top-left below the brand band (brand: centered, top at y=285 ~ 330; captions: bottom box ending y=1230). Always on.
const AI_LABEL_ZONE = { x: 70, topY: 372, size: 34 };
function assTime(t) { const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = (t % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${s}`; }
const assEsc = s => String(s).replace(/[{}\\]/g, '').replace(/\n/g, '\\N');
// wraps pipeline.buildAss (unchanged) with an always-on AI label and optional stub slate text
function buildTwinAss({ lines, salon, duration, tone, slates = [] }) {
  let a = P.buildAss({ lines, salon, duration, tone });
  const styles = `Style: AILabel,DejaVu Sans,${AI_LABEL_ZONE.size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,1,0,3,8,0,7,${AI_LABEL_ZONE.x},60,${AI_LABEL_ZONE.topY},1
Style: Slate,DejaVu Sans,44,&H00F3E3E7,&H00F3E3E7,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,120,120,0,1`;
  a = a.replace(/(\nStyle: Brand[^\n]*)/, `$1\n${styles}`);
  a += `\nDialogue: 2,${assTime(0)},${assTime(duration)},AILabel,,0,0,0,,${AI_LABEL}`;
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

module.exports = { PATH, SALON_SLUG, DEFAULT_SALON, AI_LABEL, AI_LABEL_ZONE, DURATION, TEMPLATES, ROLES, BLOCK, checkText, checkAll, BlockedError,
  cardStatus, selectable, stubSeed, cardView, preselect, newAvatar, advanceStub, draftPrompt, cleanDraft, mockDraft, cleanApproval, estimateDuration,
  buildTwinAss, stubTimeline, stubFfmpegArgs, musicFor, COLORS };
