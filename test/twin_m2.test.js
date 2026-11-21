'use strict';
// AI Twin M2: HeyGen v3 client + live render assembly. Network is always mocked here (fetchImpl / injected hg).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const C = require('../heygen_client');
const A = require('../avatar');
const TR = require('../twin_render');

const FAKE = 'hg_test_key_DO_NOT_LEAK_123';
const env = { HEYGEN_API_KEY: FAKE };
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const mockFetch = (handler) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); }; f.calls = calls; return f; };

test('m2: requests go to v3 with the key only in X-Api-Key, and users/me is normalized', async () => {
  const f = mockFetch(() => res(200, { data: { billing_type: 'wallet', wallet: { currency: 'usd', remaining_balance: 0, auto_reload: { enabled: false } }, email: 'x@y' } }));
  const m = await C.me({ fetchImpl: f, env });
  assert.equal(f.calls[0].url, 'https://api.heygen.com/v3/users/me');
  assert.equal(f.calls[0].init.headers['X-Api-Key'], FAKE);
  assert.ok(!f.calls[0].url.includes(FAKE));
  assert.deepEqual(m.wallet, { currency: 'usd', remaining_balance: 0, auto_reload: { enabled: false } });
  assert.equal(m.email, undefined);
});

test('m2: no key -> clear error, no network', async () => {
  const f = mockFetch(() => res(200, {}));
  await assert.rejects(C.me({ fetchImpl: f, env: {} }), e => e.code === 'no_key');
  assert.equal(f.calls.length, 0);
});

test('m2: createAvatarVideo refuses to spend unless explicitly allowed (v3 has no test mode)', async () => {
  const f = mockFetch(() => res(200, { data: { video_id: 'v1' } }));
  await assert.rejects(C.createAvatarVideo({ avatar_id: 'a', voice_id: 'v', script: 'hi' }, { fetchImpl: f, env }), e => e instanceof C.SpendBlockedError && e.code === 'spend_not_allowed');
  assert.equal(f.calls.length, 0);
  const r = await C.createAvatarVideo({ avatar_id: 'Daphne_public_4', voice_id: 'vv', script: 'Trim every 8 weeks.' }, { fetchImpl: f, env, allowSpend: true, log: () => {} });
  assert.equal(r.video_id, 'v1');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(f.calls[0].init.method, 'POST'); assert.equal(f.calls[0].url, 'https://api.heygen.com/v3/videos');
  assert.equal(body.type, 'avatar'); assert.equal(body.aspect_ratio, '9:16'); assert.equal('test' in body, false);
});

test('m2: avatarVideoBody validates inputs', () => {
  assert.throws(() => C.avatarVideoBody({ voice_id: 'v', script: 's' }), /avatar_id/);
  assert.throws(() => C.avatarVideoBody({ avatar_id: 'a', script: 's' }), /voice_id/);
  assert.throws(() => C.avatarVideoBody({ avatar_id: 'a', voice_id: 'v', script: ' ' }), /script/);
  assert.throws(() => C.avatarVideoBody({ avatar_id: 'a', voice_id: 'v', script: 'x'.repeat(5001) }), /5,000/);
  assert.deepEqual(C.avatarVideoBody({ avatar_id: 'a', voice_id: 'v', script: 's', engine: 'avatar_iii' }).engine, { type: 'avatar_iii' });
});

test('m2: 402 / 401 errors are friendly and never contain the key', async () => {
  const f402 = mockFetch(() => res(402, { error: { code: 'insufficient_credit', message: 'Not enough credits to render this video.' } }));
  await assert.rejects(C.createAvatarVideo({ avatar_id: 'a', voice_id: 'v', script: 's' }, { fetchImpl: f402, env, allowSpend: true, log: () => {} }),
    e => e.status === 402 && e.code === 'insufficient_credit' && /Nothing was charged/.test(e.message) && !e.message.includes(FAKE));
  const f401 = mockFetch(() => res(401, { error: { code: 'unauthorized', message: 'bad key' } }));
  await assert.rejects(C.me({ fetchImpl: f401, env }), e => e.status === 401 && !e.message.includes(FAKE));
});

test('m2: request timeout aborts with code timeout', async () => {
  const f = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(C.me({ fetchImpl: f, env, timeoutMs: 20 }), e => e.code === 'timeout');
});

