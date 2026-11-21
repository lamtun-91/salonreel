'use strict';
// AI Twin M3: Runway image_to_video client, cost guard, session cap, attribution and Promo assembly. Network always mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, execFile } = require('child_process');
const C = require('../runway_client');
const A = require('../avatar');
const TR = require('../twin_render');

const FAKE = 'key_rw_test_DO_NOT_LEAK_456';
const env = { RUNWAYML_API_SECRET: FAKE };
const IMG = 'data:image/jpeg;base64,/9j/AAAA';
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const mockFetch = (handler) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); }; f.calls = calls; return f; };
const TID = '17f20503-6c24-4c16-946b-35dbbce2af2f';

test('m3: default model is gen4_turbo and the default request never sends gen4.5', async () => {
  const f = mockFetch(() => res(200, { id: TID })); const logs = [];
  for (const e of [{}, { RUNWAY_MODEL: '' }]) await C.imageToVideo({ promptImage: IMG, promptText: 'push in', duration: 5 }, { fetchImpl: f, env: { ...env, ...e }, allowSpend: true, tracker: C.spendTracker(5), log: m => logs.push(m) });
  for (const c of f.calls) { assert.equal(JSON.parse(c.init.body).model, 'gen4_turbo'); assert.doesNotMatch(c.init.body, /gen4\.5/); }
  assert.equal(C.DEFAULT_MODEL, 'gen4_turbo'); assert.equal(C.modelFor({}, {}), 'gen4_turbo');
  assert.equal(C.modelFor({}, { RUNWAY_MODEL: 'gen4.5' }), 'gen4.5');
  assert.throws(() => C.modelFor({}, { RUNWAY_MODEL: 'gen3a_turbo' }), /Unsupported Runway model/);
  assert.equal(require('../runway').model({}), 'gen4_turbo');
  assert.ok(logs.every(m => /model=gen4_turbo duration=5s/.test(m) && /est_usd=0\.25/.test(m) && !m.includes(FAKE)), logs.join('\n'));
});

test('m3: requests hit api.dev.runwayml.com with the version header and the key only in Authorization', async () => {
  const f = mockFetch((u) => u.endsWith('/v1/organization') ? res(200, { creditBalance: 1000, tier: { maxMonthlyCreditSpend: 10000, models: {} }, usage: { models: {} } }) : res(200, { id: TID }));
  const o = await C.organization({ fetchImpl: f, env }); assert.equal(o.creditBalance, 1000); assert.equal(o.usd, 10);
  await C.imageToVideo({ promptImage: IMG, promptText: 'x', duration: 5 }, { fetchImpl: f, env, allowSpend: true, tracker: C.spendTracker(5), log: () => {} });
  assert.equal(f.calls[0].url, 'https://api.dev.runwayml.com/v1/organization'); assert.equal(f.calls[1].url, 'https://api.dev.runwayml.com/v1/image_to_video');
  for (const c of f.calls) { assert.equal(c.init.headers['X-Runway-Version'], '2024-11-06'); assert.equal(c.init.headers.Authorization, `Bearer ${FAKE}`); assert.ok(!c.url.includes(FAKE)); }
  const b = JSON.parse(f.calls[1].init.body); assert.deepEqual(Object.keys(b).sort(), ['duration', 'model', 'promptImage', 'promptText', 'ratio']); assert.equal(b.ratio, '720:1280');
});

test('m3: a paid call needs RUNWAY_ALLOW_SPEND and the facade needs RUNWAY_LIVE + key', async () => {
  const f = mockFetch(() => res(200, { id: TID }));
  await assert.rejects(C.imageToVideo({ promptImage: IMG, promptText: 'x', duration: 5 }, { fetchImpl: f, env }), e => e.code === 'spend_not_allowed');
  await assert.rejects(C.imageToVideo({ promptImage: IMG, promptText: 'x', duration: 5 }, { fetchImpl: f, env: { ...env, RUNWAY_LIVE: '1' } }), e => e.code === 'spend_not_allowed');
  assert.equal(f.calls.length, 0);
  assert.equal(C.liveEnabled({ RUNWAY_LIVE: '1' }), false); assert.equal(C.liveEnabled(env), false); assert.equal(C.liveEnabled({ ...env, RUNWAY_LIVE: '1' }), true);
  const RW = require('../runway'); assert.equal(RW.configured({ ...env }), false);
  const s = await RW.imageToVideo({ promptText: 'x', duration: 5 }); assert.equal(s.stub, true); // test env is not live
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8'), /^(?![\s\S]*RUNWAY_(LIVE|ALLOW_SPEND))/, 'render.yaml must not enable Runway');
});

