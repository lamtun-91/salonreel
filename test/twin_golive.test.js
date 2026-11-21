'use strict';
// Twin go-live hardening: stock avatars only (creation off), engine pins, global daily spend cap + per-IP limit, B-roll policy.
// No network: providers and renderHeygen are mocked; the ledger uses an in-memory ETag store or local disk.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), express = require('express');
const RA = require('../routes_avatar'), SP = require('../spend'), st = require('../storage');
const HGC = require('../heygen_client'), RWC = require('../runway_client'), A = require('../avatar');
const ROOT = path.join(__dirname, '..');
const id = () => crypto.randomBytes(6).toString('hex');
const D = (...p) => path.join(ROOT, 'data', ...p);
const deps = { llm: async () => { throw new Error('no LLM'); }, parseJSON: JSON.parse, run: async () => '', probe: async () => ({ duration: 1 }), cfg: () => ({ llmLive: false }),
  TRACKS: require('../music').TRACKS, D, id, wrap: fn => fn, express };
async function serve(app) { const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); }); return { srv, B: `http://127.0.0.1:${srv.address().port}` }; }
const j = async (B, p, body, m, headers = {}) => { const r = await fetch(B + p, body === undefined && !m ? { headers } : { method: m || 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const waitJob = async (B, pid) => { for (let i = 0; i < 200; i++) { const r = await j(B, `/api/twin/projects/${pid}/job`); if (r.body.state !== 'running') return r.body; await new Promise(z => setTimeout(z, 50)); } throw new Error('job timeout'); };
const made = [];
test.after(() => { for (const pid of made) { fs.rmSync(D('store', 'projects', pid), { recursive: true, force: true }); fs.rmSync(D('cache', pid), { recursive: true, force: true }); }
  for (const d of fs.existsSync(D('store', 'twins')) ? fs.readdirSync(D('store', 'twins')) : []) if (d.startsWith('golive-')) fs.rmSync(D('store', 'twins', d), { recursive: true, force: true });
  fs.rmSync(D('store', 'ops', 'spend', '1999-01-01.json'), { force: true }); });

function memStore({ conflictsFirst = 0 } = {}) {
  const m = new Map(); let n = 0, conflicts = conflictsFirst;
  return { m, writes: () => n,
    async getOpsJSON(k) { const v = m.get(k); return v ? { data: JSON.parse(v.body), etag: v.etag } : { data: null, etag: null }; },
    async putOpsJSON(k, obj, etag) { const cur = m.get(k)?.etag || null; if (conflicts > 0) { conflicts--; throw new st.PreconditionFailed(); }
      if ((etag || null) !== cur) throw new st.PreconditionFailed(); const e = '"' + (++n) + '"'; m.set(k, { body: JSON.stringify(obj), etag: e }); return e; } };
}
const at = iso => () => new Date(iso);
const HG1 = [{ provider: 'heygen', engine: 'avatar_iii', est_usd: 0.3 }];

// ---------- stock avatars only ----------
async function twinApp(extra = {}) {
  const slug = 'golive-' + id(), app = express(); app.use(express.json());
  RA({ app, ...deps, slug, trainMs: 0, env: {}, ...extra });
  return { slug, ...(await serve(app)) };
}
test('golive: twin creation is refused server-side (403) and only stock avatars are listed/usable', async () => {
  const { srv, B } = await twinApp();
  try {
    const c = await j(B, '/api/twin/config'); assert.equal(c.body.twinCreation, false);
    for (const [p, b] of [['/api/twin/avatars/upload-url', { contentType: 'video/mp4' }], ['/api/twin/avatars', { name: 'Me', role: 'owner' }], ['/api/twin/avatars/av_owner01/consent', {}], ['/api/twin/demo/reset', {}]]) {
      const r = await j(B, p, b); assert.equal(r.status, 403, p); assert.match(r.body.error, /not available yet/); }
    const L = (await j(B, '/api/twin/avatars')).body; assert.ok(L.avatars.length >= 1); assert.ok(L.avatars.every(a => a.sample), 'only stock (Sample) avatars');
    const own = await j(B, '/api/twin/projects', { avatar_id: 'av_owner01', template: 'tip', prompt: 'Tip about trims' }); assert.equal(own.status, 403);
    const ok = await j(B, '/api/twin/projects', { avatar_id: L.avatars[0].id, template: 'tip', prompt: 'Tip about trims' }); assert.equal(ok.status, 200); made.push(ok.body.id);
    assert.deepEqual(ok.body.overlays, { brand: false, ai_label: false }, 'overlay toggles stay off by default');
    assert.equal(RA.creationEnabled({ ENABLE_TWIN_CREATION: '1' }), true); assert.equal(RA.creationEnabled({}), false);
  } finally { srv.close(); }
  const ui = fs.readFileSync(path.join(ROOT, 'public/twin.js'), 'utf8'); assert.match(ui, /const add = !canCreate \? '' :/); assert.match(ui, /C\.twinCreation/);
  const html = fs.readFileSync(path.join(ROOT, 'public/twin.html'), 'utf8'); assert.match(html, /id="igCall"/); assert.match(html, /id="consent"/);
});

test('golive: stock avatar cards report stub=false when HeyGen is configured live', async () => {
  const { srv: s1, B: b1 } = await twinApp();
  try {
    const off = (await j(b1, '/api/twin/avatars')).body;
    assert.equal(off.stub, true);
    assert.ok(off.avatars.every(a => a.sample && a.stub === true));
  } finally { s1.close(); }
  const { srv, B } = await twinApp({ hg: { configured: () => true } });
  try {
    const c = (await j(B, '/api/twin/config')).body;
    assert.equal(c.heygenConfigured, true); assert.equal(c.stub, false);
    const L = (await j(B, '/api/twin/avatars')).body;
    assert.equal(L.stub, false, 'library stub reflects live mode');
    assert.ok(L.avatars.length >= 1);
    assert.ok(L.avatars.every(a => a.sample && a.stub === false), 'stock cards are not leftover stubs');
    const one = await j(B, '/api/twin/avatars/' + L.avatars[0].id);
    assert.equal(one.status, 200); assert.equal(one.body.stub, false);
  } finally { srv.close(); }
});

// ---------- engine pins ----------
test('golive: production pins avatar_iii and gen4_turbo; per-render guards unchanged', () => {
  const prod = { NODE_ENV: 'production' };
  assert.equal(HGC.engineFor({}, prod), 'avatar_iii'); assert.equal(HGC.engineFor({}, { ...prod, HEYGEN_ENGINE: 'avatar_iii' }), 'avatar_iii');
  assert.throws(() => HGC.engineFor({}, { ...prod, HEYGEN_ENGINE: 'avatar_iv' }), /pinned to avatar_iii/);
  assert.equal(RWC.modelFor({}, prod), 'gen4_turbo'); assert.throws(() => RWC.modelFor({}, { ...prod, RUNWAY_MODEL: 'gen4.5' }), /pinned to gen4_turbo/);
  assert.deepEqual({ ...HGC.GUARD }, { maxUsd: 0.5, maxSeconds: 30 }); assert.deepEqual({ ...RWC.GUARD }, { maxSeconds: 10, maxUsd: 1 });
});

// ---------- ledger ----------
test('golive cap: reservations count toward the daily cap and block once it would be exceeded', async () => {
  const store = memStore(), logs = [];
  const L = SP.createLedger({ store, env: { DAILY_SPEND_CAP_USD: '1', PAID_RENDERS_PER_IP_PER_DAY: '99' }, now: at('2026-11-21T15:00:00Z'), log: m => logs.push(m) });
  await L.reserve({ items: HG1, ip: '1.1.1.1' }); await L.reserve({ items: HG1, ip: '1.1.1.2' }); await L.reserve({ items: HG1, ip: '1.1.1.3' });
  await assert.rejects(L.reserve({ items: HG1, ip: '1.1.1.4' }), e => e.code === 'daily_cap' && e.status === 429 && e.message === SP.CAP_MSG);
  const s = await L.status(); assert.equal(s.total_usd, 0.9); assert.equal(s.remaining_usd, 0.1); assert.equal(s.date, '2026-11-21');
  assert.ok(store.m.has('ops/spend/2026-11-21.json'));
  assert.ok(logs.some(m => /\[spend\] reserve id=sp_\w+ provider=heygen engine=avatar_iii est_usd=0\.3000 day_total=0\.9000\/1/.test(m)), logs.join('\n'));
  assert.ok(logs.some(m => /REFUSED daily_cap/.test(m)));
  assert.equal(SP.config({}).capUsd, 5, 'default cap is $5'); assert.equal(SP.config({}).perIp, 3);
});
test('golive cap: release on provider rejection frees the budget (and the IP slot); reconcile uses the actual cost', async () => {
  const store = memStore(); const L = SP.createLedger({ store, env: { DAILY_SPEND_CAP_USD: '0.5', PAID_RENDERS_PER_IP_PER_DAY: '1' }, now: at('2026-11-21T15:00:00Z'), log: () => {} });
  const r = await L.reserve({ items: [{ provider: 'heygen', engine: 'avatar_iii', est_usd: 0.3 }, { provider: 'runway', engine: 'gen4_turbo', est_usd: 0.25 }].slice(0, 1), ip: 'a' });
  await assert.rejects(L.reserve({ items: HG1, ip: 'b' }), e => e.code === 'daily_cap');
  await L.release(r, 'heygen', 'insufficient_credit'); assert.equal((await L.status()).total_usd, 0);
  const r2 = await L.reserve({ items: HG1, ip: 'a' }); // same IP allowed again: the released render didn't count
  await L.reconcile(r2, 'heygen', 0.21); assert.equal((await L.status()).total_usd, 0.21);
  assert.equal(SP.definiteRejection({ status: 402 }), true); assert.equal(SP.definiteRejection({ code: 'timeout' }), false);
});
test('golive cap: the counter resets at midnight America/New_York', async () => {
  const store = memStore(); let now = new Date('2026-11-22T04:59:00Z'); // 11:59 PM ET on Nov 21
  const L = SP.createLedger({ store, env: { DAILY_SPEND_CAP_USD: '0.3' }, now: () => now, log: () => {} });
  await L.reserve({ items: HG1, ip: 'x' }); await assert.rejects(L.reserve({ items: HG1, ip: 'y' }), e => e.code === 'daily_cap');
  assert.equal(SP.dayKey(now), '2026-11-21');
  now = new Date('2026-11-22T05:00:00Z'); // midnight ET -> new day
  assert.equal(SP.dayKey(now), '2026-11-22'); assert.equal((await L.status()).total_usd, 0);
  await L.reserve({ items: HG1, ip: 'y' }); assert.deepEqual([...store.m.keys()].sort(), ['ops/spend/2026-11-21.json', 'ops/spend/2026-11-22.json']);
  assert.equal(SP.dayKey(new Date('2026-07-01T03:59:00Z')), '2026-06-30', 'EDT offset handled');
});
test('golive cap: persistence - a fresh ledger (restart) sees the stored total; optimistic writes retry on conflict', async () => {
  const store = memStore({ conflictsFirst: 2 }); const env = { DAILY_SPEND_CAP_USD: '0.6' }, now = at('2026-11-21T15:00:00Z');
  await SP.createLedger({ store, env, now, log: () => {} }).reserve({ items: HG1, ip: 'p' });
  const L2 = SP.createLedger({ store, env, now, log: () => {} }); assert.equal((await L2.status()).total_usd, 0.3);
  await L2.reserve({ items: HG1, ip: 'q' }); await assert.rejects(L2.reserve({ items: HG1, ip: 'r' }), e => e.code === 'daily_cap');
  const always = { getOpsJSON: store.getOpsJSON, putOpsJSON: async () => { throw new st.PreconditionFailed(); } };
  await assert.rejects(SP.createLedger({ store: always, env: { DAILY_SPEND_CAP_USD: '100' }, now, log: () => {} }).reserve({ items: HG1, ip: 'z' }), e => e.status === 503);
  const broken = { getOpsJSON: async () => { throw new Error('R2 down'); }, putOpsJSON: async () => {} };
  await assert.rejects(SP.createLedger({ store: broken, env, now, log: () => {} }).reserve({ items: HG1, ip: 'z' }), e => e.code === 'ledger_unavailable' && e.status === 503, 'fails closed');
  // local-disk store (dev) honours the same preconditions
  const k = 'ops/spend/1999-01-01.json'; fs.rmSync(path.join(st.LOCAL, k), { force: true });
  const e1 = await st.putOpsJSON(k, { a: 1 }, null); await assert.rejects(st.putOpsJSON(k, { a: 2 }, null), e => e.code === 'precondition_failed');
  const g = await st.getOpsJSON(k); assert.equal(g.etag, e1); await st.putOpsJSON(k, { a: 3 }, g.etag); assert.deepEqual((await st.getOpsJSON(k)).data, { a: 3 });
  await assert.rejects(st.putOpsJSON('projects/abc/x.json', {}, null), /bad ops key/);
});
test('golive rate limit: max N paid renders per IP per day (other IPs unaffected); IPs stored hashed', async () => {
  const store = memStore(); const L = SP.createLedger({ store, env: { DAILY_SPEND_CAP_USD: '100', PAID_RENDERS_PER_IP_PER_DAY: '3' }, now: at('2026-11-21T15:00:00Z'), log: () => {} });
  for (let i = 0; i < 3; i++) await L.reserve({ items: HG1, ip: '9.9.9.9' });
  await assert.rejects(L.reserve({ items: HG1, ip: '9.9.9.9' }), e => e.code === 'ip_limit' && e.status === 429 && /still edit/.test(e.message));
  await L.reserve({ items: HG1, ip: '8.8.8.8' });
  assert.doesNotMatch(store.m.get('ops/spend/2026-11-21.json').body, /9\.9\.9\.9|8\.8\.8\.8/);
});

// ---------- routes: paid render gating, $0 re-edits, release on rejection, B-roll policy ----------
function liveApp({ cap = '1', perIp = '3', createVideo, rwConfigured = false } = {}) {
  const store = memStore(), ledger = SP.createLedger({ store, env: { DAILY_SPEND_CAP_USD: cap, PAID_RENDERS_PER_IP_PER_DAY: perIp }, log: () => {} });
  const calls = { create: 0, assemble: 0, promo: [] };
  const hg = { configured: () => true, engine: () => 'avatar_iii', stockAvatarIds: () => ['Daphne_public_4'],
    createVideo: createVideo || (async () => { calls.create++; return { video_id: 'v_' + calls.create }; }), waitForVideo: async () => ({ video_url: 'https://x/v.mp4', duration: 18 }), download: async () => {} };
  const rw = { configured: () => rwConfigured, imageToVideo: async () => { throw new Error('runway must not be called'); }, waitForTask: async () => ({}) };
  const renderHeygen = async (p, o) => { calls.assemble++; calls.promo.push(o.promo);
    const raw = path.join(o.dir, 'heygen_raw.mp4'); let info = p.heygen && fs.existsSync(raw) ? p.heygen : null;
    if (!info) { const c = await o.hg.createVideo({ script: p.script.text }); fs.mkdirSync(o.dir, { recursive: true }); fs.writeFileSync(raw, 'RAW'); info = { video_id: c.video_id }; }
    const out = path.join(o.dir, `out_${Date.now()}_${calls.assemble}.mp4`); fs.writeFileSync(out, 'MP4');
    return { out, raw, heygen: info, duration: 18, captions: [], music: false, track: 'none', loudness: null, overlays: A.cleanOverlays(p.overlays), ai_label: null }; };
  const app = express(); app.use(express.json()); RA({ app, ...deps, slug: 'golive-' + id(), env: {}, ledger, hg, rw, renderHeygen });
  return { app, calls, ledger, store };
}
async function approvedProject(B, ip, template = 'tip') {
  const L = (await j(B, '/api/twin/avatars')).body;
  const p = (await j(B, '/api/twin/projects', { avatar_id: L.avatars[0].id, template, prompt: 'Why regular trims matter' })).body; made.push(p.id);
  await j(B, `/api/twin/projects/${p.id}/draft`, {}); await waitJob(B, p.id);
  const a = await j(B, `/api/twin/projects/${p.id}/approve`, { approved: true }); assert.equal(a.status, 200, JSON.stringify(a.body)); return p;
}
test('golive routes: paid render reserves; re-edit and export variants reuse the stored clip for $0; cap and IP limit answer 429 with the salon message', async () => {
  const L = liveApp({ cap: '0.5', perIp: '1' }); const { srv, B } = await serve(L.app);
  try {
    const H = { 'cf-connecting-ip': '5.5.5.5' };
    const p1 = await approvedProject(B);
    const r1 = await j(B, `/api/twin/projects/${p1.id}/render`, {}, 'POST', H); assert.equal(r1.status, 202); assert.equal((await waitJob(B, p1.id)).state, 'done');
    assert.equal(L.calls.create, 1); const s1 = await L.ledger.status(); assert.ok(s1.total_usd > 0 && s1.total_usd <= 0.5, JSON.stringify(s1));
    assert.ok(await st.exists(`projects/${p1.id}/raw/heygen_raw.mp4`), 'paid clip persisted for $0 re-edits after restarts');
    fs.rmSync(D('cache', p1.id), { recursive: true, force: true }); // simulate a restart wiping local disk
    const re = await j(B, `/api/twin/projects/${p1.id}/rerender`, { captions: [{ start_s: 0, end_s: 3, text: 'Trim often' }] }, 'POST', H); assert.equal(re.status, 202); assert.equal((await waitJob(B, p1.id)).state, 'done');
    const ex = await j(B, `/api/twin/projects/${p1.id}/export`, { consent: true, music: false }, 'POST', H); assert.equal(ex.status, 200);
    assert.equal(L.calls.create, 1, 'no new HeyGen render for re-edits/exports'); assert.equal((await L.ledger.status()).total_usd, s1.total_usd, '$0 for stored-clip reuse');
    const p2 = await approvedProject(B);
    const ipBlocked = await j(B, `/api/twin/projects/${p2.id}/render`, {}, 'POST', H); assert.equal(ipBlocked.status, 429); assert.match(ipBlocked.body.error, /daily limit/);
    const capBlocked = await j(B, `/api/twin/projects/${p2.id}/render`, {}, 'POST', { 'cf-connecting-ip': '6.6.6.6' }); assert.equal(capBlocked.status, 429); assert.equal(capBlocked.body.error, SP.CAP_MSG);
    assert.equal(L.calls.create, 1);
    const ops = await j(B, '/api/twin/ops/spend'); assert.equal(ops.body.total_usd, s1.total_usd); assert.equal(ops.body.cap_usd, 0.5); assert.ok(!JSON.stringify(ops.body).includes('5.5.5.5'));
    const chk = await j(B, '/api/twin/ops/spend/check', { est_usd: 0.5 }); assert.equal(chk.body.would_allow, false); assert.equal(chk.body.message, SP.CAP_MSG);
    assert.equal((await j(B, '/api/twin/ops/spend/check', { est_usd: 0 })).body.would_allow, true);
  } finally { srv.close(); }
});
test('golive routes: a provider rejection releases the reservation; no product => no B-roll; Runway never called for Tip', async () => {
  const L = liveApp({ cap: '1', createVideo: async () => { throw Object.assign(new Error('Insufficient credits'), { status: 402, code: 'insufficient_credit' }); } });
  const { srv, B } = await serve(L.app);
  try {
    const p = await approvedProject(B, null, 'promo');
    assert.equal((await j(B, `/api/twin/projects/${p.id}/render`, {})).status, 202); const jb = await waitJob(B, p.id);
    assert.equal(jb.state, 'error'); assert.match(jb.error, /Insufficient credits/);
    assert.equal((await L.ledger.status()).total_usd, 0, 'released'); assert.equal(L.calls.promo[0], null, 'promo without a product photo has no B-roll');
  } finally { srv.close(); }
});
test('golive B-roll: prod still is the photoreal countertop; promo builds one clean-surface clip, no product composite, no presenter clip', async () => {
  const buf = fs.readFileSync(path.join(ROOT, 'assets/broll_countertop.jpg')); assert.ok(buf.length > 100000, 'photoreal asset replaced the drawn one');
  const TR = require('../twin_render'); const calls = [];
  const rw = { imageToVideo: async b => { calls.push(b); return { task_id: 't', model: 'gen4_turbo', estimate: { usd: 0.25 } }; }, waitForTask: async () => ({ output: ['https://x'] }), download: async (u, d) => fs.writeFileSync(d, 'x') };
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gl_'));
  const b = await TR.buildPromoBroll({ styleAStill: path.join(ROOT, 'assets/broll_countertop.jpg'), includeB: true, styleBStill: path.join(ROOT, 'assets/broll_countertop.jpg') }, { rw, dir });
  assert.equal(calls.length, 1); assert.equal(b.length, 1); assert.equal(b[0].composite, false); assert.equal(calls[0].promptText, A.BROLL_PROMPTS.a);
  fs.rmSync(dir, { recursive: true, force: true });
  const src = fs.readFileSync(path.join(ROOT, 'routes_avatar.js'), 'utf8'); assert.match(src, /compositeProduct: false/); assert.doesNotMatch(src, /includeB: true|styleBStill/);
});
