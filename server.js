// SalonReel backend: upload -> keyframes -> vision LLM -> copy LLM -> ffmpeg render -> Instagram Reels publish
require('dotenv').config();
const express = require('express'), multer = require('multer');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = +process.env.PORT || 3000;
const D = (...p) => path.join(__dirname, 'data', ...p);
['uploads', 'frames', 'renders', 'music', 'tmp'].forEach(d => fs.mkdirSync(D(d), { recursive: true }));
const JOBS = D('scheduled.json');
const FONT = process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, out, err) => e ? rej(new Error(`${cmd} failed: ${(err || e.message).slice(-800)}`)) : res(out)));
const id = () => crypto.randomBytes(6).toString('hex');

// ---------- config ----------
function cfg() {
  const provider = (process.env.LLM_PROVIDER || 'grok').toLowerCase();
  const llmKey = provider === 'claude' ? process.env.ANTHROPIC_API_KEY : process.env.XAI_API_KEY;
  return {
    provider, llmLive: !!llmKey,
    igLive: !!(process.env.IG_ACCESS_TOKEN && process.env.IG_USER_ID && process.env.PUBLIC_BASE_URL),
    xaiModel: process.env.XAI_MODEL || 'grok-4',
    claudeModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  };
}

// ---------- music (ffmpeg-synthesized placeholders, royalty-free by construction) ----------
const TRACKS = {
  velvet: { label: 'Velvet Hours — synthesized lo-fi pad (placeholder)', expr: "0.18*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.5*t))+0.12*sin(2*PI*277.18*t)+0.10*sin(2*PI*329.63*t)" },
  glow: { label: 'Golden Glow — synthesized upbeat pulse (placeholder)', expr: "(0.2*sin(2*PI*261.63*t)+0.15*sin(2*PI*392*t))*(0.5+0.5*gt(mod(t,0.5),0.25))+0.2*sin(2*PI*65*t)*exp(-12*mod(t,0.5))" },
  silk: { label: 'Salt & Silk — synthesized ambient drone (placeholder)', expr: "0.15*sin(2*PI*174.6*t)+0.1*sin(2*PI*261.6*t+sin(2*PI*0.2*t))+0.08*sin(2*PI*349.2*t)" },
  none: { label: 'No music' },
};
async function ensureMusic() {
  for (const [k, t] of Object.entries(TRACKS)) {
    if (!t.expr) continue;
    const f = D('music', k + '.m4a');
    if (!fs.existsSync(f)) await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `aevalsrc='${t.expr}':s=44100:d=30`, '-af', 'afade=in:d=1,afade=out:st=28:d=2', '-c:a', 'aac', f]);
  }
}
async function ensureSample() {
  const f = D('uploads', 'sample.mp4');
  if (!fs.existsSync(f)) await run('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    'gradients=s=720x1280:d=8:c0=0x6b3a2e:c1=0xc9a46a:c2=0x8b4a3b:c3=0xe8c8a8:speed=0.02,format=yuv420p',
    '-vf', `drawtext=fontfile=${FONT}:text='Sample look':fontsize=64:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`, '-r', '30', '-c:v', 'libx264', '-t', '8', f]);
}
async function probe(f) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', f]));
  return { duration: +j.format.duration || 8, hasAudio: j.streams.some(s => s.codec_type === 'audio') };
}
const videoPath = vid => { if (!/^[\w.-]+$/.test(vid)) throw new Error('bad id'); const f = D('uploads', vid); if (!fs.existsSync(f)) throw new Error('video not found'); return f; };

// ---------- LLM ----------
async function llm({ system, text, images = [] }) {
  const c = cfg();
  if (c.provider === 'claude') {
    const content = [...images.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })), { type: 'text', text }];
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: c.claudeModel, max_tokens: 1500, system, messages: [{ role: 'user', content }] }) });
    const j = await r.json(); if (!r.ok) throw new Error('Claude: ' + JSON.stringify(j.error || j));
    return j.content.map(x => x.text || '').join('');
  }
  const content = [...images.map(b64 => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'high' } })), { type: 'text', text }];
  const r = await fetch('https://api.x.ai/v1/chat/completions', { method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.XAI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model: c.xaiModel, messages: [{ role: 'system', content: system }, { role: 'user', content }] }) });
  const j = await r.json(); if (!r.ok) throw new Error('Grok: ' + JSON.stringify(j.error || j));
  return j.choices[0].message.content;
}
const parseJSON = s => JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));

