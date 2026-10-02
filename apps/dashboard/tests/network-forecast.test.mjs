import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { calculateNetworkForecast, NETWORK_FORECAST_FEATURES, networkForecastDirection } from "../src/core/network-forecast.ts";
import { NETWORK_SYMBOLS } from "../src/core/network-regime.ts";

const date = "2026-10-01";
const stamp = (m, day = date) => `${day}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00.000`;
function bars(end = 900, price = 100, volume = true) {
  return Array.from({ length: end - 569 }, (_, i) => {
    if (i) price *= 1 + .0003 + .0002 * Math.sin(i * .73);
    return { timestamp: stamp(570 + i), open: price, high: price + .01, low: price - .01, close: price, ...(volume ? { volume: 100 + i % 7 } : {}) };
  });
}
const input = () => ({ spxBars: bars(900, 7000, false), spyBars: bars(900, 700), sectorContext: NETWORK_SYMBOLS.map(symbol => ({ symbol, bars: bars() })) });
function bundle() {
  return {
    schema_version: 1, model_family: "spx_direction_network_logistic", feature_order: [...NETWORK_FORECAST_FEATURES],
    decision_policy: { min_cutoff_minute: 635, horizons: [30, 60], completed_rth_bars_only: true, session_bound: true },
    display_policy: { neutral_band: [.45, .55], neutral_includes_boundaries: true, is_backtested: false },
    models: [30, 60].map(h => ({ id: `test-${h}-2026-10`, horizon_minutes: h, valid_month: "2026-10", valid_from: "2026-10-01", valid_through: "2026-10-31",
      train_start: "2025-01-02", train_end: "2026-09-30", training_rows: 500, training_days: 100, mean: Array(10).fill(0), scale: Array(10).fill(1),
      beta: [Math.log(h === 30 ? 1.5 : 2 / 3), ...Array(10).fill(0)], training_up_fraction: .52, source: "october_refit", converged: true, feature_order: [...NETWORK_FORECAST_FEATURES] })),
  };
}
const calc = (data = input(), models = bundle(), cutoff = 635, close = 960, day = date) => calculateNetworkForecast(data, cutoff, day, models, close);
const near = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const unavailable = result => { assert.equal(result.status, "unavailable"); assert.ok(result.horizons.every(h => h.probabilityUp === null && h.direction === null)); };

test("scores exported transforms, independently of the sign of sector correlation", () => {
  const data = input(), models = bundle(), saved = structuredClone({ data, models }), result = calc(data, models);
  assert.equal(result.status, "available"); assert.equal(result.experimental, true); assert.equal(result.bandBacktested, false);
  near(result.features.mean_correlation, 1);
  assert.deepEqual(result.horizons.map(h => h.direction), ["bullish", "bearish"], "a correlated bullish network is not substituted for fitted model direction");
  near(result.horizons[0].probabilityUp, .6); near(result.horizons[1].probabilityUp, .4);
  assert.deepEqual(result.horizons.map(h => h.targetEndMinute), [666, 696]);
  assert.equal(result.horizons[0].trainingThrough, "2026-09-30"); assert.equal(result.studiedDecisionMinute, true);
  assert.deepEqual({ data, models }, saved, "forecasting cannot mutate prices or fit a model");
  models.models[0].mean[0] = .001; models.models[0].scale[0] = .002; models.models[0].beta[1] = 1.25;
  const z = models.models[0].beta[0] + 1.25 * (result.features.spx_return_5 - .001) / .002;
  near(calc(data, models).horizons[0].probabilityUp, 1 / (1 + Math.exp(-z)));
});

test("price momentum, population return volatility and full-prefix SPY VWAP match the frozen formulas", () => {
  const data = input(), result = calc(data), t = 635 - 570, closes = data.spxBars.map(b => b.close);
  near(result.features.spx_return_5, closes[t] / closes[t - 5] - 1);
  near(result.features.spx_return_15, closes[t] / closes[t - 15] - 1);
  const returns = Array.from({ length: 30 }, (_, i) => closes[t - 29 + i] / closes[t - 30 + i] - 1), mean = returns.reduce((a, b) => a + b) / 30;
  near(result.features.spx_return_volatility_30, Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 30));
  const prefix = data.spyBars.slice(0, t + 1), vwap = prefix.reduce((sum, b) => sum + (b.high + b.low + b.close) / 3 * b.volume, 0) / prefix.reduce((sum, b) => sum + b.volume, 0);
  near(result.features.spy_vwap_gap, prefix.at(-1).close / vwap - 1);
  assert.deepEqual(result.featureVector, NETWORK_FORECAST_FEATURES.map(k => result.features[k]));
});

