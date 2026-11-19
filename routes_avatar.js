'use strict';
// "Your AI Twin" API (M1, stubbed): /api/twin/*. Mounted only when ENABLE_AI_TWIN=1; with the flag off nothing here is
// registered, so /api/twin/* falls through to Express's 404 and the Twin page assets are refused by staticGuard.
// M1 makes NO HeyGen / Runway calls (heygen.js / runway.js are stubs); renders are local ffmpeg slates with the AI label.
const fs = require('fs'), path = require('path');
const st = require('./storage'), A = require('./avatar'), MASTER = require('./master'), MUSIC = require('./music');
const HG = require('./heygen'), RW = require('./runway'), S = require('./studio');

const TWIN_CONSENT = 'I am the person in this AI twin, or I have their permission, and I will turn on Instagram\'s AI info label when I post.';
const IG_AI_REMINDER = 'When you post this Reel, turn on Instagram\'s "AI info" label (Advanced settings → AI label) - this video was made with AI.';
const PRODUCT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const enabled = (env = process.env) => env.ENABLE_AI_TWIN === '1';
// Express middleware placed before express.static: hides the Twin page and assets when the flag is off.
const staticGuard = (env = process.env) => (q, s, n) => (!enabled(env) && /^\/twin(\.html|\.js|\/|$)/.test(q.path)) ? s.status(404).type('text').send('Not found') : n();