// ---------- mocks ----------
const LOOKS = [
  { cut: 'Textured Shag', color: 'Copper Balayage', length: 'Shoulder', technique: 'Razor layering + hand-painted balayage', tags: ['Curtain bangs', 'Razor layering', 'Hand-painted balayage', 'Gloss toner'], standout: ['Soft face-framing movement', 'Warm copper dimension'] },
  { cut: 'Long Butterfly Layers', color: 'Honey Blonde Highlights', length: 'Long', technique: 'Face-framing layers + foilyage', tags: ['Face-framing layers', 'Foilyage', 'Blowout', 'Root smudge'], standout: ['Bouncy volume', 'Seamless root melt'] },
];
function mockCopy(look, tone, salon) {
  const { cut, color, tags } = look, t = tags.length ? tags : ['precision cutting'];
  const T = {
    luxe: { script: [`A ${cut.toLowerCase()} made to move`, `${color}, hand-finished`, `Crafted with ${t[0].toLowerCase()}`, `Reserve your chair at ${salon}`],
      caption: `Quiet luxury, in motion. ✨ This ${cut.toLowerCase()} with ${color.toLowerCase()} was shaped with ${t[0].toLowerCase()}. Elevated, effortless, unmistakably you.\n\nReserve your appointment at ${salon} — link in bio.` },
    fun: { script: ['POV: your hair just got a glow-up 💁‍♀️', `${cut} energy ⚡`, `${color} = obsessed 😍`, `Book it at ${salon}! 📅`],
      caption: `Okay but LOOK at this ${cut.toLowerCase()} 😍🔥 ${color} + ${t[0].toLowerCase()} = main character vibes. Who's next?? 🙋‍♀️\n\nLink in bio to book at ${salon}! 💖` },
    minimal: { script: [cut, color, t.slice(0, 2).join(' · '), salon], caption: `${cut}. ${color}.\n${t.join(' / ')}.\n\nBook — ${salon}, link in bio.` },
  }[tone] || {};
  const hashtags = [salon, cut, color, 'HairTransformation', 'SalonLife', 'HairReels'].map(x => '#' + x.normalize('NFD').replace(/[^a-z0-9]/gi, ''));
  return { ...T, hashtags };
}

