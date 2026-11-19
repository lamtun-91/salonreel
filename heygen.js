'use strict';
// HeyGen client - M1 STUB. Makes NO network calls and reads no key. Real v3 calls (photo-avatar training, consent,
// /v3/videos with avatar_iv, polling) land in M2. Every method resolves to deterministic placeholder data.
const STUB = true;
const configured = () => false; // M1: never live, regardless of env
const testMode = () => process.env.HEYGEN_TEST !== '0';
const engine = () => process.env.HEYGEN_AVATAR_ENGINE || 'avatar_iv';
const stockAvatarIds = () => String(process.env.HEYGEN_STOCK_AVATAR_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
async function createPhotoAvatar() { return { stub: true, group_id: null, status: 'training' }; }
async function avatarStatus() { return { stub: true, status: 'ready' }; }
async function consentUrl() { return { stub: true, url: null }; }
async function createVideo() { return { stub: true, video_id: null, status: 'completed' }; }
async function videoStatus() { return { stub: true, status: 'completed', video_url: null }; }
async function deleteAvatar() { return { stub: true, deleted: false }; } // M1: local delete only; never deletes vendor or Sample avatars
module.exports = { STUB, configured, testMode, engine, stockAvatarIds, createPhotoAvatar, avatarStatus, consentUrl, createVideo, videoStatus, deleteAvatar };
