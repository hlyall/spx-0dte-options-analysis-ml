import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateNetworkRegime, NETWORK_SYMBOLS, NETWORK_PARAMETERS } from "../src/core/network-regime.ts";

const date = "2026-10-01";
const stamp = (minute, day = date) => `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000`;
const bar = (minute, close, volume = 100, day = date) => ({ timestamp: stamp(minute, day), open: close, high: close + 0.01, low: close - 0.01, close, volume });
function series(end = 650, side = 1, initial = 100) {
  let price = initial;
  return Array.from({ length: end - 569 }, (_, i) => {
    if (i) price *= 1 + side * (0.0003 + 0.0002 * Math.sin(i * 0.73));
    return bar(570 + i, price, 100 + i % 7);
  });
}
const context = (end = 650, sides = NETWORK_SYMBOLS.map(() => 1)) => NETWORK_SYMBOLS.map((symbol, i) => ({ symbol, bars: series(end, sides[i]) }));
const calc = (data, cutoff = 650, close = 960) => calculateNetworkRegime(data, cutoff, date, close);
const near = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test("the fixed network uses sixty aligned returns, own volume VWAP and eleven-sector denominator", () => {
  const data = context(), saved = structuredClone(data), result = calc(data);
  assert.equal(result.status, "bullish_coordinated");
  assert.equal(result.experimental, true);
  assert.equal(result.coverage.eligible, 11);
  assert.equal(result.links.length, 55);
  assert.equal(result.bullishCluster.size, 11);
  near(result.meanCorrelation, 1);
  assert.equal(result.signedBreadth, 1);
  const rows = data[0].bars;
  const vwap = rows.reduce((sum, x) => sum + ((x.high + x.low + x.close) / 3) * x.volume, 0) / rows.reduce((sum, x) => sum + x.volume, 0);
  near(result.sectors[0].vwap, vwap);
  near(result.sectors[0].fiveMinuteReturn, rows.at(-1).close / rows.at(-6).close - 1);
  assert.deepEqual(data, saved, "calculation must leave the supplied bars unchanged");
  data.forEach((entry) => entry.bars.forEach((x) => { x.vwap = 1; x.sessionVwap = 99999; }));
  assert.deepEqual(calc(data), result, "vendor VWAP fields cannot replace the specified cumulative HLC3 VWAP");
  assert.equal(NETWORK_PARAMETERS.correlationThreshold, 0.6);
});

test("bearish coordination mirrors bullish; minimum coverage never rescales fractions", () => {
  const result = calc(context(650, NETWORK_SYMBOLS.map(() => -1)).slice(0, 9));
  assert.equal(result.status, "bearish_coordinated");
  assert.equal(result.coverage.eligible, 9);
  near(result.coverage.fraction, 9 / 11);
  near(result.bearishCluster.fraction, 9 / 11);
  near(result.largestClusterFraction, 9 / 11);
  near(result.signedBreadth, -9 / 11);
  assert.equal(result.bearishCluster.size, 9);
  const missing = calc(context().slice(0, 8));
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.signedBreadth, null);
  assert.equal(missing.meanCorrelation, null);
  assert.equal(missing.largestClusterFraction, null);
  assert.equal(missing.clusterGrowth, null);
});

test("seven connected same-sign sectors suffice; six do not", () => {
  const seven = calc(context(650, NETWORK_SYMBOLS.map((_, i) => i < 7 ? 1 : -1)));
  assert.equal(seven.status, "bullish_coordinated");
  assert.equal(seven.bullishCluster.size, 7);
  assert.equal(seven.bearishCluster.size, 4);
  near(seven.signedBreadth, 3 / 11);
  const six = calc(context(650, NETWORK_SYMBOLS.map((_, i) => i < 6 ? 1 : -1)));
  assert.equal(six.status, "unresolved");
  assert.equal(six.bullishCluster.size, 6);
  assert.ok(six.links.every((link) => link.sign !== 0), "anti-correlated groups are not linked with absolute correlation");
});