// ---------- ASS captions ----------
const assEsc = s => String(s).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, '').trim().replace(/[{}\\]/g, '').replace(/\n/g, ' ');
const ts = s => { const h = s / 3600 | 0, m = (s % 3600) / 60 | 0, sec = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${sec}`; };
function buildAss({ lines, salon, duration, per, tone }) {
  const font = tone === 'luxe' ? 'DejaVu Serif' : 'DejaVu Sans';
  let out = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${font},78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,${tone === 'luxe' ? 1 : 0},0,0,100,100,0,0,1,4,3,2,80,80,380,1
Style: Brand,DejaVu Sans,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,2,0,1,3,2,7,70,70,110,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  out += `Dialogue: 0,${ts(0)},${ts(duration)},Brand,,0,0,0,,✂ ${assEsc(salon)}\n`;
  const L = lines.filter(x => x.trim()); if (!L.length) return out;
  for (let t = 0, i = 0; t < duration; t += per, i++)
    out += `Dialogue: 1,${ts(t)},${ts(Math.min(duration, t + per))},Cap,,0,0,0,,{\\fad(300,300)\\move(540,1560,540,1540)}${assEsc(L[i % L.length])}\n`;
  return out;
}

// ---------- Instagram ----------
const GRAPH = 'https://graph.facebook.com/' + (process.env.IG_GRAPH_VERSION || 'v21.0');
async function igPublish(renderFile, caption) {
  const tok = process.env.IG_ACCESS_TOKEN, uid = process.env.IG_USER_ID;
  const video_url = process.env.PUBLIC_BASE_URL.replace(/\/$/, '') + '/renders/' + renderFile;
  const post = async (p, params) => { const r = await fetch(`${GRAPH}/${p}`, { method: 'POST', body: new URLSearchParams({ ...params, access_token: tok }) }); const j = await r.json(); if (!r.ok || j.error) throw new Error('Instagram: ' + JSON.stringify(j.error || j)); return j; };
  const c = await post(`${uid}/media`, { media_type: 'REELS', video_url, caption, share_to_feed: 'true' });
  for (let i = 0; i < 60; i++) { // poll up to ~5 min
    await new Promise(r => setTimeout(r, 5000));
    const s = await (await fetch(`${GRAPH}/${c.id}?fields=status_code,status&access_token=${tok}`)).json();
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram processing: ' + (s.status || s.status_code));
    if (i === 59) throw new Error('Instagram processing timed out');
  }
  const p = await post(`${uid}/media_publish`, { creation_id: c.id });
  return { mediaId: p.id, containerId: c.id };
}
// simple persisted scheduler (Graph API has no native Reels scheduling; server must be running at the time)
const loadJobs = () => { try { return JSON.parse(fs.readFileSync(JOBS)); } catch { return []; } };
const saveJobs = j => fs.writeFileSync(JOBS, JSON.stringify(j, null, 2));
async function tick() {
  const jobs = loadJobs(); let changed = false;
  for (const j of jobs) if (j.status === 'scheduled' && Date.parse(j.when) <= Date.now()) {
    j.status = 'publishing'; saveJobs(jobs); changed = true;
    try { Object.assign(j, cfg().igLive ? await igPublish(j.render, j.caption) : { mock: true }, { status: 'published', at: new Date().toISOString() }); }
    catch (e) { j.status = 'failed'; j.error = e.message; }
  }
  if (changed) saveJobs(jobs);
}
setInterval(() => tick().catch(console.error), 30000);

// ---------- routes ----------
const app = express(); app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/renders', express.static(D('renders')));
app.use('/uploads', express.static(D('uploads')));
const upload = multer({ storage: multer.diskStorage({ destination: D('uploads'), filename: (q, f, cb) => cb(null, id() + (path.extname(f.originalname).toLowerCase().replace(/[^.\w]/g, '') || '.mp4')) }),
  limits: { fileSize: 500 << 20 }, fileFilter: (q, f, cb) => cb(null, /^video\//.test(f.mimetype)) });
const wrap = fn => (q, s) => fn(q, s).catch(e => { console.error(e); s.status(500).json({ error: e.message }); });

app.get('/api/config', (q, s) => { const c = cfg(); s.json({ provider: c.provider, llmLive: c.llmLive, igLive: c.igLive, tracks: Object.entries(TRACKS).map(([k, v]) => ({ id: k, label: v.label })) }); });
app.post('/api/upload', upload.single('video'), wrap(async (q, s) => {
  if (!q.file) return s.status(400).json({ error: 'no video' });
  s.json({ videoId: q.file.filename, url: '/uploads/' + q.file.filename, ...(await probe(q.file.path)) });
}));
app.post('/api/sample', wrap(async (q, s) => { await ensureSample(); s.json({ videoId: 'sample.mp4', url: '/uploads/sample.mp4' }); }));

app.post('/api/analyze', wrap(async (q, s) => {
  const f = videoPath(q.body.videoId), { duration } = await probe(f), fid = id();
  const pat = D('frames', fid + '_%02d.jpg');
  await run('ffmpeg', ['-y', '-i', f, '-vf', `fps=${(6 / Math.max(duration, 1)).toFixed(4)},scale=768:-2`, '-frames:v', '6', '-q:v', '4', pat]);
  const frames = fs.readdirSync(D('frames')).filter(n => n.startsWith(fid)).sort();
  if (!cfg().llmLive) return s.json({ mode: 'demo', frames: frames.length, look: LOOKS[Math.random() * LOOKS.length | 0] });
  const images = frames.map(n => fs.readFileSync(D('frames', n)).toString('base64'));
  const txt = await llm({ system: 'You are an expert hairstylist and colorist analysing salon result videos. Reply with JSON only.', images,
    text: `These are ${images.length} keyframes from a video of a finished hairstyle. Return JSON: {"cut":string,"color":string,"length":"Short|Chin|Shoulder|Mid|Long","technique":string,"tags":[4-6 short technique tags],"standout":[2-4 standout details],"confidence":0-1}. If no hair is visible, say so in "cut" and set confidence low.` });
  frames.forEach(n => fs.unlinkSync(D('frames', n)));
  s.json({ mode: 'live', provider: cfg().provider, frames: images.length, look: parseJSON(txt) });
}));

app.post('/api/generate', wrap(async (q, s) => {
  const { look, tone = 'luxe', salon = 'our salon' } = q.body; const t = String(tone).toLowerCase();
  if (!cfg().llmLive) return s.json({ mode: 'demo', ...mockCopy(look, t, salon) });
  const txt = await llm({ system: 'You write Instagram Reels copy for hair salons. Reply with JSON only.',
    text: `Salon: ${salon}\nTone: ${t} (luxe = elegant, understated luxury; fun = playful, emoji-friendly; minimal = terse, clean)\nLook analysis: ${JSON.stringify(look)}\nReturn JSON {"script":[4-5 on-screen caption lines, each under 40 chars],"caption":"Instagram caption under 1200 chars ending with a booking call to action","hashtags":[8-15 hashtags with #]}.` });
  s.json({ mode: 'live', ...parseJSON(txt) });
}));

