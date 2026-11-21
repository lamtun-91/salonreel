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
  const r = await C.createAvatarVideo({ avatar_id: 'Daphne_public_4', voice_id: 'vv', script: 'Trim every 8 weeks.' }, { fetchImpl: f, env, allowSpend: true });
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
  await assert.rejects(C.createAvatarVideo({ avatar_id: 'a', voice_id: 'v', script: 's' }, { fetchImpl: f402, env, allowSpend: true }),
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

test('m2: twinAssembleArgs crops to 1080x1920, keeps speech, ducks music, overlays the product', () => {
  const a = A.twinAssembleArgs({ talking: 'raw.mp4', total: 20, assPath: '/tmp/x.ass', productFile: 'p.png', product: { slot_start_s: 5, slot_end_s: 9 }, musicFile: 'm.mp3', out: 'o.mp4' });
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.match(fc, /crop=1080:1920/); assert.match(fc, /subtitles=/); assert.match(fc, /between\(t,5,9\)/);
  assert.match(fc, new RegExp(`volume=${A.MUSIC_UNDER_SPEECH_DB}dB`)); assert.match(fc, /amix=inputs=2:duration=first/);
  const b = A.twinAssembleArgs({ talking: 'raw.mp4', total: 20, assPath: '/tmp/x.ass', out: 'o.mp4' });
  assert.doesNotMatch(b[b.indexOf('-filter_complex') + 1], /amix|overlay/);
  assert.equal(A.twinTotal(52), A.DURATION.max); assert.equal(A.twinTotal(21.37), 21.37);
});

test('m2: renderHeygen end-to-end with a mocked HeyGen (real ffmpeg), raw clip reused on re-render', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin_m2_'));
  const src = path.join(dir, 'fake_heygen.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x806060:s=720x1280:r=25:d=4', '-f', 'lavfi', '-i', 'sine=f=220:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  const calls = { create: 0 };
  const hg = { engine: () => '', stockAvatarIds: () => ['Daphne_public_4'],
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
  assert.match(fs.readFileSync(path.join(dir, 'twin_live.ass'), 'utf8'), /AILabel,,0,0,0,,AI-generated/);
  p.heygen = r.heygen; await TR.renderHeygen(p, opts);
  assert.equal(calls.create, 1, 're-render must reuse the stored HeyGen clip');
  assert.throws(() => TR.heygenIds({ avatar: { sample: false } }, hg, {}), /no HeyGen look/);
  fs.rmSync(dir, { recursive: true, force: true });
});
