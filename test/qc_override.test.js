const test = require('node:test'), assert = require('node:assert');
const { haircutOverride } = require('../studio.js');
const qc = { has_haircut: false, overall: 'no reveal' };
test('no override without explicit confirm', () => {
  assert.equal(haircutOverride({}, qc), null);
  assert.equal(haircutOverride({ force: true }, qc), null);
  assert.equal(haircutOverride({ override_qc: { confirm: 'yes' } }, qc), null);
});
test('explicit confirm records audit entry', () => {
  const o = haircutOverride({ override_qc: { confirm: true, reason: 'dark hair' } }, qc, new Date('2026-11-05T16:00:00Z'));
  assert.equal(o.gate, 'no_haircut'); assert.equal(o.reason, 'dark hair'); assert.equal(o.at, '2026-11-05T16:00:00.000Z'); assert.equal(o.qc_overall, 'no reveal');
});
test('not applied when QC passed', () => assert.equal(haircutOverride({ override_qc: { confirm: true } }, { has_haircut: true }), null));
