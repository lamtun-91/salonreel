'use strict';
// "Your AI Twin" API (M1, stubbed): /api/twin/*. Mounted only when ENABLE_AI_TWIN=1; with the flag off nothing here is
// registered, so /api/twin/* falls through to Express's 404 and the Twin page assets are refused by staticGuard.
// M2: with HEYGEN_API_KEY + HEYGEN_LIVE=1 a Sample (stock) avatar renders via HeyGen v3 (twin_render.js); spend additionally needs HEYGEN_ALLOW_SPEND=1 (v3 has no free test mode). Otherwise renders are local ffmpeg stubs. Runway stays a stub until M3.
const fs = require('fs'), path = require('path');
const st = require('./storage'), A = require('./avatar'), MASTER = require('./master'), MUSIC = require('./music');
const HG = require('./heygen'), RW = require('./runway'), S = require('./studio'), TR = require('./twin_render');
const HGC = require('./heygen_client'), RWC = require('./runway_client'), SP = require('./spend'), PB = require('./promo_broll');

const TWIN_CONSENT = 'I am the person in this AI twin, or I have their permission, and I will turn on Instagram\'s AI info label when I post.';
const IG_AI_REMINDER = 'When you post this Reel, turn on Instagram\'s "AI info" label (Advanced settings → AI label) - this video was made with AI.';
const PRODUCT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const enabled = (env = process.env) => env.ENABLE_AI_TWIN === '1';
// M4 (own twin creation) is not approved: creating/training avatars is refused unless ENABLE_TWIN_CREATION=1. Stock avatars only.
const creationEnabled = (env = process.env) => env.ENABLE_TWIN_CREATION === '1';
const CREATION_OFF_MSG = 'Creating your own AI twin is not available yet. Please use one of the stock presenters.';
const CREATION_ROUTES = ['/api/twin/avatars/upload-url', '/api/twin/avatars', '/api/twin/avatars/:aid/consent', '/api/twin/demo/reset'];
// Client IP for the per-IP paid-render limit (behind Render/Cloudflare): CF-Connecting-IP / True-Client-IP are set by the edge.
const clientIp = q => String(q.get?.('cf-connecting-ip') || q.get?.('true-client-ip') || String(q.get?.('x-forwarded-for') || '').split(',').map(x => x.trim()).filter(Boolean).pop() || q.socket?.remoteAddress || 'unknown');
// Express middleware placed before express.static: hides the Twin page and assets when the flag is off.
const staticGuard = (env = process.env) => (q, s, n) => (!enabled(env) && /^\/twin(\.html|\.js|\/|$)/.test(q.path)) ? s.status(404).type('text').send('Not found') : n();

