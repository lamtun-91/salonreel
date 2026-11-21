'use strict';
// "Your AI Twin" M1: flag gating, stub library operations, approval gate, guardrails, stub render, My Reels badges.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), express = require('express'), { execFile } = require('child_process');
const A = require('../avatar'), RA = require('../routes_avatar'), st = require('../storage'), P = require('../pipeline');
const ROOT = path.join(__dirname, '..');
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, out, err) => e ? rej(new Error(`${cmd} failed: ${(err || e.message).slice(-400)}`)) : res(out)));
const id = () => crypto.randomBytes(6).toString('hex');
const wrap = fn => (q, s) => fn(q, s).catch(e => s.status(500).json({ error: e.message }));
const D = (...p) => path.join(ROOT, 'data', ...p);
const deps = { llm: async () => { throw new Error('no LLM in tests'); }, parseJSON: JSON.parse, run, probe: async () => ({ duration: 1 }), cfg: () => ({ llmLive: false, provider: 'grok' }),
  TRACKS: require('../music').TRACKS, D, id, wrap, express };
async function serve(app) { const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); }); return { srv, B: `http://127.0.0.1:${srv.address().port}` }; }
const j = async (B, p, body, m) => { const r = await fetch(B + p, body === undefined && !m ? {} : { method: m || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const waitJob = async (B, pid) => { for (let i = 0; i < 200; i++) { const r = await j(B, `/api/twin/projects/${pid}/job`); if (r.body.state !== 'running') return r.body; await new Promise(z => setTimeout(z, 150)); } throw new Error('job timeout'); };
const made = [];
test.after(() => { for (const pid of made) fs.rmSync(D('store', 'projects', pid), { recursive: true, force: true }), fs.rmSync(D('cache', pid), { recursive: true, force: true });
  for (const d of fs.existsSync(D('store', 'twins')) ? fs.readdirSync(D('store', 'twins')) : []) if (d.startsWith('test-')) fs.rmSync(D('store', 'twins', d), { recursive: true, force: true }); });

// ---------- flag off ----------
test('flag helper: off by default, on only for ENABLE_AI_TWIN=1', () => {
  assert.equal(RA.enabled({}), false); assert.equal(RA.enabled({ ENABLE_AI_TWIN: '0' }), false); assert.equal(RA.enabled({ ENABLE_AI_TWIN: 'true' }), false); assert.equal(RA.enabled({ ENABLE_AI_TWIN: '1' }), true);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /if \(process\.env\.ENABLE_AI_TWIN === '1'\) require\('\.\/routes_avatar'\)\(/, 'routes_avatar is mounted only behind the flag');
  assert.match(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'), /^ENABLE_AI_TWIN=0$/m);
});
test('flag off: /api/twin/* is 404, Twin page/assets 404, Hair Reveal page still served', async () => {
  const app = express(); app.use(express.json()); app.use(RA.staticGuard({})); app.use(express.static(path.join(ROOT, 'public')));
  require('../routes_studio')({ app, ...deps }); // same as server.js with the flag off: routes_avatar not mounted
  const { srv, B } = await serve(app);
  try {
    for (const p of ['/api/twin/config', '/api/twin/avatars', '/api/twin/projects/abcdefabcdef']) assert.equal((await fetch(B + p)).status, 404, p);
    assert.equal((await fetch(B + '/api/twin/projects', { method: 'POST' })).status, 404);
    for (const p of ['/twin.html', '/twin.js', '/twin/thumb-owner.svg']) assert.equal((await fetch(B + p)).status, 404, p);
    const idx = await fetch(B + '/'); assert.equal(idx.status, 200); assert.match(await idx.text(), /Plan a new Reel/);
    assert.equal((await fetch(B + '/api/studio/config')).status, 200);
  } finally { srv.close(); }
});
test('flag off UI: choice screen and switcher are hidden until /api/twin/config answers enabled', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(h, /<div class="choice" id="choice" hidden>/); assert.match(h, /<span class="pathsw" id="pathSw" hidden>/);
  const boot = h.slice(h.indexOf("fetch('/api/twin/config')"));
  assert.ok(boot.indexOf('if(!TWIN)return') > 0 && boot.indexOf('if(!TWIN)return') < boot.indexOf("$('pathSw').hidden=false"), 'reveal happens only after the flag check');
  assert.match(h, /const rr=TWIN\?r:r\.filter\(p=>p\.path!='full_gen_ai'\)/, 'Twin rows hidden from My Reels when the flag is off');
  assert.match(h, /\ngo\(0\);\n/, 'Hair Reveal still boots straight into the brief');
});

// ---------- My Reels badges ----------
function pathBadgeFn() { const h = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const src = h.match(/const TPLN=\{[^}]+\};\nfunction pathBadge\(p\)\{[^\n]+\}/)[0];
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return new Function('esc', src + '\nreturn pathBadge;')(esc); }
test('My Reels badges: Hair Reveal vs AI Twin (+ template, + AI)', () => {
  const b = pathBadgeFn();
  assert.equal(b({ path: 'real_footage' }), '<span class="pbadge hr">Hair Reveal</span>');
  assert.equal(b({}), '<span class="pbadge hr">Hair Reveal</span>');
  const t = b({ path: 'full_gen_ai', template: 'booking' }); assert.match(t, /AI Twin · Booking reminder/); assert.match(t, /pbadge ai">AI</);
});

// ---------- flag on ----------
async function twinApp() {
  const slug = 'test-' + id(), app = express(); app.use(express.json()); app.use(RA.staticGuard({ ENABLE_AI_TWIN: '1' })); app.use(express.static(path.join(ROOT, 'public')));
  require('../routes_studio')({ app, ...deps }); RA({ app, ...deps, slug, trainMs: 0 });
  return { slug, ...(await serve(app)) };
}
test('flag on: config + stub library seed (ready / training / Sample) + preselect', async () => {
  const { srv, B } = await twinApp();
  try {
    const c = await j(B, '/api/twin/config'); assert.equal(c.status, 200); assert.equal(c.body.enabled, true); assert.equal(c.body.defaultSalon, 'Olya Atelier');
    assert.deepEqual(c.body.templates.map(t => t.name), ['Tip', 'FAQ', 'Promo', 'Booking reminder']); assert.ok(c.body.templates.every(t => t.example.length > 10));
    assert.equal(c.body.runwayConfigured, false); assert.equal(c.body.heygenConfigured, false); assert.match(c.body.consent, /I will turn on Instagram's AI info label/);
    assert.equal((await fetch(B + '/twin.html')).status, 200);
    const L = (await j(B, '/api/twin/avatars')).body;
    assert.deepEqual(L.avatars.map(a => a.card_status), ['ready', 'training', 'ready']);
    const sample = L.avatars.find(a => a.kind === 'sample'); assert.equal(sample.label, 'Sample'); assert.equal(sample.sample, true);
    assert.equal(L.avatars.filter(a => a.label === 'Sample').length, L.avatars.filter(a => a.kind === 'sample').length);
    assert.equal(L.preselected, 'av_owner01'); assert.equal(L.avatars[0].is_default, true);
    assert.equal((await j(B, '/api/twin/nope')).status, 404);
  } finally { srv.close(); }
});
test('flag on: rename, set default, delete, + Add avatar (stub training -> ready), last-used preselected', async () => {
  const { srv, B } = await twinApp();
  try {
    assert.equal((await j(B, '/api/twin/avatars/av_owner01', { name: 'Olya K.' }, 'PATCH')).body.name, 'Olya K.');
    assert.equal((await j(B, '/api/twin/avatars/av_sample01', { name: 'x' }, 'PATCH')).status, 400, 'Samples cannot be renamed');
    assert.equal((await j(B, '/api/twin/avatars/av_stylist1/default', {})).status, 400, 'training avatar cannot be default');
    let L = (await j(B, '/api/twin/avatars/av_sample01/default', {})).body; assert.equal(L.default_avatar_id, 'av_sample01');
    const add = await j(B, '/api/twin/avatars', { name: 'Dana', role: 'stylist' }); assert.equal(add.status, 200); assert.equal(add.body.card_status, 'training');
    assert.equal((await j(B, '/api/twin/avatars', { name: '  ' })).status, 400);
    await new Promise(z => setTimeout(z, 20));
    L = (await j(B, '/api/twin/avatars')).body; assert.equal(L.avatars.find(a => a.id === add.body.id).card_status, 'ready', 'stub training finishes');
    // project creation records last-used, which wins over default
    const p = await j(B, '/api/twin/projects', { avatar_id: add.body.id, template: 'tip' }); made.push(p.body.id);
    L = (await j(B, '/api/twin/avatars')).body; assert.equal(L.preselected, add.body.id); assert.equal(L.avatars.find(a => a.id === add.body.id).is_last_used, true);
    L = (await j(B, '/api/twin/avatars/' + add.body.id, undefined, 'DELETE')).body;
    assert.equal(L.avatars.some(a => a.id === add.body.id), false); assert.equal(L.last_used_avatar_id, null); assert.equal(L.preselected, 'av_sample01', 'falls back to default');
    assert.equal((await j(B, '/api/twin/avatars/' + add.body.id)).status, 404);
    for (const a of L.avatars) await j(B, '/api/twin/avatars/' + a.id, undefined, 'DELETE');
    L = (await j(B, '/api/twin/avatars')).body; assert.equal(L.avatars.length, 0); assert.equal(L.preselected, null, 'empty state');
  } finally { srv.close(); }
});
test('flag on: guardrails, approval gate, stub render with AI label, export consent + IG AI reminder, My Reels path', async () => {
  const { srv, B } = await twinApp();
  try {
    assert.equal((await j(B, '/api/twin/projects', { avatar_id: 'av_stylist1' })).status, 400, 'training avatar not selectable');
    const bad = await j(B, '/api/twin/projects', { avatar_id: 'av_owner01', prompt: "Show my client's hair after the cut" }); assert.equal(bad.status, 400); assert.ok(bad.body.blocked.fix);
    for (const pr of ['This treatment cures dandruff', 'before and after balayage', 'a look like a celebrity', 'tips for kids']) assert.equal(A.checkText(pr).ok, false, pr);
    const p = (await j(B, '/api/twin/projects', { avatar_id: 'av_owner01', template: 'promo', music: 'velvet-house' })).body; made.push(p.id);
    assert.equal(p.path, 'full_gen_ai'); assert.equal(p.status, 'brief'); assert.equal(p.profile.salon, 'Olya Atelier');
    assert.equal((await j(B, `/api/twin/projects/${p.id}/product-url`, { contentType: 'image/gif' })).status, 400);
    const pu = await j(B, `/api/twin/projects/${p.id}/product-url`, { contentType: 'image/png' }); assert.equal(pu.status, 200);
    // product photo: stored (same storage) with B-roll metadata for M3, never rendered on the avatar
    const png = path.join(require('os').tmpdir(), `prod_${process.pid}.png`); await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xe9dfd8:s=64x64', '-frames:v', '1', png]);
    await st.putFile(pu.body.key, png, 'image/png'); fs.unlinkSync(png);
    const pp = (await j(B, `/api/twin/projects/${p.id}/product`, { key: pu.body.key, mime: 'image/png' })).body;
    assert.equal(pp.product.key, pu.body.key); assert.equal(pp.product.use, 'broll'); assert.equal(pp.product.milestone, 'M3'); assert.equal(pp.product.render_in_avatar, false);
    assert.equal(pp.product.slot_start_s, undefined); assert.ok(pp.productUrl);
    const meta = await st.getJSON(`${pu.body.key}.meta.json`); assert.equal(meta.render_in_avatar, false); assert.equal(meta.provider, 'runway'); assert.equal(meta.project_id, p.id);
    assert.deepEqual(pp.overlays, { brand: false, ai_label: false }, 'overlays default off');
    assert.equal((await j(B, `/api/twin/projects/${p.id}/render`, {})).status, 400, 'render refused before a script exists');
    assert.equal((await j(B, `/api/twin/projects/${p.id}/draft`, {})).status, 202); assert.equal((await waitJob(B, p.id)).state, 'done');
    let q = (await j(B, `/api/twin/projects/${p.id}`)).body; assert.equal(q.status, 'awaiting_approval'); assert.equal(q.script.approved, false);
    assert.ok(q.total_s >= A.DURATION.min && q.total_s <= A.DURATION.max, String(q.total_s)); // M2: ~18s Twin reels (15-30s) assert.ok(q.broll.clips.length >= 1);
    assert.equal((await j(B, `/api/twin/projects/${p.id}/render`, {})).status, 400, 'render refused before approval');
    assert.equal((await j(B, `/api/twin/projects/${p.id}/approve`, {})).status, 400, 'needs explicit approval');
    const blocked = await j(B, `/api/twin/projects/${p.id}/approve`, { approved: true, script: q.script.text + ' It cures scalp disease.' }); assert.equal(blocked.status, 400); assert.match(blocked.body.error, /medical/);
    q = (await j(B, `/api/twin/projects/${p.id}/approve`, { approved: true })).body; assert.equal(q.status, 'approved'); assert.equal(q.script.approved_by, 'owner');
    assert.equal((await j(B, `/api/twin/projects/${p.id}/export`, { consent: true })).status, 400, 'export needs a render');
    assert.equal((await j(B, `/api/twin/projects/${p.id}/render`, {})).status, 202); const jb = await waitJob(B, p.id); assert.equal(jb.state, 'done', jb.error);
    q = (await j(B, `/api/twin/projects/${p.id}`)).body; assert.equal(q.status, 'review'); assert.equal(q.render.ai_label, null); assert.deepEqual(q.render.overlays, { brand: false, ai_label: false }); assert.equal(q.render.stub, true); assert.ok(q.previewUrl);
    assert.ok(!q.render.timeline.some(x => x.kind === 'product'), 'product photo is not rendered into the reel');
    const f = st.lp(q.render.key); assert.ok(fs.existsSync(f));
    const pr = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', f]));
    assert.equal(pr.streams.find(s => s.width).width, 1080); assert.equal(pr.streams.find(s => s.width).height, 1920); assert.ok(Math.abs(+pr.format.duration - q.total_s) < 0.3);
    const noC = await j(B, `/api/twin/projects/${p.id}/export`, { consent: false }); assert.equal(noC.status, 400); assert.match(noC.body.error, /I am the person in this AI twin/);
    const ex = await j(B, `/api/twin/projects/${p.id}/export`, { consent: true, music: false }); assert.equal(ex.status, 200); assert.match(ex.body.igAiLabelReminder, /AI info/); assert.equal(ex.body.music, false);
    q = (await j(B, `/api/twin/projects/${p.id}`)).body; assert.equal(q.status, 'exported'); assert.ok(q.renderVariants.music && q.renderVariants.no_music);
    assert.equal(ex.body.aiLabel, 'AI-generated'); assert.deepEqual(ex.body.overlays, { brand: false, ai_label: false });
    // overlay toggles: validated, persisted, invalidate cached variants, applied on re-render
    assert.equal((await j(B, `/api/twin/projects/${p.id}/overlays`, { brand: 'yes' })).status, 400);
    q = (await j(B, `/api/twin/projects/${p.id}/overlays`, { brand: true, ai_label: true })).body;
    assert.deepEqual(q.overlays, { brand: true, ai_label: true }); assert.deepEqual(q.renderVariants, {}); assert.equal(q.render.overlays_stale, true);
    assert.deepEqual((await j(B, `/api/twin/projects/${p.id}/overlays`, { ai_label: true })).body.overlays, { brand: true, ai_label: true }, 'partial update keeps the other toggle');
    assert.equal((await j(B, `/api/twin/projects/${p.id}/rerender`, {})).status, 202); assert.equal((await waitJob(B, p.id)).state, 'done');
    q = (await j(B, `/api/twin/projects/${p.id}`)).body; assert.equal(q.render.ai_label, 'AI-generated'); assert.deepEqual(q.render.overlays, { brand: true, ai_label: true });
    // unified My Reels: Twin row carries path + template; legacy Hair Reveal rows default to real_footage
    const legacy = id(); made.push(legacy); await st.putJSON(`projects/${legacy}/project.json`, { id: legacy, created: 'x', updated: '2000-01-01', status: 'planned', profile: { salon: 'Olya Atelier' } });
    const list = (await j(B, '/api/projects')).body;
    assert.deepEqual([list.find(r => r.id === p.id).path, list.find(r => r.id === p.id).template], ['full_gen_ai', 'promo']);
    assert.equal(list.find(r => r.id === legacy).path, 'real_footage');
    // a Hair Reveal reel can't be opened through the Twin API (the switcher never converts a reel)
    assert.equal((await j(B, `/api/twin/projects/${legacy}`)).status, 400);
  } finally { srv.close(); }
});

// ---------- pure helpers ----------
test('buildTwinAss wraps buildAss; salon name and AI stamp are optional overlays, off by default', () => {
  const args = { lines: [{ start_s: 0, end_s: 2, text: 'Hi' }], salon: 'Olya Atelier', duration: 30, tone: 'luxe' };
  const base = P.buildAss(args), slates = [{ start_s: 0, end_s: 3, text: 'AI B-roll (stub)\nfoam' }];
  const off = A.buildTwinAss({ ...args, slates }), on = A.buildTwinAss({ ...args, slates, overlays: { brand: true, ai_label: true } });
  // every Hair Reveal line is kept except the brand (Twin restyles it, and only draws it when switched on)
  for (const line of base.trim().split('\n').filter(l => !l.startsWith('Style: Brand,') && !/^Dialogue: 0,[^,]+,[^,]+,Brand,/.test(l))) { assert.ok(off.includes(line), line); assert.ok(on.includes(line), line); }
  assert.doesNotMatch(off, /,AILabel,,/); assert.doesNotMatch(off, /,Brand,,0,0,0,,Olya Atelier/); assert.doesNotMatch(off, /,Pill,,/);
  assert.match(on, /Dialogue: 2,0:00:00\.00,0:00:30\.00,AILabel,,0,0,0,,AI-generated/); assert.match(on, /Dialogue: 1,0:00:00\.00,0:00:30\.00,Brand,,0,0,0,,Olya Atelier/); assert.match(on, /,Pill,,0,0,0,,\{\\an7\\pos\(0,0\)/);
  assert.match(off, /AI B-roll \(stub\)\\Nfoam/);
  assert.match(on, new RegExp(`Style: Brand,[^\\n]*,2,90,90,${1920 - A.TWIN_BRAND_ZONE.bottomY},1`));
  // label: top safe area (~220-260), clear of IG's top UI and of the captions
  assert.ok(A.AI_LABEL_ZONE.topY >= 210 && A.AI_LABEL_ZONE.topY + A.AI_LABEL_ZONE.size <= 270);
  assert.ok(A.AI_LABEL_ZONE.topY + A.AI_LABEL_ZONE.size < P.CAPTION_ZONE.bottomY - 3 * P.CAPTION_ZONE.size);
  assert.ok(A.TWIN_BRAND_ZONE.bottomY - A.TWIN_BRAND_ZONE.size > P.CAPTION_ZONE.bottomY);
});
test('stub vendor clients make no network calls', async () => {
  const orig = global.fetch; let calls = 0; global.fetch = async () => { calls++; throw new Error('network'); };
  try { const HG = require('../heygen'), RW = require('../runway');
    assert.equal(HG.configured(), false); assert.equal(RW.configured(), false);
    for (const f of [HG.createPhotoAvatar, HG.avatarStatus, HG.consentUrl, HG.createVideo, HG.videoStatus, HG.deleteAvatar, RW.textToVideo, RW.imageToVideo, RW.task]) assert.equal((await f({})).stub, true);
    assert.equal(calls, 0);
    for (const f of ['heygen.js', 'runway.js', 'avatar.js', 'routes_avatar.js']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /fetch\(|https?:\/\/api\./, f);
  } finally { global.fetch = orig; }
});
test('no Grok/xAI branding in the Twin UI; Runway credit only in the UI', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'public', 'twin.html'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public', 'twin.js'), 'utf8');
  assert.doesNotMatch(ui, /grok|xai|x\.ai/i); assert.match(ui, /href="https:\/\/runway\.com"[^>]*>Powered by Runway</);
  assert.doesNotMatch(A.buildTwinAss({ lines: [], salon: 'Olya Atelier', duration: 5 }), /Runway/);
});