app.post('/api/render', wrap(async (q, s) => {
  const { videoId, lines = [], salon = '', track = 'velvet', per = 2.5, tone = 'luxe' } = q.body;
  const f = videoPath(videoId), { duration: full, hasAudio } = await probe(f), duration = Math.min(full, 90);
  const rid = id(), ass = D('tmp', rid + '.ass'), out = D('renders', rid + '.mp4');
  fs.writeFileSync(ass, buildAss({ lines, salon, duration, per: Math.max(1, +per || 2.5), tone: String(tone).toLowerCase() }));
  const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,subtitles=${ass}:fontsdir=/usr/share/fonts/truetype/dejavu`;
  const args = ['-y', '-i', f]; const music = TRACKS[track]?.expr ? D('music', track + '.m4a') : null;
  if (music) args.push('-stream_loop', '-1', '-i', music);
  let af;
  if (music && hasAudio) af = ['-filter_complex', `[0:a]volume=0.35[a0];[1:a]volume=0.8[a1];[a0][a1]amix=inputs=2:duration=first[a]`, '-map', '0:v', '-map', '[a]'];
  else if (music) af = ['-map', '0:v', '-map', '1:a'];
  else af = hasAudio ? ['-map', '0:v', '-map', '0:a'] : ['-map', '0:v', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
  if (!music && !hasAudio) { args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'); af = ['-map', '0:v', '-map', '1:a']; }
  args.push('-vf', vf, ...af, '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '21', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-movflags', '+faststart', '-shortest', out);
  await run('ffmpeg', args); fs.unlinkSync(ass);
  s.json({ renderId: rid + '.mp4', url: '/renders/' + rid + '.mp4', duration });
}));

app.post('/api/publish', wrap(async (q, s) => {
  const { renderId, caption = '', when } = q.body;
  if (!/^[\w]+\.mp4$/.test(renderId || '') || !fs.existsSync(D('renders', renderId))) return s.status(400).json({ error: 'render first' });
  if (caption.length > 2200) return s.status(400).json({ error: 'caption over 2200 chars' });
  const live = cfg().igLive;
  if (when && Date.parse(when) > Date.now() + 60000) {
    const jobs = loadJobs(), job = { id: id(), render: renderId, caption, when: new Date(when).toISOString(), status: 'scheduled', live };
    jobs.push(job); saveJobs(jobs); return s.json({ mode: live ? 'live' : 'demo', scheduled: job });
  }
  if (!live) return s.json({ mode: 'demo', published: false, message: 'Demo mode: Instagram credentials not set, nothing was posted.' });
  s.json({ mode: 'live', published: true, ...(await igPublish(renderId, caption)) });
}));
app.get('/api/scheduled', (q, s) => s.json(loadJobs()));

Promise.all([ensureMusic(), ensureSample()]).then(() => app.listen(PORT, () => {
  const c = cfg(); console.log(`SalonReel on :${PORT} | LLM ${c.provider} ${c.llmLive ? 'LIVE' : 'DEMO'} | Instagram ${c.igLive ? 'LIVE' : 'DEMO'}`);
})).catch(e => { console.error(e); process.exit(1); });
