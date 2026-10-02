import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pointCents, roundTripCents, assertChronology,
  assertTrainingCutoff, brier, maxDrawdownCents,
  inventedExample,
} from './evaluation.mjs';

const t = time => `2026-10-01T${time}:00Z`;
const record = () => ({
  barEnd: t('13:45'), availableAt: t('13:45'),
  decisionAt: t('13:45'), entryAt: t('13:46'),
  exitAt: t('14:46'), deadlineAt: t('14:46'),
});

test('decimal inputs are exact and excess precision refused', () => {
  assert.equal(pointCents('1.20'), 120);
  assert.equal(pointCents('0'), 0);
  for (const s of ['1.001', '-1', 'NaN', '', '1e2']) {
    assert.throws(() => pointCents(s));
  }
});

test('each contract-side cost enters once, including stress', () => {
  const x = inventedExample();
  assert.deepEqual(x.base, {
    grossCents: 5000, costsCents: 400, netCents: 4600,
  });
  assert.deepEqual(x.stress, {
    grossCents: 5000, costsCents: 2800, netCents: 2200,
  });
});

test('quantity sign reverses cash flow; fees never reverse', () => {
  const leg = { quantity: 1, entry: 200, exit: 250 };
  assert.equal(roundTripCents([leg]).netCents, 4800);
  assert.equal(roundTripCents([{ ...leg, quantity: -1 }])
    .netCents, -5200);
  assert.equal(roundTripCents([{ ...leg, quantity: 2 }])
    .netCents, 9600);
});

test('null prices, fractional size and overflow are rejected', () => {
  assert.throws(() => roundTripCents([]));
  for (const leg of [
    { quantity: 1, entry: null, exit: 200 },
    { quantity: 0.5, entry: 100, exit: 200 },
    { quantity: 1, entry: 100, exit: Number.MAX_SAFE_INTEGER },
  ]) assert.throws(() => roundTripCents([leg]));
  const large = Number.MAX_SAFE_INTEGER;
  assert.throws(() => roundTripCents([
    { quantity: 1, entry: 0, exit: large },
    { quantity: -1, entry: 0, exit: large },
  ]));
});

test('chronology accepts equality and enforces hard deadline', () => {
  assert.equal(assertChronology(record()), true);
  assert.throws(() => assertChronology({
    ...record(), entryAt: t('13:44'),
  }));
  assert.throws(() => assertChronology({
    ...record(), exitAt: t('14:47'),
  }));
  assert.throws(() => assertChronology({
    ...record(), availableAt: t('13:46'),
  }));
});

test('explicit offsets and known training outcomes', () => {
  assert.throws(() => assertChronology({
    ...record(), barEnd: '2026-10-01T13:45:00',
  }));
  assert.throws(() => assertChronology({
    ...record(), barEnd: '2026-02-30T13:45:00Z',
  }));
  assert.equal(assertTrainingCutoff(t('13:44'), t('13:45')),
    true);
  assert.throws(() => assertTrainingCutoff(t('13:45'),
    t('13:45')));
});

test('Brier rejects invalid probabilities and null outcomes', () => {
  assert.ok(Math.abs(inventedExample().brier - 0.225) < 1e-12);
  assert.equal(inventedExample().constantHalfBrier, 0.25);
  assert.equal(brier([{ p: 1, y: 1 }, { p: 0, y: 0 }]), 0);
  for (const rows of [[], [{ p: null, y: 1 }],
    [{ p: 1.1, y: 0 }], [{ p: 0.5, y: null }]]) {
    assert.throws(() => brier(rows));
  }
});

test('drawdown starts at zero and retains abstentions', () => {
  assert.equal(maxDrawdownCents([4600, 0, -10000, 2200]),
    10000);
  assert.equal(maxDrawdownCents([-1000, 200]), 1000);
  assert.equal(maxDrawdownCents([0, 0]), 0);
  assert.throws(() => maxDrawdownCents([0, null]));
  assert.throws(() => maxDrawdownCents([]));
});
