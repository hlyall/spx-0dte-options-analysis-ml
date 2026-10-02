// Offline, invented numerical fixtures. No market observations or fits.
import { pathToFileURL } from 'node:url';
const core = '../../apps/dashboard/src/core/';
const { calculateNetworkRegime, NETWORK_SYMBOLS } = await import(
  `${core}network-regime.ts`
);
const {
  conditionSpongeMissingFeatures, SPONGE_MISSING_RAW_FEATURES,
} = await import(`${core}sponge-missing.ts`);
const { inspectSpongeMacroInputs, spongeNetworkDirection } =
  await import(`${core}sponge-network.ts`);
const { classifyNewsHeadline } = await import(
  `${core}news-context.ts`
);
const { newsRoutes } = await import(
  '../../apps/dashboard/src/analytics.mjs'
);
export const date = '2026-10-01';
export function stamp(minute) {
  const h = String(Math.floor(minute / 60)).padStart(2, '0');
  const m = String(minute % 60).padStart(2, '0');
  return `${date}T${h}:${m}:00.000`;
}
export function bar(minute, close, volume = 100) {
  return {
    timestamp: stamp(minute), open: close,
    high: close + .01, low: close - .01, close, volume,
  };
}
export function syntheticContext(end = 650) {
  return NETWORK_SYMBOLS.map(symbol => {
    let price = 100;
    const bars = Array.from({ length: end - 569 }, (_, i) => {
      if (i) price *= 1 + .0003 + .0002 * Math.sin(i * .73);
      return bar(570 + i, price);
    });
    return { symbol, bars };
  });
}
export function rollingExample() {
  return calculateNetworkRegime(syntheticContext(), 650, date);
}
// A direct algebra fixture, not a deployable or validated bundle.
export function conditionalFixture() {
  const names = SPONGE_MISSING_RAW_FEATURES;
  const n = names.length;
  const covariance = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => Number(i === j))
  );
  covariance[0][4] = covariance[4][0] = .6;
  const raw = Object.fromEntries(names.map(name => [name, 0]));
  raw[names[0]] = 1;
  raw[names[4]] = null;
  const version = {
    mean: Array(n).fill(0), scale: Array(n).fill(1), covariance,
  };
  return { raw, version };
}
export function conditionalExample() {
  const { raw, version } = conditionalFixture();
  return conditionSpongeMissingFeatures(raw, version);
}
export function macroExample() {
  const context = [{ symbol: 'TNX', bars: [
    bar(570, 42.0), bar(645, 42.1), bar(650, 42.3),
  ] }];
  return inspectSpongeMacroInputs(context, 650, date)[1];
}
// Pedagogical score, not an exported production model.
export function toyProbability() {
  const score = -.2 + .4 * 1.5 - .1 * 1;
  const probability = 1 / (1 + Math.exp(-score));
  return { score, probability,
    direction: spongeNetworkDirection(probability) };
}
export function newsExample() {
  const articles = [{
    title: 'Nvidia expands AI investment',
    timestamp: '2026-10-01T14:00:00Z',
    firstSeenAt: '2026-10-01T14:01:00Z',
  }];
  return {
    early: newsRoutes(articles, '2026-10-01T14:00:30Z'),
    known: newsRoutes(articles, '2026-10-01T14:02:00Z'),
    tentative: classifyNewsHeadline('Oil prices may rise'),
  };
}
// Proposed evaluation helper; not a dashboard calibration fitter.
export function brier(probabilities, outcomes) {
  if (!probabilities.length ||
      probabilities.length !== outcomes.length ||
      probabilities.some(p => !Number.isFinite(p) || p<0 || p>1) ||
      outcomes.some(y => y !== 0 && y !== 1)) {
    throw new Error('Aligned probabilities and binary outcomes needed');
  }
  return probabilities.reduce((sum, p, i) =>
    sum + (p - outcomes[i]) ** 2, 0) / probabilities.length;
}
export function calibrationExample() {
  const probabilities = [.6, .6, .6, .6, .6];
  const outcomes = [1, 1, 1, 0, 0];
  return {
    meanForecast: .6, observedFrequency: 3 / 5,
    brier: brier(probabilities, outcomes),
    constantHalfBrier: brier(Array(5).fill(.5), outcomes),
  };
}
if (process.argv[1] && import.meta.url ===
    pathToFileURL(process.argv[1]).href) {
  const network = rollingExample(), missing = conditionalExample();
  console.log(JSON.stringify({
    data: 'SYNTHETIC EDUCATIONAL FIXTURES',
    network: { status: network.status,
      sectors: network.coverage.eligible,
      links: network.links.length,
      fraction: network.bullishCluster.fraction },
    conditional: { mean: missing.conditionalMean,
      covariance: missing.covariance },
    macro: macroExample(), probability: toyProbability(),
    news: newsExample(), calibration: calibrationExample(),
  }, null, 2));
}
