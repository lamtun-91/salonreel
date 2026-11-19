'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SS = require('../shotstack');
const S = require('../studio');

function fixtureEdit() {
  // Representative cleaned edit-plan shape from studio.cleanEdit / mockEdit
  return {
    segments: [
      {
        shot_id: 's1', in_s: 0.5, out_s: 3.5, speed: 1, ramp_to: null,
        zoom: { type: 'none', at_s: 0, scale: 1.15 },
        transition_in: { type: 'cut', duration: 0 },
      },
      {
        shot_id: 's2', in_s: 1, out_s: 4, speed: 1.3, ramp_to: null,
        zoom: { type: 'punch_in', at_s: 0.5, scale: 1.2 },
        transition_in: { type: 'cut', duration: 0 },
      },
      {
        shot_id: 's3', in_s: 0, out_s: 3, speed: 1, ramp_to: 0.5,
        zoom: { type: 'push_in', at_s: 0.2, scale: 1.15 },
        transition_in: { type: 'fade', duration: 0.4 },
      },
      {
        shot_id: 's4', in_s: 0.2, out_s: 5.2, speed: 0.8, ramp_to: null,
        zoom: { type: 'push_in', at_s: 0.5, scale: 1.2 },
        transition_in: { type: 'fadewhite', duration: 0.4 },
      },
    ],
    overlays: [
      { start_s: 0.5, end_s: 3.0, text: 'Ready for a change?' },
      { start_s: 18.0, end_s: 22.0, text: 'Book via link in bio' },
    ],
    music_start_s: 4.5,
    track: 'velvet',
    beat_markers: [0, 0.75, 1.5, 2.25],
    total: 20,
  };
}

function fixtureClips() {
  return {
    s1: { key: 'projects/abc/raw/s1.mp4', src_start: 0, src_end: 6, duration: 6 },
    s2: { key: 'projects/abc/raw/s2.mp4', src_start: 2, src_end: 10, duration: 8 },
    s3: { key: 'projects/abc/raw/s3.mp4', src_start: 0, src_end: 5, duration: 5 },
    s4: { key: 'projects/abc/raw/s4.mp4', src_start: 1, src_end: 9, duration: 8 },
  };
}

function fixtureUrls() {
  return {
    s1: 'https://cdn.example.com/s1.mp4',
    s2: 'https://cdn.example.com/s2.mp4',
    s3: 'https://cdn.example.com/s3.mp4',
    s4: 'https://cdn.example.com/s4.mp4',
  };
}

describe('resolveProvider', () => {
  it('defaults to ffmpeg without key', () => {
    assert.equal(SS.resolveProvider({}).provider, 'ffmpeg');
    assert.equal(SS.resolveProvider({ RENDER_PROVIDER: 'auto' }).provider, 'ffmpeg');
  });
  it('auto selects shotstack when key present', () => {
    assert.equal(SS.resolveProvider({ SHOTSTACK_API_KEY: 'sk_stage_x', RENDER_PROVIDER: 'auto' }).provider, 'shotstack');
  });
  it('honors explicit ffmpeg even with key', () => {
    assert.equal(SS.resolveProvider({ SHOTSTACK_API_KEY: 'sk', RENDER_PROVIDER: 'ffmpeg' }).provider, 'ffmpeg');
  });
  it('requires key for explicit shotstack', () => {
    assert.throws(() => SS.resolveProvider({ RENDER_PROVIDER: 'shotstack' }), /SHOTSTACK_API_KEY/);
  });
});

describe('apiBase', () => {
  it('defaults to stage sandbox', () => {
    assert.equal(SS.apiBase({}).version, 'stage');
    assert.match(SS.apiBase({}).base, /\/edit\/stage$/);
  });
  it('maps v1/production', () => {
    assert.equal(SS.apiBase({ SHOTSTACK_ENV: 'v1' }).version, 'v1');
    assert.equal(SS.apiBase({ SHOTSTACK_ENV: 'production' }).version, 'v1');
  });
});

describe('segmentTimelineDuration', () => {
  it('uses constant speed math', () => {
    assert.equal(SS.segmentTimelineDuration({ in_s: 0, out_s: 4, speed: 2 }), 2);
  });
  it('matches studio half/half ramp math', () => {
    const seg = { in_s: 0, out_s: 4, speed: 1, ramp_to: 0.5 };
    const d = SS.segmentTimelineDuration(seg);
    assert.equal(d, 2 / 1 + 2 / 0.5); // 2 + 4 = 6
  });
});