function mount({ app, llm, parseJSON, run, cfg, TRACKS, D, id, wrap, slug = A.SALON_SLUG, trainMs = 8000, env = process.env, ledger = null, hg = HG, rw = RW, renderHeygen = TR.renderHeygen }) {
  // global daily spend ledger (R2 in prod; local disk only outside production - fail closed if prod has no R2)
  const opsStore = (st.R2 || env.NODE_ENV !== 'production') ? st : { getOpsJSON: async () => { throw new Error('no R2 for the spend ledger in production'); }, putOpsJSON: async () => { throw new Error('no R2'); } };
  ledger = ledger || SP.createLedger({ store: opsStore, env });
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
  const cardStub = () => !hg.configured();
  const viewAv = (a, L) => A.cardView(a, L, { stub: cardStub() });
  async function listCards() {
    const L = await lib(), avs = [];
    for (const aid of L.avatar_ids) { try { const a = await st.getJSON(avKey(aid)); if (A.advanceStub(a)) await st.putJSON(avKey(aid), a); if (creationEnabled(env) || a.kind === 'sample') avs.push(a); } catch {} }
    // owner/stylist first, Samples last
    avs.sort((x, y) => (x.kind === 'sample') - (y.kind === 'sample'));
    return { avatars: avs.map(a => viewAv(a, L)), default_avatar_id: L.default_avatar_id, last_used_avatar_id: L.last_used_avatar_id, preselected: A.preselect(L, avs), stub: cardStub() };
  }

  app.post(CREATION_ROUTES, (q, s, n) => creationEnabled(env) ? n() : s.status(403).json({ error: CREATION_OFF_MSG, creation: false }));
  app.get('/api/twin/config', (q, s) => s.json({ enabled: true, stub: !hg.configured(), twinCreation: creationEnabled(env), templates: A.TEMPLATES, defaultSalon: A.DEFAULT_SALON, moods: S.MOODS,
    tracks: Object.entries(TRACKS).map(([k, v]) => ({ id: k, label: v.label, name: v.name, moodLabel: v.moodLabel, bpm: v.bpm })), defaultTrack: MUSIC.DEFAULT,
    heygenTest: HG.testMode(), heygenTestNote: HG.TEST_MODE_NOTE, heygenConfigured: hg.configured(), runwayConfigured: rw.configured(), llmLive: live(), consent: TWIN_CONSENT, igAiLabelReminder: IG_AI_REMINDER,
    aiLabel: A.AI_LABEL, defaultOverlays: A.DEFAULT_OVERLAYS, duration: A.DURATION, poweredBy: { name: 'Runway', text: 'Powered by Runway', url: 'https://runwayml.com' },
    promoBrollMode: PB.enabled(env) ? 'contextual' : 'off' }));

  app.get('/api/twin/avatars', w(async (q, s) => s.json(await listCards())));
  app.post('/api/twin/avatars/upload-url', w(async (q, s) => { // stub: a real signed PUT for the training clip, nothing is sent to HeyGen in M1
    const ct = String(q.body.contentType || 'video/mp4'); if (!/^video\//.test(ct)) throw err(400, 'Upload a video clip');
    const key = `twins/${slug}/uploads/${id()}.${ct.split('/')[1].replace(/[^\w]/g, '') || 'mp4'}`; s.json({ stub: true, key, ...(await st.presignPut(key, ct)) }); }));
  app.post('/api/twin/avatars', w(async (q, s) => {
    const L = await lib(), a = A.newAvatar(q.body || {}, 'av_' + id(), undefined, trainMs);
    if (q.body.footage_key) { st.safeKey(q.body.footage_key); a.footage_key = q.body.footage_key; }
    a.training = await HG.createPhotoAvatar(); // stub, no network
    await st.putJSON(avKey(a.id), a); L.avatar_ids.unshift(a.id); await saveLib(L); s.json(viewAv(a, L)); }));
  app.get('/api/twin/avatars/:aid', w(async (q, s) => { const { a, L } = await getAv(q.params.aid); s.json(viewAv(a, L)); }));
  app.post('/api/twin/avatars/:aid/consent', w(async (q, s) => { const { a } = await getAv(q.params.aid); if (a.kind === 'sample') throw err(400, 'Sample avatars do not need consent');
    s.json({ stub: true, ...(await HG.consentUrl()), status: a.consent?.status || 'stub' }); }));
  app.patch('/api/twin/avatars/:aid', w(async (q, s) => { const { a, L } = await getAv(q.params.aid);
    if (a.kind === 'sample') throw err(400, 'Sample avatars cannot be renamed');
    const nm = String(q.body.name || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim().slice(0, 40); if (!nm) throw err(400, 'Give the avatar a name');
    a.name = nm; a.updated = new Date().toISOString(); await st.putJSON(avKey(a.id), a); s.json(viewAv(a, L)); }));
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
    const p = await load(q.params.id);
    if (jobs[p.id]?.state === 'running') return s.status(409).json({ error: 'Another step is still running', job: jobs[p.id] });
    await pre(p, q);
    if (jobs[p.id]?.state === 'running') { if (q.spendRes) await ledger.release(q.spendRes, null, 'job_conflict').catch(() => {}); return s.status(409).json({ error: 'Another step is still running', job: jobs[p.id] }); }
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
    if (!creationEnabled(env) && a.kind !== 'sample') throw err(403, CREATION_OFF_MSG);
    if (!A.selectable(a)) throw err(400, a.status === 'training' || a.status === 'pending_consent' ? 'This avatar is still training - pick a ready one' : 'This avatar can\'t be used - pick a ready one');
    const template = A.TEMPLATES.some(t => t.id === b.template) ? b.template : 'tip';
    const chk = A.checkText(b.prompt, 'prompt'); if (!chk.ok) throw new A.BlockedError(chk);
    const now = new Date().toISOString();
    const p = { id: id(), path: A.PATH, template, created: now, status: 'brief',
      profile: { salon: String(b.salon || A.DEFAULT_SALON).slice(0, 60) || A.DEFAULT_SALON },
      inputs: { mood: S.MOODS.includes(b.mood) ? b.mood : S.MOODS[0], music: TRACKS[b.music] ? b.music : MUSIC.DEFAULT, language: String(b.language || 'English').slice(0, 30), prompt: String(b.prompt || '').slice(0, 600) },
      avatar_id: a.id, avatar: { id: a.id, name: a.name, role: a.role, kind: a.kind, sample: a.kind === 'sample', thumbnail: a.thumbnail, stub: !!a.stub, heygen_avatar_id: a.heygen_avatar_id || null, voice_id: a.voice_id || null },
      script: null, broll: { clips: [] }, product: null, overlays: { ...A.DEFAULT_OVERLAYS }, copy: null, musicOn: TRACKS[b.music] ? b.music !== 'none' : true, render: null, renderVariants: {}, export: null, consent: null, stub: true };
    L.last_used_avatar_id = a.id; await saveLib(L);
    await save(p); s.json(await view(p)); }));
  app.get('/api/twin/projects/:id', w(async (q, s) => s.json(await view(await load(q.params.id)))));
  // optional burned-in overlays (salon name, "AI-generated" stamp): per project, off by default, applied on the next (re-)render
  app.post('/api/twin/projects/:id/overlays', w(async (q, s) => { const p = await load(q.params.id), b = q.body || {};
    for (const k of ['brand', 'ai_label']) if (b[k] != null && typeof b[k] !== 'boolean') throw err(400, `${k} must be true or false`);
    const next = A.cleanOverlays(b, A.cleanOverlays(p.overlays));
    if (p.render && JSON.stringify(next) !== JSON.stringify(A.cleanOverlays(p.overlays))) { p.renderVariants = {}; p.render.overlays_stale = true; }
    p.overlays = next; await save(p); s.json(await view(p)); }));
  app.patch('/api/twin/projects/:id', w(async (q, s) => { // brief edits before approval (prompt/template/mood/music)
    const p = await load(q.params.id), b = q.body || {};
    if (b.prompt != null) { const chk = A.checkText(b.prompt, 'prompt'); if (!chk.ok) throw new A.BlockedError(chk); p.inputs.prompt = String(b.prompt).slice(0, 600); }
    if (A.TEMPLATES.some(t => t.id === b.template)) p.template = b.template;
    if (S.MOODS.includes(b.mood)) p.inputs.mood = b.mood; if (TRACKS[b.music]) { p.inputs.music = b.music; p.musicOn = b.music !== 'none'; }
    if (b.prompt != null || b.template) { if (p.script) p.script.approved = false; if (['approved', 'review', 'exported'].includes(p.status)) p.status = p.script ? 'awaiting_approval' : 'brief'; }
    await save(p); s.json(await view(p)); }));

  // optional product photo (the salon's own real product). Stored with B-roll metadata for M3 (Runway); it is NOT rendered
  // onto avatar segments. A sidecar <key>.meta.json in the same storage (R2 or local) records the intended use.
  app.post('/api/twin/projects/:id/product-url', w(async (q, s) => { const p = await load(q.params.id), ct = String(q.body.contentType || '');
    if (!PRODUCT_TYPES[ct]) throw err(400, 'Product photo must be a JPEG, PNG or WebP image');
    const key = `projects/${p.id}/product/product_${Date.now()}.${PRODUCT_TYPES[ct]}`; s.json({ key, ...(await st.presignPut(key, ct)) }); }));
  app.post('/api/twin/projects/:id/product', w(async (q, s) => { const p = await load(q.params.id), key = String(q.body.key || ''), mime = String(q.body.mime || '');
    if (!key.startsWith(`projects/${p.id}/product/`) || !PRODUCT_TYPES[mime]) throw err(400, 'bad product key'); st.safeKey(key);
    if (!(await st.exists(key))) throw err(400, 'Upload the photo first');
    const name = String(q.body.name || '').trim().slice(0, 80) || null;
    const typeHint = String(q.body.type || '').trim();
    // Infer only when the contextual flag is on and type/name did not already resolve; at most one cheap llm call. Flag off: store fields, no inference call.
    const inferred = PB.enabled(env)
      ? await PB.inferType({ name, type: typeHint }, { llm: live() ? llm : null, maxCalls: 1 })
      : { type: PB.typeFromMeta({ name, type: typeHint }), source: PB.typeFromMeta({ name, type: typeHint }) ? 'meta' : null, calls: 0 };
    p.product = { key, mime, ...A.PRODUCT_META, name, type: inferred.type || null, type_source: inferred.source || null, uploaded_at: new Date().toISOString() };
    await st.putJSON(`${key}.meta.json`, { project_id: p.id, template: p.template, salon: p.profile.salon, key, mime, name: p.product.name, type: p.product.type, type_source: p.product.type_source, ...A.PRODUCT_META, uploaded_at: p.product.uploaded_at });
    await save(p); s.json(await view(p)); }));
  app.delete('/api/twin/projects/:id/product', w(async (q, s) => { const p = await load(q.params.id); p.product = null; await save(p); s.json(await view(p)); }));

  // draft: script + captions + B-roll plan (+ product slot). LLM when configured, otherwise the deterministic mock.
  app.post('/api/twin/projects/:id/draft', job('draft', async p => { const chk = A.checkText(p.inputs.prompt, 'prompt'); if (!chk.ok) throw new A.BlockedError(chk); }, async p => {
    const ctx = { template: p.template, prompt: p.inputs.prompt, mood: p.inputs.mood, language: p.inputs.language, salon: p.profile.salon, avatar: p.avatar, hasProduct: false }; // product photo is for M3 B-roll, not the avatar script
    if (PB.enabled(env) && p.product) { ctx.productType = p.product.type; ctx.productName = p.product.name; }
    let d;
    if (live()) { try { d = await A.writeAiDraft(ctx, llm, parseJSON); }
      catch (e) { console.error('twin draft AI failed, using template draft:', e.message); d = null; } }
    if (!d) { d = A.mockDraft(ctx); d.mode = 'template'; }
    p.script = { ...d.script, approved: false, approved_at: null, approved_by: null, mode: d.mode }; p.broll = d.broll; p.copy = d.copy; p.total_s = d.total_s;
    if (PB.enabled(env) && p.product) {
      let clips = null;
      if (live() && p.product.key) {
        try {
          const ext = path.extname(p.product.key) || '.jpg';
          const productFile = await st.getFile(p.product.key, path.join(D('cache', p.id), 'product' + ext));
          const still = path.join(D('cache', p.id), 'broll_draft_still.png');
          const composed = await PB.composeFirstFrame({ productFile, out: still });
          const written = await PB.writeRunwayPrompts({
            firstFrame: composed.file, productFile, name: p.product.name, type: p.product.type,
            script: d.script.text, count: PB.MAX_CLIPS,
          }, { llm, parseJSON, env });
          clips = written.clips;
        } catch (e) { console.error('twin broll prompt AI failed, using template beats:', e.message); }
      }
      p.broll = { clips: clips && clips.length ? clips : PB.beatsFor({ type: p.product.type, name: p.product.name, script: d.script.text }) };
    }
    p.status = 'awaiting_approval'; await save(p);
  }));
  app.post('/api/twin/projects/:id/approve', w(async (q, s) => {
    const p = await load(q.params.id); if (!p.script) throw err(400, 'Write the script first');
    const r = A.cleanApproval(q.body || {}, p);
    p.script = { ...p.script, text: r.text, captions: r.captions, approved: true, approved_at: new Date().toISOString(), approved_by: 'owner' };
    p.broll = { clips: r.broll }; p.total_s = r.total;
    p.status = 'approved'; await save(p); s.json(await view(p)); }));

  // ---------- M2 live render (HeyGen Sample avatar) - only when HEYGEN_API_KEY + HEYGEN_LIVE=1; spend additionally needs HEYGEN_ALLOW_SPEND=1 ----------
  const probeDuration = async f => { const o = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]); return +String(o?.stdout ?? o).trim(); };
  // Paid clips are stored next to the project (projects/<id>/raw/) so re-edits after a restart reuse them for $0.
  const CLIPS = { heygen: 'heygen_raw.mp4', runway: 'broll_a.mp4', runway2: 'broll_b.mp4' };
  const clipKey = (p, name) => `projects/${p.id}/raw/${name}`;
  async function restoreClips(p, dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of Object.values(CLIPS)) { const f = path.join(dir, name);
      if (!fs.existsSync(f) && await st.exists(clipKey(p, name)).catch(() => false)) await st.getFile(clipKey(p, name), f).catch(() => {}); }
  }
  const wantsPromoBroll = p => p.template === 'promo' && !!p.product?.key && rw.configured(); // no product photo => no B-roll at all
  // What a live render of p would pay for right now (stored clips are free). Assumes restoreClips ran when dir is given.
  async function paidNeeds(p, dir = D('cache', p.id)) {
    if (!(hg.configured() && (p.avatar?.heygen_avatar_id || p.avatar?.sample))) return [];
    const have = async name => fs.existsSync(path.join(dir, name)) || await st.exists(clipKey(p, name)).catch(() => false);
    const items = [];
    if (!(p.heygen?.video_id && await have(CLIPS.heygen))) { const engine = hg.engine(); items.push({ provider: 'heygen', engine, est_usd: HGC.estimateCost({ script: p.script.text, engine }).usd }); }
    if (wantsPromoBroll(p)) {
      const model = PB.enabled(env) ? PB.brollModel(env) : RWC.modelFor({}, env);
      const names = PB.enabled(env) ? PB.CLIP_NAMES.slice(0, PB.plannedClipCount(p, env)) : [CLIPS.runway];
      const durs = PB.enabled(env)
        ? names.map((_, i) => PB.clampClipDuration((p.broll?.clips || [])[i]?.duration, model))
        : names.map(() => 5);
      for (let i = 0; i < names.length; i++) if (!(await have(names[i]))) items.push({ provider: 'runway', engine: model, est_usd: RWC.estimateCost({ model, duration: durs[i] }).usd });
    }
    return items;
  }
  async function renderLive(p, { musicOn = p.musicOn, ip = 'unknown', reservation = null } = {}) {
    const dir = D('cache', p.id);
    await restoreClips(p, dir);
    const needs = await paidNeeds(p, dir);
    if (needs.length && !reservation) reservation = await ledger.reserve({ items: needs, ip, project: p.id });
    const submitted = new Set();
    const hgW = { ...hg, createVideo: async (b, o) => {
      try { const c = await hg.createVideo(b, o); submitted.add('heygen'); if (reservation) await ledger.reconcile(reservation, 'heygen', null).catch(e => console.error('[spend]', e.message)); return c; }
      catch (e) { submitted.add('heygen'); if (reservation && SP.definiteRejection(e)) await ledger.release(reservation, 'heygen', e.code || 'rejected').catch(() => {}); throw e; } } };
    const rwW = { ...rw, imageToVideo: async (b, o) => {
      try { const c = await rw.imageToVideo(b, o); submitted.add('runway'); return c; }
      catch (e) { submitted.add('runway'); if (reservation && SP.definiteRejection(e)) await ledger.release(reservation, 'runway', e.code || 'rejected').catch(() => {}); throw e; } },
      waitForTask: async (tid, o) => { const t = await rw.waitForTask(tid, o); if (reservation) await ledger.reconcile(reservation, 'runway', t.cost != null ? t.cost * RWC.USD_PER_CREDIT : null).catch(e => console.error('[spend]', e.message)); return t; } };
    // Promo: clean-surface B-roll + product end card, only when Runway is live and a product photo is stored.
    let promo = null;
    if (wantsPromoBroll(p)) {
      const productFile = await st.getFile(p.product.key, path.join(dir, 'product' + path.extname(p.product.key)));
      promo = { productFile, styleAStill: path.join(__dirname, 'assets', 'broll_countertop.jpg'), compositeProduct: false,
        type: p.product.type, name: p.product.name, script: p.script?.text,
        beats: PB.enabled(env) ? (p.broll?.clips || []).slice(0, PB.MAX_CLIPS) : undefined,
        buildClips: PB.enabled(env)
          ? (pr, opts) => PB.buildClips(pr, { ...opts, llm: live() ? llm : null, parseJSON, env })
          : undefined };
    }
    let r;
    try { r = await renderHeygen(p, { hg: hgW, run, probeDuration, master: MASTER.masterFile, dir, musicOn, rw: promo ? rwW : null, promo }); }
    catch (e) { if (reservation) for (const it of reservation.items) if (!submitted.has(it)) await ledger.release(reservation, it, 'not_submitted').catch(() => {}); throw e; }
    p.heygen = r.heygen;
    for (const name of Object.values(CLIPS)) { const f = path.join(dir, name); if (fs.existsSync(f) && !(await st.exists(clipKey(p, name)).catch(() => false))) await st.putFile(clipKey(p, name), f, 'video/mp4').catch(e => console.error('clip store failed', e.message)); }
    const key = `projects/${p.id}/renders/${path.basename(r.out)}`; await st.putFile(key, r.out, 'video/mp4'); fs.unlinkSync(r.out);
    return { key, duration: r.duration, music: r.music, track: r.track, loudness: r.loudness, overlays: r.overlays, ai_label: r.ai_label, stub: false, heygen_video_id: r.heygen.video_id, broll: r.broll || null, timeline: r.timeline ? r.timeline.segments.map(x => ({ kind: x.kind, start_s: x.start_s, end_s: x.end_s })) : null, spend: reservation ? { id: reservation.id, date: reservation.date } : null, at: new Date().toISOString() };
  }
  const renderAny = (p, o) => (hg.configured() && (p.avatar?.heygen_avatar_id || p.avatar?.sample)) ? renderLive(p, o) : renderStub(p, o);

  // ---------- stub render ----------
  async function renderStub(p, { musicOn = p.musicOn } = {}) {
    const dir = D('cache', p.id); fs.mkdirSync(dir, { recursive: true });
    const total = +p.total_s || A.estimateDuration(p.script.text);
    const timeline = A.stubTimeline({ total, avatarName: p.avatar.name + (p.avatar.sample ? ' (Sample)' : ''), broll: p.broll.clips, product: null }); // product photo is never rendered on the avatar
    const assPath = path.join(dir, 'twin.ass');
    fs.writeFileSync(assPath, A.buildTwinAss({ lines: p.script.captions, salon: p.profile.salon, duration: total, tone: p.inputs.mood === 'Luxe' ? 'luxe' : 'clean', slates: timeline.filter(x => x.text), overlays: A.cleanOverlays(p.overlays) }));
    const productFile = null;
    const musicFile = A.musicFor(p.inputs.music, musicOn);
    const out = path.join(dir, `twin_${Date.now()}${musicFile ? '' : '_nomusic'}.mp4`);
    await HG.createVideo(); await Promise.all(p.broll.clips.map(b => RW.textToVideo({ prompt: b.prompt, duration: b.duration }))); // stubs, no network
    await run('ffmpeg', A.stubFfmpegArgs({ total, timeline, assPath, productFile, musicFile, out }));
    const loudness = musicFile ? await MASTER.masterFile(out).catch(e => ({ error: String(e.message).slice(0, 200) })) : { skipped: 'no music (silent bed)' };
    const key = `projects/${p.id}/renders/${path.basename(out)}`; await st.putFile(key, out, 'video/mp4'); fs.unlinkSync(out);
    return { key, duration: total, music: !!musicFile, track: musicFile ? p.inputs.music : 'none', loudness, overlays: A.cleanOverlays(p.overlays), ai_label: A.cleanOverlays(p.overlays).ai_label ? A.AI_LABEL : null, stub: true, timeline, at: new Date().toISOString() };
  }
  const needApproved = async p => { if (!p.script?.approved) throw err(400, 'Approve the script before rendering'); };
  // Paid render: reserve the estimated cost (daily cap + per-IP limit) BEFORE the job starts so the salon gets the message right away.
  const reserveFor = async (p, q) => { await restoreClips(p, D('cache', p.id)); const items = await paidNeeds(p); if (items.length) q.spendRes = await ledger.reserve({ items, ip: clientIp(q), project: p.id }); };
  app.post('/api/twin/projects/:id/render', job('render', async (p, q) => { await needApproved(p); await reserveFor(p, q); }, async (p, q) => {
    p.status = 'rendering'; await save(p);
    try { p.render = await renderAny(p, { ip: clientIp(q), reservation: q.spendRes || null }); p.renderVariants = { [p.render.music ? 'music' : 'no_music']: p.render.key }; p.status = 'review'; }
    catch (e) { p.status = 'error'; p.error = e.message; await save(p); throw e; }
    await save(p); }));
  app.post('/api/twin/projects/:id/rerender', job('rerender', async (p, q) => { await needApproved(p); if (!p.render) throw err(400, 'Render first');
    const caps = q.body.captions; if (caps) { const r = A.checkAll({ captions: caps }); if (!r.ok) throw new A.BlockedError(r); } }, async (p, q) => {
    const b = q.body || {};
    if (Array.isArray(b.captions)) p.script.captions = require('./pipeline').cleanSegments(b.captions.map(c => ({ ...c, text: String(c.text || '').slice(0, 80) })), p.total_s, 'text');
    if (b.copy) p.copy = { caption: String(b.copy.caption ?? p.copy?.caption ?? '').slice(0, 2200), hashtags: Array.isArray(b.copy.hashtags) ? b.copy.hashtags.slice(0, 15) : p.copy?.hashtags || [] };
    p.status = 'rendering'; await save(p);
    try { p.render = await renderAny(p, { ip: clientIp(q) }); p.renderVariants = { [p.render.music ? 'music' : 'no_music']: p.render.key }; p.status = 'review'; }
    catch (e) { p.status = 'error'; p.error = e.message; await save(p); throw e; }
    await save(p); }));
  app.post('/api/twin/projects/:id/export', w(async (q, s) => {
    const p = await load(q.params.id), b = q.body || {};
    if (!p.render) throw err(400, 'Render the reel first');
    if (b.consent !== true) throw err(400, 'Please confirm: ' + TWIN_CONSENT);
    const music = b.music !== false && p.render.music;
    const vk = music ? 'music' : 'no_music';
    if (!p.renderVariants?.[vk]) { const r = await renderAny(p, { musicOn: music, ip: clientIp(q) }); p.renderVariants = { ...(p.renderVariants || {}), [vk]: r.key }; }
    if (b.caption != null || b.hashtags) p.copy = { caption: String(b.caption ?? p.copy?.caption ?? '').slice(0, 2200), hashtags: Array.isArray(b.hashtags) ? b.hashtags.slice(0, 15) : p.copy?.hashtags || [] };
    p.consent = { text: TWIN_CONSENT, accepted: true, at: new Date().toISOString() };
    p.export = { at: new Date().toISOString(), music, key: p.renderVariants[vk], overlays: A.cleanOverlays(p.overlays), ai_label: A.cleanOverlays(p.overlays).ai_label ? A.AI_LABEL : null, ig_ai_label_reminder: true }; p.status = 'exported'; await save(p);
    s.json({ download: await st.presignGet(p.renderVariants[vk], `salonreel-twin-${p.id}${music ? '' : '-no-music'}.mp4`), music, caption: p.copy?.caption, hashtags: p.copy?.hashtags, igAiLabelReminder: IG_AI_REMINDER, aiLabel: A.AI_LABEL, overlays: A.cleanOverlays(p.overlays) });
  }));
  // ops (read-only): today's spend counter totals (no IPs/reservation details) and a dry-run budget check that reserves nothing
  app.get('/api/twin/ops/spend', w(async (q, s) => { const x = await ledger.status(); s.json({ date: x.date, tz: x.tz, cap_usd: x.cap_usd, total_usd: x.total_usd, remaining_usd: x.remaining_usd, per_ip_limit: x.per_ip_limit, reservations: x.reservations, storage: st.R2 ? 'r2' : 'local', key: `ops/spend/${x.date}.json` }); }));
  app.post('/api/twin/ops/spend/check', w(async (q, s) => { const est = +q.body?.est_usd; if (!(est >= 0) || est > 100) throw err(400, 'est_usd must be 0-100');
    const x = await ledger.status(); const ok = x.total_usd + est <= x.cap_usd + 1e-9; s.json({ would_allow: ok, est_usd: est, total_usd: x.total_usd, cap_usd: x.cap_usd, remaining_usd: x.remaining_usd, message: ok ? null : SP.CAP_MSG }); }));
  app.use('/api/twin', (q, s) => s.status(404).json({ error: 'Not found' }));
}
module.exports = Object.assign(mount, { enabled, creationEnabled, clientIp, CREATION_OFF_MSG, staticGuard, TWIN_CONSENT, IG_AI_REMINDER, PRODUCT_TYPES });
