import test from "node:test";
import assert from "node:assert/strict";
import { buildEmaRetest, EMA_RETEST_LEVEL_TOLERANCE } from "../src/core/ema-retest.ts";

const date = "2026-09-29", previousDate = "2026-09-28";
const stamp = (day, minute) => `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000`;
const candle = (day, start, value) => {
  const config = typeof value === "number" ? { close: value } : value;
  const close = config.close, open = config.open ?? close;
  return Array.from({ length: 10 }, (_, i) => ({
    timestamp: stamp(day, start + i), open, close,
    high: config.high ?? Math.max(open, close) + 0.1,
    low: config.low ?? Math.min(open, close) - 0.1, volume: 0,
  }));
};
const series = (day, values, start = 570) => values.flatMap((value, i) => candle(day, start + i * 10, value));
function fixture(values, prior = [...Array(8).fill(100), 99]) {
  return {
    date, previousDate, today: date, session: { open: 570, close: 960 },
    mode: "live", asOf: 570 + values.length * 10 - 1, fetchedAt: `${date}T14:00:00.000Z`,
    sources: [], spx: series(date, values), priorSpx: series(previousDate, prior),
    spy: [], priorSpy: [], quotes: [], chain: [], context: [], spot: null,
    measurement: { strike: null, selection: "Unavailable" }, openingIv: null, openingIvTimestamp: null,
    priorSpxClose: 99, priorSpyClose: null,
    parity: { quotes: [], index: [], rate: null, quoteTimestampBasis: "interval", indexTimestampBasis: "interval" },
  };
}
const bullish = [{ close: 102, low: 99, high: 103 }, { close: 101, low: 99.5, high: 103 }];
const bearish = [{ close: 98, low: 97, high: 101 }, { close: 99, low: 97, high: 100.5 }];
const almost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("eight complete closes seed an SMA, then EMA uses alpha 2/9", () => {
  const data = fixture([100, 102, 104, 106, 108, 110, 112, 114, 116], []);
  const warmup = buildEmaRetest(data, 639);
  assert.equal(warmup.status, "warming");
  assert.equal(warmup.ema, null);
  assert.equal(warmup.warmup.bars, 7);
  assert.equal(warmup.history.length, 0);
  const seeded = buildEmaRetest(data, 649);
  assert.equal(seeded.status, "ready");
  assert.equal(seeded.ema, 107);
  assert.equal(seeded.latestBar.endMinute, 650);
  assert.equal(seeded.history.length, 0, "a seed is not a crossover");
  const next = buildEmaRetest(data, 659);
  assert.equal(next.latestBar.previousEma, 107);
  assert.equal(next.ema, 109);
  assert.equal(next.warmup.seededFromPrior, false);
});

test("prior RTH candles warm the first current candle without replaying yesterday's signals", () => {
  const data = fixture(bullish);
  data.priorSpx.push(...series("2026-09-27", [1000, 2000]));
  const saved = structuredClone(data);
  const premarket = buildEmaRetest(data, 569);
  assert.equal(premarket.status, "premarket");
  assert.equal(premarket.history.length, 0);
  assert.equal(premarket.bullish.status, "idle");
  assert.equal(premarket.latestBar, null);
  assert.equal(premarket.warmup.priorBars, 9);
  almost(premarket.ema, 100 - 2 / 9);
  const first = buildEmaRetest(data, 579);
  assert.equal(first.status, "ready");
  assert.equal(first.warmup.seededFromPrior, true);
  assert.equal(first.bullish.status, "watching");
  assert.equal(first.bullish.episode.crossedAt, 580, "09:40 close, not 09:30 start");
  assert.ok(first.history.every((episode) => episode.id.startsWith(date)));
  assert.deepEqual(data, saved, "calculation must not modify supplied history");
});

test("a bullish cross cannot confirm itself; a later completed EMA retest can", () => {
  const data = fixture(bullish);
  const cross = buildEmaRetest(data, 579);
  assert.equal(cross.bullish.status, "watching");
  assert.equal(cross.bullish.episode.retestedAt, null);
  assert.equal(cross.latestBar.low, 99, "the crossing candle already touched the EMA");
  const partial = buildEmaRetest(data, 588);
  assert.equal(partial.bullish.status, "watching");
  assert.equal(partial.bars.length, 1, "nine minutes cannot become a completed 10-minute candle");
  const retest = buildEmaRetest(data, 589);
  assert.equal(retest.bullish.status, "confirmed");
  assert.equal(retest.bullish.episode.retestedAt, 590);
  assert.equal(retest.bullish.episode.confirmationPrice, 101);
  almost(retest.bullish.episode.retestReference, cross.ema);
  assert.equal(retest.bearish.status, "idle");
});