test("the untested display band is neutral at both boundaries, and never maps invalid data to neutral", () => {
  assert.equal(networkForecastDirection(.45), "neutral"); assert.equal(networkForecastDirection(.55), "neutral");
  assert.equal(networkForecastDirection(.45 - 1e-10), "bearish"); assert.equal(networkForecastDirection(.55 + 1e-10), "bullish");
  for (const p of [NaN, Infinity, -.01, 1.01, undefined, null, "0.5"]) assert.equal(networkForecastDirection(p), null);
  const models = bundle(); models.models.forEach(m => { m.beta[0] = 0; });
  assert.deepEqual(calc(input(), models).horizons.map(h => h.direction), ["neutral", "neutral"]);
});

test("past cutoff is invariant to future bars and prior-session rows; source arrays may be unordered", () => {
  const data = input(), expected = calc(data);
  for (const rows of [data.spxBars, data.spyBars, ...data.sectorContext.map(s => s.bars)]) {
    rows.push({ ...rows.at(-1), timestamp: stamp(636), close: -1, volume: -1 });
    rows.push({ ...rows[20], timestamp: stamp(590, "2026-09-30"), close: -1 });
    rows.push({ ...rows.at(-1), timestamp: stamp(636).replace(":00.000", ":30.000"), close: -1 });
    rows.reverse();
  }
  assert.deepEqual(calc(data), expected);
});

test("required SPX prices and SPY VWAP prefixes reject gaps, duplicates, invalid prices and extra off-grid rows", () => {
  for (const symbol of ["spxBars", "spyBars"]) for (const change of [
    rows => rows.splice(50, 1), rows => rows.push({ ...rows[50] }),
    rows => { rows[50].close = 0; }, rows => { rows[50].high = rows[50].low; },
    rows => { rows[50].close = NaN; }, rows => { rows[50].close = "100"; },
    rows => rows.push({ ...rows[50], timestamp: rows[50].timestamp.replace(":00.000", ":01.000") }),
    rows => rows.push({ ...rows[50], timestamp: rows[50].timestamp.replace(":00.000", ":00.001") }),
  ]) { const data = input(); change(data[symbol]); unavailable(calc(data)); }
  const oldSPXGap = input(); oldSPXGap.spxBars.shift(); assert.equal(calc(oldSPXGap).status, "available", "SPX needs its exact trailing price window, not a full RTH VWAP prefix");
  const oldSPYGap = input(); oldSPYGap.spyBars.shift(); unavailable(calc(oldSPYGap));
});

test("cash-index volume is unused; SPY volume and positive cumulative VWAP remain mandatory", () => {
  const data = input(); assert.ok(!("volume" in data.spxBars[0])); assert.equal(calc(data).status, "available");
  for (const change of [
    rows => { delete rows[20].volume; }, rows => { rows[20].volume = -1; },
    rows => { rows[20].volume = Infinity; }, rows => rows.forEach(b => { b.volume = 0; }),
  ]) { const d = input(); change(d.spyBars); unavailable(calc(d)); }
  const zero = input(); zero.spyBars[20].volume = 0; assert.equal(calc(zero).status, "available", "one zero-volume candle is permitted when the prefix has positive total volume");
});

test("forecast warmup, minimum coverage and same-universe growth are strict", () => {
  const warming = calc(input(), bundle(), 634); assert.equal(warming.status, "warming"); assert.ok(warming.horizons.every(h => h.status === "unavailable"));
  assert.equal(calc().status, "available"); assert.equal(calc(input(), bundle(), 636).studiedDecisionMinute, false);
  const few = input(); few.sectorContext = few.sectorContext.slice(0, 8); unavailable(calc(few));
  const nine = input(); nine.sectorContext = nine.sectorContext.slice(0, 9); assert.equal(calc(nine).status, "available");
  const changed = input(); changed.sectorContext[0].bars = changed.sectorContext[0].bars.filter(b => b.timestamp !== stamp(633)); unavailable(calc(changed));
});

test("each horizon ends by the verified session close, including an early close", () => {
  const both = calc(input(), bundle(), 719, 780); assert.deepEqual(both.horizons.map(h => h.status), ["available", "available"]);
  const thirty = calc(input(), bundle(), 749, 780); assert.deepEqual(thirty.horizons.map(h => h.status), ["available", "unavailable"]); assert.equal(thirty.horizons[1].probabilityUp, null);
  unavailable(calc(input(), bundle(), 750, 780));
  unavailable(calc(input(), bundle(), 930, 960));
});

