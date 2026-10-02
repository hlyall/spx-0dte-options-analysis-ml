import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { calculateSpongeNetwork, parseSpongeNetworkBundle, SPONGE_NETWORK_FEATURES, SPONGE_MACRO_FEATURES, spongeNetworkDirection } from "../src/core/sponge-network.ts";
import { NETWORK_SYMBOLS } from "../src/core/network-regime.ts";

const date = "2026-10-01";
const stamp = (minute, day = date) => `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000`;
function bars(end = 900, price = 100, volume = true, direction = 1) {
  return Array.from({ length: end - 569 }, (_, i) => {
    if (i) price *= 1 + direction * (.0003 + .0002 * Math.sin(i * .73));
    return { timestamp: stamp(570 + i), open: price, high: price + .01, low: price - .01, close: price, ...(volume ? { volume: 100 + i % 7 } : {}) };
  });
}
const input = () => ({ spxBars: bars(900, 7000, false), spyBars: bars(900, 700), sectorContext: NETWORK_SYMBOLS.map((symbol, i) => ({ symbol, bars: bars(900, 100, true, i < 7 ? 1 : -1) })) });
function bundle() {
  const edges = [{ source: "XLK", target: "XLF", weight: .8 }, { source: "XLF", target: "XLY", weight: .7 }, { source: "XLI", target: "XLB", weight: .6 }];
  const adjacency = Array.from({ length: 11 }, () => Array(11).fill(0));
  for (const edge of edges) {
    const i = NETWORK_SYMBOLS.indexOf(edge.source), j = NETWORK_SYMBOLS.indexOf(edge.target); adjacency[i][j] = adjacency[j][i] = edge.weight;
  }
  const fit = (count, horizon) => ({ feature_order: SPONGE_NETWORK_FEATURES.slice(0, count), mean: Array(count).fill(0), scale: Array(count).fill(1),
    beta: [Math.log(horizon === 30 ? 1.5 : 2 / 3), ...Array(count).fill(0)], iterations: 5, converged: true, training_rows: 500, training_days: 100,
    train_start: "2025-01-02", train_end: "2026-09-30", training_up_fraction: .52 });
  return {
    schema_version: 1, model_kind: "persistent-sector-sponge", latest_version_id: "sponge-2026-10", sectors: [...NETWORK_SYMBOLS],
    base_features: SPONGE_NETWORK_FEATURES.slice(0, 5), node_features: SPONGE_NETWORK_FEATURES.slice(5, 27), graph_features: SPONGE_NETWORK_FEATURES.slice(27), feature_order: [...SPONGE_NETWORK_FEATURES],
    decision_policy: { backtested_decision_minutes: [636, 696, 756, 816, 876], horizons: [30, 60], min_cutoff_minute: 635, completed_rth_bars_only: true,
      strict_sector_count: 11, other_minutes_validation: "unvalidated", session_bound: true },
    versions: [{ id: "sponge-2026-10", valid_from: "2026-10-01", valid_to: "2026-10-31", train_start: "2025-01-02", train_end: "2026-09-30",
      graph: { id: "historical-graph-2026-10", node_order: [...NETWORK_SYMBOLS], adjacency, edges, threshold: .6, weight_sum: 2.1,
        training_rows: 30000, training_days: 100, train_start: "2025-01-02", train_end: "2026-09-30" },
      models: Object.fromEntries([30, 60].map(horizon => [horizon, { baseline: fit(5, horizon), individual: fit(27, horizon), sponge: fit(31, horizon) }])) }],
  };
}
const calc = (data = input(), models = bundle(), cutoff = 635, close = 960, day = date) => calculateSpongeNetwork(data, cutoff, day, models, close);
const near = (a, b, tolerance = 1e-11) => assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const unavailable = result => { assert.equal(result.status, "unavailable"); assert.ok(result.horizons.every(h => h.probabilityUp === null && h.probabilityDown === null && h.direction === null)); };
const modifyFits = (models, fn) => Object.values(models.versions[0].models).forEach(group => Object.values(group).forEach(fn));