test("bearish loss and a later retest rejection mirror the bullish sequence", () => {
  const data = fixture(bearish, [...Array(8).fill(100), 101]);
  const first = buildEmaRetest(data, 579);
  assert.equal(first.bearish.status, "watching");
  assert.equal(first.bullish.status, "idle");
  const next = buildEmaRetest(data, 589);
  assert.equal(next.bearish.status, "confirmed");
  assert.equal(next.bearish.episode.retestedAt, 590);
  almost(next.bearish.episode.retestReference, first.ema);
});

test("the retest must touch the previous completed EMA, not only an intrabar estimate", () => {
  const data = fixture([bullish[0], { close: 102, low: 100.5, high: 103 }]);
  const result = buildEmaRetest(data, data.asOf);
  assert.ok(result.latestBar.low > result.latestBar.previousEma);
  assert.ok(result.latestBar.low < result.latestBar.ema, "the range includes the updated EMA only");
  assert.equal(result.bullish.status, "watching");
  assert.equal(result.bullish.episode.retestedAt, null);
});

test("the third later candle can confirm; after it closes the watch expires", () => {
  const confirming = fixture([bullish[0], 104, 106, { close: 105, low: 101, high: 106 }]);
  const good = buildEmaRetest(confirming, confirming.asOf);
  assert.equal(good.bullish.status, "confirmed");
  assert.equal(good.bullish.episode.retestedAt, 610);
  const missing = fixture([bullish[0], 104, 106, 108, { close: 109, low: 100, high: 110 }]);
  assert.equal(buildEmaRetest(missing, 599).bullish.status, "watching");
  const expired = buildEmaRetest(missing, 609);
  assert.equal(expired.bullish.status, "expired");
  assert.equal(expired.bullish.episode.endedAt, 610);
  const late = buildEmaRetest(missing, missing.asOf);
  assert.equal(late.bullish.status, "expired");
  assert.equal(late.bullish.episode.retestedAt, null);
  assert.equal(late.history.length, 1, "late touches cannot resurrect the expired cross");
});

test("an opposite cross cancels a watch and starts the opposite side", () => {
  const data = fixture([bullish[0], { close: 98, low: 97, high: 103 }, { close: 99, low: 98, high: 101 }]);
  const opposite = buildEmaRetest(data, 589);
  assert.equal(opposite.bullish.status, "cancelled");
  assert.equal(opposite.bullish.episode.endedAt, 590);
  assert.equal(opposite.bearish.status, "watching");
  assert.equal(opposite.bearish.episode.crossedAt, 590);
  assert.equal(opposite.bearish.episode.retestedAt, null);
  const next = buildEmaRetest(data, 599);
  assert.equal(next.bearish.status, "confirmed");
  assert.equal(next.history.length, 2);
});

test("a confirmed retest invalidates on a later wrong-side close, while preserving the observation", () => {
  const data = fixture([...bullish, 98]);
  const result = buildEmaRetest(data, data.asOf);
  assert.equal(result.bullish.status, "invalidated");
  assert.equal(result.bullish.episode.retestedAt, 590);
  assert.equal(result.bullish.episode.endedAt, 600);
  assert.equal(result.bearish.status, "watching");
  assert.match(result.bullish.episode.reason, /wrong side/);
});

test("a missing minute resets EMA and pattern continuity even when the feed is fresh", () => {
  const data = fixture(bullish);
  data.spx = data.spx.filter((bar) => bar.timestamp !== stamp(date, 584));
  const result = buildEmaRetest(data, 589);
  assert.equal(result.freshness.ageMinutes, 0);
  assert.equal(result.status, "unavailable");
  assert.equal(result.ema, null);
  assert.equal(result.bullish.status, "cancelled");
  assert.equal(result.bullish.episode.retestedAt, null);
  assert.equal(result.warmup.bars, 0);
  assert.equal(result.warmup.priorBars, 0);
});

test("duplicate or malformed OHLC source rows cannot satisfy ten-minute completeness", () => {
  for (const alteration of ["duplicate", "invalid", "wrong-minute"]) {
    const data = fixture(bullish);
    if (alteration === "duplicate") data.spx.push({ ...data.spx[14] });
    if (alteration === "invalid") data.spx[14].high = data.spx[14].close - 1;
    if (alteration === "wrong-minute") data.spx[14].timestamp = `${date}T09:44:30.000`;
    const result = buildEmaRetest(data, data.asOf);
    assert.equal(result.status, "unavailable", alteration);
    assert.equal(result.bullish.status, "cancelled", alteration);
    assert.equal(result.bullish.episode.retestedAt, null, alteration);
  }
});