test("only a unique prior-month-trained model valid for the selected month can score", () => {
  for (const change of [
    m => { m.train_end = "2026-10-01"; }, m => { m.train_end = "2026-11-01"; },
    m => { m.valid_through = "2026-09-30"; }, m => { m.valid_from = "2026-10-02"; },
    m => { m.training_rows = 349; }, m => { m.training_days = 79; }, m => { m.train_start = "2026-10-02"; },
    m => { m.converged = false; }, m => { m.valid_month = "2026-09"; },
  ]) { const models = bundle(); models.models.forEach(change); unavailable(calc(input(), models)); }
  const duplicate = bundle(); duplicate.models.push(structuredClone(duplicate.models[0]));
  assert.deepEqual(calc(input(), duplicate).horizons.map(h => h.status), ["unavailable", "available"]);
  const d = input(); for (const rows of [d.spxBars, d.spyBars, ...d.sectorContext.map(s => s.bars)]) rows.forEach(b => { b.timestamp = b.timestamp.replace(date, "2026-11-02"); });
  unavailable(calc(d, bundle(), 635, 960, "2026-11-02"));
});

test("malformed model schemas, feature order and transforms never produce a forecast", () => {
  for (const models of [null, undefined, {}, { models: [] }]) unavailable(calculateNetworkForecast(input(), 635, date, models));
  for (const change of [
    b => { b.feature_order.reverse(); }, b => { b.schema_version = 2; }, b => { b.display_policy.neutral_includes_boundaries = false; },
    b => b.models.forEach(m => { m.beta[0] = NaN; }), b => b.models.forEach(m => { m.scale[0] = 0; }),
    b => b.models.forEach(m => { m.mean[0] = Infinity; }), b => b.models.forEach(m => { m.beta.pop(); }),
    b => b.models.forEach(m => { m.feature_order.reverse(); }), b => b.models.forEach(m => { m.training_up_fraction = 2; }),
  ]) { const models = bundle(); change(models); unavailable(calc(input(), models)); }
});

test("invalid dates, incomplete identities and invalid clocks cannot score", () => {
  unavailable(calc(input(), bundle(), 635, 960, "2026-10-02"));
  unavailable(calc(input(), bundle(), 635, 960, "2026-02-30"));
  for (const cutoff of [NaN, Infinity, 635.1, -1, 1440]) unavailable(calc(input(), bundle(), cutoff));
  for (const close of [NaN, 570, 780.5, 1441]) unavailable(calc(input(), bundle(), 635, close));
});

if (process.env.NETWORK_FORECAST_FIXTURE) {
  const path = process.env.NETWORK_FORECAST_FIXTURE, fixtures = JSON.parse(readFileSync(path, "utf8"));
  const models = JSON.parse(readFileSync(join(dirname(path), "model.json"), "utf8"));
  for (const fixture of fixtures.cases) test(`Python actual-data forecast parity: ${fixture.name}`, () => {
    const data = structuredClone(fixtures.inputs);
    for (const mutation of fixture.mutations ?? []) {
      if (mutation.action === "remove") {
        const key = mutation.symbol === "SPX" ? "spxBars" : mutation.symbol === "SPY" ? "spyBars" : null;
        if (key) data[key] = data[key].filter(b => Number(b.timestamp.slice(11, 13)) * 60 + Number(b.timestamp.slice(14, 16)) !== mutation.minute);
        else { const sector = data.sectorContext.find(s => s.symbol === mutation.symbol); sector.bars = sector.bars.filter(b => Number(b.timestamp.slice(11, 13)) * 60 + Number(b.timestamp.slice(14, 16)) !== mutation.minute); }
      } else if (mutation.action === "shift_all_bar_dates") {
        for (const rows of [data.spxBars, data.spyBars, ...data.sectorContext.map(s => s.bars)]) rows.forEach(b => { b.timestamp = mutation.date + b.timestamp.slice(10); });
      } else assert.fail(`Unhandled fixture mutation ${mutation.action}`);
    }
    const result = calculateNetworkForecast(data, fixture.cutoffMinute, fixture.sessionDate, models, fixture.sessionClose);
    const h = result.horizons.find(h => h.minutes === fixture.horizonMinutes);
    assert.equal(h.status, fixture.expected.status, h.reason);
    if (fixture.expected.featureVector) result.featureVector.forEach((v, i) => near(v, fixture.expected.featureVector[i], 1e-10));
    if ("probabilityUp" in fixture.expected) near(h.probabilityUp, fixture.expected.probabilityUp, 1e-10);
    if ("modelId" in fixture.expected) assert.equal(h.modelId, fixture.expected.modelId);
    if ("direction" in fixture.expected) assert.equal(h.direction, fixture.expected.direction);
  });
}