function mount({ app, llm, parseJSON, run, cfg, TRACKS, D, id, wrap, slug = A.SALON_SLUG, trainMs = 8000 }) {
  const err = (code, msg, extra) => Object.assign(new Error(msg), { status: code, ...extra });
  // like server.js wrap, but honours err.status (400/404/409) and blocklist details
  const w = fn => (q, s) => fn(q, s).catch(e => { if (!e.status) console.error(e); s.status(e.status || 500).json({ error: e.message, ...(e.blocked ? { blocked: e.blocked } : {}) }); });
  const libKey = `twins/${slug}/library.json`, avKey = aid => `twins/${slug}/avatars/${aid}.json`;
  const pkey = pid => `projects/${pid}/project.json`;
  const okAid = aid => { if (!/^av_[a-z0-9]{4,16}$/.test(aid)) throw err(400, 'bad avatar id'); return aid; };
  const live = () => cfg().llmLive;

  // ---------- library ----------
  async function lib() {
    if (await st.exists(libKey)) return st.getJSON(libKey);
    const seed = A.stubSeed(), L = { default_avatar_id: seed[0].id, last_used_avatar_id: null, avatar_ids: seed.map(a => a.id), stub: true, updated: new Date().toISOString() };
    for (const a of seed) await st.putJSON(avKey(a.id), a);
    await st.putJSON(libKey, L); return L;
  }
  const saveLib = L => { L.updated = new Date().toISOString(); return st.putJSON(libKey, L); };
  const getAv = async aid => { okAid(aid); const L = await lib(); if (!L.avatar_ids.includes(aid)) throw err(404, 'Avatar not found');
    const a = await st.getJSON(avKey(aid)); if (A.advanceStub(a)) await st.putJSON(avKey(aid), a); return { a, L }; };
  async function listCards() {
    const L = await lib(), avs = [];
    for (const aid of L.avatar_ids) { try { const a = await st.getJSON(avKey(aid)); if (A.advanceStub(a)) await st.putJSON(avKey(aid), a); avs.push(a); } catch {} }
    // owner/stylist first, Samples last
    avs.sort((x, y) => (x.kind === 'sample') - (y.kind === 'sample'));
    return { avatars: avs.map(a => A.cardView(a, L)), default_avatar_id: L.default_avatar_id, last_used_avatar_id: L.last_used_avatar_id, preselected: A.preselect(L, avs), stub: true };
  }

  app.get('/api/twin/config', (q, s) => s.json({ enabled: true, stub: true, templates: A.TEMPLATES, defaultSalon: A.DEFAULT_SALON, moods: S.MOODS,
    tracks: Object.entries(TRACKS).map(([k, v]) => ({ id: k, label: v.label, name: v.name, moodLabel: v.moodLabel, bpm: v.bpm })), defaultTrack: MUSIC.DEFAULT,
    heygenTest: HG.testMode(), heygenConfigured: HG.configured(), runwayConfigured: RW.configured(), llmLive: live(), consent: TWIN_CONSENT, igAiLabelReminder: IG_AI_REMINDER,
    aiLabel: A.AI_LABEL, duration: A.DURATION, poweredBy: { name: 'Runway', url: 'https://runway.com' } }));

  app.get('/api/twin/avatars', w(async (q, s) => s.json(await listCards())));
  app.post('/api/twin/avatars/upload-url', w(async (q, s) => { // stub: a real signed PUT for the training clip, nothing is sent to HeyGen in M1
    const ct = String(q.body.contentType || 'video/mp4'); if (!/^video\//.test(ct)) throw err(400, 'Upload a video clip');
    const key = `twins/${slug}/uploads/${id()}.${ct.split('/')[1].replace(/[^\w]/g, '') || 'mp4'}`; s.json({ stub: true, key, ...(await st.presignPut(key, ct)) }); }));
  app.post('/api/twin/avatars', w(async (q, s) => {
    const L = await lib(), a = A.newAvatar(q.body || {}, 'av_' + id(), undefined, trainMs);
    if (q.body.footage_key) { st.safeKey(q.body.footage_key); a.footage_key = q.body.footage_key; }
    a.training = await HG.createPhotoAvatar(); // stub, no network
    await st.putJSON(avKey(a.id), a); L.avatar_ids.unshift(a.id); await saveLib(L); s.json(A.cardView(a, L)); }));
  app.get('/api/twin/avatars/:aid', w(async (q, s) => { const { a, L } = await getAv(q.params.aid); s.json(A.cardView(a, L)); }));
  app.post('/api/twin/avatars/:aid/consent', w(async (q, s) => { const { a } = await getAv(q.params.aid); if (a.kind === 'sample') throw err(400, 'Sample avatars do not need consent');
    s.json({ stub: true, ...(await HG.consentUrl()), status: a.consent?.status || 'stub' }); }));
  app.patch('/api/twin/avatars/:aid', w(async (q, s) => { const { a, L } = await getAv(q.params.aid);
    if (a.kind === 'sample') throw err(400, 'Sample avatars cannot be renamed');
    const nm = String(q.body.name || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim().slice(0, 40); if (!nm) throw err(400, 'Give the avatar a name');
    a.name = nm; a.updated = new Date().toISOString(); await st.putJSON(avKey(a.id), a); s.json(A.cardView(a, L)); }));
  app.post('/api/twin/avatars/:aid/default', w(async (q, s) => { const { a, L } = await getAv(q.params.aid);
    if (!A.selectable(a)) throw err(400, 'Only a ready avatar can be the default'); L.default_avatar_id = a.id; await saveLib(L); s.json(await listCards()); }));
  app.delete('/api/twin/avatars/:aid', w(async (q, s) => { const { a, L } = await getAv(q.params.aid);
    // M1: remove from this salon's library only. Never deletes anything at HeyGen; Sample (stock) avatars are only hidden here.
    L.avatar_ids = L.avatar_ids.filter(x => x !== a.id);
    if (L.default_avatar_id === a.id) L.default_avatar_id = null; if (L.last_used_avatar_id === a.id) L.last_used_avatar_id = null;
    a.deleted_at = new Date().toISOString(); await st.putJSON(avKey(a.id), a); await saveLib(L); s.json(await listCards()); }));
  // demo helper (flag-on only): reseed the stub library, or empty it to show the empty state
  app.post('/api/twin/demo/reset', w(async (q, s) => {
    const seed = A.stubSeed(); for (const a of seed) await st.putJSON(avKey(a.id), a);
    await st.putJSON(libKey, { default_avatar_id: q.body.empty ? null : seed[0].id, last_used_avatar_id: null, avatar_ids: q.body.empty ? [] : seed.map(a => a.id), stub: true, updated: new Date().toISOString() });
    s.json(await listCards()); }));

  // ---------- projects ----------
  const load = async pid => { if (!/^[a-z0-9]{12}$/.test(pid)) throw err(400, 'bad project id'); let p; try { p = await st.getJSON(pkey(pid)); } catch { throw err(404, 'Reel not found'); }
    if (p.path !== A.PATH) throw err(400, 'This reel is a Hair Reveal reel - open it from My Reels'); return p; };
  const save = async p => { p.updated = new Date().toISOString(); await st.putJSON(pkey(p.id), p); return p; };
  const view = async p => ({ ...p, previewUrl: p.render ? await st.presignGet(p.render.key) : null, productUrl: p.product?.key ? await st.presignGet(p.product.key) : null, storage: st.R2 ? 'r2' : 'local' });
  const jobs = {};
  const job = (name, pre, fn) => w(async (q, s) => {
    const p = await load(q.params.id); await pre(p, q);
    if (jobs[p.id]?.state === 'running') return s.status(409).json({ error: 'Another step is still running', job: jobs[p.id] });
    const j = jobs[p.id] = { name, state: 'running', started: Date.now() };
    s.status(202).json({ job: j }); st.putJSON(`projects/${p.id}/job.json`, j).catch(() => {});
    fn(p, q).then(() => { j.state = 'done'; }).catch(e => { if (!e.status) console.error(name, e); j.state = 'error'; j.error = e.message; })
      .finally(() => { j.ms = Date.now() - j.started; st.putJSON(`projects/${p.id}/job.json`, j).catch(() => {}); });
  });
  app.get('/api/twin/projects/:id/job', w(async (q, s) => {
    if (jobs[q.params.id]) return s.json(jobs[q.params.id]); await load(q.params.id);
    const j = await st.getJSON(`projects/${q.params.id}/job.json`).catch(() => null);
    if (j?.state === 'running') return s.json({ ...j, state: 'error', error: 'The server restarted during this step (free plan). Please try again.' });
    s.json(j || { state: 'idle' });
  }));

  app.post('/api/twin/projects', w(async (q, s) => {
    const b = q.body || {}, { a, L } = await getAv(String(b.avatar_id || ''));
    if (!A.selectable(a)) throw err(400, a.status === 'training' || a.status === 'pending_consent' ? 'This avatar is still training - pick a ready one' : 'This avatar can\'t be used - pick a ready one');
    const template = A.TEMPLATES.some(t => t.id === b.template) ? b.template : 'tip';
    const chk = A.checkText(b.prompt, 'prompt'); if (!chk.ok) throw new A.BlockedError(chk);
    const now = new Date().toISOString();
    const p = { id: id(), path: A.PATH, template, created: now, status: 'brief',
      profile: { salon: String(b.salon || A.DEFAULT_SALON).slice(0, 60) || A.DEFAULT_SALON },
      inputs: { mood: S.MOODS.includes(b.mood) ? b.mood : S.MOODS[0], music: TRACKS[b.music] ? b.music : MUSIC.DEFAULT, language: String(b.language || 'English').slice(0, 30), prompt: String(b.prompt || '').slice(0, 600) },
      avatar_id: a.id, avatar: { id: a.id, name: a.name, role: a.role, kind: a.kind, sample: a.kind === 'sample', thumbnail: a.thumbnail, stub: !!a.stub },
      script: null, broll: { clips: [] }, product: null, copy: null, musicOn: TRACKS[b.music] ? b.music !== 'none' : true, render: null, renderVariants: {}, export: null, consent: null, stub: true };
    L.last_used_avatar_id = a.id; await saveLib(L);
    await save(p); s.json(await view(p)); }));
  app.get('/api/twin/projects/:id', w(async (q, s) => s.json(await view(await load(q.params.id)))));
  app.patch('/api/twin/projects/:id', w(async (q, s) => { // brief edits before approval (prompt/template/mood/music)
    const p = await load(q.params.id), b = q.body || {};
    if (b.prompt != null) { const chk = A.checkText(b.prompt, 'prompt'); if (!chk.ok) throw new A.BlockedError(chk); p.inputs.prompt = String(b.prompt).slice(0, 600); }
    if (A.TEMPLATES.some(t => t.id === b.template)) p.template = b.template;
    if (S.MOODS.includes(b.mood)) p.inputs.mood = b.mood; if (TRACKS[b.music]) { p.inputs.music = b.music; p.musicOn = b.music !== 'none'; }
    if (b.prompt != null || b.template) { if (p.script) p.script.approved = false; if (['approved', 'review', 'exported'].includes(p.status)) p.status = p.script ? 'awaiting_approval' : 'brief'; }
    await save(p); s.json(await view(p)); }));

  // optional product photo (the salon's own real product); M1 composites it into the stub render
  app.post('/api/twin/projects/:id/product-url', w(async (q, s) => { const p = await load(q.params.id), ct = String(q.body.contentType || '');
    if (!PRODUCT_TYPES[ct]) throw err(400, 'Product photo must be a JPEG, PNG or WebP image');
    const key = `projects/${p.id}/product/product_${Date.now()}.${PRODUCT_TYPES[ct]}`; s.json({ key, ...(await st.presignPut(key, ct)) }); }));
  app.post('/api/twin/projects/:id/product', w(async (q, s) => { const p = await load(q.params.id), key = String(q.body.key || ''), mime = String(q.body.mime || '');
    if (!key.startsWith(`projects/${p.id}/product/`) || !PRODUCT_TYPES[mime]) throw err(400, 'bad product key'); st.safeKey(key);
    if (!(await st.exists(key))) throw err(400, 'Upload the photo first');
    p.product = { key, mime, slot_start_s: p.product?.slot_start_s ?? null, slot_end_s: p.product?.slot_end_s ?? null };
    await save(p); s.json(await view(p)); }));
  app.delete('/api/twin/projects/:id/product', w(async (q, s) => { const p = await load(q.params.id); p.product = null; await save(p); s.json(await view(p)); }));

  // draft: script + captions + B-roll plan (+ product slot). LLM when configured, otherwise the deterministic mock.
  app.post('/api/twin/projects/:id/draft', job('draft', async p => { const chk = A.checkText(p.inputs.prompt, 'prompt'); if (!chk.ok) throw new A.BlockedError(chk); }, async p => {
    const ctx = { template: p.template, prompt: p.inputs.prompt, mood: p.inputs.mood, language: p.inputs.language, salon: p.profile.salon, avatar: p.avatar, hasProduct: !!p.product };
    let d;
    if (live()) { try { d = A.cleanDraft(parseJSON(await llm({ system: 'You write short-form salon video scripts. Reply with JSON only.', effort: 'low', text: A.draftPrompt(ctx) })), ctx);
      if (!d.script.text || !A.checkAll({ script: d.script.text, captions: d.script.captions, broll: d.broll.clips }).ok) d = null; } catch (e) { console.error('twin draft AI failed, using template draft:', e.message); d = null; } }
    if (!d) { d = A.mockDraft(ctx); d.mode = 'template'; } else d.mode = 'ai';
    p.script = { ...d.script, approved: false, approved_at: null, approved_by: null, mode: d.mode }; p.broll = d.broll; p.copy = d.copy; p.total_s = d.total_s;
    if (p.product) Object.assign(p.product, d.product_slot || { slot_start_s: Math.round(d.total_s * 0.45), slot_end_s: Math.round(d.total_s * 0.45) + 3 });
    p.status = 'awaiting_approval'; await save(p);
  }));
  app.post('/api/twin/projects/:id/approve', w(async (q, s) => {
    const p = await load(q.params.id); if (!p.script) throw err(400, 'Write the script first');
    const r = A.cleanApproval(q.body || {}, p);
    p.script = { ...p.script, text: r.text, captions: r.captions, approved: true, approved_at: new Date().toISOString(), approved_by: 'owner' };
    p.broll = { clips: r.broll }; p.total_s = r.total;
    if (p.product && q.body.product) { const a = Math.max(0, Math.min(r.total - 2, +q.body.product.slot_start_s || 0)); p.product.slot_start_s = a; p.product.slot_end_s = Math.min(r.total, Math.max(a + 2, +q.body.product.slot_end_s || a + 3)); }
    p.status = 'approved'; await save(p); s.json(await view(p)); }));

  // ---------- stub render ----------
  async function renderStub(p, { musicOn = p.musicOn } = {}) {
    const dir = D('cache', p.id); fs.mkdirSync(dir, { recursive: true });
    const total = +p.total_s || A.estimateDuration(p.script.text);
    const timeline = A.stubTimeline({ total, avatarName: p.avatar.name + (p.avatar.sample ? ' (Sample)' : ''), broll: p.broll.clips, product: p.product?.key ? p.product : null });
    const assPath = path.join(dir, 'twin.ass');
    fs.writeFileSync(assPath, A.buildTwinAss({ lines: p.script.captions, salon: p.profile.salon, duration: total, tone: p.inputs.mood === 'Luxe' ? 'luxe' : 'clean', slates: timeline.filter(x => x.text) }));
    let productFile = null; if (p.product?.key) { productFile = path.join(dir, path.basename(p.product.key)); if (!fs.existsSync(productFile)) await st.getFile(p.product.key, productFile); }
    const musicFile = A.musicFor(p.inputs.music, musicOn);
    const out = path.join(dir, `twin_${Date.now()}${musicFile ? '' : '_nomusic'}.mp4`);
    await HG.createVideo(); await Promise.all(p.broll.clips.map(b => RW.textToVideo({ prompt: b.prompt, duration: b.duration }))); // stubs, no network
    await run('ffmpeg', A.stubFfmpegArgs({ total, timeline, assPath, productFile, musicFile, out }));
    const loudness = musicFile ? await MASTER.masterFile(out).catch(e => ({ error: String(e.message).slice(0, 200) })) : { skipped: 'no music (silent bed)' };
    const key = `projects/${p.id}/renders/${path.basename(out)}`; await st.putFile(key, out, 'video/mp4'); fs.unlinkSync(out);
    return { key, duration: total, music: !!musicFile, track: musicFile ? p.inputs.music : 'none', loudness, ai_label: A.AI_LABEL, stub: true, timeline, at: new Date().toISOString() };
  }
  const needApproved = async p => { if (!p.script?.approved) throw err(400, 'Approve the script before rendering'); };
  app.post('/api/twin/projects/:id/render', job('render', needApproved, async p => {
    p.status = 'rendering'; await save(p);
    try { p.render = await renderStub(p); p.renderVariants = { [p.render.music ? 'music' : 'no_music']: p.render.key }; p.status = 'review'; }
    catch (e) { p.status = 'error'; p.error = e.message; await save(p); throw e; }
    await save(p); }));
  app.post('/api/twin/projects/:id/rerender', job('rerender', async (p, q) => { await needApproved(p); if (!p.render) throw err(400, 'Render first');
    const caps = q.body.captions; if (caps) { const r = A.checkAll({ captions: caps }); if (!r.ok) throw new A.BlockedError(r); } }, async (p, q) => {
    const b = q.body || {};
    if (Array.isArray(b.captions)) p.script.captions = require('./pipeline').cleanSegments(b.captions.map(c => ({ ...c, text: String(c.text || '').slice(0, 80) })), p.total_s, 'text');
    if (b.copy) p.copy = { caption: String(b.copy.caption ?? p.copy?.caption ?? '').slice(0, 2200), hashtags: Array.isArray(b.copy.hashtags) ? b.copy.hashtags.slice(0, 15) : p.copy?.hashtags || [] };
    p.status = 'rendering'; await save(p);
    try { p.render = await renderStub(p); p.renderVariants = { [p.render.music ? 'music' : 'no_music']: p.render.key }; p.status = 'review'; }
    catch (e) { p.status = 'error'; p.error = e.message; await save(p); throw e; }
    await save(p); }));
  app.post('/api/twin/projects/:id/export', w(async (q, s) => {
    const p = await load(q.params.id), b = q.body || {};
    if (!p.render) throw err(400, 'Render the reel first');
    if (b.consent !== true) throw err(400, 'Please confirm: ' + TWIN_CONSENT);
    const music = b.music !== false && p.render.music;
    const vk = music ? 'music' : 'no_music';
    if (!p.renderVariants?.[vk]) { const r = await renderStub(p, { musicOn: music }); p.renderVariants = { ...(p.renderVariants || {}), [vk]: r.key }; }
    if (b.caption != null || b.hashtags) p.copy = { caption: String(b.caption ?? p.copy?.caption ?? '').slice(0, 2200), hashtags: Array.isArray(b.hashtags) ? b.hashtags.slice(0, 15) : p.copy?.hashtags || [] };
    p.consent = { text: TWIN_CONSENT, accepted: true, at: new Date().toISOString() };
    p.export = { at: new Date().toISOString(), music, key: p.renderVariants[vk], ai_label: A.AI_LABEL, ig_ai_label_reminder: true }; p.status = 'exported'; await save(p);
    s.json({ download: await st.presignGet(p.renderVariants[vk], `salonreel-twin-${p.id}${music ? '' : '-no-music'}.mp4`), music, caption: p.copy?.caption, hashtags: p.copy?.hashtags, igAiLabelReminder: IG_AI_REMINDER, aiLabel: A.AI_LABEL });
  }));
  app.use('/api/twin', (q, s) => s.status(404).json({ error: 'Not found' }));
}
module.exports = Object.assign(mount, { enabled, staticGuard, TWIN_CONSENT, IG_AI_REMINDER, PRODUCT_TYPES });