test('m3: cost guard refuses >10s or >$1 per clip before any network call', async () => {
  const f = mockFetch(() => res(200, { id: TID })); const logs = [];
  assert.deepEqual(C.estimateCost({ model: 'gen4_turbo', duration: 5 }), { model: 'gen4_turbo', duration: 5, credits: 25, usd: 0.25 });
  assert.equal(C.estimateCost({ model: 'gen4.5', duration: 10 }).usd, 1.2);
  assert.throws(() => C.checkCost({ model: 'gen4_turbo', duration: 11, usd: 0.55 }), e => e.code === 'cost_guard' && /10s/.test(e.message));
  // gen4.5 10s = $1.20 -> refused by the $1 cap
  await assert.rejects(C.imageToVideo({ promptImage: IMG, promptText: 'x', duration: 10 }, { fetchImpl: f, env: { ...env, RUNWAY_MODEL: 'gen4.5' }, allowSpend: true, tracker: C.spendTracker(5), log: m => logs.push(m) }), e => e.code === 'cost_guard' && /\$1\.20/.test(e.message));
  await assert.rejects(C.imageToVideo({ promptImage: IMG, promptText: 'x', duration: 11 }, { fetchImpl: f, env, allowSpend: true, tracker: C.spendTracker(5), log: m => logs.push(m) }), e => e.code === 'bad_request');
  assert.equal(f.calls.length, 0); assert.ok(logs.some(m => /REFUSED model=gen4\.5 duration=10s est_usd=1\.20/.test(m)));
  // gen4_turbo 10s = $0.50 passes
  await C.imageToVideo({ promptImage: IMG, promptText: 'x', duration: 10 }, { fetchImpl: f, env, allowSpend: true, tracker: C.spendTracker(5), log: () => {} });
  assert.equal(f.calls.length, 1);
});

test('m3: session spend tracker refuses once the cumulative estimate would pass the cap; definite rejections release', async () => {
  const tr = C.spendTracker(5); const f = mockFetch(() => res(200, { id: TID }));
  for (let i = 0; i < 10; i++) await C.imageToVideo({ promptImage: IMG, promptText: 'x', duration: 10 }, { fetchImpl: f, env, allowSpend: true, tracker: tr, log: () => {} });
  assert.equal(tr.spent, 5);
  await assert.rejects(C.imageToVideo({ promptImage: IMG, promptText: 'x', duration: 2 }, { fetchImpl: f, env, allowSpend: true, tracker: tr, log: () => {} }), e => e.code === 'cost_guard' && /Session cap/.test(e.message));
  assert.equal(f.calls.length, 10);
  const tr2 = C.spendTracker(5); const f402 = mockFetch(() => res(402, { error: 'You do not have enough credits to run this task.' }));
  await assert.rejects(C.imageToVideo({ promptImage: IMG, promptText: 'x', duration: 5 }, { fetchImpl: f402, env, allowSpend: true, tracker: tr2, log: () => {} }), e => e.code === 'insufficient_credits' && /credits/.test(e.message) && !e.message.includes(FAKE));
  assert.equal(tr2.spent, 0); assert.equal(f402.calls.length, 1, 'no retry');
});

