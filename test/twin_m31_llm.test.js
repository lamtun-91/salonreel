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
const validClip = (prompt, extra = {}) => ({
  prompt, duration: 5, ratio: '720:1280', rationale: 'motion only', ...extra,
});
const VALID = [
  validClip('The camera eases in as window light drifts across the label.'),
  validClip('The camera holds as a slow shimmer moves through the liquid.'),
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

test('m31 llm: system prompt is Tung\'s text verbatim', () => {
  assert.equal(PB.PROMPT_SYSTEM, VERBATIM);
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
    return pack(VALID);
  };
  const r = await PB.writeRunwayPrompts({
    firstFrame: first, productFile: product, name: 'Olya Atelier — Repair Serum', type: 'serum',
    script: 'A light pump, then smooth through the mid-lengths.', count: 2,
  }, { llm, env: {} });
  assert.equal(r.source, 'llm');
  assert.equal(r.model, 'gen4_turbo');
  assert.equal(r.calls, 1);
  assert.equal(calls, 1);
  assert.equal(r.clips.length, 2);
  assert.equal(r.clips[0].prompt, VALID[0].prompt);
  assert.equal(r.clips[1].prompt, VALID[1].prompt);
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