test('m2: waitForVideo polls to completed, surfaces failures and gives up on timeout', async () => {
  const seq = ['pending', 'processing', 'completed'];
  const f = mockFetch((u, i, n) => res(200, { data: { id: 'vid_1', status: seq[n - 1], video_url: n === 3 ? 'https://files.example/v.mp4' : null, duration: 21.4 } }));
  const v = await C.waitForVideo('vid_1', { fetchImpl: f, env, sleep: async () => {}, intervalMs: 1 });
  assert.equal(v.status, 'completed'); assert.equal(v.duration, 21.4); assert.equal(f.calls.length, 3);
  const ff = mockFetch(() => res(200, { data: { id: 'vid_2', status: 'failed', failure_message: 'moderation' } }));
  await assert.rejects(C.waitForVideo('vid_2', { fetchImpl: ff, env, sleep: async () => {} }), /moderation/);
  let t = 0; const fp = mockFetch(() => res(200, { data: { id: 'vid_3', status: 'processing' } }));
  await assert.rejects(C.waitForVideo('vid_3', { fetchImpl: fp, env, sleep: async () => {}, now: () => (t += 1000), timeoutMs: 3000 }), e => e.code === 'timeout');
  await assert.rejects(C.getVideo('../etc', { fetchImpl: fp, env }), /bad video_id/);
});

test('m2: download streams the presigned file without the API key', async () => {
  const dest = path.join(os.tmpdir(), `hg_dl_${process.pid}.bin`);
  const f = mockFetch(() => ({ ok: true, status: 200, body: new Blob([Buffer.from('mp4data')]).stream() }));
  await C.download('https://files.example/v.mp4', dest, { fetchImpl: f });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'mp4data'); fs.unlinkSync(dest);
  assert.equal(f.calls[0].init.headers, undefined);
  await assert.rejects(C.download('http://insecure/x', dest, { fetchImpl: f }), /bad download url/);
});

test('m2: facade stays stubbed without HEYGEN_LIVE=1 even when a key exists; testMode is false on v3', async () => {
  const HG = require('../heygen');
  assert.equal(HG.configured({ HEYGEN_API_KEY: FAKE }), false);
  assert.equal(HG.configured({ HEYGEN_API_KEY: FAKE, HEYGEN_LIVE: '1' }), true);
  assert.equal(HG.configured({ HEYGEN_LIVE: '1' }), false);
  assert.equal(HG.testMode(), false); assert.match(HG.TEST_MODE_NOTE, /no test mode/);
});

test('m2: retimeCaptions scales to the real clip length', () => {
  const c = TR.retimeCaptions([{ start_s: 0, end_s: 10, text: 'a' }, { start_s: 10, end_s: 20, text: 'b' }, { start_s: 30, end_s: 36, text: 'c' }], 36, 18);
  assert.deepEqual(c.map(x => [x.start_s, x.end_s]), [[0, 5], [5, 10], [15, 18]]);
});

