import test from 'node:test';
import assert from 'node:assert/strict';
import {
  syntheticContext, rollingExample, conditionalExample,
  conditionalFixture, macroExample, toyProbability,
  newsExample, calibrationExample, brier, date, bar,
} from './network.mjs';
const core = '../../apps/dashboard/src/core/';
const { calculateNetworkRegime } = await import(
  `${core}network-regime.ts`
);
const { conditionSpongeMissingFeatures } = await import(
  `${core}sponge-missing.ts`
);
const { spongeNetworkDirection } = await import(
  `${core}sponge-network.ts`
);
const near = (a, b, eps = 1e-8) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('rolling fixture imports actual graph and fixed denominator', () => {
  const result = rollingExample();
  assert.equal(result.status, 'bullish_coordinated');
  assert.equal(result.links.length, 55);
  assert.equal(result.bullishCluster.size, 11);
  const partial = calculateNetworkRegime(
    syntheticContext().slice(0, 9), 650, date
  );
  near(partial.bullishCluster.fraction, 9 / 11);
  assert.equal(calculateNetworkRegime(
    syntheticContext().slice(0, 8), 650, date
  ).status, 'unavailable');
});
test('future corruption cannot change a prior rolling result', () => {
  const context = syntheticContext();
  context[0].bars.push(bar(651, NaN));
  assert.deepEqual(calculateNetworkRegime(context, 650, date),
    rollingExample());
  context[0].bars.push({ ...context[0].bars.at(-2) });
  assert.equal(calculateNetworkRegime(context, 650, date)
    .coverage.eligible, 10);
});
test('conditional mean and variance match Gaussian example', () => {
  const x = conditionalExample();
  near(x.conditionalMean[0], .6);
  near(x.covariance[0][0], .64);
  near(x.lower[0][0], .8);
  const { raw, version } = conditionalFixture();
  const saved = structuredClone(raw);
  conditionSpongeMissingFeatures(raw, version);
  assert.deepEqual(raw, saved);
  raw.spx_return_5 = 7;
  assert.throws(() => conditionSpongeMissingFeatures(raw, version),
    /six-standard-deviation/);
});
test('TNX scaling is percent and basis points, never volume VWAP', () => {
  const x = macroExample();
  assert.equal(x.eligible, true);
  near(x.yieldPercent, 4.23);
  near(x.change5Bps, 2);
  near(x.changeFromOpenBps, 3);
});
test('toy probability uses actual neutral-band boundaries', () => {
  near(toyProbability().score, .3);
  near(toyProbability().probability, .5744425168);
  assert.equal(spongeNetworkDirection(.45), 'neutral');
  assert.equal(spongeNetworkDirection(.55), 'neutral');
  assert.equal(spongeNetworkDirection(NaN), null);
});
test('news first-seen ordering and no forecast adjustment survive', () => {
  const x = newsExample();
  assert.equal(x.early.length, 0);
  assert.deepEqual(x.known[0].targets, ['XLK']);
  assert.equal(x.known[0].forecastInfluence, false);
  assert.equal(x.tentative.length, 0);
});
test('binary Brier toy is .24 versus .25; invalid inputs reject', () => {
  near(calibrationExample().brier, .24);
  near(calibrationExample().constantHalfBrier, .25);
  assert.throws(() => brier([], []));
  assert.throws(() => brier([.5], [2]));
  assert.throws(() => brier([1.1], [1]));
});
