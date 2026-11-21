'use strict';
// Runway facade for the Twin path. Live only when RUNWAYML_API_SECRET is set AND RUNWAY_LIVE=1; generations additionally need
// RUNWAY_ALLOW_SPEND=1 (owner-approved). Otherwise methods resolve to stub data with NO network call. Network code: runway_client.js.
const C = require('./runway_client');
const STUB = !C.liveEnabled();
const configured = (env = process.env) => C.liveEnabled(env);
const apiVersion = () => process.env.RUNWAY_API_VERSION || C.API_VERSION;
const model = (env = process.env) => C.modelFor({}, env); // gen4_turbo unless RUNWAY_MODEL says otherwise
const stub = x => ({ stub: true, ...x });
async function imageToVideo(args = {}, o = {}) { return configured() ? C.imageToVideo(args, o) : stub({ task_id: null, status: 'SUCCEEDED', output: [], prompt: args.promptText, duration: args.duration }); }
// M3 uses image_to_video only; text_to_video stays a stub (Gen-4 Turbo needs an input image).
async function textToVideo({ prompt, duration } = {}) { return stub({ task_id: null, status: 'SUCCEEDED', output: [], prompt, duration }); }
async function task(id, o = {}) { return configured() ? C.task(id, o) : stub({ status: 'SUCCEEDED', output: [] }); }
async function waitForTask(id, o = {}) { return configured() ? C.waitForTask(id, o) : stub({ status: 'SUCCEEDED', output: [] }); }
async function download(url, dest, o = {}) { if (!configured()) throw new Error('Runway is not configured'); return C.download(url, dest, o); }
async function organization(o = {}) { return configured() ? C.organization(o) : stub({ creditBalance: null }); }
module.exports = { STUB, configured, apiVersion, model, imageToVideo, textToVideo, task, waitForTask, download, organization, estimateCost: C.estimateCost, GUARD: C.GUARD };
