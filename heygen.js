'use strict';
// HeyGen facade for the Twin path. Live only when BOTH HEYGEN_API_KEY is set AND HEYGEN_LIVE=1; otherwise every method
// resolves to deterministic stub data with NO network call (tests, local dev, and production while ENABLE_AI_TWIN is off).
// The network client is heygen_client.js (HeyGen v3). Note: v3 has no free test mode - see heygen_client.js header;
// renders additionally need HEYGEN_ALLOW_SPEND=1 (owner-approved), so a live config alone can never spend.
const C = require('./heygen_client');
const configured = (env = process.env) => !!C.key(env) && env.HEYGEN_LIVE === '1';
const STUB = !configured();
// The v3 API has no test/sandbox flag (v1/v2 `test: true` was retired 2026-10-31). Kept for the config payload.
const testMode = () => false;
const TEST_MODE_NOTE = 'HeyGen v3 has no test mode; every render is billed. Renders require HEYGEN_ALLOW_SPEND=1.';
const engine = (env = process.env) => C.engineFor({}, env); // avatar_iii (cheapest) unless HEYGEN_ENGINE says otherwise
const stockAvatarIds = () => String(process.env.HEYGEN_STOCK_AVATAR_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const stub = x => ({ stub: true, ...x });
async function createPhotoAvatar() { return stub({ group_id: null, status: 'training' }); } // M4 (twin creation needs Tung's OK)
async function avatarStatus() { return stub({ status: 'ready' }); }
async function consentUrl() { return stub({ url: null }); }
async function createVideo(args = {}, o = {}) { return configured() ? C.createAvatarVideo(args, o) : stub({ video_id: null, status: 'completed' }); }
async function videoStatus(video_id, o = {}) { return configured() ? C.getVideo(video_id, o) : stub({ status: 'completed', video_url: null }); }
async function waitForVideo(video_id, o = {}) { return configured() ? C.waitForVideo(video_id, o) : stub({ status: 'completed', video_url: null }); }
async function download(url, dest, o = {}) { if (!configured()) throw new Error('HeyGen is not configured'); return C.download(url, dest, o); }
async function account(o = {}) { return configured() ? C.me(o) : stub({ billing_type: null }); }
async function deleteAvatar() { return stub({ deleted: false }); } // never deletes vendor or Sample avatars
module.exports = { STUB, configured, testMode, TEST_MODE_NOTE, engine, stockAvatarIds, createPhotoAvatar, avatarStatus, consentUrl, createVideo, videoStatus, waitForVideo, download, account, deleteAvatar, HeyGenError: C.HeyGenError, SpendBlockedError: C.SpendBlockedError };