test('m3: polling handles SUCCEEDED / FAILED and download writes the file', async () => {
  let n = 0; const f = mockFetch(() => res(200, ++n < 3 ? { id: TID, status: n === 1 ? 'PENDING' : 'RUNNING' } : { id: TID, status: 'SUCCEEDED', output: ['https://dnznrvs05pmza.cloudfront.net/x.mp4'], cost: { credits: 25 } }));
  const t = await C.waitForTask(TID, { fetchImpl: f, env, sleep: async () => {} });
  assert.equal(t.status, 'SUCCEEDED'); assert.equal(t.cost, 25); assert.equal(f.calls.length, 3); assert.equal(f.calls[0].url, `https://api.dev.runwayml.com/v1/tasks/${TID}`);
  const ff = mockFetch(() => res(200, { id: TID, status: 'FAILED', failure: 'moderation', failureCode: 'SAFETY.INPUT.IMAGE' }));
  await assert.rejects(C.waitForTask(TID, { fetchImpl: ff, env, sleep: async () => {} }), e => /failed: moderation/.test(e.message) && e.code === 'SAFETY.INPUT.IMAGE');
  await assert.rejects(C.task('../../etc', { fetchImpl: ff, env }), /bad task id/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw_')); const dest = path.join(dir, 'c.mp4');
  const df = async () => ({ ok: true, status: 200, body: new Response('VIDEOBYTES').body });
  await C.download('https://dnznrvs05pmza.cloudfront.net/x.mp4', dest, { fetchImpl: df }); assert.equal(fs.readFileSync(dest, 'utf8'), 'VIDEOBYTES');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m3: Runway attribution appears in the Twin UI only (near B-roll and export), linking runwayml.com; never burned in', () => {
  const ROOT = path.join(__dirname, '..');
  const ui = fs.readFileSync(path.join(ROOT, 'public/twin.html'), 'utf8');
  assert.match(ui, /id="rwyBroll"><a href="https:\/\/runwayml\.com"[^>]*>Powered by Runway<\/a>/);
  assert.match(ui, /id="rwyExport">B-roll scenes <a href="https:\/\/runwayml\.com"[^>]*>Powered by Runway<\/a>/);
  assert.doesNotMatch(ui, /grok|xai|x\.ai/i);
  for (const f of ['public/index.html', 'public/app.js']) if (fs.existsSync(path.join(ROOT, f))) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /Runway/, f);
  assert.doesNotMatch(A.buildTwinAss({ lines: [{ start_s: 0, end_s: 3, text: 'hi' }], salon: 'Olya Atelier', duration: 9, overlays: { brand: true, ai_label: true } }), /Runway/);
});

test('m3: promo timeline order is avatar -> B-roll -> end card with crossfades', () => {
  const tl = A.promoTimeline([{ kind: 'avatar', dur: 18 }, { kind: 'broll', dur: 5 }, { kind: 'broll', dur: 5 }, { kind: 'endcard', dur: 2.5 }]);
  assert.deepEqual(tl.segments.map(s => s.kind), ['avatar', 'broll', 'broll', 'endcard']);
  assert.deepEqual(tl.segments.map(s => s.xfade_offset), [null, 17.6, 22.2, 26.8]);
  assert.equal(tl.total, 29.3);
  assert.throws(() => A.promoTimeline([{ kind: 'broll', dur: 5 }, { kind: 'endcard', dur: 2 }]), /start with the avatar/);
  assert.throws(() => A.promoTimeline([{ kind: 'avatar', dur: 5 }, { kind: 'broll', dur: 5 }]), /end with the product end card/);
  const { args } = A.promoAssembleArgs({ avatar: { file: 'a.mp4', dur: 18 }, brolls: [{ file: 'b.mp4', dur: 5, composite: true }], productFile: 'p.png', assPath: '/t/x.ass', musicFile: null, out: 'o.mp4' });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(args.indexOf('a.mp4') < args.indexOf('b.mp4') && args.indexOf('b.mp4') < args.lastIndexOf('p.png'));
  assert.match(fc, /\[s0\]\[s1\]xfade=transition=fade:duration=0\.4:offset=17\.6\[x1\];\[x1\]\[s2\]xfade=transition=fade:duration=0\.4:offset=22\.2\[x2\]/);
  assert.match(fc, /overlay=\(W-w\)\/2:1060-h\/2:enable='gte\(t,2\.80\)'/, 'product composited on the clean surface at the end of style-a B-roll');
  assert.match(A.BROLL_PROMPTS.a, /No people/); assert.match(A.BROLL_PROMPTS.b, /lifts a hair product bottle into view and smiles/); assert.match(A.BROLL_PROMPTS.b, /No text/);
  assert.deepEqual(A.stillArgs('raw.mp4', 1.5, 's.jpg').slice(-5, -1), ['-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280', '-q:v', '2']);
});