const videoTracks = payload => payload.timeline.tracks.filter(t => t.clips[0]?.asset?.type === 'video');
// video clips back in timeline order (tracks are stacked latest-on-top)
const videoClipsInOrder = payload => videoTracks(payload).map(t => t.clips[0]).sort((a, b) => a.start - b.start);

describe('buildEditPayload', () => {
  it('builds a 9:16 payload: crossfades by overlap + opacity tween, no fade through background', () => {
    const edit = fixtureEdit();
    const { edit: payload, meta } = SS.buildEditPayload({
      edit, clips: fixtureClips(), clipUrls: fixtureUrls(),
      musicUrl: 'https://cdn.example.com/velvet_60.m4a', profile: { salon: 'Olya Atelier' },
    });
    assert.equal(payload.output.format, 'mp4');
    assert.deepEqual(payload.output.size, { width: 1080, height: 1920 });
    assert.equal(payload.output.fps, 30);

    const vids = videoClipsInOrder(payload);
    assert.equal(vids.length, 4);
    // later clips sit on higher tracks (earlier in the tracks array)
    const vt = videoTracks(payload).map(t => t.clips[0].start);
    assert.deepEqual(vt, [...vt].sort((a, b) => b - a));
    for (const c of vids) {
      assert.equal(c.fit, 'crop'); assert.equal(c.asset.volume, 0);
      assert.equal(c.transition, undefined, 'no transition.in/out: those fade through the background');
    }
    // cut: next starts exactly where previous ends; fade: overlap equals the opacity tween length
    assert.equal(vids[1].start, Math.round((vids[0].start + vids[0].length) * 100) / 100);
    assert.equal(vids[1].opacity, undefined);
    for (const i of [2, 3]) {
      const ov = Math.round((vids[i - 1].start + vids[i - 1].length - vids[i].start) * 100) / 100;
      assert.ok(ov > 0.1, 'overlap');
      assert.equal(vids[i].opacity[0].from, 0); assert.equal(vids[i].opacity[0].to, 1);
      assert.ok(Math.abs(vids[i].opacity[0].length - ov) <= 0.011);
    }
    const last = vids[vids.length - 1];
    assert.ok(Math.abs(last.start + last.length - meta.total) <= 0.011, 'timeline ends at plan total');

    assert.equal(vids[0].asset.trim, 0.5);
    assert.equal(vids[1].asset.trim, 2.31); // source 3.0s at speed 1.3 -> trim 3/1.3 (Shotstack starts at trim x speed)
    assert.equal(vids[1].asset.speed, 1.3);
    assert.ok(Array.isArray(vids[2].asset.speed));
    assert.equal(vids[2].effect, 'zoomInSlow');
    assert.equal(vids[1].effect, 'zoomInFast');

    const music = payload.timeline.tracks.find(t => t.clips[0]?.asset?.type === 'audio').clips[0];
    assert.equal(music.asset.trim, 4.5); assert.equal(music.start, 0); assert.equal(music.length, meta.total);

    const blob = JSON.stringify(payload);
    assert.equal(blob.includes('beat_markers'), false);
    assert.equal(blob.includes('shot_id'), false);
    assert.equal(blob.includes('qc'), false);
  });

  it('total matches studio.layout / cleanEdit plan total (no extra seconds)', () => {
    const clips = { s1: { duration: 5.04, src_start: 0 }, s2: { duration: 5.04, src_start: 0 }, s4: { duration: 5.04, src_start: 0 }, s5: { duration: 5.04, src_start: 0 } };
    // the fa506846b2ab plan that rendered 14.10s for a 12.81s plan
    const segments = [
      { shot_id: 's1', in_s: 0.8, out_s: 3.8, speed: 0.8, ramp_to: null, zoom: { type: 'push_in', at_s: 0.75, scale: 1.12 }, transition_in: { type: 'cut', duration: 0 } },
      { shot_id: 's2', in_s: 0.8, out_s: 4.18, speed: 1.5, ramp_to: null, zoom: { type: 'none', at_s: 0, scale: 1 }, transition_in: { type: 'dissolve', duration: 0.4 } },
      { shot_id: 's4', in_s: 0.8, out_s: 2.15, speed: 1, ramp_to: null, zoom: { type: 'none', at_s: 0, scale: 1 }, transition_in: { type: 'smoothup', duration: 0.35 } },
      { shot_id: 's5', in_s: 0.8, out_s: 4.85, speed: 0.6, ramp_to: null, zoom: { type: 'push_in', at_s: 1.5, scale: 1.1 }, transition_in: { type: 'fade', duration: 0.54 } }];
    const urls = Object.fromEntries(Object.keys(clips).map(k => [k, `https://cdn.example.com/${k}.mp4`]));
    const { meta, edit: payload } = SS.buildEditPayload({ edit: { segments, overlays: [] }, clips, clipUrls: urls, musicUrl: null });
    assert.ok(Math.abs(meta.total - 12.81) <= 0.1, `total ${meta.total}`);
    const vids = videoClipsInOrder(payload), last = vids[vids.length - 1];
    assert.ok(Math.abs(last.start + last.length - 12.81) <= 0.1);
  });

  it('puts salon name and captions in separate zones inside the Reels safe area, with contrast', () => {
    const { edit: payload } = SS.buildEditPayload({ edit: fixtureEdit(), clips: fixtureClips(), clipUrls: fixtureUrls(), musicUrl: null, profile: { salon: 'Olya Atelier' } });
    const texts = payload.timeline.tracks.flatMap(t => t.clips).filter(c => c.asset.type === 'rich-text');
    const brand = texts.find(c => c.asset.text === 'Olya Atelier'), caps = texts.filter(c => c !== brand);
    assert.ok(brand && caps.length);
    const band = c => { const cy = 960 - c.offset.y * 1920; return [cy - c.height / 2, cy + c.height / 2]; };
    const [b0, b1] = band(brand);
    for (const c of caps) {
      const [c0, c1] = band(c);
      assert.ok(c0 > b1 + 200, 'caption band well below the salon name band');
      assert.ok(c1 <= 1920 * 0.65 + 1, 'caption above the bottom 35% IG UI');
      assert.ok(c.asset.background && c.asset.background.opacity >= 0.4, 'caption backing');
      assert.ok(c.asset.shadow);
    }
    assert.ok(b0 >= 1920 * 0.14 - 1, 'salon name below the top 14% IG header');
    assert.ok(brand.asset.shadow || brand.asset.stroke);
  });

  it('applies QC letterbox crops to the asset', () => {
    const { edit: payload } = SS.buildEditPayload({ edit: fixtureEdit(), clips: fixtureClips(), clipUrls: fixtureUrls(), musicUrl: null, crops: { s2: { top: 0.16, bottom: 0.18 } } });
    const vids = videoClipsInOrder(payload);
    assert.deepEqual(vids[1].asset.crop, { top: 0.16, bottom: 0.18 });
    assert.equal(vids[0].asset.crop, undefined);
  });

  it('rejects non-https media urls', () => {
    assert.throws(() => SS.buildEditPayload({ edit: fixtureEdit(), clips: fixtureClips(), clipUrls: { ...fixtureUrls(), s1: '/api/local/get?x=1' }, musicUrl: null, profile: {} }), /public https/);
    assert.throws(() => SS.buildEditPayload({ edit: fixtureEdit(), clips: fixtureClips(), clipUrls: { ...fixtureUrls(), s1: 'http://cdn.example.com/s1.mp4' }, musicUrl: null, profile: {} }), /public https/);
  });

  it('works without music track', () => {
    const { edit: payload } = SS.buildEditPayload({ edit: { ...fixtureEdit(), track: 'none' }, clips: fixtureClips(), clipUrls: fixtureUrls(), musicUrl: null, profile: { salon: 'Olya Atelier' } });
    assert.equal(payload.timeline.tracks.some(t => t.clips[0].asset.type === 'audio'), false);
  });

  it('aligns with cleanEdit fixture durations', () => {
    const clips = { s1: { duration: 5, src_start: 0 }, s2: { duration: 6, src_start: 0 }, s3: { duration: 7, src_start: 0 }, s4: { duration: 8, src_start: 0 }, s5: { duration: 5, src_start: 0 } };
    const shots = [
      { id: 's1', name: 'Before', type: 'before', target_s: 3 }, { id: 's2', name: 'Cut', type: 'cutting', target_s: 4 },
      { id: 's3', name: 'Blow', type: 'blowdry', target_s: 4 }, { id: 's4', name: 'Reveal', type: 'reveal', target_s: 4 },
      { id: 's5', name: 'Back', type: 'reveal', target_s: 3 }];
    const qc = { clips: shots.map(s => ({ shot_id: s.id, best: { start_s: 0, end_s: s.target_s }, what_is_visible: s.name, issues: [] })) };
    const plan = S.mockEdit({ shots, clips, qc, music: 'velvet' });
    const urls = Object.fromEntries(shots.map(s => [s.id, `https://cdn.example.com/${s.id}.mp4`]));
    const { meta } = SS.buildEditPayload({ edit: { ...plan, overlays: [{ start_s: 0.5, end_s: 2.5, text: 'Hook' }] }, clips, clipUrls: urls, musicUrl: 'https://cdn.example.com/m.m4a', profile: { salon: 'Olya Atelier' } });
    assert.ok(Math.abs(meta.total - plan.total) <= 0.05, `shotstack ${meta.total} vs plan ${plan.total}`);
    assert.ok(meta.total >= 15 && meta.total <= 30);
  });
});