test("even an identical duplicate replacing a missing minute is not ten distinct minutes", () => {
  const data = fixture(bullish);
  data.spx = data.spx.filter((bar) => bar.timestamp !== stamp(date, 584));
  data.spx.push({ ...data.spx[13] });
  assert.equal(data.spx.length, 20);
  const result = buildEmaRetest(data, data.asOf);
  assert.equal(result.status, "unavailable");
  assert.equal(result.bars.length, 1);
});

test("a gap requires eight new complete candles and cannot be bridged by prior warmup", () => {
  const data = fixture([bullish[0], 101, ...Array(8).fill(100)]);
  data.spx = data.spx.filter((bar) => bar.timestamp !== stamp(date, 584));
  const seven = buildEmaRetest(data, 659);
  assert.equal(seven.status, "warming");
  assert.equal(seven.ema, null);
  assert.equal(seven.warmup.bars, 7);
  assert.equal(seven.warmup.seededFromPrior, false);
  const eight = buildEmaRetest(data, 669);
  assert.equal(eight.status, "ready");
  assert.equal(eight.ema, 100);
  assert.equal(eight.warmup.priorBars, 0);
  assert.equal(eight.history.length, 1, "the newly seeded EMA must not manufacture another cross");
});

test("a prior-session partial or duplicate final bucket resets rather than warming today's open", () => {
  for (const duplicate of [false, true]) {
    const data = fixture(bullish);
    if (duplicate) data.priorSpx.push({ ...data.priorSpx.at(-1) });
    else data.priorSpx.pop();
    const result = buildEmaRetest(data, data.asOf);
    assert.equal(result.status, "warming");
    assert.equal(result.ema, null);
    assert.equal(result.warmup.bars, 2);
    assert.equal(result.warmup.priorBars, 0);
    assert.equal(result.history.length, 0);
  }
});

test("a source gap cancels confirmed continuity instead of inventing a price invalidation", () => {
  const data = fixture([...bullish, 102]);
  data.spx = data.spx.filter((bar) => bar.timestamp !== stamp(date, 594));
  const result = buildEmaRetest(data, data.asOf);
  assert.equal(result.status, "unavailable");
  assert.equal(result.bullish.status, "cancelled");
  assert.equal(result.bullish.episode.retestedAt, 590);
  assert.match(result.bullish.episode.reason, /source minutes/);
});

test("replay cannot use future minute data, later session rows or data beyond asOf", () => {
  const data = fixture([...bullish, 98, 110]);
  const atCross = buildEmaRetest(data, 579);
  const atRetest = buildEmaRetest(data, 589);
  data.spx.push(...series("2026-09-30", [2000, 3000]));
  data.spx.push(...series(previousDate, [1000, 2000]));
  data.spx.push(...series(date, [4000, 5000], 900));
  data.spx.reverse();
  assert.deepEqual(buildEmaRetest(data, 579), atCross);
  assert.deepEqual(buildEmaRetest(data, 589), atRetest);
  data.asOf = 579;
  const delayed = buildEmaRetest(data, 589);
  assert.equal(delayed.asOf, 579);
  assert.equal(delayed.bullish.status, "watching");
  assert.equal(delayed.bullish.episode.retestedAt, null);
  assert.equal(delayed.status, "stale");
});

test("SPX-only freshness permits missing premiums and does not mistake a partial ten-minute candle for stale data", () => {
  const data = fixture([...bullish, 103]);
  const result = buildEmaRetest(data, 595);
  assert.equal(result.status, "ready");
  assert.equal(result.latestBar.endMinute, 590);
  assert.equal(result.freshness.latestMinute, 595);
  assert.equal(result.freshness.ageMinutes, 0);
  assert.equal(result.bullish.status, "confirmed");
  assert.equal(data.quotes.length, 0);
  const staleData = fixture(bullish);
  const stale = buildEmaRetest(staleData, 592);
  assert.equal(stale.status, "stale");
  assert.equal(stale.freshness.ageMinutes, 3);
  assert.equal(stale.bullish.status, "confirmed", "past detection stays inspectable while status suppresses current use");
});

test("level confluence is bounded context frozen at confirmation, with an independent next mapped level", () => {
  assert.equal(EMA_RETEST_LEVEL_TOLERANCE, 2);
  const data = fixture([...bullish, 106]);
  const reference = buildEmaRetest(data, 579).ema;
  const levels = [
    { name: "PDC", low: 100, high: 100 },
    { name: "Edge", low: reference + 2, high: reference + 2 },
    { name: "Outside", low: reference + 2.01, high: reference + 2.01 },
    { name: "Higher", low: 110, high: 111 },
  ];
  const saved = structuredClone(levels);
  const atRetest = buildEmaRetest(data, 589, levels);
  assert.equal(atRetest.bullish.status, "confirmed");
  assert.deepEqual(atRetest.bullish.episode.confluence.map((level) => level.name), ["PDC", "Edge"]);
  assert.equal(atRetest.bullish.episode.target.name, "Edge");
  const later = buildEmaRetest(data, 599, levels);
  assert.deepEqual(later.bullish.episode.confluence, atRetest.bullish.episode.confluence);
  assert.deepEqual(later.bullish.episode.target, atRetest.bullish.episode.target);
  assert.equal(later.levels.above.name, "Higher", "current price map may change without moving the original mapped level");
  assert.deepEqual(levels, saved);
  const noLevels = buildEmaRetest(data, 589);
  assert.equal(noLevels.bullish.status, "confirmed", "level context is not an unstated signal gate");
  assert.deepEqual(noLevels.bullish.episode.confluence, []);
  assert.equal(noLevels.bullish.episode.target, null);
});