test('m2: twinAssembleArgs crops to 1080x1920, keeps speech, ducks music, never overlays a product photo', () => {
  const a = A.twinAssembleArgs({ talking: 'raw.mp4', total: 20, assPath: '/tmp/x.ass', productFile: 'p.png', product: { slot_start_s: 5, slot_end_s: 9 }, musicFile: 'm.mp3', out: 'o.mp4' });
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.match(fc, /crop=1080:1920/); assert.match(fc, /subtitles=/);
  assert.match(fc, new RegExp(`volume=${A.MUSIC_UNDER_SPEECH_DB}dB`)); assert.match(fc, /amix=inputs=2:duration=first/);
  assert.doesNotMatch(fc, /overlay|between\(t,5,9\)/); assert.ok(!a.includes('p.png'), 'product photo is not an input');
  const b = A.twinAssembleArgs({ talking: 'raw.mp4', total: 20, assPath: '/tmp/x.ass', out: 'o.mp4' });
  assert.doesNotMatch(b[b.indexOf('-filter_complex') + 1], /amix|overlay/);
  assert.equal(A.twinTotal(52), A.DURATION.max); assert.equal(A.twinTotal(21.37), 21.37);
});
test('m2: renderHeygen end-to-end with a mocked HeyGen (real ffmpeg), raw clip reused on re-render', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin_m2_'));
  const src = path.join(dir, 'fake_heygen.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x806060:s=720x1280:r=25:d=4', '-f', 'lavfi', '-i', 'sine=f=220:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  const calls = { create: 0 };
  const hg = { engine: () => 'avatar_iii', stockAvatarIds: () => ['Daphne_public_4'],
    createVideo: async (b) => { calls.create++; calls.body = b; return { video_id: 'mock_vid_1', status: 'pending' }; },
    waitForVideo: async () => ({ status: 'completed', video_url: 'https://files.example/v.mp4', duration: 4 }),
    download: async (u, d) => { fs.copyFileSync(src, d); return d; } };
  const run = (cmd, args) => new Promise((ok, no) => require('child_process').execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, o, er) => e ? no(new Error(er)) : ok(o)));
  const probeDuration = async f => +String(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).trim();
  const p = { id: 'abc123abc123', profile: { salon: 'Olya Atelier' }, inputs: { mood: 'Clean', music: 'none' }, musicOn: false, total_s: 8,
    avatar: { sample: true, heygen_avatar_id: null, voice_id: null }, script: { text: 'Trim every eight weeks while growing it out.', captions: [{ start_s: 0, end_s: 8, text: 'Trim every 8 weeks' }] } };
  const opts = { hg, run, probeDuration, master: async () => ({ skipped: 'test' }), dir, getProduct: async () => null, env: { HEYGEN_STOCK_VOICE_ID: 'voice_x' } };
  const r = await TR.renderHeygen(p, opts);
  assert.equal(calls.create, 1); assert.equal(calls.body.avatar_id, 'Daphne_public_4'); assert.equal(calls.body.voice_id, 'voice_x'); assert.equal(calls.body.aspect_ratio, '9:16');
  const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type:format=duration', '-of', 'json', r.out]));
  const v = pr.streams.find(s => s.codec_type === 'video'); assert.equal(v.width, 1080); assert.equal(v.height, 1920);
  assert.ok(pr.streams.some(s => s.codec_type === 'audio'));
  assert.ok(Math.abs(+pr.format.duration - 4) < 0.15, pr.format.duration);
  assert.deepEqual(r.captions.map(c => c.end_s), [4]);
  const ass0 = fs.readFileSync(path.join(dir, 'twin_live.ass'), 'utf8');
  assert.doesNotMatch(ass0, /AILabel,,0,0,0,,AI-generated/, 'AI stamp off by default'); assert.doesNotMatch(ass0, /Brand,,0,0,0,,Olya Atelier/, 'salon name off by default');
  assert.equal(r.ai_label, null); assert.deepEqual(r.overlays, { brand: false, ai_label: false });
  p.heygen = r.heygen; p.overlays = { brand: true, ai_label: true }; p.product = { key: 'projects/abc123abc123/product/x.png', render_in_avatar: false };
  const r2 = await TR.renderHeygen(p, opts);
  assert.equal(calls.create, 1, 're-render must reuse the stored HeyGen clip');
  const ass1 = fs.readFileSync(path.join(dir, 'twin_live.ass'), 'utf8');
  assert.match(ass1, /AILabel,,0,0,0,,AI-generated/); assert.match(ass1, /Brand,,0,0,0,,Olya Atelier/); assert.match(ass1, /,Pill,,/);
  assert.equal(r2.ai_label, 'AI-generated'); assert.equal(r2.product_for_broll, p.product.key);
  assert.throws(() => TR.heygenIds({ avatar: { sample: false } }, hg, {}), /no HeyGen look/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m2: Dockerfile copies every local module the server requires (M2 deploy once failed on a missing file)', () => {
  const ROOT = path.join(__dirname, '..');
  const line = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').split('\n').find(l => /^COPY server\.js /.test(l));
  const copied = new Set(line.split(/\s+/).slice(1, -1));
  const seen = new Set(), todo = ['server.js'];
  while (todo.length) { const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/require\('\.\/([\w.-]+?)(\.js)?'\)/g)) todo.push(m[1] + '.js'); }
  for (const f of seen) assert.ok(copied.has(f), `${f} is required but not COPYed in Dockerfile`);
});