describe('createClient (mocked HTTP)', () => {
  it('submits once and polls until done without re-POST', async () => {
    const calls = [];
    let polls = 0;
    const fetchImpl = async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET' });
      if (String(opts.method).toUpperCase() === 'POST' && url.endsWith('/render')) {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ success: true, response: { id: 'rid-1', message: 'queued' } }),
        };
      }
      if (url.includes('/render/rid-1')) {
        polls += 1;
        const status = polls < 3 ? 'rendering' : 'done';
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            success: true,
            response: { id: 'rid-1', status, url: status === 'done' ? 'https://cdn.example.com/out.mp4' : null },
          }),
        };
      }
      if (url === 'https://cdn.example.com/out.mp4') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from('mp4data'),
          body: null,
        };
      }
      throw new Error('unexpected url ' + url);
    };

    const client = SS.createClient({
      env: { SHOTSTACK_API_KEY: 'sk_test', SHOTSTACK_ENV: 'stage', SHOTSTACK_POLL_MS: '10', SHOTSTACK_TIMEOUT_MS: '5000' },
      fetchImpl,
    });
    assert.equal(client.version, 'stage');
    const submitted = await client.submit({ timeline: { tracks: [] }, output: { format: 'mp4' } });
    assert.equal(submitted.id, 'rid-1');
    const done = await client.waitForRender('rid-1');
    assert.equal(done.status, 'done');
    assert.equal(done.url, 'https://cdn.example.com/out.mp4');
    const posts = calls.filter(c => String(c.method).toUpperCase() === 'POST');
    assert.equal(posts.length, 1, 'must not re-submit while polling');
    assert.ok(polls >= 3);

    const dest = path.join(os.tmpdir(), `ss-test-${Date.now()}.mp4`);
    await client.downloadToFile(done.url, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'mp4data');
    fs.unlinkSync(dest);

    // ensure key never appears in call urls (header only)
    assert.ok(calls.every(c => !String(c.url).includes('sk_test')));
  });

  it('surfaces API errors', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ message: 'Invalid edit' }),
    });
    const client = SS.createClient({ env: { SHOTSTACK_API_KEY: 'sk' }, fetchImpl });
    await assert.rejects(() => client.submit({}), /Invalid edit/);
  });
});

