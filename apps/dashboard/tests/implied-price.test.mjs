import test from "node:test";
import assert from "node:assert/strict";
import { impliedPrice } from "../src/core/implied-price.ts";
import { readout, defaults } from "../src/core/readout.ts";

// Explicitly invented future session and quote values; no market record is used.
// Midpoints 1.25 and 3.00 imply 5000 + 1.25 - 3.00 = 4998.25.
const date = "2035-05-17", session = { open: 570, close: 960 };
const stamp = (minute) => `${date}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000`;
const pair = (minute = 959) => [
  { symbol: "SPXW", expiration: date, strike: 5000, right: "CALL", timestamp: stamp(minute), bid: 1.20, ask: 1.30, bid_size: 10, ask_size: 12 },
  { symbol: "SPXW", expiration: date, strike: 5000, right: "PUT", timestamp: stamp(minute), bid: 2.85, ask: 3.15, bid_size: 20, ask_size: 18 },
];
const fixture = () => ({ quotes: pair(), index: [{ timestamp: stamp(959), price: 4998.30 }], rate: null,
  quoteTimestampBasis: "event", indexTimestampBasis: "event" });
const run = (data, cutoff = 959, schedule = session, spread = 0.25) => impliedPrice(data, date, 5000, schedule, cutoff, spread);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);

test("fresh-looking interval labels cannot certify old quote freshness", () => {
  for (const quoteTimestampBasis of ["interval", undefined]) {
    const data = { ...fixture(), quoteTimestampBasis };
    const result = run(data);
    assert.equal(result.point, null);
    assert.equal(result.timestamp, null);
    assert.match(result.reason, /update times are unverified/);
  }
});

test("an interval index sample cannot create an apparently synchronized price gap", () => {
  const result = run({ ...fixture(), indexTimestampBasis: "interval" });
  assert.equal(result.status, "ready");
  assert.equal(result.point.observed, null);
  assert.equal(result.point.gap, null);
  assert.equal(result.point.comparison, "unmatched");
});

test("matched NBBO pair implies a midpoint, quote range and same-sample SPX difference", () => {
  const result = run(fixture());
  assert.equal(result.status, "ready");
  const p = result.point;
  near(p.spot, 4998.25); near(p.forward, 4998.25);
  near(p.low, 4998.05); near(p.high, 4998.45);
  near(p.gap, -0.05); near(p.gapPct, -0.05 / 4998.30 * 100);
  assert.equal(p.comparison, "inside");
  assert.equal(p.rate.assumed, true);
});

test("prior SOFR discounts the strike and keeps implied spot distinct from expiry forward", () => {
  const data = fixture(); data.quotes = pair(600); data.index = [{ timestamp: stamp(600), price: 4998.30 }];
  data.rate = { created: "2035-05-16", rate: 2.4 };
  const p = run(data, 600).point;
  const accumulation = 1 + 0.024 * 0.25 / 360;
  near(p.discount, 1 / accumulation);
  near(p.spot, -1.75 + 5000 / accumulation);
  near(p.forward, 5000 - 1.75 * accumulation);
  assert.ok(p.forward > p.spot);
  assert.equal(p.rate.assumed, false);
  assert.equal(p.minutesRemaining, 360);
});

test("early-close sessions use only the remaining time to that day's PM settlement", () => {
  const data = fixture(); data.quotes = pair(600); data.rate = { created: "2035-05-16", rate: 2.4 };
  const normal = run(data, 600).point, early = run(data, 600, { open: 570, close: 780 }).point;
  assert.equal(early.minutesRemaining, 180);
  assert.ok(early.spot > normal.spot);
  near(early.forward, 5000 - 1.75 * (1 + 0.024 * 0.125 / 360));
});

test("same-day, future, old, invalid and missing rates use a visible zero-rate assumption", () => {
  for (const rate of [null, { created: date, rate: 2.4 }, { created: "2035-05-18", rate: 2.4 },
    { created: "2035-05-09", rate: 2.4 }, { created: "invalid", rate: 2.4 },
    { created: "2035-05-16", rate: NaN }, { created: "2035-05-16", rate: 300 }]) {
    const data = fixture(); data.rate = rate;
    const p = run(data).point;
    assert.equal(p.rate.assumed, true); near(p.spot, 4998.25);
  }
});

test("replay excludes later quotes and index prices regardless of arrival order", () => {
  const data = fixture(); data.quotes = pair(600); data.index = [{ timestamp: stamp(600), price: 4998.30 }];
  const before = run(data, 600);
  data.quotes.unshift(...pair(959).map((q) => ({ ...q, bid: 20, ask: 20.1 })));
  data.index.unshift({ timestamp: stamp(959), price: 9000 });
  assert.deepEqual(run(data, 600), before);
});