const SCRIPT18 = "Growing your hair out? Don't skip trims. A tiny dusting every eight to ten weeks keeps ends healthy, so your length actually shows. Ask for a dusting, not a cut, at your next visit to Olya Atelier.";
test('m2 cost: default request pins avatar_iii and never sends avatar_iv', async () => {
  const f = mockFetch(() => res(200, { data: { video_id: 'v9' } }));
  const logs = [];
  for (const e of [{}, { HEYGEN_ENGINE: '' }, { HEYGEN_AVATAR_ENGINE: 'avatar_iv' }]) {
    await C.createAvatarVideo({ avatar_id: 'Daphne_public_4', voice_id: 'vv', script: SCRIPT18 }, { fetchImpl: f, env: { ...env, ...e }, allowSpend: true, log: m => logs.push(m) });
  }
  for (const c of f.calls) { const b = JSON.parse(c.init.body); assert.deepEqual(b.engine, { type: 'avatar_iii' }); assert.doesNotMatch(c.init.body, /avatar_iv/); }
  assert.deepEqual(C.avatarVideoBody({ avatar_id: 'a', voice_id: 'v', script: 's' }).engine, { type: 'avatar_iii' });
  const HG = require('../heygen'); assert.equal(HG.engine({}), 'avatar_iii'); assert.equal(HG.engine({ HEYGEN_ENGINE: 'avatar_iv' }), 'avatar_iv');
  assert.ok(logs.every(m => /engine=avatar_iii est_s=\d/.test(m) && /est_usd=0\.\d{4}/.test(m) && !m.includes(FAKE)), logs.join('\n'));
  assert.throws(() => C.engineFor({}, { HEYGEN_ENGINE: 'turbo9' }), /Unsupported HeyGen engine/);
});
test('m2 cost: estimate is conservative and uses the docs rates', () => {
  const e = C.estimateCost({ script: SCRIPT18, engine: 'avatar_iii' });
  assert.equal(e.rate_per_min, 0.99); assert.equal(e.seconds, 14.7); // 37 words / 3.0 * 1.15 + 0.5s
  assert.equal(e.usd, 0.2426);
  assert.equal(C.ratePerMin('avatar_iii', 'digital_twin'), 0.60); assert.equal(C.ratePerMin('avatar_iv', 'mystery'), 4.83);
  assert.equal(C.estimateSeconds('one two three four five six seven eight nine ten eleven'), 4.7);
});
test('m2 cost: refuses over $0.50 or over 30s before any network call', async () => {
  const f = mockFetch(() => res(200, { data: { video_id: 'never' } }));
  const long = Array(80).fill('word').join(' '); // 80/3*1.15+0.5 = 31.2s
  const logs = [];
  await assert.rejects(C.createAvatarVideo({ avatar_id: 'a', voice_id: 'v', script: long }, { fetchImpl: f, env, allowSpend: true, log: m => logs.push(m) }), e => e instanceof C.CostGuardError && /capped at 30s/.test(e.message));
  // ~14.7s on avatar_iv studio = ~$1.18 -> over the cap
  await assert.rejects(C.createAvatarVideo({ avatar_id: 'a', voice_id: 'v', script: SCRIPT18, engine: 'avatar_iv' }, { fetchImpl: f, env, allowSpend: true, log: m => logs.push(m) }), e => e.code === 'cost_guard' && /over the \$0\.50/.test(e.message));
  await assert.rejects(C.createAvatarVideo({ avatar_id: 'a', voice_id: 'v', script: SCRIPT18 }, { fetchImpl: f, env: { ...env, HEYGEN_ENGINE: 'avatar_v' }, allowSpend: true, log: m => logs.push(m) }), e => e.code === 'cost_guard');
  assert.equal(f.calls.length, 0);
  assert.equal(logs.filter(m => /^\[heygen\] REFUSED/.test(m)).length, 3);
  assert.equal(Object.isFrozen(C.GUARD), true);
});

