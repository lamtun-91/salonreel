// Licensed music library (Mixkit Stock Music Free License; see music/manifest.json for per-track source + licence).
'use strict';
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, 'music');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const MOOD_LABEL = { warm: 'Warm & confident', luxe: 'Luxe & velvet', upbeat: 'Upbeat pop', chill: 'Chill', edgy: 'Edgy', edm: 'EDM' };
const TRACKS = {};
for (const t of manifest.tracks) {
  TRACKS[t.id] = { label: `${t.label} · ${MOOD_LABEL[t.mood] || t.mood}`, name: t.label, mood: t.mood, moodLabel: MOOD_LABEL[t.mood] || t.mood,
    bpm: t.bpm, drop_s: t.drop_s, duration_s: t.duration_s, file: path.join(__dirname, t.file), ext: path.extname(t.file).slice(1),
    title: t.title, artist: t.artist, license: t.license, source_url: t.source_url };
}
TRACKS.none = { label: 'No music', name: 'No music', mood: 'none', moodLabel: 'No music', bpm: 100 };
// retired ffmpeg-synth placeholders -> closest real track (old projects keep working)
const LEGACY = { velvet: 'velvet-house', glow: 'one-more-dance', silk: 'green-chair' };
const DEFAULT = 'velvet-house';
const resolve = id => TRACKS[id] ? id : LEGACY[id] || DEFAULT;
const fileFor = id => { const t = TRACKS[resolve(id)]; return t && t.file && fs.existsSync(t.file) ? t.file : null; };
const bpmFor = id => TRACKS[resolve(id)]?.bpm || 100;
const dropFor = id => TRACKS[resolve(id)]?.drop_s ?? null;
module.exports = { manifest, TRACKS, LEGACY, DEFAULT, MOOD_LABEL, resolve, fileFor, bpmFor, dropFor };