function macroBundle() {
  const models = bundle();
  Object.assign(models, { schema_version: 2, model_kind: "persistent-sector-sponge-macro", feature_order: [...SPONGE_MACRO_FEATURES],
    macro_features: SPONGE_MACRO_FEATURES.slice(31), macro_inputs: [
      { symbol: "USO", kind: "oil_futures_etf", source_endpoint: "/stock/history/ohlc", venue: "nqb", features: SPONGE_MACRO_FEATURES.slice(31, 33) },
      { symbol: "TNX", kind: "ten_year_treasury_yield_index", source_endpoint: "/index/history/ohlc", quote_divisor_for_yield_percent: 10, quote_delta_multiplier_for_basis_points: 10, features: SPONGE_MACRO_FEATURES.slice(33) },
    ] });
  models.decision_policy.required_macro_symbols = ["USO", "TNX"];
  for (const horizon of [30, 60]) {
    const old = models.versions[0].models[horizon], macro = structuredClone(old.sponge);
    macro.feature_order = [...SPONGE_MACRO_FEATURES]; macro.mean.push(0, 0, 0, 0); macro.scale.push(1, 1, 1, 1); macro.beta.push(0, 0, 0, 0);
    models.versions[0].models[horizon] = { baseline: old.baseline, sector_sponge: old.sponge, macro_sponge: macro };
  }
  return models;
}
const rateBar = (minute, close, open = close) => ({ timestamp: stamp(minute), open, high: Math.max(open, close) + .01, low: Math.min(open, close) - .01, close, volume: 0, count: 0 });
const macroInput = () => ({ ...input(), macroContext: [{ symbol: "USO", bars: bars(900, 70) }, { symbol: "TNX", bars: [rateBar(570, 40.05, 40), rateBar(630, 40.15), rateBar(635, 40.2)] }] });

test("the loaded historical graph and weights are detached, deeply frozen and never refitted", () => {
  const raw = bundle(), saved = structuredClone(raw), loaded = parseSpongeNetworkBundle(raw), data = input(), prices = structuredClone(data);
  assert.deepEqual(raw, saved); assert.notEqual(loaded, raw); assert.ok(Object.isFrozen(loaded)); assert.ok(Object.isFrozen(loaded.versions[0].graph.edges[0]));
  assert.throws(() => { loaded.versions[0].graph.edges[0].weight = .9; }, TypeError);
  assert.throws(() => { loaded.versions[0].models["30"].sponge.beta[0] = 8; }, TypeError);
  assert.equal(parseSpongeNetworkBundle(loaded), loaded);
  const first = calc(data, loaded), later = calc(data, loaded, 695);
  const nextDay = structuredClone(data);
  for (const rows of [nextDay.spxBars, nextDay.spyBars, ...nextDay.sectorContext.map(s => s.bars)]) for (const bar of rows) bar.timestamp = bar.timestamp.replace(date, "2026-10-02");
  const tomorrow = calc(nextDay, loaded, 635, 960, "2026-10-02");
  assert.equal(first.status, "available"); assert.equal(tomorrow.status, "available");
  assert.equal(first.graph.links, later.graph.links); assert.equal(first.graph.links, tomorrow.graph.links);
  assert.deepEqual(first.graph, later.graph); assert.deepEqual(first.graph, tomorrow.graph);
  assert.notEqual(first.nodes[0].fiveMinuteReturn, later.nodes[0].fiveMinuteReturn, "live node activations change while graph stays fixed");
  raw.versions[0].graph.edges[0].weight = .99; raw.versions[0].models["30"].sponge.beta[0] = 99;
  assert.deepEqual(calc(data, loaded), first, "the loaded snapshot cannot be changed through its original JSON object");
  assert.deepEqual(data, prices, "scoring never changes source prices");
});

test("static edges determine nonlinear live components and weighted directional participation", () => {
  const result = calc(); assert.equal(result.status, "available"); assert.equal(result.coverage.eligible, 11);
  assert.deepEqual(result.nodes.map(node => node.sign), [1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1]);
  near(result.features.sector_signed_breadth, 3 / 11); near(result.features.bullish_cluster_fraction, 3 / 11); near(result.features.bearish_cluster_fraction, 2 / 11);
  near(result.features.bullish_edge_weight_fraction, 1.5 / 2.1); near(result.features.bearish_edge_weight_fraction, .6 / 2.1);
  const models = bundle(); Object.assign(models.versions[0].graph, { edges: [], adjacency: Array.from({ length: 11 }, () => Array(11).fill(0)), weight_sum: 0 });
  const empty = calc(input(), models); assert.equal(empty.status, "available"); near(empty.features.bullish_cluster_fraction, 1 / 11); near(empty.features.bearish_cluster_fraction, 1 / 11);
  near(empty.features.bullish_edge_weight_fraction, 0); near(empty.features.bearish_edge_weight_fraction, 0);
  const flat = input(); flat.sectorContext.forEach(sector => { sector.bars = sector.bars.map(bar => ({ ...bar, open: 100, high: 100, low: 100, close: 100 })); });
  const neutral = calc(flat); assert.ok(neutral.nodes.every(node => node.sign === 0)); near(neutral.features.bullish_cluster_fraction, 0); near(neutral.features.bearish_cluster_fraction, 0);
});

