import test from 'node:test';
import assert from 'node:assert/strict';
import { greekAudit, premiumQuotes, premiumAudit }
  from './pricing.mjs';
import { payoffAudit, parityData, parityAudit,
  gammaData, gammaAudit } from './structure.mjs';
import { blackScholes, normalCdf, riskProfile, gammaProfile }
  from '../../apps/dashboard/src/analytics.mjs';
import { premiumSeries, classifyRegime, addParticipation,
  confirmation, executionConfirmation }
  from '../../apps/dashboard/src/core/engine.ts';
import { impliedPrice }
  from '../../apps/dashboard/src/core/implied-price.ts';
import { buildEmaRetest }
  from '../../apps/dashboard/src/core/ema-retest.ts';
import { advanceReversal, needsTabAttention, reversalCopy }
  from '../../apps/dashboard/src/core/reversal-warning.ts';

const near = (a, b, tolerance = 1e-8) => {
  assert.ok(Math.abs(a - b) < tolerance, `${a} vs ${b}`);
};

test('Greeks agree with local finite differences', () => {
  for (const right of ['CALL', 'PUT']) {
    const a = greekAudit({
      spot: 6000, strike: 6000, years: 1 / 365,
      iv: 0.2, rate: 0.04, right,
    });
    for (const key of ['delta', 'gamma', 'vega', 'theta']) {
      near(a.analytic[key], a.difference[key], 2e-4);
    }
  }
});

test('CDF symmetry and parity provide independent checks', () => {
  near(normalCdf(0), 0.5, 1e-8);
  for (const x of [0.2, 1, 3]) {
    near(normalCdf(x) + normalCdf(-x), 1);
  }
  const p = greekAudit().inputs;
  const call = blackScholes(p);
  const put = blackScholes({ ...p, right: 'PUT' });
  near(call.price - put.price,
    p.spot - p.strike * Math.exp(-p.rate * p.years));
});

test('invalid model inputs do not manufacture values', () => {
  const p = greekAudit().inputs;
  for (const patch of [
    { years: 0 }, { years: -1 }, { iv: 0 },
    { spot: NaN }, { strike: -2 }, { right: 'call' },
  ]) assert.equal(blackScholes({ ...p, ...patch }), null);
});

test('a chart range is not a global naked-call bound', () => {
  const a = payoffAudit();
  assert.equal(a.samples, 81);
  near(a.chartMax, 170); near(a.chartMin, -830);
  const naked = [
    { right: 'CALL', strike: 6000, premium: 3, quantity: -1 },
  ];
  const loss = range => Math.min(...riskProfile(
    naked, 6000, range,
  ).map(row => row.pnl));
  assert.ok(loss(160) < loss(80));
});

test('parity uses event pairs and identifies assumed rates', () => {
  const p = parityAudit().point;
  near(p.spot, 6001); near(p.low, 6000.8);
  near(p.high, 6001.2); assert.equal(p.rate.assumed, true);
  const f = parityAudit({ created: '2026-10-01', rate: 3.6 });
  near(f.point.spot, 1 + 6000 / 1.000025);
  near(f.point.forward, 6000 + 1.000025);
  assert.equal(f.point.rate.assumed, false);
  const data = parityData();
  data.quoteTimestampBasis = 'interval';
  assert.equal(impliedPrice(data, '2026-10-02', 6000,
    { open: 570, close: 960 }, 600).point, null);
});

test('GEX units and future-OI rejection are explicit', () => {
  const row = gammaAudit().rows[0];
  near(row.call, 36e6); near(row.put, -21.6e6);
  near(row.net, 14.4e6);
  const data = gammaData().map(q => ({ ...q,
    openInterestAsOf: '2026-10-03T00:00:00.000Z',
  }));
  const future = gammaProfile(data, 6000,
    '2026-10-02T14:00:00.000Z');
  assert.equal(future.rows.length, 0);
  assert.equal(future.rejected, 2);
});

