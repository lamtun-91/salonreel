'use strict';
// Global daily spend cap for paid AI renders (HeyGen + Runway), shared by all users and instances.
// - The day is the America/New_York calendar date; the counter lives at ops/spend/YYYY-MM-DD.json (R2 in prod, local only in dev),
//   so restarts never reset it and a new date starts from $0 at midnight ET.
// - Estimated cost is RESERVED before any provider call (read-modify-write with an ETag precondition, retried on conflict),
//   released if the provider rejects the job, and reconciled to the actual cost when the provider reports it.
// - A per-IP limit (paid renders per IP per day) is enforced in the same atomic write. IPs are stored only as salted hashes.
// - Logs every reservation (provider, engine, estimate, running total); never keys.
const crypto = require('crypto');
const TZ = 'America/New_York';
const CAP_MSG = "Today's AI video limit has been reached — please try again tomorrow.";
const ipMsg = n => `You've made ${n} new AI videos today, the daily limit. You can still edit captions and music on videos you already made; new videos unlock tomorrow.`;
const UNAVAILABLE_MSG = 'AI videos are temporarily unavailable — please try again in a few minutes.';
const dayKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const r4 = x => Math.round(x * 10000) / 10000;
class SpendLimitError extends Error { constructor(msg, code, status = 429) { super(msg); this.name = 'SpendLimitError'; this.code = code; this.status = status; } }

function config(env = process.env) {
  const cap = +(env.DAILY_SPEND_CAP_USD ?? 5), perIp = parseInt(env.PAID_RENDERS_PER_IP_PER_DAY ?? 3, 10);
  return { capUsd: Number.isFinite(cap) && cap >= 0 ? cap : 5, perIp: Number.isFinite(perIp) && perIp >= 0 ? perIp : 3 };
}
function createLedger({ store, env = process.env, now = () => new Date(), log = m => console.log(m), salt = env.SPEND_IP_SALT || 'salonreel-spend', maxTries = 6 } = {}) {
  if (!store?.getOpsJSON || !store?.putOpsJSON) throw new Error('ledger needs a store');
  const key = date => `ops/spend/${date}.json`;
  const ipHash = (ip, date) => crypto.createHash('sha256').update(`${salt}:${date}:${ip || 'unknown'}`).digest('hex').slice(0, 16);
  const blank = (date, cfg) => ({ date, tz: TZ, cap_usd: cfg.capUsd, total_usd: 0, reservations: [], ip_counts: {}, updated: null });
  const totalOf = doc => r4(doc.reservations.reduce((t, r) => t + r.items.reduce((u, i) => u + (i.status === 'released' ? 0 : (i.actual_usd ?? i.est_usd)), 0), 0));
  async function mutate(date, fn) {
    for (let t = 0; t < maxTries; t++) {
      const { data, etag } = await store.getOpsJSON(key(date));
      const doc = data || blank(date, config(env));
      const out = fn(doc); doc.total_usd = totalOf(doc); doc.updated = now().toISOString();
      try { await store.putOpsJSON(key(date), doc, etag); return { doc, out }; }
      catch (e) { if (e.code !== 'precondition_failed') throw e; } // someone else wrote first: re-read and retry
    }
    throw new SpendLimitError(UNAVAILABLE_MSG, 'ledger_busy', 503);
  }
  // items: [{ provider: 'heygen'|'runway', engine, est_usd }]
  async function reserve({ items, ip, project = null }) {
    const cfg = config(env), date = dayKey(now()), h = ipHash(ip, date), sum = r4(items.reduce((t, i) => t + i.est_usd, 0));
    const id = 'sp_' + crypto.randomBytes(6).toString('hex');
    let res;
    try {
      res = await mutate(date, doc => {
        doc.cap_usd = cfg.capUsd;
        const used = totalOf(doc);
        if ((doc.ip_counts[h] || 0) >= cfg.perIp) throw new SpendLimitError(ipMsg(cfg.perIp), 'ip_limit');
        if (used + sum > cfg.capUsd + 1e-9) throw new SpendLimitError(CAP_MSG, 'daily_cap');
        doc.ip_counts[h] = (doc.ip_counts[h] || 0) + 1;
        doc.reservations.push({ id, at: now().toISOString(), project, ip: h, items: items.map(i => ({ provider: i.provider, engine: i.engine, est_usd: r4(i.est_usd), actual_usd: null, status: 'reserved' })) });
        return used;
      });
    } catch (e) {
      if (e instanceof SpendLimitError) { log(`[spend] REFUSED ${e.code} date=${date} est_usd=${sum.toFixed(4)} cap=${cfg.capUsd}`); throw e; }
      log(`[spend] ledger error, refusing paid render: ${String(e.message).slice(0, 120)}`); throw new SpendLimitError(UNAVAILABLE_MSG, 'ledger_unavailable', 503);
    }
    for (const i of items) log(`[spend] reserve id=${id} provider=${i.provider} engine=${i.engine} est_usd=${i.est_usd.toFixed(4)} day_total=${res.doc.total_usd.toFixed(4)}/${cfg.capUsd} date=${date}`);
    return { id, date, items: items.map(i => i.provider) };
  }
  // release one provider's item (or all) - used when the provider rejected the job, so nothing was spent
  async function release(r, provider = null, reason = 'rejected') {
    const { doc } = await mutate(r.date, d => { const x = d.reservations.find(y => y.id === r.id); if (!x) return;
      for (const i of x.items) if ((!provider || i.provider === provider) && i.status === 'reserved') { i.status = 'released'; i.reason = reason; }
      if (x.items.every(i => i.status === 'released') && !x.ip_refunded) { d.ip_counts[x.ip] = Math.max(0, (d.ip_counts[x.ip] || 1) - 1); x.ip_refunded = true; } });
    log(`[spend] release id=${r.id} provider=${provider || 'all'} reason=${reason} day_total=${doc.total_usd.toFixed(4)}`);
  }
  async function reconcile(r, provider, actualUsd) {
    const { doc } = await mutate(r.date, d => { const x = d.reservations.find(y => y.id === r.id); if (!x) return;
      for (const i of x.items) if (i.provider === provider && i.status !== 'released') { i.status = 'spent'; if (actualUsd != null && Number.isFinite(+actualUsd)) i.actual_usd = r4(+actualUsd); } });
    log(`[spend] reconcile id=${r.id} provider=${provider} actual_usd=${actualUsd == null ? 'unknown(est kept)' : (+actualUsd).toFixed(4)} day_total=${doc.total_usd.toFixed(4)}`);
  }
  async function status() { const cfg = config(env), date = dayKey(now()); const { data } = await store.getOpsJSON(key(date));
    const total = data ? totalOf(data) : 0; return { date, tz: TZ, cap_usd: cfg.capUsd, total_usd: total, remaining_usd: r4(Math.max(0, cfg.capUsd - total)), per_ip_limit: cfg.perIp, reservations: data ? data.reservations.length : 0 }; }
  return { reserve, release, reconcile, status, key, ipHash };
}
// Which provider errors mean "rejected, nothing billed" (safe to release)
const definiteRejection = e => !!e && (e.code === 'spend_not_allowed' || e.code === 'cost_guard' || e.code === 'no_key' || e.code === 'bad_request' || e.code === 'bad_engine' || e.code === 'bad_model' || (e.status >= 400 && e.status < 500));
module.exports = { createLedger, dayKey, config, SpendLimitError, definiteRejection, CAP_MSG, UNAVAILABLE_MSG, ipMsg, TZ };
