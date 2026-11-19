// Studio API: projects stored in R2 (or local disk) under projects/{id}/
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const MUSIC = require('./music'), st = require('./storage'), S = require('./studio'), P = require('./pipeline'), SS = require('./shotstack');
const CONSENT = 'The client agreed to be featured online.';
const P_outDur = sg => Math.round(SS.segmentTimelineDuration(sg) * 1000) / 1000;

module.exports = ({ app, llm, parseJSON, run, probe, cfg, TRACKS, D, id, wrap }) => {
  const cache = pid => { const d = D('cache', pid); fs.mkdirSync(d, { recursive: true }); return d; };
  const pkey = pid => `projects/${pid}/project.json`;
  const load = async pid => { if (!/^[a-z0-9]{12}$/.test(pid)) throw new Error('bad project id'); return st.getJSON(pkey(pid)); };
  const save = async p => { p.updated = new Date().toISOString(); await st.putJSON(pkey(p.id), p); return p; };
  const live = () => cfg().llmLive;
  // long steps run as background jobs (proxies drop requests > ~100s); client polls /job
  const jobs = {};
  const job = (name, fn) => wrap(async (q, s) => {
    const pid = q.params.id; await load(pid);
    if (jobs[pid]?.state === 'running') return s.status(409).json({ error: 'Another step is still running', job: jobs[pid] });
    const j = jobs[pid] = { name, state: 'running', started: Date.now() };
    s.status(202).json({ job: j }); st.putJSON(`projects/${pid}/job.json`, j).catch(() => {});
    fn(q).then(() => { j.state = 'done'; }).catch(e => { console.error(name, e); j.state = 'error'; j.error = e.message; }).finally(() => { j.ms = Date.now() - j.started; st.putJSON(`projects/${pid}/job.json`, j).catch(() => {}); });
  });
  app.get('/api/projects/:id/job', wrap(async (q, s) => {
    if (jobs[q.params.id]) return s.json(jobs[q.params.id]); await load(q.params.id);
    const j = await st.getJSON(`projects/${q.params.id}/job.json`).catch(() => null);
    if (j?.state === 'running') return s.json({ ...j, state: 'error', error: 'The server restarted during this step (free plan). Please try again.' });
    s.json(j || { state: 'idle' });
  }));
  async function local(p, key) { // download raw clip once into cache
    const f = path.join(cache(p.id), key.split('/').pop()); if (!fs.existsSync(f)) await st.getFile(key, f); return f; }
  async function frameAt(src, t, out, w = 448) { await run('ffmpeg', ['-y', '-ss', Math.max(0, t).toFixed(2), '-i', src, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', '6', out]); return fs.existsSync(out) ? fs.readFileSync(out).toString('base64') : null; }
  async function metrics(src, a, b) {
    const out = await run('ffmpeg', ['-hide_banner', '-ss', a.toFixed(2), '-t', (b - a).toFixed(2), '-i', src, '-vf', 'fps=5,scale=320:-2,signalstats,metadata=print:file=-', '-an', '-f', 'null', '-']).catch(() => '');
    const avg = k => { const v = [...out.matchAll(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`, 'g'))].map(m => +m[1]); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; };
    return { yavg: avg('YAVG'), ydif: avg('YDIF') };
  }
  // letterbox / blurred-fill bars: 3 gray frames across [a,b] -> crop fractions or null
  async function detectBars(src, a, b) {
    const W = 180, H = 320, N = 3, d = Math.max(0.5, b - a);
    const buf = await new Promise(res => require('child_process').execFile('ffmpeg', ['-v', 'error', '-ss', a.toFixed(2), '-t', d.toFixed(2), '-i', src,
      '-vf', `fps=${N}/${d.toFixed(2)},scale=${W}:${H},format=gray`, '-frames:v', String(N), '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 8 << 20 }, (e, out) => res(e ? null : out)));
    const n = buf ? Math.floor(buf.length / (W * H)) : 0;
    return n ? S.analyzeBars(buf, W, H, n) : null;
  }
  const view = async p => ({ ...p, clipsView: Object.fromEntries(await Promise.all(Object.entries(p.clips || {}).map(async ([k, c]) => [k, { ...c, url: await st.presignGet(c.key) }]))),
    previewUrl: p.render ? await st.presignGet(p.render.key) : null, storage: st.R2 ? 'r2' : 'local' });

  // local-disk stand-ins for presigned URLs
  app.put('/api/local/put', wrap(async (q, s) => { const k = st.verifyLocal(q.query, 'put'), f = st.lp(k); fs.mkdirSync(path.dirname(f), { recursive: true });
    await new Promise((res, rej) => q.pipe(fs.createWriteStream(f)).on('finish', res).on('error', rej)); s.json({ ok: true }); }));
  app.get('/api/local/get', wrap(async (q, s) => { const k = st.verifyLocal(q.query, 'get'); if (q.query.dl) s.attachment(q.query.dl); s.sendFile(st.lp(k)); }));

  app.get('/api/studio/config', (q, s) => { const rp = SS.resolveProvider(); s.json({ storage: st.R2 ? 'r2' : 'local', llmLive: live(), provider: cfg().provider, renderProvider: rp.provider, renderProviderReason: rp.reason, styles: S.STYLES, moods: S.MOODS,
    tracks: Object.entries(TRACKS).map(([k, v]) => ({ id: k, label: v.label, name: v.name, mood: v.mood, moodLabel: v.moodLabel, bpm: v.bpm, drop_s: v.drop_s ?? null })), defaultTrack: MUSIC.DEFAULT, consent: CONSENT }); });

  // My Reels
  app.get('/api/projects', wrap(async (q, s) => {
    const ids = await st.listProjectIds(), out = [];
    for (const i of ids.slice(-50)) { try { const p = await st.getJSON(pkey(i)); out.push({ id: p.id, created: p.created, updated: p.updated, status: p.status, salon: p.profile?.salon, style: p.inputs?.style, concept: p.plan?.concept, exported: !!p.export }); } catch {} }
    s.json(out.sort((a, b) => (b.updated || '').localeCompare(a.updated || '')));
  }));
  app.get('/api/projects/:id', wrap(async (q, s) => s.json(await view(await load(q.params.id)))));

  // 1. create + shot list
  app.post('/api/projects', wrap(async (q, s) => {
    const { profile = {}, style = 'Transformation', mood = 'Luxe', music = MUSIC.DEFAULT } = q.body;
    const p = { id: crypto.randomBytes(6).toString('hex'), created: new Date().toISOString(), status: 'planning', profile, inputs: { style, mood, music: music === 'none' ? 'none' : MUSIC.resolve(music) }, clips: {} };
    const ctx = { profile, style, mood, music: p.inputs.music };
    p.plan = live() ? S.cleanShots(parseJSON(await llm({ system: 'You are a social video producer for hair salons. Reply with JSON only.', text: S.shotPrompt(ctx) })), style) : S.mockShots(ctx);
    p.plan.mode = live() ? 'live' : 'demo'; p.status = 'filming';
    s.json(await view(await save(p)));
  }));

  // 2. guided filming: presigned upload, then register
  app.post('/api/projects/:id/upload-url', wrap(async (q, s) => {
    const p = await load(q.params.id), slot = String(q.body.slot || ''), ct = String(q.body.contentType || 'video/mp4');
    if (slot !== 'full' && !p.plan.shots.find(x => x.id === slot)) throw new Error('unknown shot slot');
    if (!/^video\//.test(ct)) throw new Error('video files only');
    const ext = (String(q.body.ext || 'mp4').toLowerCase().match(/^[a-z0-9]{2,4}$/) || ['mp4'])[0];
    const key = `projects/${p.id}/raw/${slot}_${Date.now().toString(36)}.${ext}`;
    s.json({ key, ...(await st.presignPut(key, ct)) });
  }));
  app.post('/api/projects/:id/clips', job('clips', async q => {
    const p = await load(q.params.id), { slot, key } = q.body;
    if (!String(key).startsWith(`projects/${p.id}/raw/`) || !(await st.exists(key))) throw new Error('upload not found');
    const f = await local(p, key), m = await probe(f);
    const dims = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', f])).streams[0] || {};
    if (!dims.width || !(m.duration > 0.5)) throw new Error('That file has no playable video (or is under 0.5s). Please re-record this shot.');
    let [w, h] = [dims.width, dims.height]; if (Math.abs(dims.side_data_list?.[0]?.rotation || 0) === 90) [w, h] = [h, w];
    if (slot === 'full') {
      p.source = { mode: 'single', key, duration: m.duration }; p.clips = {};
      const dur = Math.min(m.duration, 120), n = Math.min(40, Math.max(4, Math.round(dur))), stamps = Array.from({ length: n }, (_, i) => (i + 0.5) * dur / n);
      let segs;
      if (live()) { const imgs = []; for (const [i, t] of stamps.entries()) { const b = await frameAt(f, t, path.join(cache(p.id), `sp${i}.jpg`), 320); if (b) imgs.push(b); }
        segs = S.cleanSplit(parseJSON(await llm({ system: 'You are a video editor. Reply with JSON only.', images: imgs, text: S.splitPrompt(p.plan.shots, stamps, dur) })), p.plan.shots, dur);
      } else segs = S.mockSplit(p.plan.shots, dur);
      for (const g of segs) p.clips[g.shot_id] = { key, src_start: g.start_s, src_end: g.end_s, duration: Math.round((g.end_s - g.start_s) * 100) / 100, width: w, height: h, auto_split: true, note: g.what_is_visible };
      p.split = { mode: live() ? 'live' : 'demo', segments: segs };
    } else {
      if (!p.plan.shots.find(x => x.id === slot)) throw new Error('unknown shot slot');
      if (p.source?.mode === 'single') { p.clips = {}; }
      p.source = { mode: 'slots' };
      p.clips[slot] = { key, src_start: 0, src_end: m.duration, duration: m.duration, width: w, height: h };
    }
    delete p.qc; delete p.edit; delete p.render; delete p.consent; delete p.export; delete p.gaps; p.status = 'filming';
    await save(p);
  }));

  // 3. QC + gap report
  app.post('/api/projects/:id/qc', job('qc', async q => {
    const p = await load(q.params.id), items = [], metricsBy = {}, images = []; let fn = 1;
    for (const shot of p.plan.shots) { const clip = p.clips[shot.id]; if (!clip) continue;
      const f = await local(p, clip.key), a = clip.src_start, b = clip.src_end;
      metricsBy[shot.id] = await metrics(f, a, b);
      metricsBy[shot.id].bars = await detectBars(f, a, b).catch(() => null);
      const stamps = [0.15, 0.5, 0.85].map(x => x * clip.duration), nums = [];
      if (live()) for (const [i, t] of stamps.entries()) { const im = await frameAt(f, a + t, path.join(cache(p.id), `qc_${shot.id}_${i}.jpg`), 384); if (im) { images.push(im); nums.push(fn++); } }
      items.push({ shot, clip, stamps, frameNums: nums });
    }
    if (!items.length) throw new Error('Upload at least one clip first');
    p.qc = live() ? S.cleanQC(parseJSON(await llm({ system: 'You are a strict video QC assistant. Reply with JSON only.', images, text: S.qcPrompt(items) })), items, metricsBy) : S.mockQC(items, metricsBy);
    p.qc.mode = live() ? 'live' : 'demo'; p.gaps = S.gapReport(p.plan.shots, p.clips, p.qc, p.inputs.style);
    if (!p.qc.has_haircut) p.gaps.ready = false, p.gaps.note = 'No finished haircut detected in the reveal — reshoot the reveal.';
    p.status = p.gaps.ready ? 'ready_to_edit' : 'needs_reshoot';
    await save(p);
  }));

  // 4. edit plan + script (Tung's prompt) -> 5. render
  async function absoluteUrl(u) {
    if (!u) return null;
    if (/^https:\/\//i.test(u)) return u;
    if (/^http:\/\//i.test(u)) throw new Error('Shotstack media URLs must be https (got http)');
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (!base) throw new Error('PUBLIC_BASE_URL is required so Shotstack can fetch local media');
    if (!/^https:\/\//i.test(base)) throw new Error('PUBLIC_BASE_URL must be https for Shotstack media fetch');
    return base + (u.startsWith('/') ? u : '/' + u);
  }
  async function mediaUrl(key) {
    return absoluteUrl(await st.presignGet(key));
  }
  async function ensureMusicUrl(p, track) {
    if (track === 'none') return null;
    const local = MUSIC.fileFor(track); if (!local) throw new Error('music file missing for track ' + track);
    const key = MUSIC.storageKey(track); // shared library object; presigned https GET for Shotstack
    if (!(await st.exists(key))) await st.putFile(key, local, 'audio/mp4');
    return mediaUrl(key);
  }
  async function renderWithFfmpeg(p) {
    const e = p.edit, dir = cache(p.id), segFiles = [];
    for (const [i, sg] of e.segments.entries()) {
      const c = p.clips[sg.shot_id], src = await local(p, c.key), crop = (p.qc?.clips || []).find(q => q.shot_id === sg.shot_id)?.crop || null;
      const want = P_outDur(sg), sgc = { ...sg, crop };
      const h = crypto.createHash('md5').update(JSON.stringify([c.key, c.src_start, sgc, 2])).digest('hex').slice(0, 10), out = path.join(dir, `seg_${h}.mp4`);
      // tpad+trim pins every segment to exactly its planned length so the assembled reel matches the plan
      if (!fs.existsSync(out)) await run('ffmpeg', ['-y', '-ss', (c.src_start + sg.in_s).toFixed(3), '-t', (sg.out_s - sg.in_s).toFixed(3), '-i', src, '-filter_complex', S.segFilter(sgc).replace(/\[v\]$/, `,tpad=stop_mode=clone:stop_duration=1,trim=0:${want.toFixed(3)},setpts=PTS-STARTPTS[v]`), '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', '-threads', '1', out]);
      segFiles.push({ f: out, d: want });
    }
    // transitions rendered as short pieces (tail+head), then concat: tiny memory footprint on 512MB instances
    const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', '30', '-video_track_timescale', '15360', '-threads', '1'];
    // true crossfades (xfade, never through black) or hard cuts; total = sum(segments) - sum(overlaps) = plan total
    const plan = S.xfadePlan(segFiles.map(x => x.d), e.segments), pieces = [], tmp = [];
    for (const pc of plan.pieces) { const o = path.join(dir, `pc_${tmp.length}.mp4`); tmp.push(o);
      if (pc.kind === 'xfade') await run('ffmpeg', ['-y', '-threads', '1', '-ss', pc.ss.toFixed(3), '-t', pc.dur.toFixed(3), '-i', segFiles[pc.from].f, '-threads', '1', '-t', pc.dur.toFixed(3), '-i', segFiles[pc.to].f, '-filter_complex', `[0:v]setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=0.2[a];[1:v]setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=0.2[b];[a][b]xfade=transition=${pc.transition}:duration=${pc.dur.toFixed(3)}:offset=0,trim=0:${pc.dur.toFixed(3)}[v]`, '-map', '[v]', '-an', ...enc, o]);
      else await run('ffmpeg', ['-y', '-threads', '1', '-ss', pc.ss.toFixed(3), '-t', pc.dur.toFixed(3), '-i', segFiles[pc.seg].f, '-an', ...enc, o]);
      pieces.push(o); }
    let t = plan.total;
    const list = path.join(dir, 'concat.txt'); fs.writeFileSync(list, pieces.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const acc = path.join(dir, 'acc.mp4'); await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', acc]);
    tmp.forEach(f => fs.unlinkSync(f)); const accDur = (await probe(acc)).duration || t;
    const args = ['-y', '-threads', '1', '-i', acc], fc = [], last = '[0:v]tpad=stop_mode=clone:stop_duration=1[vp];[vp]';
    const music = p.musicOn !== false && e.track !== 'none' ? MUSIC.fileFor(e.track) : null; // no-music export: silent bed, same timing
    const total = t, ass = path.join(dir, 'cap.ass');
    const lines = P.cleanSegments(e.overlays || [], total, 'text');
    fs.writeFileSync(ass, P.buildAss({ lines, salon: p.profile.salon || '', duration: total, tone: String(p.inputs.mood).toLowerCase() }));
    fc.push(`${last}subtitles='${S.ffEsc(ass)}':fontsdir=/usr/share/fonts/truetype/dejavu,format=yuv420p[vout]`);
    const ai = 1;
    if (music) { args.push('-ss', String(e.music_start_s || 0), '-i', music); fc.push(`[${ai}:a]apad,atrim=0:${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 1).toFixed(3)}:d=1[aout]`); }
    else { args.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo'); fc.push(`[${ai}:a]anull[aout]`); }
    const out = path.join(dir, `render_${Date.now().toString(36)}.mp4`);
    args.push('-filter_complex_threads', '1', '-filter_complex', fc.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-threads', '1', '-x264-params', 'rc-lookahead=4:sync-lookahead=0:bframes=1', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out);
    await run('ffmpeg', args); if (acc.includes('acc_')) fs.unlinkSync(acc);
    let measured = total; try { measured = (await probe(out)).duration || total; } catch {}
    const key = `projects/${p.id}/renders/${path.basename(out)}`; await st.putFile(key, out, 'video/mp4'); fs.unlinkSync(out);
    p.render = { key, at: new Date().toISOString(), duration: Math.round(measured * 100) / 100, plan_total: e.total, assembled: Math.round(accDur * 100) / 100, provider: 'ffmpeg', transitions: 'xfade-or-cut', music: !!music, music_track: music ? e.track : null }; delete p.consent; delete p.export;
  }
  async function renderWithShotstack(p) {
    const e = p.edit;
    const clipUrls = {};
    for (const sg of e.segments) {
      const c = p.clips[sg.shot_id];
      if (!c?.key) throw new Error('missing clip key for ' + sg.shot_id);
      clipUrls[sg.shot_id] = await mediaUrl(c.key);
    }
    const musicUrl = p.musicOn === false ? null : await ensureMusicUrl(p, e.track); // no-music export omits the soundtrack clip
    const crops = Object.fromEntries((p.qc?.clips || []).filter(q => q.crop).map(q => [q.shot_id, q.crop]));
    const { edit: payload, meta } = SS.buildEditPayload({ edit: e, clips: p.clips, clipUrls, musicUrl, profile: p.profile || {}, crops });
    const client = SS.createClient();
    // Resume polling an in-flight Shotstack job instead of re-submitting (avoids duplicate renders).
    let renderId = p.render?.provider === 'shotstack' && p.render?.status && p.render.status !== 'done' && p.render.status !== 'failed'
      ? p.render.renderId : null;
    if (!renderId) {
      const submitted = await client.submit(payload);
      renderId = submitted.id;
      p.render = {
        provider: 'shotstack', renderId, status: 'queued', at: new Date().toISOString(),
        duration: meta.total, approximations: meta.approximations, env: client.version,
      };
      await save(p);
    } else {
      p.render = { ...p.render, status: 'polling', approximations: meta.approximations, env: client.version };
      await save(p);
    }
    const done = await client.waitForRender(renderId, {
      onTick: async (stt) => {
        p.render = { ...p.render, status: stt.status, renderId, updated: new Date().toISOString() };
        if (stt.error) p.render.error = String(stt.error).slice(0, 500);
        await save(p).catch(() => {});
      },
    });
    const dir = cache(p.id);
    const out = path.join(dir, `shotstack_${renderId}.mp4`);
    await client.downloadToFile(done.url, out);
    let duration = meta.total;
    try { duration = (await probe(out)).duration || meta.total; } catch {}
    duration = Math.round(duration * 100) / 100;
    const key = `projects/${p.id}/renders/${path.basename(out)}`;
    await st.putFile(key, out, 'video/mp4');
    try { fs.unlinkSync(out); } catch {}
    p.render = {
      key, at: new Date().toISOString(), duration, plan_total: e.total, transitions: 'crossfade-or-cut', music: !!musicUrl, music_track: musicUrl ? e.track : null,
      provider: 'shotstack', renderId, status: 'done', env: client.version, watermarked: client.version === 'stage',
      approximations: meta.approximations, url: done.url,
    };
    delete p.consent; delete p.export;
  }
  const RENDER_VERSION = 2; // bump when renderer output changes so cached variants are not reused
  const editSig = e => crypto.createHash('md5').update(JSON.stringify([RENDER_VERSION, e.segments, e.overlays, e.music_start_s, e.track])).digest('hex').slice(0, 12);
  async function renderProject(p, { music } = {}) {
    p.musicOn = music === undefined ? p.edit?.music !== false : !!music;
    if (p.edit) p.edit.music = p.musicOn;
    const have = p.renderVariants?.[p.musicOn ? 'music' : 'no_music'];
    if (have?.key && p.edit && have.sig === editSig(p.edit) && (await st.exists(have.key).catch(() => false))) { delete p.musicOn; p.render = { ...have, reused: true }; delete p.consent; delete p.export; return; }
    try { await renderOnce(p); } finally { delete p.musicOn; }
    if (p.render?.key) { p.render.sig = editSig(p.edit); p.renderVariants = { ...(p.renderVariants || {}), [p.render.music ? 'music' : 'no_music']: p.render }; }
  }
  async function renderOnce(p) {
    const choice = SS.resolveProvider();
    p.renderMeta = { choice: choice.provider, reason: choice.reason, music: p.musicOn, at: new Date().toISOString(), ...(choice.provider === 'shotstack' ? { shotstack_env: SS.apiBase().version } : {}) };
    if (choice.provider === 'shotstack') {
      try {
        await renderWithShotstack(p);
        return;
      } catch (err) {
        const msg = err?.message || String(err);
        console.error('shotstack render failed', msg);
        p.render = {
          ...(p.render || {}),
          provider: 'shotstack',
          status: 'failed',
          error: msg.slice(0, 800),
          at: new Date().toISOString(),
        };
        await save(p).catch(() => {});
        if (SS.strictMode()) throw err;
        console.error('falling back to ffmpeg renderer');
        p.renderMeta.fallback = 'ffmpeg';
        p.renderMeta.fallbackError = msg.slice(0, 800);
        await renderWithFfmpeg(p);
        p.render.fallbackFrom = 'shotstack';
        p.render.fallbackError = msg.slice(0, 500);
        return;
      }
    }
    await renderWithFfmpeg(p);
  }

  app.post('/api/projects/:id/edit', job('edit', async q => {
    const p = await load(q.params.id);
    if (!p.gaps?.ready && !q.body.force) throw new Error('Fix the gap report first (missing/reshoot shots), or continue anyway');
    const ctx = { shots: p.plan.shots, clips: p.clips, qc: p.qc, mood: p.inputs.mood, music: p.inputs.music, style: p.inputs.style };
    if (live()) {
      const raw = parseJSON(await llm({ system: 'You are a short-form video editor. Reply with JSON only.', effort: 'low', text: S.editPrompt(ctx) }) /* low effort: ~30s instead of ~140s; the server clamps the plan anyway */);
      console.log('edit plan from AI:', (raw.segments || []).map(x => x.shot_id + ' ' + x.in_s + '-' + x.out_s + ' x' + x.speed).join(' | '));
      p.edit = S.cleanEdit(raw, ctx);
    } else p.edit = S.mockEdit(ctx);
    p.edit.mode = live() ? 'live' : 'demo';
    const override = S.haircutOverride(q.body, p.qc);
    if (override) p.qc_override = override;
    const look = { has_haircut: p.qc.has_haircut !== false || !!override, clip_breakdown: S.breakdownFor(p.edit, p.qc) }, prof = { ...p.profile };
    let copy;
    if (!look.has_haircut) copy = { error: 'no_haircut' };
    else if (live()) {
      const text = P.copyPrompt({ look, tone: p.inputs.mood, profile: prof, duration: p.edit.total });
      // frame-based captioning: 1-2 small keyframes per clip from the final timeline; text-only fallback on any failure
      let images = [], frameMap = [], visionErr = null;
      try {
        frameMap = S.captionFrameStamps(p.edit, p.clips);
        for (const c of frameMap) for (const [k, f] of c.frames.entries()) {
          const src = await local(p, p.clips[c.shot_id].key), b64 = await frameAt(src, f.src_s, path.join(cache(p.id), `cap_${c.clip}_${k}.jpg`), 512);
          if (!b64) throw new Error(`no frame for clip ${c.clip}`); images.push(b64);
        }
      } catch (e) { visionErr = 'frames: ' + e.message; images = []; }
      if (images.length) {
        try { copy = P.cleanCopy(parseJSON(await llm({ system: P.copySystem, images, detail: 'low', effort: 'low', timeoutMs: +process.env.VISION_TIMEOUT_MS || 180000, retry: false, text: text + P.visionCaptionAddendum(frameMap) })), p.edit.total); if (copy.error) throw new Error(copy.error); copy.mode = 'vision'; }
        catch (e) { visionErr = 'vision: ' + String(e.message).slice(0, 200); copy = null; }
      }
      if (!copy || copy.error === undefined && !copy.script?.length) { copy = P.cleanCopy(parseJSON(await llm({ system: P.copySystem, text })), p.edit.total); copy.mode = 'text'; }
      copy.frames = { count: images.length, per_clip: frameMap.map(c => ({ clip: c.clip, shot_id: c.shot_id, on: [c.start_s, c.end_s], src_s: c.frames.map(f => f.src_s) })), ...(visionErr ? { fallback: visionErr } : {}) };
    }
    else copy = P.cleanCopy(P.mockCopy({ ...look, cut: 'Fresh cut', color: 'Signature color', tags: [] }, String(p.inputs.mood).toLowerCase(), prof, p.edit.total), p.edit.total);
    if (copy.error) { p.status = 'needs_reshoot'; await save(p); throw new Error('no_haircut'); }
    // time each line to the clip actually on screen (writer gives line.clip; fallback max overlap)
    p.edit.overlays = S.alignOverlays(copy.script, p.edit); p.edit.overlays_source = copy.script.map(({ text, start_s, end_s, clip }) => ({ text, start_s, end_s, clip }));
    p.edit.overlay_check = S.validateOverlays(p.edit.overlays, p.edit); p.edit.caption_mode = copy.mode || (live() ? 'text' : 'demo'); if (copy.frames) p.edit.caption_frames = copy.frames; p.copy = { caption: copy.caption, hashtags: copy.hashtags };
    delete p.renderVariants; await renderProject(p, { music: q.body.music }); p.status = 'review'; if (override) p.edit.qc_overridden = true;
    await save(p);
  }));
  app.post('/api/projects/:id/rerender', job('rerender', async q => {
    const p = await load(q.params.id); if (!p.edit) throw new Error('No edit plan yet');
    if (Array.isArray(q.body.overlays)) p.edit.overlays = P.cleanSegments(q.body.overlays.map(o => ({ ...o, text: P.noEmoji(o.text) })), p.edit.total, 'text');
    if (q.body.caption != null) p.copy.caption = String(q.body.caption).slice(0, 2200);
    if (q.body.hashtags) p.copy.hashtags = P.cleanCopy({ script: [], hashtags: q.body.hashtags }, 1).hashtags;
    await renderProject(p, { music: typeof q.body.music === 'boolean' ? q.body.music : undefined }); await save(p);
  }));
  // 6. export (consent required)
  app.post('/api/projects/:id/export', wrap(async (q, s) => {
    const p = await load(q.params.id);
    if (q.body.consent !== true) return s.status(400).json({ error: 'Consent is required: confirm the client agreed to be featured online.' });
    if (!p.render) throw new Error('Render first');
    if (typeof q.body.music === 'boolean' && (p.render.music !== false) !== q.body.music) {
      const v = p.renderVariants?.[q.body.music ? 'music' : 'no_music'];
      if (!v?.key || v.sig !== editSig(p.edit)) return s.status(409).json({ error: `Re-render ${q.body.music ? 'with' : 'without'} music first`, need_rerender: { music: q.body.music } });
      p.render = v;
    }
    if (q.body.caption != null) p.copy.caption = String(q.body.caption).slice(0, 2200);
    p.consent = { agreed: true, statement: CONSENT, at: new Date().toISOString(), render: p.render.key };
    p.export = { at: p.consent.at, key: p.render.key, music: p.render.music !== false, provider: p.render.provider, env: p.render.env || null }; p.status = 'exported';
    await save(p);
    s.json({ download: await st.presignGet(p.render.key, `salonreel-${p.id}${p.export.music ? '' : '-no-music'}.mp4`), music: p.export.music, caption: p.copy.caption, hashtags: p.copy.hashtags });
  }));
};
module.exports.ensureCors = st.ensureCors;