test('premium baseline includes the current valid sample', () => {
  const last = premiumAudit();
  near(last.z, Math.SQRT2); near(last.slope, 1);
  assert.equal(last.baselineBars, 5);
  const flat = premiumSeries(premiumQuotes([2, 2, 2, 2, 2]));
  assert.equal(flat.at(-1).z, null);
  const rows = premiumQuotes([1, 2, 3, 4, 5, 6, 7]);
  rows.splice(5, 1);
  assert.equal(premiumSeries(rows).at(-1).baselineBars, 1);
});

test('regime equality is inside and RVOL excludes current', () => {
  assert.equal(classifyRegime({
    high: 105, low: 95, close: 100, pmHigh: 105, pmLow: 95,
  }).code, 'INSIDE');
  const bars = premiumQuotes([1, 2, 3, 4, 5]).map((q, i) => ({
    timestamp: q.timestamp, close: 101, vwap: 100,
    volume: [10, 20, 30, 40, 100][i],
  }));
  near(addParticipation(bars).at(-1).rvol, 4);
});

test('entry alignment does not itself enforce participation', () => {
  const points = premiumSeries(premiumQuotes([1, 2, 3, 4, 5]));
  const bars = points.map(p => ({ timestamp: p.timestamp,
    close: 101, sessionVwap: 100, rvol: 0.1,
  }));
  const c = confirmation(bars, points);
  assert.equal(c.participation, false);
  assert.equal(c.direction, 'long');
  const gate = executionConfirmation({
    type: 'Momentum', side: 'long', regime: 'INSIDE',
  }, bars, { high: 105, low: 95 }, c);
  assert.equal(gate.passed, true);
});

function minuteBars(day, values) {
  return values.flatMap((close, bucket) =>
    Array.from({ length: 10 }, (_, i) => {
      const at = 570 + bucket * 10 + i;
      const hh = String(Math.floor(at / 60)).padStart(2, '0');
      const mm = String(at % 60).padStart(2, '0');
      return { timestamp: `${day}T${hh}:${mm}:00.000`,
        open: close, high: close + 0.1,
        low: close - 0.1, close, volume: 0,
      };
    }));
}

function emaFixture() {
  const date = '2026-10-02', previousDate = '2026-10-01';
  const spx = minuteBars(date, [102, 101]);
  for (const row of spx.slice(0, 10)) {
    row.low = 99; row.high = 103;
  }
  for (const row of spx.slice(10)) {
    row.low = 99.5; row.high = 103;
  }
  return { date, previousDate, asOf: 589, spx,
    session: { open: 570, close: 960 },
    priorSpx: minuteBars(previousDate,
      [...Array(8).fill(100), 99]),
  };
}

test('a completed cross cannot confirm its own retest', () => {
  const data = emaFixture();
  const cross = buildEmaRetest(data, 579);
  assert.equal(cross.bullish.status, 'watching');
  assert.equal(cross.bullish.episode.crossedAt, 580);
  const partial = buildEmaRetest(data, 588);
  assert.equal(partial.bullish.status, 'watching');
  const later = buildEmaRetest(data, 589);
  assert.equal(later.bullish.status, 'confirmed');
  assert.equal(later.bullish.episode.retestedAt, 590);
});

test('duplicate source minutes cancel continuous evidence', () => {
  const data = emaFixture();
  data.spx.push({ ...data.spx[15] });
  const result = buildEmaRetest(data, 589);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.ema, null);
  assert.equal(result.bullish.status, 'cancelled');
});

test('warning direction and replay reset are independent', () => {
  const sample = { scope: 'demo:2026-10-02', cutoff: 600,
    mode: 'live', code: 'EXT-UP-COOLING', usable: true,
  };
  const state = advanceReversal(null, sample);
  assert.equal(reversalCopy('EXT-UP-COOLING').positions, 'bullish');
  assert.equal(needsTabAttention(state), true);
  const replay = advanceReversal(state, {
    ...sample, cutoff: 590, mode: 'replay', code: null,
  });
  assert.equal(replay.warning, null);
  assert.equal(needsTabAttention(replay), false);
});
