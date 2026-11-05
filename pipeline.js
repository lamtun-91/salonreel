// SalonReel AI pipeline helpers: prompts, mocks, validation, captions
const fs = require('fs'), path = require('path');
const SCRIPT_PROMPT_FILE = path.join(__dirname, 'prompts', 'script_prompt.txt');
const scriptPrompt = () => fs.readFileSync(SCRIPT_PROMPT_FILE, 'utf8').trim();
const MIN_CONF = 0.4;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D\u20E3]/gu;
const noEmoji = s => String(s || '').replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
const r1 = n => Math.round(n * 10) / 10;

// ---- vision ----
const visionSystem = 'You are an expert hairstylist and colorist analysing salon result videos. Reply with JSON only.';
function visionPrompt(stamps, duration) {
  return `These are ${stamps.length} keyframes from a ${duration.toFixed(1)}s salon video, in order. Frame timestamps (seconds): ${stamps.map((t, i) => `#${i + 1}=${t.toFixed(1)}s`).join(', ')}.
Return JSON:
{"has_haircut":boolean (true only if a finished haircut/hairstyle is clearly visible),
 "confidence":0-1,
 "cut":string,"color":string,"length":"Short|Chin|Shoulder|Mid|Long","technique":string,
 "tags":[4-6 short technique tags],"standout":[2-4 standout details],
 "clip_breakdown":[{"start_s":number,"end_s":number,"what_is_visible":string}] covering 0 to ${duration.toFixed(1)} in order, segments based on the frame timestamps (merge frames that show the same thing)}
If no haircut is visible set has_haircut false and leave cut/color/etc empty.`;
}
function cleanLook(look, duration) {
  const l = { ...look };
  l.has_haircut = l.has_haircut !== false && !!l.cut;
  l.confidence = Math.max(0, Math.min(1, +l.confidence || 0));
  if (l.confidence < MIN_CONF) l.has_haircut = false;
  ['tags', 'standout'].forEach(k => l[k] = Array.isArray(l[k]) ? l[k].map(String).slice(0, 8) : []);
  l.clip_breakdown = cleanSegments(l.clip_breakdown, duration, 'what_is_visible');
  return l;
}

// ---- copy ----
const copySystem = 'You write Instagram Reels copy for hair salons. Reply with JSON only.';
function cityTag(c) {
  c = String(c || '').trim(); if (!c) return 'none provided';
  return c.startsWith('#') ? c : '#' + c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '') + 'Hair';
}
function copyPrompt({ look, tone, profile, duration }) {
  const p = profile || {}, d = duration.toFixed(1), none = v => String(v || '').trim() || 'none provided';
  const vars = {
    salon_name: none(p.salon), tone: String(tone || 'luxe').toLowerCase(), brand_notes: none(p.brandNotes),
    stylist_name: none(p.stylist), services: none(p.services), booking_cta: String(p.booking || '').trim() || 'Book via link in bio',
    city_tag: cityTag(p.city), language: String(p.language || '').trim() || 'English',
    clip_breakdown: JSON.stringify((look.clip_breakdown || []).map(({ start_s, end_s, what_is_visible }) => ({ start_s, end_s, what_is_visible }))),
  };
  const filled = scriptPrompt().replace(/\{(\w+)\}/g, (m, k) => k in vars ? vars[k] : m);
  return `${filled}

ADDITIONAL RULES
- Clip duration: ${d}s. Every script line's start_s and end_s must be within 0..${d}, in order, non-overlapping, each at least 1.0s long.
- Script lines: no emoji (emoji in the caption only as the voice allows).
- If the clip breakdown shows no finished haircut, return exactly {"error":"no_haircut"}.`;
}
function cleanSegments(segs, duration, key) {
  if (!Array.isArray(segs)) return [];
  const out = []; let prev = 0;
  segs.map(s => ({ ...s, start_s: +s.start_s, end_s: +s.end_s })).filter(s => isFinite(s.start_s) && isFinite(s.end_s))
    .sort((a, b) => a.start_s - b.start_s).forEach(s => {
      const st = r1(Math.max(prev, Math.min(duration, s.start_s))), en = r1(Math.min(duration, s.end_s));
      if (en - st >= 0.5 && String(s[key] || '').trim()) { out.push({ ...s, start_s: st, end_s: en, [key]: String(s[key]).trim() }); prev = en; }
    });
  return out;
}
function cleanCopy(c, duration) {
  if (c && c.error) return { error: String(c.error) };
  const script = cleanSegments((c.script || []).map(l => typeof l === 'string' ? { text: l } : l).map(l => ({ ...l, text: noEmoji(l.text) })), duration, 'text');
  const hashtags = [...new Set((Array.isArray(c.hashtags) ? c.hashtags : String(c.hashtags || '').split(/\s+/))
    .map(h => '#' + String(h).replace(/^#+/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}_]/gu, '')).filter(h => h.length > 1))].slice(0, 30);
  return { script, caption: String(c.caption || '').slice(0, 2000), hashtags };
}
function autoTime(texts, duration) {
  const n = texts.length || 1, per = duration / n;
  return texts.map((t, i) => ({ start_s: r1(i * per), end_s: r1(Math.min(duration, (i + 1) * per)), text: t }));
}

// ---- mocks ----
const LOOKS = [
  { cut: 'Textured Shag', color: 'Copper Balayage', length: 'Shoulder', technique: 'Razor layering + hand-painted balayage', tags: ['Curtain bangs', 'Razor layering', 'Hand-painted balayage', 'Gloss toner'], standout: ['Soft face-framing movement', 'Warm copper dimension'] },
  { cut: 'Long Butterfly Layers', color: 'Honey Blonde Highlights', length: 'Long', technique: 'Face-framing layers + foilyage', tags: ['Face-framing layers', 'Foilyage', 'Blowout', 'Root smudge'], standout: ['Bouncy volume', 'Seamless root melt'] },
];
function mockLook(duration) {
  const l = LOOKS[Math.random() * LOOKS.length | 0], d = duration, a = r1(d / 3), b = r1(2 * d / 3);
  return { ...l, has_haircut: true, confidence: 0.9, clip_breakdown: [
    { start_s: 0, end_s: a, what_is_visible: 'Front view, face-framing pieces' },
    { start_s: a, end_s: b, what_is_visible: 'Turn to the side showing layers and color' },
    { start_s: b, end_s: r1(d), what_is_visible: 'Back view, full length and finish' }] };
}
function mockCopy(look, tone, p, duration) {
  if (!look || look.has_haircut === false) return { error: 'no_haircut' };
  const salon = p.salon || 'our salon', { cut, color } = look, t = look.tags?.length ? look.tags : ['precision cutting'];
  const by = p.stylist ? ` by ${p.stylist}` : '', book = p.booking || 'Book via link in bio', city = p.city ? ` in ${p.city}` : '';
  const T = {
    luxe: { s: [`A ${cut.toLowerCase()}${by}`, `${color}, hand-finished`, `Crafted with ${t[0].toLowerCase()}`, book],
      caption: `Quiet luxury, in motion. This ${cut.toLowerCase()} with ${color.toLowerCase()}${by} was shaped with ${t[0].toLowerCase()}. ${p.brandNotes ? p.brandNotes + ' ' : ''}\n\n${salon}${city}. ${book}.` },
    fun: { s: ['POV: your hair just got a glow-up', `${cut} energy`, `${color}, obsessed`, book],
      caption: `Okay but LOOK at this ${cut.toLowerCase()} 😍🔥 ${color} + ${t[0].toLowerCase()}${by} = main character vibes. Who's next?? 🙋‍♀️\n\n${salon}${city} — ${book}! 💖` },
    minimal: { s: [cut, color, t.slice(0, 2).join(' · '), salon], caption: `${cut}. ${color}.${by ? '\nStylist: ' + p.stylist + '.' : ''}\n${t.join(' / ')}.\n\n${salon}${city}. ${book}.` },
  }[tone] || {};
  return { script: autoTime(T.s, duration), caption: T.caption, hashtags: [salon, cut, color, p.city || 'SalonLife', 'HairTransformation', 'HairReels'] };
}

// ---- ASS captions with explicit timings ----
const assEsc = s => noEmoji(s).replace(/[{}\\]/g, '').replace(/\n/g, ' ');
const ts = s => { const h = s / 3600 | 0, m = (s % 3600) / 60 | 0, sec = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${sec}`; };
function buildAss({ lines, salon, duration, tone }) {
  const font = tone === 'luxe' ? 'DejaVu Serif' : 'DejaVu Sans';
  let out = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${font},78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,${tone === 'luxe' ? 1 : 0},0,0,100,100,0,0,1,4,3,2,80,80,380,1
Style: Brand,DejaVu Sans,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,2,0,1,3,2,7,70,70,110,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  out += `Dialogue: 0,${ts(0)},${ts(duration)},Brand,,0,0,0,,${assEsc(salon)}\n`;
  for (const l of lines) out += `Dialogue: 1,${ts(l.start_s)},${ts(l.end_s)},Cap,,0,0,0,,{\\fad(250,250)}${assEsc(l.text)}\n`;
  return out;
}
module.exports = { visionSystem, visionPrompt, cleanLook, copySystem, copyPrompt, cleanCopy, cleanSegments, autoTime, mockLook, mockCopy, buildAss, noEmoji };
