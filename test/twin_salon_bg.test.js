'use strict';
// Salon interior background (TWIN_SALON_BACKGROUND), flag off by default. No paid renders here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const C = require('../heygen_client');
const A = require('../avatar');

const FAKE = 'hg_test_key_DO_NOT_LEAK_123';
const env = { HEYGEN_API_KEY: FAKE };
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const mockFetch = (handler) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); }; f.calls = calls; return f; };

test('salon bg flag off: payload has no background or remove_background', () => {
  const b = C.avatarVideoBody({ avatar_id: 'Daphne_public_4', voice_id: 'v', script: 's' });
  assert.equal('background' in b, false);
  assert.equal('remove_background' in b, false);
  assert.equal(C.salonBackground({}), null);
  assert.equal(C.salonBackground({ TWIN_SALON_BACKGROUND: '0', PUBLIC_BASE_URL: 'https://salonreel.onrender.com' }), null);
  assert.equal(C.pushInAmount({}), 0);
  assert.equal(C.pushInAmount({ TWIN_SALON_BACKGROUND: '0' }), 0);
});

test('salon bg flag on: image url + asset_id, and push-in defaults', () => {
  const urlEnv = { TWIN_SALON_BACKGROUND: '1', TWIN_SALON_BACKGROUND_URL: 'https://example.com/twin/salon_interior.jpg' };
  assert.deepEqual(C.salonBackground(urlEnv), { type: 'image', url: 'https://example.com/twin/salon_interior.jpg' });
  const pubEnv = { TWIN_SALON_BACKGROUND: '1', PUBLIC_BASE_URL: 'https://salonreel.onrender.com/' };
  assert.deepEqual(C.salonBackground(pubEnv), { type: 'image', url: 'https://salonreel.onrender.com' + C.SALON_BG_PUBLIC_PATH });
  const idEnv = { TWIN_SALON_BACKGROUND: '1', TWIN_SALON_BACKGROUND_ASSET_ID: 'asset_abc' };
  assert.deepEqual(C.salonBackground(idEnv), { type: 'image', asset_id: 'asset_abc' });
  assert.throws(() => C.salonBackground({ TWIN_SALON_BACKGROUND: '1' }), e => e.code === 'bad_request');
  assert.throws(() => C.salonBackground({ TWIN_SALON_BACKGROUND: '1', TWIN_SALON_BACKGROUND_URL: 'http://insecure.example/x.jpg' }), /HTTPS/);
  assert.equal(C.pushInAmount(urlEnv), C.DEFAULT_PUSH_IN);
  assert.equal(C.pushInAmount({ ...urlEnv, TWIN_SALON_PUSH_IN: '0' }), 0);
  assert.equal(C.pushInAmount({ ...urlEnv, TWIN_SALON_PUSH_IN: '0.05' }), 0.05);
  assert.equal(C.pushInAmount({ ...urlEnv, TWIN_SALON_PUSH_IN: '1' }), 0.08);
});

test('salon bg flag on: createAvatarVideo POST body uses BackgroundSetting + remove_background', async () => {
  const f = mockFetch(() => res(200, { data: { video_id: 'vbg' } }));
  const e = { ...env, TWIN_SALON_BACKGROUND: '1', TWIN_SALON_BACKGROUND_URL: 'https://salonreel.onrender.com/twin/salon_interior.jpg' };
  const logs = [];
  await C.createAvatarVideo({ avatar_id: 'Daphne_public_4', voice_id: 'vv', script: 'Short tip.' }, { fetchImpl: f, env: e, allowSpend: true, log: m => logs.push(m) });
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.type, 'avatar');
  assert.deepEqual(body.engine, { type: 'avatar_iii' });
  assert.equal(body.remove_background, true);
  assert.deepEqual(body.background, { type: 'image', url: 'https://salonreel.onrender.com/twin/salon_interior.jpg' });
  assert.equal('test' in body, false);
  assert.ok(logs.some(m => /salon_bg=1/.test(m)));
  const f2 = mockFetch(() => res(200, { data: { video_id: 'v2' } }));
  await C.createAvatarVideo({ avatar_id: 'Daphne_public_4', voice_id: 'vv', script: 'Short tip.' }, { fetchImpl: f2, env, allowSpend: true, log: () => {} });
  const b2 = JSON.parse(f2.calls[0].init.body);
  assert.equal('background' in b2, false);
  assert.equal('remove_background' in b2, false);
});

test('salon bg: default twinAssembleArgs filter is unchanged; pushIn adds a slow zoom', () => {
  const off = A.twinAssembleArgs({ talking: 'raw.mp4', total: 20, assPath: '/tmp/x.ass', out: 'o.mp4' });
  const fc = off[off.indexOf('-filter_complex') + 1];
  assert.match(fc, /\[0:v\]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30\[bg\]/);
  assert.doesNotMatch(fc, /eval=frame/);
  const on = A.twinAssembleArgs({ talking: 'raw.mp4', total: 20, assPath: '/tmp/x.ass', out: 'o.mp4', pushIn: 0.04 });
  const fc2 = on[on.indexOf('-filter_complex') + 1];
  assert.match(fc2, /eval=frame/);
  assert.match(fc2, /1080\*\(1\+0\.04\*t\/20\.000\)/);
  assert.match(fc2, /crop=1080:1920/);
  assert.doesNotMatch(fc2, /overlay/);
});

test('salon bg: push-in ffmpeg filter produces 1080x1920', { timeout: 30000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salon_bg_'));
  const src = path.join(dir, 'in.mp4'), out = path.join(dir, 'out.mp4'), ass = path.join(dir, 'x.ass');
  fs.writeFileSync(ass, '[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,60,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x806060:s=720x1280:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=220:d=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  execFileSync('ffmpeg', A.twinAssembleArgs({ talking: src, total: 1, assPath: ass, out, pushIn: 0.04, fontsdir: '/usr/share/fonts/truetype/dejavu' }));
  const dim = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
  assert.equal(dim, '1080,1920');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('salon bg asset is 1080x1920 and attributed (Pexels, commercial use)', () => {
  const ROOT = path.join(__dirname, '..');
  const img = path.join(ROOT, 'public/twin/salon_interior.jpg');
  const asset = path.join(ROOT, 'assets/salon_interior.jpg');
  assert.ok(fs.existsSync(img));
  assert.ok(fs.existsSync(asset));
  const att = fs.readFileSync(path.join(ROOT, 'assets/salon_interior.ATTRIBUTION.txt'), 'utf8');
  assert.match(att, /Marina Chocobar/);
  assert.match(att, /pexels\.com\/license/);
  assert.match(att, /7823407/);
  const dim = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', img], { encoding: 'utf8' }).trim();
  assert.equal(dim, '1080,1920');
});