test("base and individual features use exact completed prices and full-prefix population formulas", () => {
  const data = input(), result = calc(data), t = 635 - 570, closes = data.spxBars.map(bar => bar.close);
  near(result.features.spx_return_5, closes[t] / closes[t - 5] - 1); near(result.features.spx_return_15, closes[t] / closes[t - 15] - 1);
  const returns = Array.from({ length: 30 }, (_, i) => closes[t - 29 + i] / closes[t - 30 + i] - 1), mean = returns.reduce((a, b) => a + b) / 30;
  near(result.features.spx_return_volatility_30, Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 30));
  for (const [symbol, rows] of [["SPY", data.spyBars], ...data.sectorContext.map(sector => [sector.symbol, sector.bars])]) {
    const prefix = rows.slice(0, t + 1), vwap = prefix.reduce((sum, bar) => sum + (bar.high + bar.low + bar.close) / 3 * bar.volume, 0) / prefix.reduce((sum, bar) => sum + bar.volume, 0);
    near(result.features[symbol === "SPY" ? "spy_vwap_gap" : `${symbol}_vwap_gap`], rows[t].close / vwap - 1);
    if (symbol !== "SPY") near(result.features[`${symbol}_return_5`], rows[t].close / rows[t - 5].close - 1);
  }
  assert.deepEqual(result.featureVector, SPONGE_NETWORK_FEATURES.map(feature => result.features[feature]));
});

test("fitted coefficients produce signed log-odds contributions with an exact additive identity", () => {
  const models = bundle(), model = models.versions[0].models["30"].sponge;
  model.beta[6] = 3; model.beta[7] = -4; model.mean[5] = .001; model.scale[5] = .002; model.mean[6] = .002; model.scale[6] = .003;
  model.beta[28] = .2;
  const result = calc(input(), models), horizon = result.horizons[0], values = result.featureVector;
  const expected = 3 * (values[5] - .001) / .002 - 4 * (values[6] - .002) / .003;
  near(horizon.nodeContributions.find(item => item.symbol === "XLK").logOdds, expected);
  near(horizon.logOdds, model.beta[0] + expected + .2 * values[27]);
  near(horizon.logOdds, horizon.intercept + horizon.featureContributions.reduce((sum, item) => sum + item.logOdds, 0));
  near(horizon.probabilityUp, 1 / (1 + Math.exp(-horizon.logOdds))); near(horizon.probabilityDown, 1 - horizon.probabilityUp);
  assert.equal(horizon.featureContributions.length, 31); assert.equal(horizon.nodeContributions.length, 11);
  for (const contributions of [horizon.nodeContributions, horizon.featureContributions]) for (let i = 1; i < contributions.length; i++) assert.ok(Math.abs(contributions[i - 1].logOdds) >= Math.abs(contributions[i].logOdds));
  assert.equal(horizon.modelId, "sponge-2026-10:sponge:30"); assert.equal(horizon.trainingThrough, "2026-09-30");
  near(result.horizons[1].probabilityUp, .4); assert.equal(result.horizons[1].direction, "bearish");
});

test("weak binary estimates are neutral including both boundaries; invalid values never become neutral", () => {
  assert.equal(spongeNetworkDirection(.45), "neutral"); assert.equal(spongeNetworkDirection(.55), "neutral");
  assert.equal(spongeNetworkDirection(.45 - 1e-10), "bearish"); assert.equal(spongeNetworkDirection(.55 + 1e-10), "bullish");
  for (const p of [NaN, Infinity, -.01, 1.01, undefined, null, "0.5"]) assert.equal(spongeNetworkDirection(p), null);
  const models = bundle(); modifyFits(models, model => { model.beta[0] = 0; });
  assert.deepEqual(calc(input(), models).horizons.map(horizon => horizon.direction), ["neutral", "neutral"]);
});