test("bearish mapped level lies strictly below confirmation price; overlapping intervals are context", () => {
  const data = fixture(bearish, [...Array(8).fill(100), 101]);
  const result = buildEmaRetest(data, 589, [
    { name: "Overlap", low: 98.8, high: 99.2 },
    { name: "Lower", low: 97, high: 98 },
    { name: "Further", low: 94, high: 95 },
    { name: "Bad", low: 105, high: 103 },
  ]);
  assert.equal(result.bearish.episode.target.name, "Lower");
  assert.deepEqual(result.levels.overlapping.map((level) => level.name), ["Overlap"]);
  assert.equal(result.levels.below.name, "Lower");
  assert.equal(result.levels.above, null);
});

test("ten-minute buckets anchor to the supplied session open, not the wall-clock multiple", () => {
  const data = fixture(bullish);
  data.session = { open: 575, close: 965 };
  data.spx = series(date, bullish, 575);
  data.priorSpx = series(previousDate, [...Array(8).fill(100), 99], 575);
  data.asOf = 594;
  const partial = buildEmaRetest(data, 583);
  assert.equal(partial.status, "warming");
  assert.equal(partial.latestBar, null);
  const result = buildEmaRetest(data, 594);
  assert.equal(result.latestBar.startMinute, 585);
  assert.equal(result.latestBar.endMinute, 595);
  assert.equal(result.bullish.episode.crossedAt, 585);
  assert.equal(result.bullish.episode.retestedAt, 595);
});

test("a new session cannot inherit the previous session's active pattern or post-close bars", () => {
  const data = fixture(bullish);
  const old = buildEmaRetest(data, data.asOf);
  assert.equal(old.bullish.status, "confirmed");
  const next = {
    ...data, date: "2026-09-30", previousDate: date, asOf: 569,
    spx: [], priorSpx: data.spx,
  };
  const fresh = buildEmaRetest(next, 569);
  assert.equal(fresh.status, "premarket");
  assert.equal(fresh.history.length, 0);
  assert.equal(fresh.bullish.status, "idle");
  const short = fixture(bullish);
  short.session.close = 590;
  short.spx.push(...candle(date, 590, 500));
  short.asOf = 599;
  const closed = buildEmaRetest(short, 599);
  assert.equal(closed.asOf, 589);
  assert.equal(closed.bars.length, 2);
  assert.equal(closed.ema, old.ema);
});

test("an exact EMA close cannot restart a same-side watch or hide an already confirmed episode", () => {
  const crossEma = buildEmaRetest(fixture([bullish[0]]), 579).ema;
  const watching = fixture([bullish[0], crossEma, 104]);
  const result = buildEmaRetest(watching, watching.asOf);
  assert.equal(result.bullish.status, "watching");
  assert.equal(result.bullish.episode.crossedAt, 580);
  assert.equal(result.history.length, 1);
  const confirmedEma = buildEmaRetest(fixture(bullish), 589).ema;
  const confirmed = fixture([...bullish, confirmedEma, 104]);
  const second = buildEmaRetest(confirmed, confirmed.asOf);
  assert.equal(second.bullish.status, "confirmed");
  assert.equal(second.bullish.episode.retestedAt, 590);
  assert.equal(second.history.length, 1);
});

test("cash close expires unfinished watches, including a cross first observed on the final candle", () => {
  for (const values of [[bullish[0], 104], [99, bullish[0]]]) {
    const data = fixture(values);
    data.session.close = 590;
    const result = buildEmaRetest(data, data.asOf);
    assert.equal(result.bullish.status, "expired");
    assert.equal(result.bullish.episode.endedAt, 590);
    assert.equal(result.bullish.episode.retestedAt, null);
    assert.match(result.bullish.episode.reason, /session ended/);
  }
  const early = fixture([...Array(20).fill(99), bullish[0]]);
  early.session.close = 780;
  const result = buildEmaRetest(early, early.asOf);
  assert.equal(result.bullish.episode.crossedAt, 780);
  assert.equal(result.bullish.episode.endedAt, 780);
  assert.equal(result.bullish.status, "expired");
});
