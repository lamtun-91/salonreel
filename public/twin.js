// "Your AI Twin" UI (M1, stubbed backend). Same look as the Hair Reveal studio; never converts a Hair Reveal reel.
const $ = id => document.getElementById(id);
let C = null, L = null, SEL = null, TPL = 'tip', P = null, prodKey = null, pollT = null;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(m) { $('toast').textContent = m; $('toast').style.display = 'block'; setTimeout(() => $('toast').style.display = 'none', 2200); }
async function api(p, body, m) {
  const r = await fetch(p, body === undefined && !m ? {} : { method: m || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({ error: r.statusText })); if (!r.ok) throw new Error(j.error || r.statusText);
  if (r.status == 202 && j.job) { const pid = p.split('/')[4];
    for (;;) { await new Promise(z => setTimeout(z, 1500)); const js = await (await fetch(`/api/twin/projects/${pid}/job`)).json();
      if (js.state == 'error') throw new Error(js.error); if (js.state != 'running') return api(`/api/twin/projects/${pid}`); } }
  return j;
}
function go(n) { document.querySelectorAll('section').forEach((s, i) => s.classList.toggle('on', i == n)); document.querySelectorAll('#steps span').forEach((s, i) => s.classList.toggle('on', i <= n));
  if (n == 0) drawLib(); if (n == 1) drawTpls(); if (n == 3) drawDraft(); if (n == 5) drawReview(); window.scrollTo(0, 0); }

// ---------- 1 avatar library ----------
const ST = { ready: 'Ready', training: 'Training…', failed: "Couldn't train" };
async function loadLib() { L = await api('/api/twin/avatars'); if (!SEL || !L.avatars.some(a => a.id == SEL && a.selectable)) SEL = L.preselected; }
async function drawLib(refetch = true) {
  try { if (refetch || !L) await loadLib(); } catch (x) { $('e0').textContent = x.message; return; }
  const canCreate = !!(C && C.twinCreation); // own-twin creation (M4) is off: stock presenters only
  const add = !canCreate ? '' : `<button class="add" id="addTile"><b>+</b>Add avatar<span style="font-size:11px;margin-top:4px">you or a stylist</span></button>`;
  const cards = L.avatars.map(a => `<div class="av ${a.id == SEL ? 'sel' : ''} ${a.selectable ? '' : 'dis'}" data-id="${a.id}">
    <div class="chips">${a.sample ? '<span class="chip sample">Sample</span>' : ''}<span class="chip ${a.card_status}">${ST[a.card_status]}</span>${a.is_default ? '<span class="chip def">★ Default</span>' : ''}${a.is_last_used ? '<span class="chip last">Last used</span>' : ''}</div>
    <img class="th" src="${esc(a.thumbnail)}" alt="">
    <div class="b"><div class="n">${esc(a.name)}</div><div class="s" style="margin:0;font-size:12px">${esc(a.label)}${a.sample ? ' · stock AI presenter' : ''}</div>
    <div class="acts">${a.sample ? '' : `<button data-act="rename">Rename</button>`}${a.selectable && !a.is_default ? `<button data-act="default">Set default</button>` : ''}<button data-act="delete">${a.sample ? 'Hide' : 'Delete'}</button></div></div></div>`).join('');
  $('lib').innerHTML = (L.avatars.length ? '' : `<div class="empty"><div style="font-size:30px">🎙️</div><b>No avatars yet</b><p class="s" style="margin:6px 0 0">${canCreate ? 'Add yourself or a stylist. Training takes a few minutes, then your twin can talk for you.' : 'Stock AI presenters will appear here.'}</p></div>`) + `<div class="lib">${cards}${add}</div>`;
  if ($('addTile')) $('addTile').onclick = () => { $('avName').value = ''; $('eAdd').textContent = ''; $('addM').classList.add('on'); };
  $('lib').querySelectorAll('.av').forEach(d => d.onclick = async e => {
    const act = e.target.dataset?.act, aid = d.dataset.id, a = L.avatars.find(x => x.id == aid);
    try {
      if (act == 'rename') { const nm = prompt('New name', a.name); if (!nm) return; await api(`/api/twin/avatars/${aid}`, { name: nm }, 'PATCH'); return drawLib(); }
      if (act == 'default') { L = await api(`/api/twin/avatars/${aid}/default`, {}); toast(a.name + ' is now your default'); return drawLib(false); }
      if (act == 'delete') { if (!confirm(a.sample ? `Hide the Sample avatar "${a.name}"?` : `Delete ${a.name}? Reels you already made stay in My Reels.`)) return; L = await api(`/api/twin/avatars/${aid}`, undefined, 'DELETE'); if (SEL == aid) SEL = L.preselected; return drawLib(false); }
      if (!a.selectable) return toast(a.card_status == 'training' ? `${a.name} is still training` : `${a.name} can't be used`);
      SEL = aid; drawLib(false);
    } catch (x) { $('e0').textContent = x.message; }
  });
  const s = L.avatars.find(a => a.id == SEL); $('useBtn').disabled = !s; $('useBtn').textContent = s ? `Use ${s.name} →` : 'Continue →';
  $('useMsg').textContent = s ? (s.sample ? 'Sample avatars are stock AI presenters, not a real stylist.' : '') : (L.avatars.length ? 'Pick a ready avatar' : '');
  clearTimeout(pollT); if (L.avatars.some(a => a.card_status == 'training') && $('t0').classList.contains('on')) pollT = setTimeout(() => drawLib(), 3000);
}
$('addCancel').onclick = () => $('addM').classList.remove('on');
$('addOk').onclick = async () => { try { const f = $('avFile').files[0];
  let footage_key; if (f) { const u = await api('/api/twin/avatars/upload-url', { contentType: f.type || 'video/mp4' }); await fetch(u.url, { method: 'PUT', headers: u.headers, body: f }); footage_key = u.key; }
  const a = await api('/api/twin/avatars', { name: $('avName').value, role: $('avRole').value, footage_key }); $('addM').classList.remove('on'); toast(`Training ${a.name}…`); drawLib(); }
  catch (x) { $('eAdd').textContent = x.message; } };
$('useBtn').onclick = () => go(1);

// ---------- 2 template + brief ----------
function drawTpls() { $('tpls').innerHTML = C.templates.map(t => `<button class="tpl ${t.id == TPL ? 'on' : ''}" data-id="${t.id}"><b>${esc(t.name)}</b><span>${esc(t.blurb)}</span></button>`).join('');
  $('tpls').querySelectorAll('.tpl').forEach(b => b.onclick = () => { const was = C.templates.find(t => t.id == TPL); TPL = b.dataset.id;
    if (!$('prompt').value.trim() || $('prompt').value == was?.example) $('prompt').value = C.templates.find(t => t.id == TPL).example; drawTpls(); });
  if (!$('prompt').value.trim()) $('prompt').value = C.templates.find(t => t.id == TPL).example; }
$('briefBtn').onclick = async () => { $('e1').textContent = ''; const body = { avatar_id: SEL, template: TPL, prompt: $('prompt').value, salon: $('salon').value, mood: $('mood').value, music: $('music').value, language: $('language').value };
  try { P = P && P.avatar_id == SEL && P.status == 'brief' ? await api(`/api/twin/projects/${P.id}`, body, 'PATCH') : await api('/api/twin/projects', body); history.replaceState(null, '', '?project=' + P.id); go(2); }
  catch (x) { $('e1').textContent = x.message; } };

// ---------- 3 product photo ----------
function drawProd() { $('prodPrev').innerHTML = P?.productUrl ? `<img src="${esc(P.productUrl)}" alt="product"><button class="btn ghost sm" id="prodRm">Remove</button>` : '<div style="font-size:34px">🧴</div>';
  if ($('prodRm')) $('prodRm').onclick = async () => { P = await api(`/api/twin/projects/${P.id}/product`, undefined, 'DELETE'); drawProd(); }; }
$('prodFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; $('e2').textContent = ''; $('prodStat').textContent = 'Uploading…';
  try { const u = await api(`/api/twin/projects/${P.id}/product-url`, { contentType: f.type }); const r = await fetch(u.url, { method: 'PUT', headers: u.headers, body: f }); if (!r.ok) throw new Error('Upload failed');
    P = await api(`/api/twin/projects/${P.id}/product`, { key: u.key, mime: f.type }); $('prodStat').textContent = 'Saved for upcoming product B-roll scenes. It won\'t appear over your avatar.'; drawProd(); }
  catch (x) { $('e2').textContent = x.message; $('prodStat').textContent = ''; } };
async function draft(errEl) { errEl.textContent = ''; $('draftBtn').disabled = $('redraftBtn').disabled = true; $('draftStat').textContent = 'Writing your script…';
  try { P = await api(`/api/twin/projects/${P.id}/draft`, {}); go(3); } catch (x) { errEl.textContent = x.message; } finally { $('draftBtn').disabled = $('redraftBtn').disabled = false; } }
$('draftBtn').onclick = () => draft($('e2')); $('skipBtn').onclick = async () => { if (P.product) { P = await api(`/api/twin/projects/${P.id}/product`, undefined, 'DELETE'); drawProd(); } draft($('e2')); };
$('redraftBtn').onclick = () => draft($('e3'));

// ---------- 4 approve ----------
const capRow = (c, i, pre) => `<div class="cap"><input data-i="${i}" data-k="start_s" value="${c.start_s}"><input data-i="${i}" data-k="end_s" value="${c.end_s}"><input data-i="${i}" data-k="text" value="${esc(c.text)}" id="${pre}${i}"></div>`;
const readCaps = (box, src) => src.map((c, i) => { const g = k => box.querySelector(`[data-i="${i}"][data-k="${k}"]`).value; return { start_s: +g('start_s'), end_s: +g('end_s'), text: g('text') }; });
function drawDraft() { if (!P?.script) return; $('script').value = P.script.text; $('durPill').textContent = `~${Math.round(P.total_s)}s`; $('durPill').className = 'pill ok';
  $('draftStat').textContent = (P.script.approved ? 'Approved. ' : 'Nothing is rendered until you approve. ') + (P.script.mode == 'template' ? 'Draft written from the template.' : '');
  $('caps').innerHTML = P.script.captions.map((c, i) => capRow(c, i, 'c')).join('');
  $('broll').innerHTML = P.broll.clips.map((b, i) => `<div class="broll"><b>${b.start_s}s – ${b.end_s}s</b> · salon atmosphere, no faces or hair results<textarea data-i="${i}" rows="2">${esc(b.prompt)}</textarea></div>`).join('') || '<p class="s">No B-roll.</p>';
  $('prodSlot').innerHTML = P.product ? `<div class="broll"><b>Product photo</b> saved for upcoming product B-roll (your real photo, not AI). Not shown in this Reel.</div>` : '';
  $('approve').checked = false; $('approveBtn').disabled = true; }
$('approve').onchange = () => $('approveBtn').disabled = !$('approve').checked;
$('approveBtn').onclick = async () => { $('e3').textContent = '';
  const body = { approved: true, script: $('script').value, captions: readCaps($('caps'), P.script.captions),
    broll: P.broll.clips.map((b, i) => ({ ...b, prompt: $('broll').querySelector(`textarea[data-i="${i}"]`).value })) };
  try { P = await api(`/api/twin/projects/${P.id}/approve`, body); await render(); } catch (x) { $('e3').textContent = x.message; } };
async function render(path = 'render', body = {}) { go(4); $('e4').textContent = ''; let w = 5; $('bar').style.width = '5%'; const t = setInterval(() => { w = Math.min(92, w + 6); $('bar').style.width = w + '%'; }, 700);
  try { P = await api(`/api/twin/projects/${P.id}/${path}`, body); $('bar').style.width = '100%'; go(5); } catch (x) { $('e4').innerHTML = esc(x.message) + ' <a href="#" onclick="go(3);return false">← Back to script</a>'; } finally { clearInterval(t); } }

// ---------- 5 review + export ----------
function drawReview() { if (!P?.render) return; $('prevV').src = P.previewUrl;
  $('renSum').textContent = `${Math.round(P.render.duration)}s · ${P.avatar.name}${P.avatar.sample ? ' (Sample)' : ''} · ${P.render.music ? 'with music' : 'no music'}${P.render.stub ? ' · preview render' : ''}`;
  $('caps2').innerHTML = P.script.captions.map((c, i) => capRow(c, i, 'r')).join('');
  $('caption').value = P.copy?.caption || ''; $('tags').value = (P.copy?.hashtags || []).join(' ');
  $('ovBrand').checked = !!P.overlays?.brand; $('ovLabel').checked = !!P.overlays?.ai_label;
  $('noMusic').checked = !P.render.music; $('noMusic').disabled = !P.render.music; $('consent').checked = false; $('expBtn').disabled = true; $('dl').innerHTML = ''; }
$('consent').onchange = () => $('expBtn').disabled = !$('consent').checked;
// overlay toggles: saved on the project, then the preview is re-rendered with them
async function setOverlays() { $('ovStat').textContent = ' Saving…';
  try { P = await api(`/api/twin/projects/${P.id}/overlays`, { brand: $('ovBrand').checked, ai_label: $('ovLabel').checked }); $('ovStat').textContent = '';
    await render('rerender', { captions: readCaps($('caps2'), P.script.captions) }); } catch (x) { $('e5').textContent = x.message; $('ovStat').textContent = ''; } }
$('ovBrand').onchange = setOverlays; $('ovLabel').onchange = setOverlays;
$('rerBtn').onclick = async () => { $('rerStat').textContent = ' Re-rendering…';
  try { await render('rerender', { captions: readCaps($('caps2'), P.script.captions), copy: { caption: $('caption').value, hashtags: $('tags').value.split(/\s+/).filter(Boolean) } }); } catch (x) { $('e5').textContent = x.message; } $('rerStat').textContent = ''; };
$('expBtn').onclick = async () => { $('e5').textContent = ''; $('expBtn').disabled = true;
  try { const r = await api(`/api/twin/projects/${P.id}/export`, { consent: true, music: !$('noMusic').checked, caption: $('caption').value, hashtags: $('tags').value.split(/\s+/).filter(Boolean) });
    $('dl').innerHTML = `<a class="btn rose" href="${esc(r.download)}" download>⬇ Download MP4</a> <span class="s">Ready${r.music ? '' : ' (no music)'}.</span><div class="igcall"><b>⚠️ When you post: Advanced settings → turn on &ldquo;AI info&rdquo;</b>${esc(r.igAiLabelReminder || '')}</div>`; }
  catch (x) { $('e5').textContent = x.message; } finally { $('expBtn').disabled = !$('consent').checked; } };
$('copyBtn').onclick = () => { navigator.clipboard?.writeText($('caption').value + '\n\n' + $('tags').value); toast('Copied'); };

// ---------- header: path switcher never converts a reel; it starts a new one ----------
$('swReveal').onclick = e => { if (P && !confirm('Switch to Hair Reveal? That starts a new reel. This AI Twin reel stays in My Reels.')) e.preventDefault(); };
$('newBtn').onclick = e => { e.preventDefault(); P = null; history.replaceState(null, '', '/twin.html'); $('prompt').value = ''; go(0); };

// ---------- boot ----------
fetch('/api/twin/config').then(r => r.ok ? r.json() : null).catch(() => null).then(async c => {
  if (!c?.enabled) { document.querySelector('main').innerHTML = '<section class="on"><h2>Your AI Twin isn\'t available yet</h2><p class="s"><a href="/">← Back to Hair Reveal</a></p></section>'; return; }
  C = c; $('stubBanner').hidden = !c.stub;
  $('mood').innerHTML = c.moods.map(m => `<option>${esc(m)}</option>`).join('');
  $('music').innerHTML = c.tracks.map(t => `<option value="${t.id}"${t.id == c.defaultTrack ? ' selected' : ''}>${t.id == 'none' ? 'No music' : esc((t.name || t.label) + (t.bpm ? ' · ' + t.bpm + ' bpm' : ''))}</option>`).join('');
  $('consentTxt').textContent = c.consent; $('igaTxt').textContent = c.igAiLabelReminder;
  const pid = new URLSearchParams(location.search).get('project');
  if (/^[a-z0-9]{12}$/.test(pid || '')) { try { P = await api('/api/twin/projects/' + pid); SEL = P.avatar_id; TPL = P.template; $('prompt').value = P.inputs.prompt; $('salon').value = P.profile.salon; $('mood').value = P.inputs.mood; $('music').value = P.inputs.music; drawProd();
    return go(P.render ? 5 : P.script ? 3 : 2); } catch (x) { toast(x.message); } }
  go(0);
});
