'use strict';
// M3.1 vision LLM Runway prompt writer. LLM is always mocked. No Runway or HeyGen calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const PB = require('../promo_broll');
const A = require('../avatar');
const RWC = require('../runway_client');

const ROOT = path.join(__dirname, '..');

function tmpDir(p = 'm31llm_') { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function tinyJpeg(dest) {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=white:s=64x64', '-frames:v', '1', dest], { stdio: 'pipe' });
  return dest;
}
function makeProduct(dest, kind = 'serum') {
  const body = kind === 'mask'
    ? 'drawbox=60:260:280:280:color=0xC4B09A:t=fill,drawbox=110:340:180:120:color=0xF4F0E6:t=fill'
    : 'drawbox=130:80:140:80:color=0xF2F2F2:t=fill,drawbox=120:160:160:420:color=0xD9C48A:t=fill,drawbox=145:260:110:140:color=0xF4F0E6:t=fill';
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=white:s=400x640', '-vf', body, '-frames:v', '1', dest], { stdio: 'pipe' });
  return dest;
}
const validClip = (prompt, extra = {}) => ({
  prompt, duration: 5, ratio: '720:1280', rationale: 'motion only', ...extra,
});
const VALID = [
  validClip('The camera eases in as window light drifts across the label.', { scene: 'product' }),
  validClip('The camera holds as a stylist\'s hands smooth the product through the mid-lengths of a seated customer\'s hair.', { scene: 'in-use' }),
];
function pack(clips) { return JSON.stringify({ clips }); }

const VERBATIM = `You write Runway Gen-4.5 image-to-video prompts for salon product B-roll.
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

test('m31 llm: system prompt keeps Tung\'s rules verbatim and requires product then in-use scenes', () => {
  assert.equal(PB.TUNG_PROMPT_RULES, VERBATIM);
  assert.ok(PB.PROMPT_SYSTEM.startsWith(VERBATIM));
  assert.match(PB.PROMPT_SYSTEM, /Scene 1 \(product\)/);
  assert.match(PB.PROMPT_SYSTEM, /Scene 2 \(in-use\)/);
  assert.match(PB.PROMPT_SYSTEM, /stylist'?s hands apply the product through the customer'?s hair lengths/i);
  assert.match(PB.PROMPT_SYSTEM, /no bottle or jar in the shot/i);
  assert.doesNotMatch(PB.PROMPT_SYSTEM, /face|back or side of the head|out of frame/i);
});

test('m31 llm: broll model defaults to gen4_turbo; gen4.5 only inside the $1 cap and ledger remainder', () => {
  assert.equal(PB.BROLL_MODEL_ENV, 'RUNWAY_BROLL_MODEL');
  assert.equal(PB.brollModel({}), 'gen4_turbo');
  assert.equal(PB.brollModel({ RUNWAY_BROLL_MODEL: '' }), 'gen4_turbo');
  assert.equal(PB.brollModel({ RUNWAY_BROLL_MODEL: 'gen4_turbo' }), 'gen4_turbo');
  assert.equal(PB.brollModel({ RUNWAY_MODEL: 'gen4.5' }), 'gen4_turbo', 'RUNWAY_MODEL alone must not switch B-roll to gen4.5');
  assert.equal(PB.brollModel({ RUNWAY_BROLL_MODEL: 'gen4.5' }), 'gen4.5');
  assert.equal(RWC.estimateCost({ model: 'gen4.5', duration: 5 }).usd, 0.6);
  assert.equal(PB.brollModel({ RUNWAY_BROLL_MODEL: 'gen4.5' }, { ledgerStatus: { remaining_usd: 0.6 } }), 'gen4.5');
  assert.equal(PB.brollModel({ RUNWAY_BROLL_MODEL: 'gen4.5' }, { ledgerStatus: { remaining_usd: 0.4 } }), 'gen4_turbo');
  const envEx = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(envEx, /# RUNWAY_BROLL_MODEL=gen4_turbo/);
  assert.doesNotMatch(envEx, /^RUNWAY_BROLL_MODEL=/m);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8'), /RUNWAY_BROLL_MODEL/);
});

test('m31 llm: duration and ratio are clamped; 10s gen4.5 exceeds the $1 cap so it becomes 5s', () => {
  assert.equal(PB.clampClipDuration(5, 'gen4_turbo'), 5);
  assert.equal(PB.clampClipDuration(10, 'gen4_turbo'), 10);
  assert.equal(PB.clampClipDuration(7, 'gen4_turbo'), 5);
  assert.equal(PB.clampClipDuration('nope', 'gen4_turbo'), 5);
  assert.equal(PB.clampClipDuration(10, 'gen4.5'), 5);
  assert.equal(RWC.estimateCost({ model: 'gen4.5', duration: 10 }).usd, 1.2);
});

test('m31 llm: a valid JSON response becomes two planned clips with rationale stored', async () => {
  const dir = tmpDir();
  const first = tinyJpeg(path.join(dir, 'first.jpg'));
  const product = tinyJpeg(path.join(dir, 'product.jpg'));
  let calls = 0;
  const llm = async ({ system, text, images, effort }) => {
    calls += 1;
    assert.equal(system, PB.PROMPT_SYSTEM);
    assert.equal(effort, 'low');
    assert.ok(images.length >= 1);
    assert.match(text, /Repair Serum/);
    assert.match(text, /serum/);
    assert.match(text, /Scene 1 is the product scene/);
    assert.match(text, /Scene 2 is the in-use scene/);
    assert.ok(images.length >= 2, "product still plus in-use still (and optional product photo)");
    return pack(VALID);
  };
  const inUse = tinyJpeg(path.join(dir, 'inuse.jpg'));
  const r = await PB.writeRunwayPrompts({
    firstFrame: first, inUseFirstFrame: inUse, productFile: product, name: 'Olya Atelier — Repair Serum', type: 'serum',
    script: 'A light pump, then smooth through the mid-lengths.', count: 2,
  }, { llm, env: {} });
  assert.equal(r.source, 'llm');
  assert.equal(r.model, 'gen4_turbo');
  assert.equal(r.calls, 1);
  assert.equal(calls, 1);
  assert.equal(r.clips.length, 2);
  assert.equal(r.clips[0].prompt, VALID[0].prompt);
  assert.equal(r.clips[1].prompt, VALID[1].prompt);
  assert.equal(r.clips[0].scene, 'product');
  assert.equal(r.clips[1].scene, 'in-use');
  assert.equal(r.clips[0].rationale, 'motion only');
  assert.equal(r.clips[0].duration, 5);
  assert.equal(r.clips[0].ratio, '720:1280');
  assert.equal(r.clips[0].source, 'llm');
  assert.equal(A.checkAll({ broll: r.clips.map(c => ({ prompt: c.prompt })) }).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31 llm: a negation word triggers one re-prompt, then the cleaned reply is used', async () => {
  const dir = tmpDir();
  const first = tinyJpeg(path.join(dir, 'first.jpg'));
  const texts = [];
  const llm = async ({ text }) => {
    texts.push(text);
    if (texts.length === 1) {
      return pack([
        validClip('The camera pushes in. Do not move the bottle.'),
        VALID[1],
      ]);
    }
    return pack(VALID);
  };
  const r = await PB.writeRunwayPrompts({ firstFrame: first, name: 'Repair Serum', type: 'serum', script: 'x', count: 2 }, { llm, env: {} });
  assert.equal(texts.length, 2);
  assert.match(texts[1], /negation word/i);
  assert.equal(r.source, 'llm');
  assert.equal(r.calls, 2);
  assert.equal(r.clips[0].prompt, VALID[0].prompt);
  assert.equal(PB.hasNegation(r.clips[0].prompt), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31 llm: invalid JSON is retried once, then falls back to the BEATS templates', async () => {
  const dir = tmpDir();
  const first = tinyJpeg(path.join(dir, 'first.jpg'));
  let calls = 0;
  const llm = async () => { calls += 1; return 'this is not json {'; };
  const r = await PB.writeRunwayPrompts({ firstFrame: first, name: 'Repair Mask', type: 'mask', script: 'scoop from the jar', count: 2 }, { llm, env: {} });
  assert.equal(calls, 2);
  assert.equal(r.source, 'template');
  assert.equal(r.calls, 2);
  assert.equal(r.clips.length, 2);
  assert.ok(r.clips.every(c => c.source === 'template'));
  assert.ok(r.clips.every(c => A.checkAll({ broll: [{ prompt: c.prompt }] }).ok));
  const templates = PB.beatsFor({ type: 'mask', script: 'scoop from the jar' });
  assert.equal(r.clips[0].prompt, templates[0].prompt);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31 llm: duration and ratio values on a valid reply are clamped', async () => {
  const dir = tmpDir();
  const first = tinyJpeg(path.join(dir, 'first.jpg'));
  const llmTurbo = async () => pack([
    { prompt: VALID[0].prompt, duration: 10, ratio: '1280:720', rationale: 'slow push' },
    { prompt: VALID[1].prompt, duration: 7, ratio: '720:1280', rationale: 'hold' },
  ]);
  const turbo = await PB.writeRunwayPrompts({ firstFrame: first, name: 'Repair Serum', type: 'serum', count: 2 }, { llm: llmTurbo, env: {} });
  assert.equal(turbo.source, 'llm');
  assert.equal(turbo.clips[0].duration, 10, 'gen4_turbo 10s is $0.50, under the $1 cap');
  assert.equal(turbo.clips[0].ratio, '720:1280');
  assert.equal(turbo.clips[1].duration, 5);

  const llm45 = async () => pack([
    { prompt: VALID[0].prompt, duration: 10, ratio: '1280:720', rationale: 'slow push' },
    { prompt: VALID[1].prompt, duration: 5, ratio: '720:1280', rationale: 'hold' },
  ]);
  const g45 = await PB.writeRunwayPrompts({ firstFrame: first, name: 'Repair Serum', type: 'serum', count: 2 }, { llm: llm45, env: { RUNWAY_BROLL_MODEL: 'gen4.5' } });
  assert.equal(g45.model, 'gen4.5');
  assert.equal(g45.clips[0].duration, 5, 'gen4.5 10s is $1.20, clamp to 5');
  assert.equal(g45.clips[0].ratio, '720:1280');
  assert.equal(g45.clips[0].model, 'gen4.5');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31 llm: a blocklist hit is re-prompted once, then falls back if it is still blocked', async () => {
  const dir = tmpDir();
  const first = tinyJpeg(path.join(dir, 'first.jpg'));
  const blocked = validClip('The camera pulls back as the finished hairstyle is revealed.');
  assert.equal(A.checkAll({ broll: [{ prompt: blocked.prompt }] }).ok, false);
  let calls = 0;
  const llmRetry = async () => { calls += 1; return calls === 1 ? pack([blocked, VALID[1]]) : pack(VALID); };
  const ok = await PB.writeRunwayPrompts({ firstFrame: first, name: 'Repair Serum', type: 'serum', count: 2 }, { llm: llmRetry, env: {} });
  assert.equal(calls, 2);
  assert.equal(ok.source, 'llm');
  assert.equal(ok.clips[0].prompt, VALID[0].prompt);
  assert.equal(A.checkAll({ broll: ok.clips.map(c => ({ prompt: c.prompt })) }).ok, true);

  calls = 0;
  const llmStuck = async () => { calls += 1; return pack([blocked, blocked]); };
  const fb = await PB.writeRunwayPrompts({ firstFrame: first, name: 'Repair Serum', type: 'serum', count: 2 }, { llm: llmStuck, env: {} });
  assert.equal(calls, 2);
  assert.equal(fb.source, 'template');
  assert.ok(fb.clips.every(c => A.checkAll({ broll: [{ prompt: c.prompt }] }).ok));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31 llm: without an llm or a first frame the writer uses BEATS and never calls the network', async () => {
  const noLlm = await PB.writeRunwayPrompts({ name: 'Repair Serum', type: 'serum', count: 2 }, { env: {} });
  assert.equal(noLlm.source, 'template');
  assert.equal(noLlm.calls, 0);
  let calls = 0;
  const missing = await PB.writeRunwayPrompts({ firstFrame: '/tmp/does-not-exist.jpg', name: 'Repair Serum', type: 'serum', count: 2 }, { llm: async () => { calls += 1; return pack(VALID); }, env: {} });
  assert.equal(calls, 0);
  assert.equal(missing.source, 'template');
});

test('m31 llm: planned cost per promo is $0.50 on gen4_turbo 5s and $1.20 on gen4.5 5s for two clips', () => {
  assert.equal(PB.maxPromoUsd('gen4_turbo'), 0.5);
  assert.equal(PB.clipEstimate('gen4_turbo').usd, 0.25);
  assert.equal(RWC.estimateCost({ model: 'gen4.5', duration: 5 }).usd * 2, 1.2);
  assert.equal(PB.maxPromoUsd('gen4.5'), 1.2);
});

test('m31 llm: buildClips uses the product still for scene 1 and the in-use still for scene 2', async () => {
  const dir = tmpDir();
  const product = makeProduct(path.join(dir, 'product.jpg'));
  const llm = async ({ text, images }) => {
    assert.ok(images.length >= 2);
    assert.match(text, /in-use scene/i);
    return pack(VALID);
  };
  const clips = await PB.buildClips(
    { productFile: product, type: 'serum', name: 'Repair Serum', script: 'smooth through the mid-lengths', clipSeconds: 5 },
    {
      dir, llm, env: {},
      runwayClip: async ({ dest, still }) => {
        fs.copyFileSync(still, dest.replace(/\.mp4$/, '_still_used.png'));
        const { execFileSync } = require('child_process');
        execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=0x445566:s=720x1280:d=0.3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-t', '0.3', '-an', dest], { stdio: 'pipe' });
        return { file: dest, reused: false };
      },
      checkWarp: async () => ({ warped: false, ssim: 0.99, threshold: PB.LABEL_SSIM_MIN, samples: [] }),
    },
  );
  assert.equal(clips.length, 2);
  assert.equal(clips[0].scene, 'product');
  assert.equal(clips[1].scene, 'in-use');
  assert.ok(clips[0].still.endsWith('broll_a_still.png'));
  assert.ok(clips[1].still.endsWith('broll_b_still.png'));
  const a = fs.readFileSync(clips[0].still);
  const b = fs.readFileSync(clips[1].still);
  assert.notEqual(a.equals(b), true, 'product and in-use first frames must differ');
  assert.equal(clips[1].label, null);
  const same = await PB.ssimOnPair(clips[1].still, PB.IN_USE_SURFACE, { x: 0, y: 0, w: 720, h: 1280 });
  assert.ok(same.ssim != null && same.ssim >= 0.98, `scene 2 still should be the bare in-use asset, ssim=${same.ssim}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('m31 llm: scene 1 keeps the SSIM label check; scene 2 skips it', async () => {
  const dir = tmpDir();
  const product = makeProduct(path.join(dir, 'product.jpg'));
  let warpCalls = 0, pushCalls = 0;
  const clips = await PB.buildClips(
    { productFile: product, type: 'serum', name: 'Repair Serum', beats: PB.beatsFor({ type: 'serum' }) },
    {
      dir, env: {},
      runwayClip: async ({ dest }) => {
        const { execFileSync } = require('child_process');
        execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=0x112233:s=720x1280:d=0.3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-t', '0.3', '-an', dest], { stdio: 'pipe' });
        return { file: dest, reused: false };
      },
      checkWarp: async () => { warpCalls += 1; return { warped: true, ssim: 0.2, threshold: PB.LABEL_SSIM_MIN, samples: [] }; },
      pushIn: async ({ dest, duration }) => {
        pushCalls += 1;
        const { execFileSync } = require('child_process');
        execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=0xAABBCC:s=720x1280:d=0.3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-t', String(duration || 0.3), '-an', dest], { stdio: 'pipe' });
        return { file: dest, fallback: 'static_push_in', duration };
      },
    },
  );
  assert.equal(clips.length, 2);
  assert.equal(warpCalls, 1, 'only the product scene is label-checked');
  assert.equal(pushCalls, 1);
  assert.equal(clips[0].fallback, 'static_push_in');
  assert.equal(clips[1].fallback, null);
  assert.equal(clips[1].warp, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