test("future rows, future corruptions and prior sessions cannot change a completed historical score", () => {
  const data = input(), expected = calc(data);
  for (const rows of [data.spxBars, data.spyBars, ...data.sectorContext.map(s => s.bars)]) {
    rows.push({ ...rows.at(-1), timestamp: stamp(636), close: -1, volume: -1 });
    rows.push({ ...rows[20], timestamp: stamp(590, "2026-09-30"), close: -1 });
    rows.push({ ...rows.at(-1), timestamp: stamp(636).replace(":00.000", ":30.000"), close: -1 }); rows.reverse();
  }
  assert.deepEqual(calc(data), expected);
});

test("all eleven sector prefixes are mandatory; missing feeds preserve frozen graph metadata", () => {
  for (const change of [
    data => data.sectorContext.pop(), data => data.sectorContext.push(structuredClone(data.sectorContext[0])),
    data => data.sectorContext[0].bars.splice(0, 1), data => data.sectorContext[0].bars.splice(50, 1),
    data => data.sectorContext[0].bars.push({ ...data.sectorContext[0].bars[50] }),
  ]) {
    const data = input(); change(data); const result = calc(data); unavailable(result); assert.deepEqual(result.graph.links, bundle().versions[0].graph.edges);
    assert.equal(result.coverage.eligible, 10); assert.ok(result.nodes.some(node => !node.eligible));
  }
  const result = calc({ spxBars: [], spyBars: [], sectorContext: [] }); unavailable(result); assert.equal(result.graph.id, "historical-graph-2026-10");
  assert.ok(result.nodes.every(node => !node.eligible));
});

test("missing, duplicate, off-grid and invalid required bars cannot produce probabilities", () => {
  for (const symbol of ["SPX", "SPY", "XLK"]) for (const change of [
    rows => rows.splice(50, 1), rows => rows.push({ ...rows[50] }),
    rows => { rows[50].close = 0; }, rows => { rows[50].high = rows[50].low; }, rows => { rows[50].close = NaN; }, rows => { rows[50].close = "100"; },
    rows => rows.push({ ...rows[50], timestamp: rows[50].timestamp.replace(":00.000", ":01.000") }),
    rows => rows.push({ ...rows[50], timestamp: rows[50].timestamp.replace(":00.000", ":00.001") }),
    rows => rows.push({ ...rows[50], timestamp: `${rows[50].timestamp}Z` }),
  ]) {
    const data = input(), rows = symbol === "SPX" ? data.spxBars : symbol === "SPY" ? data.spyBars : data.sectorContext[0].bars;
    change(rows); unavailable(calc(data));
  }
  const oldSPXGap = input(); oldSPXGap.spxBars.shift(); assert.equal(calc(oldSPXGap).status, "available", "SPX needs trailing prices only");
  const oldSPYGap = input(); oldSPYGap.spyBars.shift(); unavailable(calc(oldSPYGap));
});

test("SPX is price-only but SPY and sector OHLCV prefixes require valid proxy volume", () => {
  const cash = input(); cash.spxBars.forEach(bar => { bar.volume = NaN; }); assert.equal(calc(cash).status, "available");
  for (const symbol of ["SPY", "XLK"]) for (const change of [
    rows => { delete rows[20].volume; }, rows => { rows[20].volume = -1; }, rows => { rows[20].volume = Infinity; }, rows => rows.forEach(bar => { bar.volume = 0; }),
  ]) { const data = input(); change(symbol === "SPY" ? data.spyBars : data.sectorContext[0].bars); unavailable(calc(data)); }
  const zero = input(); zero.spyBars[20].volume = 0; zero.sectorContext[0].bars[20].volume = 0; assert.equal(calc(zero).status, "available");
});

