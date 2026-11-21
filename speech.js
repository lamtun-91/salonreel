'use strict';
// One speech-rate calibration for the Twin path, shared by the script length target, the duration estimate and the
// HeyGen cost guard. Measured on the M2 stock renders (Daphne_public_4 + voice 812d4eea...): Tip 42 words in 13.17s
// (3.19 w/s), Promo 39 words in 14.55s (2.68 w/s) -> ~3.0 words/sec.
const SPEECH = Object.freeze({
  wordsPerSec: 3.0,
  targetSeconds: 18, targetWords: 55,        // the script generator aims here
  guardFactor: 1.15, guardPadSeconds: 0.5,   // cost guard assumes 15% slower speech + 0.5s lead-in/out (errs high)
});
const words = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const r1 = x => Math.round(x * 10) / 10;
const spokenSeconds = s => words(s) / SPEECH.wordsPerSec;                                         // best estimate
const guardSeconds = s => r1(spokenSeconds(s) * SPEECH.guardFactor + SPEECH.guardPadSeconds);    // conservative
module.exports = { SPEECH, words, spokenSeconds, guardSeconds };