// ---------- M2 follow-ups: speech calibration, Twin brand zone, 1080p ----------
const SP = require('../speech');
const P = require('../pipeline');
test('m2 calib: one ~3 w/s calibration drives the script target, duration estimate and cost guard', () => {
  assert.equal(SP.SPEECH.wordsPerSec, 3.0);
  const s55 = Array(55).fill('word').join(' ');
  assert.equal(A.estimateDuration(s55), 18.33); // 55 words ~ 18s reel
  assert.equal(A.DURATION.target, 18); assert.equal(A.DURATION.words, 55); assert.equal(A.DURATION.max, C.GUARD.maxSeconds);
  assert.equal(A.DURATION.minWords, 50); assert.equal(A.DURATION.maxWords, 76);
  assert.match(A.draftPrompt({ template: 'tip', salon: 'Olya Atelier', mood: 'Clean', language: 'English' }), /about 55 words \(~18s/);
  const g = C.estimateCost({ script: s55, engine: 'avatar_iii' });
  assert.ok(g.seconds > A.estimateDuration(s55), 'guard stays more conservative than the estimate'); assert.equal(g.seconds, 21.6);
  assert.ok(g.usd < C.GUARD.maxUsd);
  // the measured M2 renders fit inside the guard estimate
  assert.ok(SP.guardSeconds(Array(42).fill('w').join(' ')) >= 13.17); assert.ok(SP.guardSeconds(Array(39).fill('w').join(' ')) >= 14.55);
  // mock drafts now land near 18s
  for (const t of ['tip', 'faq', 'promo', 'booking']) { const d = A.mockDraft({ template: t, salon: 'Olya Atelier', avatar: { name: 'Olya' } }); assert.ok(d.total_s >= 15 && d.total_s <= 24, `${t} ${d.total_s}`); }
});
test('m2 layout: optional brand pill (bottom band) and AI stamp (top safe area) clear captions and each other', () => {
  const a = A.buildTwinAss({ lines: [{ start_s: 0, end_s: 1, text: 'x' }], salon: 'Olya Atelier', duration: 2, overlays: { brand: true, ai_label: true } });
  const brand = a.split('\n').find(l => l.startsWith('Style: Brand,')).split(',');
  assert.equal(brand[18], '2', 'bottom-centre alignment'); assert.equal(+brand[21], 1920 - A.TWIN_BRAND_ZONE.bottomY);
  const pill = A.brandPill('Olya Atelier');
  assert.ok(pill.y > P.CAPTION_ZONE.bottomY + 100, 'pill below captions'); assert.ok(pill.bottom <= 1760, 'pill above the bottom edge');
  assert.ok(pill.x > 0 && pill.x + pill.w < 1080); assert.equal(pill.x + pill.w / 2, 540);
  assert.ok(pill.y < A.TWIN_BRAND_ZONE.bottomY - A.TWIN_BRAND_ZONE.size && pill.bottom > A.TWIN_BRAND_ZONE.bottomY, 'pill wraps the text');
  assert.match(a, new RegExp(`Style: Pill,[^\\n]*&H${A.BRAND_PILL.alpha}000000`)); assert.ok(parseInt(A.BRAND_PILL.alpha, 16) >= 0x73 && parseInt(A.BRAND_PILL.alpha, 16) <= 0x8C, '45-55% opaque');
  assert.ok(A.brandPill('A very long salon name for the pill test').w <= A.BRAND_PILL.maxW);
  const label = a.split('\n').find(l => l.startsWith('Style: AILabel,')).split(',');
  assert.equal(label[18], '7'); assert.equal(+label[21], A.AI_LABEL_ZONE.topY);
  assert.ok(A.AI_LABEL_ZONE.topY >= 210 && A.AI_LABEL_ZONE.topY + A.AI_LABEL_ZONE.size <= 270, 'label in the top safe area ~220-260');
  assert.ok(A.AI_LABEL_ZONE.topY + A.AI_LABEL_ZONE.size < P.CAPTION_ZONE.bottomY - 3 * P.CAPTION_ZONE.size);
  assert.deepEqual(A.cleanOverlays({}), { brand: false, ai_label: false }); assert.deepEqual(A.cleanOverlays({ brand: 'x' }), { brand: false, ai_label: false });
  assert.equal(A.PRODUCT_META.render_in_avatar, false);
});
test('m2 brand: Hair Reveal brand/caption overlay params are unchanged', () => {
  const h = s => require('crypto').createHash('sha256').update(s).digest('hex');
  const inp = { lines: [{ start_s: 0.5, end_s: 3.2, text: 'Fresh bob, soft ends' }, { start_s: 3.5, end_s: 7, text: 'Book at Olya Atelier' }], salon: 'Olya Atelier', duration: 18 };
  assert.equal(h(P.buildAss({ ...inp, tone: 'clean' })), '7e002281237f18bc5fe187bc6cfb34915c0bb38b546c475f41922792d581a4e8');
  assert.equal(h(P.buildAss({ ...inp, tone: 'luxe' })), 'f18251a2853e1bb76f0d182ddf2350cfa8b5bd37ea921b275629c0a1f80c3ef5');
  assert.deepEqual(P.BRAND_ZONE, { topY: 285, size: 46 });
  assert.deepEqual(P.CAPTION_ZONE, { bottomY: 1230, size: 66, marginL: 90, marginR: 160 });
  assert.deepEqual(require('../shotstack').ZONES, { brand: { centerY: 320, height: 90, width: 760, size: 44 }, caption: { centerY: 1110, height: 240, width: 860, size: 60, x: -30 } });
});
test('m2 1080p: Twin HeyGen requests default to 1080p', async () => {
  assert.equal(C.avatarVideoBody({ avatar_id: 'a', voice_id: 'v', script: 's' }).resolution, '1080p');
  const f = mockFetch(() => res(200, { data: { video_id: 'v1080' } }));
  await C.createAvatarVideo({ avatar_id: 'Daphne_public_4', voice_id: 'vv', script: 'Short tip.' }, { fetchImpl: f, env, allowSpend: true, log: () => {} });
  assert.equal(JSON.parse(f.calls[0].init.body).resolution, '1080p');
});