test("each horizon fits the verified cash close, including early-close boundary minutes", () => {
  const both = calc(input(), bundle(), 719, 780); assert.deepEqual(both.horizons.map(h => h.status), ["available", "available"]);
  const thirty = calc(input(), bundle(), 749, 780); assert.deepEqual(thirty.horizons.map(h => h.status), ["available", "unavailable"]); assert.equal(thirty.horizons[1].probabilityUp, null);
  unavailable(calc(input(), bundle(), 750, 780)); unavailable(calc(input(), bundle(), 930, 960));
  const warming = calc(input(), bundle(), 634); assert.equal(warming.status, "warming"); assert.equal(warming.graph.id, "historical-graph-2026-10");
  assert.equal(calc().studiedDecisionMinute, true); assert.equal(calc(input(), bundle(), 636).studiedDecisionMinute, false);
});

test("model and graph dates cannot leak across their exact monthly validity window", () => {
  for (const change of [
    b => { b.versions[0].train_end = "2026-10-01"; }, b => { b.versions[0].train_start = "2026-09-31"; },
    b => { b.versions[0].graph.train_end = "2026-10-01"; }, b => { b.versions[0].graph.train_start = "2024-01-01"; },
    b => { b.versions[0].models["30"].sponge.train_end = "2026-10-01"; },
    b => { b.versions[0].valid_from = "2026-10-02"; }, b => { b.versions[0].valid_to = "2026-11-01"; },
    b => { b.versions[0].graph.training_rows = 9999; }, b => { b.versions[0].graph.training_days = 79; },
    b => { b.versions[0].models["30"].sponge.training_rows = 349; }, b => { b.versions[0].models["60"].sponge.training_days = 79; },
    b => b.versions.push(structuredClone(b.versions[0])), b => { b.latest_version_id = "not-the-latest"; },
  ]) { const models = bundle(); change(models); assert.throws(() => parseSpongeNetworkBundle(models), /Invalid sponge bundle/); unavailable(calc(input(), models)); }
  unavailable(calc(input(), bundle(), 635, 960, "2026-11-02"));
});

test("malformed graph topology, model transforms and feature schemas fail closed", () => {
  for (const models of [null, undefined, {}, { versions: [] }]) unavailable(calculateSpongeNetwork(input(), 635, date, models));
  for (const change of [
    b => { b.schema_version = 2; }, b => b.feature_order.reverse(), b => b.sectors.reverse(), b => { b.decision_policy.strict_sector_count = 9; },
    b => { b.versions[0].graph.adjacency[0][1] = .9; }, b => { b.versions[0].graph.adjacency[0][0] = 1; },
    b => { b.versions[0].graph.weight_sum = 4; }, b => { b.versions[0].graph.edges[0].weight = Infinity; },
    b => { b.versions[0].graph.edges[0].source = "QQQ"; }, b => { b.versions[0].graph.edges[0].target = "XLK"; },
    b => b.versions[0].graph.edges.push({ source: "XLF", target: "XLK", weight: .8 }),
    b => b.versions[0].graph.node_order.reverse(), b => { b.versions[0].models["30"].sponge = null; },
    b => { b.versions[0].models["30"].sponge.beta[0] = NaN; }, b => { b.versions[0].models["30"].sponge.scale[0] = 0; },
    b => { b.versions[0].models["30"].sponge.mean[0] = Infinity; }, b => { b.versions[0].models["30"].sponge.converged = false; },
    b => b.versions[0].models["30"].sponge.feature_order.reverse(), b => { b.versions[0].models["30"].sponge.training_up_fraction = 2; },
  ]) { const models = bundle(); change(models); assert.throws(() => parseSpongeNetworkBundle(models), /Invalid sponge bundle/); unavailable(calc(input(), models)); }
});

test("invalid session dates and clocks cannot score", () => {
  unavailable(calc(input(), bundle(), 635, 960, "2026-10-02")); unavailable(calc(input(), bundle(), 635, 960, "2026-02-30"));
  for (const cutoff of [NaN, Infinity, 635.1, -1, 1440]) unavailable(calc(input(), bundle(), cutoff));
  for (const close of [NaN, 570, 780.5, 1441]) unavailable(calc(input(), bundle(), 635, close));
});