test("components use transitive connectivity, not an all-pairs clique", () => {
  const weights = NETWORK_SYMBOLS.map((_, i) => i < 3 ? [1, 0] : i < 7 ? [0.75, Math.sqrt(7) / 4] : [0.125, Math.sqrt(63) / 8]);
  const data = NETWORK_SYMBOLS.map((symbol, k) => {
    let close = 100;
    return { symbol, bars: Array.from({ length: 61 }, (_, i) => {
      if (i) close *= 1 + 0.001 + 0.0002 * (weights[k][0] * Math.sin(2 * Math.PI * i / 60) + weights[k][1] * Math.cos(2 * Math.PI * i / 60));
      return bar(570 + i, close);
    }) };
  });
  const result = calc(data, 630);
  assert.equal(result.status, "bullish_coordinated");
  assert.equal(result.bullishCluster.size, 11);
  assert.ok(!result.links.some((link) => link.source === "XLK" && link.target === "XLI"), "the first and third return bases have correlation 0.125");
  near(result.links.find((link) => link.source === "XLK" && link.target === "XLP").correlation, 0.75);
});

test("date, minute completion and future filtering are causal and order independent", () => {
  const expected = calc(context(650), 640), data = context(650);
  for (const entry of data) {
    entry.bars.push(bar(640, 9999, 100, "2026-09-30"));
    entry.bars.push(bar(650, -2, -4)); // Even an invalid future duplicate must not poison cutoff640.
    entry.bars.push(bar(569, 777));
    entry.bars.reverse();
  }
  assert.deepEqual(calc(data, 640), expected);
  const warming = calc(context(), 629), first = calc(context(), 630), grown = calc(context(), 635);
  assert.equal(warming.status, "warming");
  assert.equal(warming.warmup.elapsedBars, 60);
  assert.equal(first.status, "bullish_coordinated");
  assert.equal(first.clusterGrowth, null);
  assert.equal(grown.clusterGrowth, 0);
  assert.equal(grown.bullishGrowth, 0);
  assert.equal(calc(context(), 569).status, "premarket");
});

test("missing, duplicate and invalid session minutes quarantine sectors without pairwise deletion", () => {
  for (const change of [
    (bars) => bars.shift(), // Gap before the return window still invalidates the RTH VWAP.
    (bars) => bars.splice(50, 1),
    (bars) => bars.push({ ...bars[0] }),
    (bars) => { bars[1].volume = -1; },
    (bars) => { bars[1].volume = "100"; },
    (bars) => { bars[1].high = bars[1].low; },
    (bars) => { bars[1].close = Infinity; },
    (bars) => { bars[1].timestamp += "Z"; },
    (bars) => { bars[1].timestamp = bars[1].timestamp.replace(":00.000", ":15.000"); },
  ]) {
    const data = context().slice(0, 9);
    change(data[0].bars);
    const result = calc(data);
    assert.equal(result.status, "unavailable");
    assert.equal(result.coverage.eligible, 8);
    assert.equal(result.sectors[0].eligible, false);
    assert.ok(result.sectors[0].reason);
  }
  const duplicated = context().slice(0, 9);
  duplicated.push(structuredClone(duplicated[0]));
  assert.equal(calc(duplicated).coverage.eligible, 8);
  const unknown = context(); unknown.push({ symbol: "SPY", bars: [] });
  assert.deepEqual(calc(unknown), calc(context()), "the fixed universe cannot expand with unrelated context");
});

test("zero variance, absent volume and nonfinite accumulations are unavailable", () => {
  for (const change of [
    (bars) => bars.forEach((x) => { x.open = x.high = x.low = x.close = 100; }),
    (bars) => bars.forEach((x) => { x.volume = 0; }),
    (bars) => bars.forEach((x) => { x.volume = Number.MAX_VALUE; }),
  ]) {
    const data = context().slice(0, 9); change(data[0].bars);
    const result = calc(data);
    assert.equal(result.coverage.eligible, 8);
    assert.equal(result.status, "unavailable");
    assert.ok(!JSON.stringify(result).includes("NaN"));
  }
});

test("extra off-grid rows quarantine their completed minute even beside an exact bar", () => {
  for (const suffix of [":15.000", ":00.001"]) {
    const data = context();
    const invalid = { ...data[0].bars[20], timestamp: stamp(590).replace(":00.000", suffix) };
    data[0].bars.push(invalid);
    const result = calc(data);
    assert.equal(result.coverage.eligible, 10);
    assert.equal(result.sectors[0].eligible, false);
    assert.match(result.sectors[0].reason, /Invalid source timestamp/);
    assert.equal(result.clusterGrowth, 0, "the same excluded sector persists in both growth snapshots");
    assert.equal(data[0].bars.at(-1).timestamp, invalid.timestamp, "source rows must not be repaired or mutated");
  }
  const data = context(), expected = calc(data, 640);
  data[0].bars.push({ ...bar(648, -1, -1), timestamp: stamp(648).replace(":00.000", ":30.000") });
  data[0].bars.push({ ...bar(568, -1, -1), timestamp: stamp(568).replace(":00.000", ":30.000") });
  data[0].bars.push({ ...bar(590, -1, -1, "2026-09-30"), timestamp: stamp(590, "2026-09-30").replace(":00.000", ":30.000") });
  assert.deepEqual(calc(data, 640), expected, "future, premarket and other-date invalid rows must not poison a past cutoff");
  const later = calc(data, 650);
  assert.equal(later.coverage.eligible, 10);
  assert.equal(later.clusterGrowth, null, "off-grid evidence after the prior cutoff changes the growth universe");
});

