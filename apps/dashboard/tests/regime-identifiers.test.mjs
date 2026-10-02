import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRegime, PLAYBOOK, confirmation, executionConfirmation } from '../src/core/engine.ts';
import { REGIME_GUIDE } from '../src/core/regime-guide.ts';
import { PLAYBOOK_GUIDE, explainPlaybook } from '../src/core/playbook-guide.ts';

const levels = { high: 110, low: 90, close: 100 };
test('range IDs preserve strict boundaries, equality, and two-sided priority', () => {
  for (const [low, high, expected] of [
    [95, 105, 'INSIDE'], [90, 110, 'INSIDE'], [110, 110, 'INSIDE'],
    [111, 115, 'GAP-UP'], [85, 89, 'GAP-DOWN'],
    [110, 115, 'EXT-UP'], [90, 115, 'EXT-UP'],
    [85, 90, 'EXT-DOWN'], [85, 110, 'EXT-DOWN'],
    [85, 115, 'TWO-SIDED'],
  ]) assert.equal(classifyRegime({ ...levels, pmLow: low, pmHigh: high }).code, expected);
  for (const invalid of [{ pmLow: null, pmHigh: 105 }, { pmLow: 105, pmHigh: 95 }, { low: 110, pmLow: 95, pmHigh: 105 }])
    assert.equal(classifyRegime({ ...levels, ...invalid }).code, '—');
});

test('every current pattern resolves its complete hyphenated regime and guide', () => {
  assert.deepEqual(PLAYBOOK.map(p => p.code), [
    'INSIDE-RISE', 'INSIDE-FALL', 'INSIDE-SELLING',
    'EXT-UP-COOLING', 'EXT-UP-REBOUND', 'EXT-UP-FAILURE',
    'EXT-DOWN-SELLING', 'EXT-DOWN-REBOUND', 'EXT-DOWN-RECOVERY',
  ]);
  assert.equal(Object.keys(PLAYBOOK_GUIDE).length, PLAYBOOK.length);
  for (const p of PLAYBOOK) {
    const guide = explainPlaybook(p.code);
    assert.equal(guide.regime, p.regime);
    assert.ok(guide.structure);
    assert.ok(REGIME_GUIDE.some(r => r.code === p.regime));
    assert.equal(guide.suffixMeaning, p.name);
  }
  for (const code of ['GAP-UP', 'GAP-DOWN', 'TWO-SIDED']) {
    assert.ok(REGIME_GUIDE.some(r => r.code === code));
    assert.equal(PLAYBOOK.filter(p => p.regime === code).length, 0);
  }
  assert.equal(explainPlaybook('UNKNOWN-PATTERN'), null);
});

const bar = (minute, close) => ({ timestamp: `2026-10-01T09:${minute}:00.000`, close, sessionVwap: 100 });
test('anticipation gates retain their prior-high or prior-low boundary and crossing requirement', () => {
  for (const [code, boundary, direction] of [
    ['EXT-UP-COOLING', 110, 'short'], ['EXT-UP-REBOUND', 110, 'long'], ['EXT-DOWN-REBOUND', 90, 'long'],
  ]) {
    const p = PLAYBOOK.find(p => p.code === code), sign = direction === 'long' ? 1 : -1;
    const bars = [bar(30, boundary - sign), bar(31, boundary + sign), bar(32, boundary + sign)];
    const actual = executionConfirmation(p, bars, levels, { direction: 'neutral' });
    assert.equal(actual.passed, true, code);
    assert.equal(actual.direction, direction);
    assert.equal(executionConfirmation(p, bars.slice(1), levels, { direction: 'neutral' }).passed, false);
    assert.equal(executionConfirmation(p, [bars[0], bars[1], bar(33, boundary + sign)], levels, { direction: 'neutral' }).passed, false);
  }
});

test('negative-premium recovery is a visible context condition but cannot pass momentum confirmation', () => {
  const points = [-3, -2.9, -2.8, -2.7, -2.6, -2.5, -2.4, -2.3, -2.2, -2.1, -2, -1.9]
    .map(z => ({ valid: true, z, slope: 0.1, baselineBars: 30 }));
  const conf = confirmation([bar(31, 101), bar(32, 102)], points);
  assert.equal(conf.above, true);
  assert.equal(conf.normalization, true);
  assert.equal(conf.direction, 'neutral');
  for (const code of ['INSIDE-SELLING', 'EXT-DOWN-RECOVERY'])
    assert.equal(executionConfirmation(PLAYBOOK.find(p => p.code === code), [], levels, conf).passed, false);
});