test("macro v2 preserves all eleven historical nodes/edges and the original 31 features", () => {
  const data = macroInput(), models = macroBundle(), old = calc(data), result = calc(data, models);
  assert.equal(result.status, "available"); assert.equal(result.featureVector.length, 35);
  assert.deepEqual(result.graph, old.graph); assert.deepEqual(result.nodes, old.nodes); assert.deepEqual(result.featureVector.slice(0, 31), old.featureVector);
  assert.deepEqual(models.versions[0].graph, bundle().versions[0].graph);
  assert.deepEqual(result.macroCoverage, { eligible: 2, total: 2 }); assert.equal(result.coverage.total, 11);
  assert.equal(result.macroNodes[0].family, "oil"); assert.equal(result.macroNodes[1].family, "rates");
  near(result.features.USO_return_5, data.macroContext[0].bars[65].close / data.macroContext[0].bars[60].close - 1);
  near(result.features.TNX_change_5_bps, .5); near(result.features.TNX_change_from_open_bps, 2);
  near(result.macroNodes[1].yieldPercent, 4.02); assert.equal(result.macroNodes[1].vwap, null);
  assert.equal(result.horizons[0].nodeContributions.length, 11); assert.equal(result.horizons[0].macroContributions.length, 2);
});

test("macro coefficients learn either sign; their contributions are exact standardized log-odds", () => {
  const models = macroBundle(), model = models.versions[0].models[30].macro_sponge;
  model.beta[32] = -2; model.beta[33] = 3; model.beta[34] = -.4; model.beta[35] = .7;
  model.mean[33] = .1; model.scale[33] = 2;
  const result = calc(macroInput(), models), horizon = result.horizons[0], [oil, rates] = horizon.macroContributions;
  near(oil.logOdds, -2 * result.features.USO_return_5 + 3 * result.features.USO_vwap_gap);
  near(rates.logOdds, -.4 * (.5 - .1) / 2 + .7 * 2);
  near(horizon.logOdds, horizon.intercept + oil.logOdds + rates.logOdds);
  near(horizon.probabilityUp, 1 / (1 + Math.exp(-horizon.logOdds)));
  assert.deepEqual(rates.featureContributions.map(item => item.feature), ["TNX_change_5_bps", "TNX_change_from_open_bps"]);
  for (const macro of horizon.macroContributions) near(macro.logOdds, macro.featureContributions.reduce((sum, item) => sum + item.logOdds, 0));
});

test("TNX uses exactly open[09:30], close[t-5], close[t] and never needs traded volume or other minute bars", () => {
  const data = macroInput(), expected = calc(data, macroBundle());
  data.macroContext[1].bars.forEach(bar => { delete bar.volume; });
  assert.deepEqual(calc(data, macroBundle()), expected);
  data.macroContext[1].bars.push({ ...rateBar(600, 0), high: 0, low: 0, volume: -1 });
  data.macroContext[1].bars.push({ ...rateBar(636, 0), timestamp: stamp(636).replace(":00.000", ":01.000") });
  data.macroContext[1].bars.push({ ...rateBar(635, 0), timestamp: stamp(635, "2026-09-30") });
  assert.deepEqual(calc(data, macroBundle()), expected, "unrequired or future/prior-session observations cannot fill or poison required prices");
  for (const minute of [570, 630, 635]) for (const change of [
    rows => rows.splice(rows.findIndex(bar => bar.timestamp === stamp(minute)), 1),
    rows => rows.push({ ...rows.find(bar => bar.timestamp === stamp(minute)) }),
    rows => { rows.find(bar => bar.timestamp === stamp(minute)).close = 0; },
    rows => { rows.find(bar => bar.timestamp === stamp(minute)).open = NaN; },
    rows => { rows.find(bar => bar.timestamp === stamp(minute)).source_valid = false; },
    rows => { rows.find(bar => bar.timestamp === stamp(minute)).identity_valid = false; },
    rows => rows.push({ ...rows.find(bar => bar.timestamp === stamp(minute)), timestamp: stamp(minute).replace(":00.000", ":00.001") }),
  ]) { const data = macroInput(); change(data.macroContext[1].bars); unavailable(calc(data, macroBundle())); }
});