test("five-minute price change must agree with VWAP; neutral correlations cannot form directional clusters", () => {
  const data = context(660);
  for (const entry of data) for (let i = 0; i < 10; i++) {
    entry.bars[i].open = entry.bars[i].high = entry.bars[i].low = entry.bars[i].close = 1000;
  }
  const result = calc(data, 660);
  assert.equal(result.status, "dispersed");
  assert.equal(result.signedBreadth, 0);
  assert.equal(result.links.length, 55);
  assert.ok(result.links.every((link) => link.sign === 0));
  assert.equal(result.bullishCluster.size, 0);
  assert.equal(result.bearishCluster.size, 0);
  assert.ok(result.sectors.every((sector) => sector.fiveMinuteReturn > 0 && sector.close < sector.vwap && sector.sign === 0));
  const equal = context();
  equal[0].bars[80] = bar(650, equal[0].bars[75].close);
  assert.equal(calc(equal).sectors[0].sign, 0, "strict equality is neutral");
});

test("growth is withheld when coverage membership changes, even when both snapshots pass", () => {
  const changed = context(); changed[0].bars = changed[0].bars.filter((x) => x.timestamp !== stamp(648));
  const result = calc(changed);
  assert.equal(result.coverage.eligible, 10);
  assert.equal(result.status, "bullish_coordinated");
  assert.equal(result.clusterGrowth, null);
  assert.equal(result.bullishGrowth, null);
  const stable = context().slice(1);
  assert.equal(calc(stable).clusterGrowth, 0);
  assert.equal(calc(stable).bullishGrowth, 0);
});

test("directional growth distinguishes a full bearish flip from unchanged largest-component size", () => {
  const data = context(650);
  for (const entry of data) for (let i = 76; i <= 80; i++) entry.bars[i] = bar(570 + i, 90 - (i - 76) * 0.3);
  const result = calc(data);
  assert.equal(result.status, "bearish_coordinated");
  assert.equal(result.clusterGrowth, 0);
  assert.equal(result.bullishGrowth, -1);
  assert.equal(result.bearishGrowth, 1);
});

test("exchange close bounds the snapshot and invalid clocks never produce a signal", () => {
  assert.deepEqual(calc(context(810), 900, 780), calc(context(779), 779, 780));
  for (const [cutoff, day, close] of [[NaN, date, 960], [630.5, date, 960], [1440, date, 960], [630, "2026-02-30", 960], [630, date, 570], [630, date, 1441]]) {
    const result = calculateNetworkRegime(context(), cutoff, day, close);
    assert.equal(result.status, "unavailable");
    assert.equal(result.largestClusterFraction, null);
  }
});

// Optional external, outcome-independent fixtures allow the Python research engine to be
// checked against this exact production implementation without adding an engine dependency.
// Format: [{name, context, cutoffMinute, sessionDate, sessionClose?, expected:{...}}].
if (process.env.NETWORK_PARITY_FIXTURE) {
  const fixtures = JSON.parse(readFileSync(process.env.NETWORK_PARITY_FIXTURE, "utf8"));
  function compare(actual, expected, path = "") {
    if (typeof expected === "number") { near(actual, expected, 1e-9); return; }
    if (expected === null || typeof expected !== "object") { assert.equal(actual, expected, path); return; }
    for (const [key, value] of Object.entries(expected)) compare(actual[key], value, `${path}.${key}`);
  }
  for (const fixture of fixtures) test(`Python parity: ${fixture.name}`, () => {
    const actual = calculateNetworkRegime(fixture.context, fixture.cutoffMinute, fixture.sessionDate, fixture.sessionClose);
    compare(actual, fixture.expected);
  });
}