describe('strictMode', () => {
  it('parses truthy flags', () => {
    assert.equal(SS.strictMode({ SHOTSTACK_STRICT: '1' }), true);
    assert.equal(SS.strictMode({ SHOTSTACK_STRICT: 'true' }), true);
    assert.equal(SS.strictMode({}), false);
  });
});

describe('trim vs speed (Shotstack starts at trim x speed)', () => {
  const SS = require('../shotstack');
  it('divides the source start by the playback rate', () => {
    const edit = { segments: [
      { shot_id: 'a', in_s: 0, out_s: 3.5, speed: 1, transition_in: { type: 'cut', duration: 0 }, zoom: { type: 'none' } },
      { shot_id: 'b', in_s: 0, out_s: 4.5, speed: 1.5, transition_in: { type: 'cut', duration: 0 }, zoom: { type: 'none' } },
      { shot_id: 'c', in_s: 1.47, out_s: 4.9, speed: 0.7, transition_in: { type: 'fade', duration: 0.5 }, zoom: { type: 'none' } }], overlays: [], total: 13 };
    const clips = { a: { src_start: 15.7 }, b: { src_start: 24.1 }, c: { src_start: 43.4 } };
    const clipUrls = { a: 'https://x/a.mp4', b: 'https://x/b.mp4', c: 'https://x/c.mp4' };
    const { edit: payload } = SS.buildEditPayload({ edit, clips, clipUrls, musicUrl: null, profile: { salon: 'Olya Atelier' } });
    const vids = payload.timeline.tracks.flatMap(t => t.clips).filter(c => c.asset.type === 'video');
    const by = Object.fromEntries(vids.map(v => [v.asset.src.slice(-5, -4), v.asset]));
    assert.equal(by.a.trim, 15.7);
    assert.equal(by.b.trim, +(24.1 / 1.5).toFixed(2));
    assert.equal(by.c.trim, +((43.4 + 1.47) / 0.7).toFixed(2));
  });
});
