'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const M = require('../music'), S = require('../studio');
test('manifest: 12-15 licensed tracks with required fields, shipped files, under 15 MB', () => {
  const ts = M.manifest.tracks; assert.ok(ts.length >= 12 && ts.length <= 15);
  let bytes = 0;
  for (const t of ts) {
    for (const k of ['id', 'label', 'title', 'artist', 'mood', 'source_url', 'license', 'license_url', 'duration_s', 'bpm']) assert.ok(t[k] != null && t[k] !== '', `${t.id} ${k}`);
    assert.equal(t.license, 'Mixkit Stock Music Free License'); assert.match(t.source_url, /^https:\/\/mixkit\.co\/free-stock-music\//);
    assert.equal(t.attribution_required, false);
    const f = path.join(__dirname, '..', t.file); assert.ok(fs.existsSync(f), f); bytes += fs.statSync(f).size;
    assert.ok(t.duration_s >= 15 && t.duration_s <= 60.5);
    const r = t.bpm_check / t.bpm; assert.ok([0.5, 1, 2].some(x => Math.abs(r - x) / x < 0.05), `${t.id} bpm ${t.bpm} vs ${t.bpm_check}`);
    assert.doesNotMatch(t.label, /grok|xai/i);
  }
  assert.ok(bytes < 15 * 1024 * 1024, String(bytes));
  const moods = new Set(ts.map(t => t.mood)); for (const m of ['warm', 'luxe', 'upbeat', 'chill', 'edgy', 'edm']) assert.ok(moods.has(m), m);
  assert.ok(ts.filter(t => t.mood === 'edm').length >= 4);
});
test('legacy synth ids resolve to real tracks; no synth placeholders left', () => {
  for (const k of ['velvet', 'glow', 'silk']) { assert.ok(M.fileFor(k)); assert.equal(M.TRACKS[k], undefined); }
  assert.ok(Object.values(M.TRACKS).every(t => !t.expr));
});
test('beat grid uses each track bpm; drop-based music start lands the drop on the reveal, on the grid', () => {
  for (const t of M.manifest.tracks) {
    const g = S.beatGrid(t.id, 10); assert.ok(Math.abs(g[1] - 60 / t.bpm) < 0.011, t.id);
    if (t.drop_s == null) continue;
    const reveal = Math.round(9 / (60 / t.bpm)) * (60 / t.bpm); // a reveal start on the beat grid
    const ms = S.musicStart(0, t.id, reveal);
    assert.equal(ms.music_start_source, 'drop', t.id);
    assert.ok(Math.abs(ms.music_start_s + reveal - t.drop_s) <= 60 / t.bpm / 2 + 0.01, `${t.id} drop ${t.drop_s} vs ${ms.music_start_s + reveal}`);
  }
});