test('m3: promo renderHeygen end-to-end with mocked HeyGen + Runway (real ffmpeg); B-roll clip reused on re-render', { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin_m3_'));
  const src = path.join(dir, 'fake_heygen.mp4'), brollSrc = path.join(dir, 'fake_broll.mp4'), prod = path.join(dir, 'prod.png');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x806060:s=720x1280:r=25:d=4', '-f', 'lavfi', '-i', 'sine=f=220:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xd8d0c8:s=720x1280:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', brollSrc]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x3040a0:s=400x600', '-frames:v', '1', prod]);
  const hg = { engine: () => 'avatar_iii', stockAvatarIds: () => ['Daphne_public_4'], createVideo: async () => ({ video_id: 'mock_vid_p' }),
    waitForVideo: async () => ({ status: 'completed', video_url: 'https://f/v.mp4', duration: 4 }), download: async (u, d) => { fs.copyFileSync(src, d); return d; } };
  const rwCalls = []; const rw = { imageToVideo: async (b) => { rwCalls.push(b); return { task_id: TID, model: 'gen4_turbo', estimate: { usd: 0.15 } }; },
    waitForTask: async () => ({ status: 'SUCCEEDED', output: ['https://cdn/x.mp4'], cost: 15 }), download: async (u, d) => { fs.copyFileSync(brollSrc, d); return d; } };
  const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, o, er) => e ? no(new Error(er)) : ok(o)));
  const probeDuration = async f => +String(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).trim();
  const p = { id: 'prm123prm123', template: 'promo', profile: { salon: 'Olya Atelier' }, inputs: { mood: 'Clean', music: 'none' }, musicOn: false, total_s: 4,
    avatar: { sample: true }, script: { text: 'Our bond repair mask is back.', captions: [{ start_s: 0, end_s: 4, text: 'Bond repair mask' }] }, product: { key: 'k.png' } };
  const opts = { hg, run, probeDuration, master: async () => ({ skipped: 'test' }), dir, env: { HEYGEN_STOCK_VOICE_ID: 'v' }, rw,
    promo: { productFile: prod, styleAStill: path.join(__dirname, '..', 'assets', 'broll_countertop.jpg'), clipSeconds: 3, endCardDur: 2 } };
  const r = await TR.renderHeygen(p, opts);
  assert.equal(rwCalls.length, 1); assert.match(rwCalls[0].promptImage, /^data:image\/jpeg;base64,/); assert.equal(rwCalls[0].promptText, A.BROLL_PROMPTS.a); assert.equal(rwCalls[0].ratio, '720:1280');
  assert.deepEqual(r.timeline.segments.map(s => s.kind), ['avatar', 'broll', 'endcard']);
  const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type:format=duration', '-of', 'json', r.out]));
  const v = pr.streams.find(s => s.codec_type === 'video'); assert.equal(v.width, 1080); assert.equal(v.height, 1920); assert.ok(pr.streams.some(s => s.codec_type === 'audio'));
  assert.ok(Math.abs(+pr.format.duration - (4 + 3 + 2 - 0.8)) < 0.2, pr.format.duration);
  const ass = fs.readFileSync(path.join(dir, 'twin_live.ass'), 'utf8'); assert.doesNotMatch(ass, /AILabel,,0,0,0,,AI-generated/); assert.doesNotMatch(ass, /Brand,,0,0,0,,Olya/);
  p.heygen = r.heygen; await TR.renderHeygen(p, opts); assert.equal(rwCalls.length, 1, 're-render reuses the stored B-roll clip');
  // tip template never calls Runway
  const r3 = await TR.renderHeygen({ ...p, template: 'tip' }, opts); assert.equal(rwCalls.length, 1); assert.equal(r3.timeline, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
