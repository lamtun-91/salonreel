'use strict';
// Twin draft length: 50-word floor, one LLM re-prompt, deterministic expansion, cost-guard consistency.
const test = require('node:test'), assert = require('node:assert/strict');
const A = require('../avatar'), SP = require('../speech'), C = require('../heygen_client');

const ctx = { template: 'tip', prompt: 'A short tip: how often should I trim if I am growing my hair out?',
  mood: 'Luxe', language: 'English', salon: 'Olya Atelier', avatar: { name: 'Studio host', role: 'sample' }, hasProduct: false };
const words = n => Array(n).fill('word').join(' ');
function draftJson(script) {
  return JSON.stringify({
    script,
    captions: [{ start_s: 0, end_s: 3, text: 'Hair tip' }, { start_s: 3, end_s: 6, text: 'Book via link in bio' }],
    broll: [{ prompt: 'Slow pan across an empty salon styling station with brushes', start_s: 4, end_s: 8 }],
    product: null, caption: 'A trim tip from Olya Atelier.', hashtags: ['hairtips'],
  });
}

test('draft length: min 50 / max 76 words, duration 15-30s, cost guard stays inside $0.50 and 30s', () => {
  assert.equal(A.DURATION.minWords, 50);
  assert.equal(A.DURATION.maxWords, 76);
  assert.equal(A.DURATION.maxWords, Math.floor(A.DURATION.max * SP.SPEECH.wordsPerSec * 0.85));
  for (const n of [A.DURATION.minWords, A.DURATION.words, A.DURATION.maxWords]) {
    const s = words(n);
    const dur = A.estimateDuration(s);
    assert.ok(dur >= A.DURATION.min && dur <= A.DURATION.max, `${n} words duration ${dur}`);
    const g = C.estimateCost({ script: s, engine: 'avatar_iii' });
    assert.ok(g.seconds <= C.GUARD.maxSeconds, `${n} words guard ${g.seconds}s`);
    assert.ok(g.usd <= C.GUARD.maxUsd, `${n} words $${g.usd}`);
  }
  for (const t of ['tip', 'faq', 'promo', 'booking']) {
    const d = A.mockDraft({ template: t, salon: 'Olya Atelier', avatar: { name: 'Olya' } });
    const n = SP.words(d.script.text);
    assert.ok(n >= A.DURATION.minWords && n <= A.DURATION.maxWords, `${t} words=${n}`);
    assert.ok(d.total_s >= 15 && d.total_s <= 30, `${t} ${d.total_s}`);
  }
});

test('writeAiDraft: a short first draft triggers one re-prompt; the 55-word rewrite is used', async () => {
  const short = 'Hi, I am Olya from Olya Atelier. Trim every ten to twelve weeks. Book via the link in bio.';
  const full = words(55);
  assert.ok(SP.words(short) < A.DURATION.minWords);
  const calls = [];
  const llm = async opts => { calls.push(opts); return draftJson(calls.length === 1 ? short : full); };
  const d = await A.writeAiDraft(ctx, llm, JSON.parse);
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /too short/);
  assert.match(calls[1].text, /about 55 words/);
  assert.equal(d.script.text, full);
  assert.equal(SP.words(d.script.text), 55);
  assert.equal(d.mode, 'ai');
  assert.ok(d.total_s >= 15 && d.total_s <= 30);
});

test('writeAiDraft: a still-short draft after the re-prompt gets the deterministic fallback', async () => {
  const short = 'Hi, I am Olya from Olya Atelier. Trim every ten to twelve weeks. Book via the link in bio.';
  const calls = [];
  const llm = async opts => { calls.push(opts); return draftJson(short); };
  const d = await A.writeAiDraft(ctx, llm, JSON.parse);
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /too short/);
  assert.ok(d.script.text.includes('Trim every ten to twelve weeks'));
  assert.ok(SP.words(d.script.text) >= A.DURATION.minWords, 'expanded to at least 50');
  assert.ok(SP.words(d.script.text) <= A.DURATION.maxWords);
  assert.ok(d.total_s >= 15 && d.total_s <= 30);
  const g = C.estimateCost({ script: d.script.text, engine: 'avatar_iii' });
  assert.ok(g.seconds <= C.GUARD.maxSeconds && g.usd <= C.GUARD.maxUsd);
  assert.equal(d.mode, 'ai');
});

test('writeAiDraft: a normal 55-word draft passes through untouched (no re-prompt)', async () => {
  const exact = words(55);
  const calls = [];
  const llm = async opts => { calls.push(opts); return draftJson(exact); };
  const d = await A.writeAiDraft(ctx, llm, JSON.parse);
  assert.equal(calls.length, 1);
  assert.equal(d.script.text, exact);
  assert.equal(SP.words(d.script.text), 55);
  assert.equal(d.mode, 'ai');
  assert.doesNotMatch(calls[0].text, /too short/);
});
