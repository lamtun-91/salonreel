// Studio API: projects stored in R2 (or local disk) under projects/{id}/
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const st = require('./storage'), S = require('./studio'), P = require('./pipeline');
const CONSENT = 'The client agreed to be featured online.';

module.exports = ({ app, llm, parseJSON, run, probe, cfg, TRACKS, D, id, wrap }) => {
  const cache = pid => { const d = D('cache', pid); fs.mkdirSync(d, { recursive: true }); return d; };
  const pkey = pid => `projects/${pid}/project.json`;
  const load = async pid => { if (!/^[a-z0-9]{12}$/.test(pid)) throw new Error('bad project id'); return st.getJSON(pkey(pid)); };
  const save = async p => { p.updated = new Date().toISOString(); await st.putJSON(pkey(p.id), p); return p; };
  const live = () => cfg().llmLive;
  async function local(p, key) { // download raw clip once into cache
    const f = path.join(cache(p.id), key.split('/').pop()); if (!fs.existsSync(f)) await st.getFile(key, f); return f; }
  async function frameAt(src, t, out, w = 448) { await run('ffmpeg', ['-y', '-ss', Math.max(0, t).toFixed(2), '-i', src, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', '6', out]); return fs.existsSync(out) ? fs.readFileSync(out).toString('base64') : null; }
  async function metrics(src, a, b) {
    const out = await run('ffmpeg', ['-hide_banner', '-ss', a.toFixed(2), '-t', (b - a).toFixed(2), '-i', src, '-vf', 'fps=5,scale=320:-2,signalstats,metadata=print:file=-', '-an', '-f', 'null', '-']).catch(() => '');
    const avg = k => { const v = [...out.matchAll(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`, 'g'))].map(m => +m[1]); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; };
    return { yavg: avg('YAVG'), ydif: avg('YDIF') };
  }
  const view = async p => ({ ...p, clipsView: Object.fromEntries(await Promise.all(Object.entries(p.clips || {}).map(async ([k, c]) => [k, { ...c, url: await st.presignGet(c.key) }]))),
    previewUrl: p.render ? await st.presignGet(p.render.key) : null, storage: st.R2 ? 'r2' : 'local' });

  // local-disk stand-ins for presigned URLs
  app.put('/api/local/put', wrap(async (q, s) => { const k = st.verifyLocal(q.query, 'put'), f = st.lp(k); fs.mkdirSync(path.dirname(f), { recursive: true });
    await new Promise((res, rej) => q.pipe(fs.createWriteStream(f)).on('finish', res).on('error', rej)); s.json({ ok: true }); }));
  app.get('/api/local/get', wrap(async (q, s) => { const k = st.verifyLocal(q.query, 'get'); if (q.query.dl) s.attachment(q.query.dl); s.sendFile(st.lp(k)); }));

  app.get('/api/studio/config', (q, s) => s.json({ storage: st.R2 ? 'r2' : 'local', llmLive: live(), provider: cfg().provider, styles: S.STYLES, moods: S.MOODS,
    tracks: Object.entries(TRACKS).map(([k, v]) => ({ id: k, label: v.label, bpm: S.TRACK_BPM[k] })), consent: CONSENT }));

  // My Reels
  app.get('/api/projects', wrap(async (q, s) => {
    const ids = await st.listProjectIds(), out = [];
    for (const i of ids.slice(-50)) { try { const p = await st.getJSON(pkey(i)); out.push({ id: p.id, created: p.created, updated: p.updated, status: p.status, salon: p.profile?.salon, style: p.inputs?.style, concept: p.plan?.concept, exported: !!p.export }); } catch {} }
    s.json(out.sort((a, b) => (b.updated || '').localeCompare(a.updated || '')));
  }));
  app.get('/api/projects/:id', wrap(async (q, s) => s.json(await view(await load(q.params.id)))));

  // 1. create + shot list
  app.post('/api/projects', wrap(async (q, s) => {
    const { profile = {}, style = 'Transformation', mood = 'Luxe', music = 'velvet' } = q.body;
    const p = { id: crypto.randomBytes(6).toString('hex'), created: new Date().toISOString(), status: 'planning', profile, inputs: { style, mood, music: TRACKS[music] ? music : 'velvet' }, clips: {} };
    const ctx = { profile, style, mood, music: p.inputs.music };
    p.plan = live() ? S.cleanShots(parseJSON(await llm({ system: 'You are a social video producer for hair salons. Reply with JSON only.', text: S.shotPrompt(ctx) }))) : S.mockShots(ctx);
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
  app.post('/api/projects/:id/clips', wrap(async (q, s) => {
    const p = await load(q.params.id), { slot, key } = q.body;
    if (!String(key).startsWith(`projects/${p.id}/raw/`) || !(await st.exists(key))) throw new Error('upload not found');
    const f = await local(p, key), m = await probe(f);
    const dims = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', f])).streams[0] || {};
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
    delete p.qc; delete p.edit; delete p.render; delete p.consent; delete p.export; p.status = 'filming';
    s.json(await view(await save(p)));
  }));

  // 3. QC + gap report
  app.post('/api/projects/:id/qc', wrap(async (q, s) => {
    const p = await load(q.params.id), items = [], metricsBy = {}, images = []; let fn = 1;
    for (const shot of p.plan.shots) { const clip = p.clips[shot.id]; if (!clip) continue;
      const f = await local(p, clip.key), a = clip.src_start, b = clip.src_end;
      metricsBy[shot.id] = await metrics(f, a, b);
      const stamps = [0.15, 0.5, 0.85].map(x => x * clip.duration), nums = [];
      if (live()) for (const [i, t] of stamps.entries()) { const im = await frameAt(f, a + t, path.join(cache(p.id), `qc_${shot.id}_${i}.jpg`), 384); if (im) { images.push(im); nums.push(fn++); } }
      items.push({ shot, clip, stamps, frameNums: nums });
    }
    if (!items.length) throw new Error('Upload at least one clip first');
    p.qc = live() ? S.cleanQC(parseJSON(await llm({ system: 'You are a strict video QC assistant. Reply with JSON only.', images, text: S.qcPrompt(items) })), items, metricsBy) : S.mockQC(items, metricsBy);
    p.qc.mode = live() ? 'live' : 'demo'; p.gaps = S.gapReport(p.plan.shots, p.clips, p.qc);
    if (!p.qc.has_haircut) p.gaps.ready = false, p.gaps.note = 'No finished haircut detected in the reveal — reshoot the reveal.';
    p.status = p.gaps.ready ? 'ready_to_edit' : 'needs_reshoot';
    s.json(await view(await save(p)));
  }));

  // 4. edit plan + script (Tung's prompt) -> 5. render
  async function renderProject(p) {
    const e = p.edit, dir = cache(p.id), segFiles = [];
    for (const [i, sg] of e.segments.entries()) {
      const c = p.clips[sg.shot_id], src = await local(p, c.key);
      const h = crypto.createHash('md5').update(JSON.stringify([c.key, c.src_start, sg])).digest('hex').slice(0, 10), out = path.join(dir, `seg_${h}.mp4`);
      if (!fs.existsSync(out)) await run('ffmpeg', ['-y', '-ss', (c.src_start + sg.in_s).toFixed(3), '-t', (sg.out_s - sg.in_s).toFixed(3), '-i', src, '-filter_complex', S.segFilter(sg), '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-threads', '2', out]);
      segFiles.push({ f: out, d: (await probe(out)).duration });
    }
    // xfade chain using actual segment durations
    const args = ['-y']; segFiles.forEach(x => args.push('-i', x.f));
    const music = TRACKS[e.track]?.expr ? D('music', e.track + '_60.m4a') : null;
    let fc = [], last = '[0:v]', t = segFiles[0].d;
    for (let i = 1; i < segFiles.length; i++) {
      const tr = e.segments[i].transition_in, d = tr.type === 'cut' ? 0.04 : Math.min(tr.duration, segFiles[i].d * 0.4, segFiles[i - 1].d * 0.4);
      const off = Math.max(0, t - d); fc.push(`${last}[${i}:v]xfade=transition=${tr.type === 'cut' ? 'fade' : tr.type}:duration=${d.toFixed(3)}:offset=${off.toFixed(3)}[x${i}]`);
      last = `[x${i}]`; t = off + segFiles[i].d;
    }
    const total = t, ass = path.join(dir, 'cap.ass');
    const lines = P.cleanSegments(e.overlays || [], total, 'text');
    fs.writeFileSync(ass, P.buildAss({ lines, salon: p.profile.salon || '', duration: total, tone: String(p.inputs.mood).toLowerCase() }));
    fc.push(`${last}subtitles='${S.ffEsc(ass)}':fontsdir=/usr/share/fonts/truetype/dejavu,format=yuv420p[vout]`);
    const ai = segFiles.length;
    if (music) { args.push('-ss', String(e.music_start_s || 0), '-i', music); fc.push(`[${ai}:a]atrim=0:${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 1).toFixed(3)}:d=1[aout]`); }
    else { args.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo'); fc.push(`[${ai}:a]anull[aout]`); }
    const out = path.join(dir, `render_${Date.now().toString(36)}.mp4`);
    args.push('-filter_complex', fc.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out);
    await run('ffmpeg', args);
    const key = `projects/${p.id}/renders/${path.basename(out)}`; await st.putFile(key, out, 'video/mp4'); fs.unlinkSync(out);
    p.render = { key, at: new Date().toISOString(), duration: Math.round(total * 100) / 100 }; delete p.consent; delete p.export;
  }
  app.post('/api/projects/:id/edit', wrap(async (q, s) => {
    const p = await load(q.params.id);
    if (!p.gaps?.ready && !q.body.force) throw new Error('Fix the gap report first (missing/reshoot shots), or continue anyway');
    const ctx = { shots: p.plan.shots, clips: p.clips, qc: p.qc, mood: p.inputs.mood, music: p.inputs.music, style: p.inputs.style };
    p.edit = live() ? S.cleanEdit(parseJSON(await llm({ system: 'You are a short-form video editor. Reply with JSON only.', text: S.editPrompt(ctx) })), ctx) : S.mockEdit(ctx);
    p.edit.mode = live() ? 'live' : 'demo';
    const look = { has_haircut: p.qc.has_haircut !== false, clip_breakdown: S.breakdownFor(p.edit, p.qc) }, prof = { ...p.profile };
    let copy;
    if (!look.has_haircut) copy = { error: 'no_haircut' };
    else if (live()) copy = P.cleanCopy(parseJSON(await llm({ system: P.copySystem, text: P.copyPrompt({ look, tone: p.inputs.mood, profile: prof, duration: p.edit.total }) })), p.edit.total);
    else copy = P.cleanCopy(P.mockCopy({ ...look, cut: 'Fresh cut', color: 'Signature color', tags: [] }, String(p.inputs.mood).toLowerCase(), prof, p.edit.total), p.edit.total);
    if (copy.error) { p.status = 'needs_reshoot'; await save(p); return s.status(422).json({ error: 'no_haircut' }); }
    p.edit.overlays = copy.script; p.copy = { caption: copy.caption, hashtags: copy.hashtags };
    await renderProject(p); p.status = 'review';
    s.json(await view(await save(p)));
  }));
  app.post('/api/projects/:id/rerender', wrap(async (q, s) => {
    const p = await load(q.params.id); if (!p.edit) throw new Error('No edit plan yet');
    if (Array.isArray(q.body.overlays)) p.edit.overlays = P.cleanSegments(q.body.overlays.map(o => ({ ...o, text: P.noEmoji(o.text) })), p.edit.total, 'text');
    if (q.body.caption != null) p.copy.caption = String(q.body.caption).slice(0, 2200);
    if (q.body.hashtags) p.copy.hashtags = P.cleanCopy({ script: [], hashtags: q.body.hashtags }, 1).hashtags;
    await renderProject(p); s.json(await view(await save(p)));
  }));
  // 6. export (consent required)
  app.post('/api/projects/:id/export', wrap(async (q, s) => {
    const p = await load(q.params.id);
    if (q.body.consent !== true) return s.status(400).json({ error: 'Consent is required: confirm the client agreed to be featured online.' });
    if (!p.render) throw new Error('Render first');
    if (q.body.caption != null) p.copy.caption = String(q.body.caption).slice(0, 2200);
    p.consent = { agreed: true, statement: CONSENT, at: new Date().toISOString(), render: p.render.key };
    p.export = { at: p.consent.at, key: p.render.key }; p.status = 'exported';
    await save(p);
    s.json({ download: await st.presignGet(p.render.key, `salonreel-${p.id}.mp4`), caption: p.copy.caption, hashtags: p.copy.hashtags });
  }));
};
module.exports.ensureCors = st.ensureCors;
