'use strict';
// M3.1 contextual product B-roll. Network always mocked. PROMO_BROLL_MODE stays off unless a test sets it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const PB = require('../promo_broll');
const A = require('../avatar');
const TR = require('../twin_render');
const RWC = require('../runway_client');

const ROOT = path.join(__dirname, '..');
const SURFACE = path.join(ROOT, 'assets/broll_countertop.jpg');

function tmpDir(p = 'm31_') { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

function makeProduct({ dest, w = 400, h = 640, kind = 'serum' } = {}) {
  // White studio backdrop + a solid colored body and a contrasting label. No real brand.
  const body = kind === 'mask'
    ? `drawbox=60:260:280:280:color=0xC4B09A:t=fill,drawbox=90:200:220:80:color=0xEDE6D6:t=fill,drawbox=110:340:180:120:color=0xF4F0E6:t=fill`
    : `drawbox=130:80:140:80:color=0xF2F2F2:t=fill,drawbox=120:160:160:420:color=0xD9C48A:t=fill,drawbox=145:260:110:140:color=0xF4F0E6:t=fill`;
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=white:s=${w}x${h}`, '-vf', body, '-frames:v', '1', dest], { stdio: 'pipe' });
  return dest;
}

function probeWxH(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [w, h] = out.split(',').map(Number);
  return { w, h };
}

function writeTinyMp4(dest, { w = 720, h = 1280, t = 0.4, color = '0x445566' } = {}) {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=${color}:s=${w}x${h}:d=${t}`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-t', String(t), '-an', dest], { stdio: 'pipe' });
  return dest;
}

test('m31: flag is off by default and does not change the production Promo path', () => {
  assert.equal(PB.MODE_ENV, 'PROMO_BROLL_MODE');
  assert.equal(PB.MODE_VALUE, 'contextual');
  assert.equal(PB.enabled({}), false);
  assert.equal(PB.enabled({ PROMO_BROLL_MODE: '' }), false);
  assert.equal(PB.enabled({ PROMO_BROLL_MODE: 'off' }), false);
  assert.equal(PB.enabled({ PROMO_BROLL_MODE: 'contextual' }), true);
  assert.equal(PB.plannedClipCount({ broll: { clips: [{}, {}, {}] } }, {}), 1);
  const draft = A.draftPrompt({ template: 'promo', salon: 'Olya Atelier', mood: 'Clean', language: 'English' });
  assert.match(draft, /generic salon atmosphere or process shot/);
  assert.doesNotMatch(draft, /product-in-use beat/);
  const src = fs.readFileSync(path.join(ROOT, 'routes_avatar.js'), 'utf8');
  assert.match(src, /compositeProduct: false/);
  assert.match(src, /promoBrollMode: PB\.enabled\(env\) \? 'contextual' : 'off'/);
  const envEx = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(envEx, /# PROMO_BROLL_MODE=contextual/);
  assert.doesNotMatch(envEx, /^PROMO_BROLL_MODE=/m);
  const renderYaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  assert.doesNotMatch(renderYaml, /PROMO_BROLL_MODE/);
});

test('m31: type inference uses meta or name first, one llm call, then generic fallback', async () => {
  let calls = 0;
  const llm = async () => { calls += 1; return 'serum'; };
  const fromType = await PB.inferType({ type: 'mask', name: 'Repair Serum' }, { llm });
  assert.deepEqual(fromType, { type: 'mask', source: 'meta', calls: 0 });
  assert.equal(calls, 0);
  const fromName = await PB.inferType({ name: 'Olya Atelier Repair Serum' }, { llm });
  assert.equal(fromName.type, 'serum'); assert.equal(fromName.source, 'meta'); assert.equal(fromName.calls, 0);
  assert.equal(PB.typeFromName('leave-in mist'), 'leave-in');
  assert.equal(PB.typeFromName('hydrating spray'), 'spray');
  assert.equal(PB.normalizeType('masque'), 'mask');
  const fromLlm = await PB.inferType({ name: 'Bottle Eleven' }, { llm, maxCalls: 1 });
  assert.deepEqual(fromLlm, { type: 'serum', source: 'llm', calls: 1 });
  assert.equal(calls, 1);
  // A second infer with a known type must not call again; an unknown type with maxCalls 1 still only once per call.
  const again = await PB.inferType({ name: 'Bottle Eleven' }, { llm, maxCalls: 1 });
  assert.equal(again.calls, 1); assert.equal(calls, 2);
  const noLlm = await PB.inferType({ name: 'Mystery' }, { llm: null });
  assert.deepEqual(noLlm, { type: PB.GENERIC, source: 'fallback', calls: 0 });
  const boom = await PB.inferType({ name: 'Mystery' }, { llm: async () => { throw new Error('nope'); }, maxCalls: 1 });
  assert.deepEqual(boom, { type: PB.GENERIC, source: 'fallback', calls: 1 });
  const unreadable = await PB.inferType({ name: 'Mystery' }, { llm: async () => 'not a known product class', maxCalls: 1 });
  assert.deepEqual(unreadable, { type: PB.GENERIC, source: 'fallback', calls: 1 });
});

test('m31: beatsFor returns 1-2 blocklist-clean product-in-use beats per type', () => {
  const types = [...PB.TYPES, PB.GENERIC];
  for (const type of types) {
    const beats = PB.beatsFor({ type, script: 'press the pump into your palm, then smooth it through the mid-lengths. scoop from the jar. a light mist on the hair.' });
    assert.ok(beats.length >= 1 && beats.length <= 2, `${type} beat count ${beats.length}`);
    assert.ok(beats.length <= PB.MAX_CLIPS);
    assert.equal(beats.length, 2, `${type} should return product then in-use`);
    assert.equal(beats[0].scene, 'product');
    assert.equal(beats[1].scene, 'in-use');
    assert.match(beats[1].prompt, /hands/i);
    assert.match(beats[1].prompt, /hair/i);
    for (const b of beats) {
      assert.equal(b.duration, 5);
      assert.equal(b.type, type === PB.GENERIC ? PB.GENERIC : type);
      const chk = A.checkAll({ broll: [{ prompt: b.prompt }] });
      assert.equal(chk.ok, true, `${type} blocked: ${chk.match || ''} :: ${b.prompt}`);
      assert.doesNotMatch(b.prompt, /finished hairstyle|before and after|before\/after/i);
    }
  }
  const serum = PB.beatsFor({ type: 'serum', name: 'Repair Serum', script: 'press the pump and smooth it through the lengths' });
  assert.ok(serum.some(b => /pump|serum/i.test(b.prompt)));
  const mask = PB.beatsFor({ type: 'mask', name: 'Repair Mask', script: 'scoop a little from the jar and work it through the lengths' });
  assert.ok(mask.some(b => /scoop|jar|mask/i.test(b.prompt)));
});

test('m31: cleanBeatPrompt and draft schema enforce the blocklist', () => {
  assert.equal(PB.cleanBeatPrompt('Close-up of a finished hairstyle on a client'), null);
  assert.equal(PB.cleanBeatPrompt('A before and after of the color'), null);
  assert.ok(PB.cleanBeatPrompt('Close-up of hands smoothing serum over hair lengths on a marble counter.'));
  const schema = PB.draftBrollSchema({ productType: 'serum', productName: 'Repair Serum' });
  assert.ok(schema);
  assert.match(schema.jsonExample, /product-in-use beat for a serum/);
  assert.equal(A.checkAll({ broll: [{ prompt: schema.jsonExample }, { prompt: schema.rules }] }).ok, true);
  assert.equal(PB.draftBrollSchema({}), null, 'no type => generic production draft');
  const draft = A.draftPrompt({ template: 'promo', salon: 'Olya Atelier', mood: 'Clean', language: 'English', productType: 'serum', productName: 'Repair Serum' });
  assert.match(draft, /product-in-use beat for a serum/);
  assert.doesNotMatch(draft, /generic salon atmosphere or process shot/);
});

test('m31: compositor places the real product on the 720x1280 marble still', async () => {
  const dir = tmpDir();
  const product = makeProduct({ dest: path.join(dir, 'serum.jpg'), kind: 'serum' });
  const out = path.join(dir, 'first.png');
  const r = await PB.composeFirstFrame({ productFile: product, out });
  assert.equal(r.width, 720); assert.equal(r.height, 1280);
  assert.deepEqual(probeWxH(out), { w: 720, h: 1280 });
  assert.equal(r.product.baseY, 960);
  assert.ok(r.product.w > 40 && r.product.h > 40);
  assert.ok(r.product.y + r.product.h === r.product.baseY || Math.abs((r.product.y + r.product.h) - r.product.baseY) <= 1);
  assert.ok(r.product.x >= 0 && r.product.x + r.product.w <= 720);
  assert.ok(r.product.y >= 0 && r.product.y + r.product.h <= 1280);
  assert.ok(fs.existsSync(r.cutout));
  const a = fs.readFileSync(out), b = fs.readFileSync(SURFACE);
  assert.notEqual(a.length, b.length);
  // Label box sits on the product, used later for the warp check.
  assert.ok(r.label.w > 8 && r.label.h > 8);
  assert.ok(r.label.x >= r.product.x && r.label.x + r.label.w <= r.product.x + r.product.w);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31: in-use compositor places the real product at the edge of the sanctioned salon still', async () => {
  assert.equal(PB.inUseSurfaceAvailable(), true);
  const dir = tmpDir();
  const product = makeProduct({ dest: path.join(dir, 'serum.jpg'), kind: 'serum' });
  const out = path.join(dir, 'in_use.png');
  const r = await PB.composeInUseFirstFrame({ productFile: product, out });
  assert.equal(r.width, 720); assert.equal(r.height, 1280);
  assert.deepEqual(probeWxH(out), { w: 720, h: 1280 });
  assert.equal(r.product.baseY, PB.IN_USE_COMPOSE.baseY);
  assert.equal(r.product.x, PB.IN_USE_COMPOSE.x);
  assert.ok(r.product.w <= PB.IN_USE_COMPOSE.maxW);
  assert.ok(r.product.h <= PB.IN_USE_COMPOSE.maxH);
  assert.ok(r.product.x >= 0 && r.product.x + r.product.w <= 720);
  assert.ok(r.label.w > 8 && r.label.h > 8);
  assert.ok(r.label.x >= r.product.x && r.label.x + r.label.w <= r.product.x + r.product.w);
  const a = fs.readFileSync(out), b = fs.readFileSync(PB.IN_USE_SURFACE);
  assert.notEqual(a.length, b.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31: SSIM of the label region detects a warp and leaves an identical pair clean', async () => {
  const dir = tmpDir();
  const product = makeProduct({ dest: path.join(dir, 'serum.jpg'), kind: 'serum' });
  const first = path.join(dir, 'first.png');
  const composed = await PB.composeFirstFrame({ productFile: product, out: first });
  const same = await PB.ssimOnPair(first, first, composed.label);
  assert.ok(same.ssim != null && same.ssim >= 0.99, `identical ssim ${same.ssim}`);
  assert.equal(same.warped, false);
  // A clearly warped/replaced label crop must fall under the 0.84 threshold.
  const warped = path.join(dir, 'warped.png');
  const { x, y, w, h } = composed.label;
  execFileSync('ffmpeg', ['-y', '-i', first, '-vf', `drawbox=${x}:${y}:${w}:${h}:color=black:t=fill`, warped], { stdio: 'pipe' });
  const bad = await PB.ssimOnPair(first, warped, composed.label);
  assert.ok(bad.ssim != null && bad.ssim < PB.LABEL_SSIM_MIN, `warped ssim ${bad.ssim} should be < ${PB.LABEL_SSIM_MIN} (box ${w}x${h} at ${x},${y})`);
  assert.equal(bad.warped, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31: a warped label falls back to a static push-in of the real composited photo', async () => {
  const dir = tmpDir();
  const product = makeProduct({ dest: path.join(dir, 'serum.jpg'), kind: 'serum' });
  let runwayCalls = 0, pushCalls = 0;
  const clips = await PB.buildClips(
    { productFile: product, type: 'serum', name: 'Repair Serum', script: 'press the pump into your palm', clipSeconds: 1, beats: PB.beatsFor({ type: 'serum' }).slice(0, 1) },
    {
      dir,
      runwayClip: async ({ dest }) => {
        runwayCalls += 1;
        writeTinyMp4(dest, { t: 0.4, color: '0x112233' });
        return { file: dest, reused: false };
      },
      checkWarp: async () => ({ warped: true, ssim: 0.4, threshold: PB.LABEL_SSIM_MIN, samples: [] }),
      pushIn: async ({ still, dest, duration }) => {
        pushCalls += 1;
        assert.ok(fs.existsSync(still));
        writeTinyMp4(dest, { t: duration || 1, color: '0xAABBCC' });
        return { file: dest, fallback: 'static_push_in', duration };
      },
    },
  );
  assert.equal(clips.length, 1);
  assert.equal(runwayCalls, 1);
  assert.equal(pushCalls, 1);
  assert.equal(clips[0].fallback, 'static_push_in');
  assert.ok(fs.existsSync(clips[0].file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31: at most two gen4_turbo 5s clips and the promo estimate stays at $0.50', () => {
  assert.equal(PB.MAX_CLIPS, 2);
  assert.equal(PB.CLIP_SECONDS, 5);
  assert.equal(RWC.DEFAULT_MODEL, 'gen4_turbo');
  assert.deepEqual(PB.clipEstimate(), { model: 'gen4_turbo', duration: 5, credits: 25, usd: 0.25 });
  assert.equal(PB.maxPromoUsd(), 0.5);
  const many = { product: { type: 'serum' }, broll: { clips: [{}, {}, {}, {}] } };
  assert.equal(PB.plannedClipCount(many, { PROMO_BROLL_MODE: 'contextual' }), 2);
  assert.equal(PB.plannedClipCount(many, {}), 1);
});

test('m31: buildClips caps at two clips and re-edits reuse stored dest files without another Runway call', async () => {
  const dir = tmpDir();
  const product = makeProduct({ dest: path.join(dir, 'mask.jpg'), kind: 'mask' });
  const beats = [
    ...PB.beatsFor({ type: 'mask', script: 'scoop from the jar and work it through the lengths' }),
    { id: 'extra', type: 'mask', prompt: PB.beatsFor({ type: 'mask' })[0].prompt, duration: 5 },
  ];
  assert.ok(beats.length >= 3);
  let generates = 0;
  const rw = {
    imageToVideo: async () => { throw new Error('buildClips must go through runwayClip, not rw directly'); },
  };
  const runwayClip = async (opts) => {
    const r = await TR.runwayClip({ ...opts, rw: { imageToVideo: async () => { generates += 1; return { task_id: 't', model: 'gen4_turbo', estimate: { usd: 0.25 } }; }, waitForTask: async () => ({ output: ['https://x'] }), download: async (_u, d) => writeTinyMp4(d, { t: 0.4 }) } });
    return r;
  };
  const first = await PB.buildClips({ productFile: product, type: 'mask', name: 'Repair Mask', beats, skipCompose: false }, { dir, rw, runwayClip, checkWarp: async () => ({ warped: false, ssim: 1, samples: [] }) });
  assert.equal(first.length, 2, 'third beat must be dropped');
  assert.equal(generates, 2);
  assert.ok(fs.existsSync(path.join(dir, 'broll_a.mp4')));
  assert.ok(fs.existsSync(path.join(dir, 'broll_b.mp4')));
  assert.equal(first.every(c => c.reused === false), true);

  const second = await PB.buildClips({ productFile: product, type: 'mask', name: 'Repair Mask', beats, skipCompose: false }, { dir, rw, runwayClip, checkWarp: async () => { throw new Error('should not warp-check a reused clip'); } });
  assert.equal(second.length, 2);
  assert.equal(generates, 2, 're-edit must not call Runway again');
  assert.equal(second.every(c => c.reused === true), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31: production buildPromoBroll stays on one generic clip when buildClips is not set', async () => {
  const dir = tmpDir();
  const calls = [];
  const rw = { imageToVideo: async b => { calls.push(b); return { task_id: 't', model: 'gen4_turbo', estimate: { usd: 0.25 } }; }, waitForTask: async () => ({ output: ['https://x'] }), download: async (_u, d) => writeTinyMp4(d, { t: 0.4 }) };
  const b = await TR.buildPromoBroll({ styleAStill: SURFACE, compositeProduct: false, includeB: true }, { rw, dir });
  assert.equal(calls.length, 1);
  assert.equal(b.length, 1);
  assert.equal(b[0].composite, false);
  assert.equal(calls[0].promptText, A.BROLL_PROMPTS.a);
  fs.rmSync(dir, { recursive: true, force: true });
});
