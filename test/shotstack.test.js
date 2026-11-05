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

describe('buildEditPayload', () => {
  it('builds a contiguous 9:16 payload with overlays, music, zooms, ramps', () => {
    const edit = fixtureEdit();
    const { edit: payload, meta } = SS.buildEditPayload({
      edit,
      clips: fixtureClips(),
      clipUrls: fixtureUrls(),
      musicUrl: 'https://cdn.example.com/velvet_60.m4a',
      profile: { salon: 'Olya Atelier' },
    });

    assert.equal(payload.output.format, 'mp4');
    assert.deepEqual(payload.output.size, { width: 1080, height: 1920 });
    assert.equal(payload.output.fps, 30);
    assert.equal(payload.timeline.background, '#000000');

    // tracks: text, video, audio
    assert.equal(payload.timeline.tracks.length, 3);
    const [textTrack, videoTrack, audioTrack] = payload.timeline.tracks;
    assert.ok(textTrack.clips.some(c => c.asset.type === 'rich-text' && c.asset.text === 'Olya Atelier'));
    assert.ok(textTrack.clips.some(c => c.asset.text === 'Ready for a change?'));

    assert.equal(videoTrack.clips.length, 4);
    // contiguous starts
    let t = 0;
    for (const c of videoTrack.clips) {
      assert.equal(c.start, Math.round(t * 100) / 100);
      assert.equal(c.fit, 'crop');
      assert.equal(c.asset.volume, 0);
      assert.equal(c.asset.type, 'video');
      t += c.length;
    }
    assert.equal(meta.total, Math.round(t * 100) / 100);

    // trim includes clip.src_start + in_s
    assert.equal(videoTrack.clips[0].asset.trim, 0.5); // 0 + 0.5
    assert.equal(videoTrack.clips[1].asset.trim, 3); // 2 + 1

    // constant speed
    assert.equal(videoTrack.clips[1].asset.speed, 1.3);
    // ramp as tween array
    assert.ok(Array.isArray(videoTrack.clips[2].asset.speed));
    assert.equal(videoTrack.clips[2].asset.speed[0].from, 1);
    assert.equal(videoTrack.clips[2].asset.speed[1].to, 0.5);
    assert.equal(videoTrack.clips[2].effect, 'zoomInSlow');
    assert.equal(videoTrack.clips[1].effect, 'zoomInFast');

    // transitions
    assert.equal(videoTrack.clips[0].transition.in, 'fade');
    assert.equal(videoTrack.clips[2].transition.in, 'fade');
    assert.equal(videoTrack.clips[3].transition.in, 'fade'); // fadewhite mapped
    assert.equal(videoTrack.clips[3].transition.out, 'fade');

    // music
    const music = audioTrack.clips[0];
    assert.equal(music.asset.type, 'audio');
    assert.equal(music.asset.trim, 4.5);
    assert.equal(music.start, 0);
    assert.equal(music.length, meta.total);

    // no leak of beat markers / shot ids into payload
    const blob = JSON.stringify(payload);
    assert.equal(blob.includes('beat_markers'), false);
    assert.equal(blob.includes('shot_id'), false);
    assert.equal(blob.includes('qc'), false);
    assert.ok(meta.approximations.length >= 1);
  });

  it('rejects non-https media urls', () => {
    assert.throws(() => SS.buildEditPayload({
      edit: fixtureEdit(),
      clips: fixtureClips(),
      clipUrls: { ...fixtureUrls(), s1: '/api/local/get?x=1' },
      musicUrl: null,
      profile: {},
    }), /public https/);
    assert.throws(() => SS.buildEditPayload({
      edit: fixtureEdit(),
      clips: fixtureClips(),
      clipUrls: { ...fixtureUrls(), s1: 'http://cdn.example.com/s1.mp4' },
      musicUrl: null,
      profile: {},
    }), /public https/);
  });

  it('works without music track', () => {
    const { edit: payload } = SS.buildEditPayload({
      edit: { ...fixtureEdit(), track: 'none' },
      clips: fixtureClips(),
      clipUrls: fixtureUrls(),
      musicUrl: null,
      profile: { salon: 'Olya Atelier' },
    });
    assert.equal(payload.timeline.tracks.length, 2);
  });

  it('aligns with cleanEdit fixture durations', () => {
    const clips = {
      s1: { duration: 5, src_start: 0 },
      s2: { duration: 6, src_start: 0 },
      s3: { duration: 7, src_start: 0 },
      s4: { duration: 8, src_start: 0 },
      s5: { duration: 5, src_start: 0 },
    };
    const shots = [
      { id: 's1', name: 'Before', type: 'before', target_s: 3 },
      { id: 's2', name: 'Cut', type: 'cutting', target_s: 4 },
      { id: 's3', name: 'Blow', type: 'blowdry', target_s: 4 },
      { id: 's4', name: 'Reveal', type: 'reveal', target_s: 4 },
      { id: 's5', name: 'Back', type: 'reveal', target_s: 3 },
    ];
    const qc = { clips: shots.map(s => ({ shot_id: s.id, best: { start_s: 0, end_s: s.target_s }, what_is_visible: s.name, issues: [] })) };
    const plan = S.mockEdit({ shots, clips, qc, music: 'velvet' });
    const urls = Object.fromEntries(shots.map(s => [s.id, `https://cdn.example.com/${s.id}.mp4`]));
    const { edit: payload, meta } = SS.buildEditPayload({
      edit: { ...plan, overlays: [{ start_s: 0.5, end_s: 2.5, text: 'Hook' }] },
      clips,
      clipUrls: urls,
      musicUrl: 'https://cdn.example.com/m.m4a',
      profile: { salon: 'Olya Atelier' },
    });
    const video = payload.timeline.tracks.find(t => t.clips[0]?.asset?.type === 'video');
    assert.ok(video.clips.length >= 2);
    assert.ok(meta.total > 10 && meta.total <= 30);
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