test("an unpaired latest quote cannot silently reuse an older valid pair", () => {
  const data = fixture(); data.quotes = [...pair(958), pair()[0]];
  assert.equal(run(data).status, "unavailable");
  assert.match(run(data).reason, /matched pair/);
});

test("quotes with different seconds or milliseconds cannot be paired", () => {
  for (const timestamp of [`${date}T15:58:59.000`, `${date}T15:58:59.999`]) {
    const data = fixture(); data.quotes[1].timestamp = timestamp;
    assert.equal(run(data).point, null);
  }
});

test("mismatched strike, expiry, symbol, session or right cannot supply a missing leg", () => {
  for (const patch of [{ strike: 4995 }, { expiration: "2035-05-20" }, { symbol: "SPX" },
    { timestamp: "2035-05-16T15:59:00.000" }, { right: "CALL" }, { timestamp: "bad" }]) {
    const data = fixture(); Object.assign(data.quotes[1], patch);
    assert.equal(run(data).point, null);
  }
});

test("duplicate legs at the same sample are rejected rather than selected arbitrarily", () => {
  const data = fixture(); data.quotes.push({ ...data.quotes[0] });
  assert.equal(run(data).point, null);
});

test("invalid latest quotes never fall back to an older valid observation", () => {
  for (const patch of [{ bid: 0 }, { bid: -1 }, { bid: NaN }, { ask: Infinity },
    { ask: 0.5 }, { ask: 9 }, { bid_size: 0 }, { ask_size: 0 }, { ask_size: NaN }]) {
    const data = fixture(); Object.assign(data.quotes[0], patch); data.quotes.unshift(...pair(958));
    assert.equal(run(data).point, null);
    assert.match(run(data).reason, /quote/);
  }
});

test("both legs respect the user's relative-spread limit", () => {
  const data = fixture();
  // Call spread = 8%, put spread = 10%: passing the call alone is insufficient.
  assert.equal(run(data, 959, session, 0.09).point, null);
  assert.equal(run(data, 959, session, 0.11).status, "ready");
});

test("samples older than two minutes are withheld, with no stale numeric estimate", () => {
  const data = fixture(); data.quotes = pair(956);
  assert.equal(run(data).status, "stale");
  assert.equal(run(data).point, null);
  data.quotes = pair(957); assert.equal(run(data).status, "ready");
});

test("without an exact index sample the estimate survives but the comparison is withheld", () => {
  for (const index of [[], [{ timestamp: stamp(958), price: 4998.30 }],
    [{ timestamp: stamp(959), price: NaN }], [{ timestamp: stamp(959), price: 0 }],
    [{ timestamp: stamp(959), price: 4998.30 }, { timestamp: stamp(959), price: 4998.31 }]]) {
    const p = run({ ...fixture(), index }).point;
    assert.equal(p.observed, null); assert.equal(p.gap, null); assert.equal(p.gapPct, null);
    assert.equal(p.comparison, "unmatched"); near(p.spot, 4998.25);
  }
});

test("range comparisons distinguish quote bands above, below and containing SPX", () => {
  for (const [price, comparison] of [[4998.0, "above"], [4998.5, "below"], [4998.05, "inside"], [4998.45, "inside"]]) {
    const data = fixture(); data.index[0].price = price;
    assert.equal(run(data).point.comparison, comparison);
  }
});

test("premarket, missing contracts and post-settlement quotes do not invent a price", () => {
  assert.equal(run(fixture(), 569).point, null);
  assert.equal(run(undefined).point, null);
  assert.equal(impliedPrice(fixture(), date, null, session, 959).point, null);
  const data = fixture(); data.quotes = pair(960);
  assert.equal(run(data, 960).point, null);
});

test("readout passes the replay cutoff and quote settings into the price calculation", () => {
  const parity = fixture(); parity.quotes.unshift(...pair(600)); parity.index.unshift({ timestamp: stamp(600), price: 4998.2 });
  const data = { date, session, parity, measurement: { strike: 5000 }, spx: [], spy: [], priorSpx: [], priorSpy: [], quotes: [], openingIv: null, openingIvTimestamp: null };
  const v = readout(data, 600, defaults);
  assert.equal(v.implied.timestamp, stamp(600)); near(v.implied.point.observed, 4998.2);
  assert.equal(readout(data, 600, { ...defaults, maxSpread: 0.09 }).implied.point, null);
});