test("USO requires its full positive-volume traded prefix and missing macro inputs hold both forecasts", () => {
  for (const change of [
    data => { delete data.macroContext; }, data => data.macroContext.pop(), data => data.macroContext.shift(),
    data => data.macroContext.push(structuredClone(data.macroContext[0])),
    data => data.macroContext[0].bars.shift(), data => { data.macroContext[0].bars[20].volume = 0; },
    data => { data.macroContext[0].bars[20].volume = -1; }, data => { data.macroContext[0].bars[20].count = 0; },
    data => { data.macroContext[0].bars[20].count = NaN; }, data => { data.macroContext[0].bars[20].source_valid = false; },
    data => { data.macroContext[0].bars[20].identity_valid = false; },
    data => data.macroContext[0].bars.push({ ...data.macroContext[0].bars[20] }),
  ]) { const data = macroInput(); change(data); const result = calc(data, macroBundle()); unavailable(result); assert.equal(result.graph.links.length, 3); assert.equal(result.coverage.eligible, 11); }
  const data = macroInput(); data.macroContext[0].bars.forEach(bar => { bar.count = 1; }); assert.equal(calc(data, macroBundle()).status, "available");
});

test("macro schema rejects changed feature order, missing dependencies, proxy substitutions and incorrect yield units", () => {
  for (const change of [
    b => b.macro_features.reverse(), b => { b.macro_inputs[1].quote_divisor_for_yield_percent = 1; },
    b => { b.macro_inputs[1].quote_delta_multiplier_for_basis_points = 100; }, b => { b.macro_inputs[1].symbol = "IEF"; },
    b => { b.macro_inputs[0].source_endpoint = "/index/history/ohlc"; }, b => { b.decision_policy.required_macro_symbols.pop(); },
    b => { b.versions[0].models[30].macro_sponge.train_end = "2026-10-01"; },
    b => { b.versions[0].models[30].macro_sponge.feature_order.reverse(); },
    b => { b.versions[0].models[30].macro_sponge.mean[34] = Infinity; },
  ]) { const models = macroBundle(); change(models); assert.throws(() => parseSpongeNetworkBundle(models), /Invalid sponge bundle/); unavailable(calc(macroInput(), models)); }
  const frozen = parseSpongeNetworkBundle(macroBundle()); assert.ok(Object.isFrozen(frozen.macro_inputs[1]));
  assert.throws(() => { frozen.versions[0].models[30].macro_sponge.beta[35] = 1; }, TypeError);
});

for (const path of [process.env.SPONGE_NETWORK_FIXTURE, process.env.SPONGE_MACRO_FIXTURE].filter(Boolean)) {
  const fixtures = JSON.parse(readFileSync(path, "utf8"));
  const models = parseSpongeNetworkBundle(JSON.parse(readFileSync(join(dirname(path), "model.json"), "utf8")));
  for (const fixture of fixtures.cases) test(`Python actual-data persistent-network parity: ${fixture.date} ${fixture.decision_minute}`, () => {
    const convert = (symbol) => fixture.context[symbol].map(bar => ({ timestamp: stamp(bar.minute, fixture.date), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, source_valid: bar.source_valid }));
    const data = { spxBars: convert("SPX"), spyBars: convert("SPY"), sectorContext: NETWORK_SYMBOLS.map(symbol => ({ symbol, bars: convert(symbol) })),
      ...(models.schema_version === 2 ? { macroContext: ["USO", "TNX"].map(symbol => ({ symbol, bars: convert(symbol) })) } : {}) };
    const result = calc(data, models, fixture.decision_minute - 1, fixture.session_close, fixture.date);
    assert.equal(result.status, "available", result.reason);
    const vector = Array.isArray(fixture.features) ? fixture.features : models.feature_order.map(feature => fixture.features[feature]);
    result.featureVector.forEach((value, i) => near(value, vector[i], 1e-10));
    for (const node of result.nodes) {
      near(node.fiveMinuteReturn, fixture.node_states[node.symbol].return5, 1e-10); near(node.vwapGap, fixture.node_states[node.symbol].vwap_gap, 1e-10);
      assert.equal(node.sign, fixture.node_states[node.symbol].sign);
    }
    for (const horizon of result.horizons) {
      near(horizon.probabilityUp, fixture.probabilities[horizon.minutes], 1e-10);
      const expected = fixture.log_odds_contributions[horizon.minutes];
      near(horizon.intercept, expected.intercept, 1e-10); near(horizon.logOdds, expected.log_odds, 1e-10);
      horizon.featureContributions.forEach(item => near(item.logOdds, Array.isArray(expected.by_feature) ? expected.by_feature[models.feature_order.indexOf(item.feature)] : expected.by_feature[item.feature], 1e-10));
    }
  });
}
