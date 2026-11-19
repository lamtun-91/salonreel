'use strict';
// Runway client - M1 STUB. Makes NO network calls and reads no key. Real text_to_video / image_to_video tasks
// (X-Runway-Version header, polling, moderation handling) land in M3. Methods resolve to placeholder data.
const STUB = true;
const configured = () => false; // M1: never live, regardless of env
const apiVersion = () => process.env.RUNWAY_API_VERSION || '2024-11-06';
const model = () => process.env.RUNWAY_MODEL || 'gen4.5';
async function textToVideo({ prompt, duration } = {}) { return { stub: true, task_id: null, status: 'SUCCEEDED', output: [], prompt, duration }; }
async function imageToVideo({ prompt, duration } = {}) { return { stub: true, task_id: null, status: 'SUCCEEDED', output: [], prompt, duration }; }
async function task() { return { stub: true, status: 'SUCCEEDED', output: [] }; }
module.exports = { STUB, configured, apiVersion, model, textToVideo, imageToVideo, task };
