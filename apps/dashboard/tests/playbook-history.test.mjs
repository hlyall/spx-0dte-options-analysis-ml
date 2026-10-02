import test from "node:test";
import assert from "node:assert/strict";
import { buildPlaybookHistory } from "../src/core/playbook-history.ts";
import { defaults, readout } from "../src/core/readout.ts";

const date = "2026-09-11";
const previousDate = "2026-09-10";
const stamp = (at, day = date) => `${day}T${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}:00.000`;
const bar = (at, close, day = date) => ({
  timestamp: stamp(at, day), open: close, high: close + 0.1, low: close - 0.1,
  close, volume: 100, vwap: 100,
});
function fixture(premiums = [1, 2, 3, 4, 5, 6, 1, 0.8, 0.6, 9, 10], prices = [107, 107, 107, 107, 107, 107, 94, 94, 100, 107, 107]) {
  return {
    date, previousDate, today: date, mode: "historical", asOf: 959,
    session: { open: 570, close: 960 }, fetchedAt: stamp(960), sources: [],
    spx: premiums.map((_, i) => bar(570 + i, prices[i] * 10)),
    spy: [{ ...bar(569, 100), high: 105, low: 95 }, ...premiums.map((_, i) => bar(570 + i, prices[i]))],
    priorSpy: [{ ...bar(959, 100, previousDate), high: 110, low: 90 }], priorSpyClose: 100,
    priorSpx: [{ ...bar(959, 1000, previousDate), high: 1100, low: 900 }], priorSpxClose: 1000,
    quotes: premiums.map((premium, i) => ({
      timestamp: stamp(570 + i), underlying_timestamp: stamp(570 + i), underlying_price: prices[i] * 10,
      bid: premium, ask: premium, strike: 1200, right: "CALL", symbol: "SPXW", expiration: date,
    })),
    measurement: { strike: 1200, selection: "Selected call" },
    openingIv: null, openingIvTimestamp: null, chain: [], context: [], spot: null,
    parity: { quotes: [], index: [], rate: null },
  };
}
const run = (data, cutoff, settings = defaults) => buildPlaybookHistory(data, cutoff, settings);
const detection = (code, firstDetectedAt, lastDetectedAt) => ({
  code, name: code === "INSIDE-RISE" ? "Price above premarket high" : "Price below premarket low", firstDetectedAt, lastDetectedAt,
});

test("late-open and reload reconstruct earlier playbooks from the selected session", () => {
  const data = fixture();
  const result = run(data, 580);
  assert.deepEqual(result.current, detection("INSIDE-RISE", 579, 580));
  assert.deepEqual(result.previous, detection("INSIDE-FALL", 576, 577));
  assert.deepEqual(result.latest, result.current);
  assert.deepEqual(run(structuredClone(data), 580), result);
});

test("repeated matching samples extend one episode and the first match has no previous", () => {
  const data = fixture();
  const result = run(data, 575);
  assert.deepEqual(result.current, detection("INSIDE-RISE", 574, 575));
  assert.equal(result.previous, null);
  assert.deepEqual(run(data, 575), result);
});

test("a different primary candidate preserves the completed preceding episode", () => {
  const data = fixture();
  const result = run(data, 576);
  assert.equal(result.current.code, readout(data, 576, defaults).active.code);
  assert.deepEqual(result.current, detection("INSIDE-FALL", 576, 576));
  assert.deepEqual(result.previous, detection("INSIDE-RISE", 574, 575));
});

test("no current match retains the newest detection with its actual last matching minute", () => {
  const result = run(fixture(), 578);
  assert.equal(result.current, null);
  assert.deepEqual(result.previous, detection("INSIDE-FALL", 576, 577));
  assert.deepEqual(result.latest, result.previous);
});

test("a no-match sample separates recurrences of the same playbook", () => {
  const data = fixture([1, 2, 3, 4, 5, 6, 7, 8], [107, 107, 107, 107, 107, 100, 107, 107]);
  const result = run(data, 577);
  assert.deepEqual(result.current, detection("INSIDE-RISE", 576, 577));
  assert.deepEqual(result.previous, detection("INSIDE-RISE", 574, 574));
});

test("rewinding replay discards later episodes without requiring reset state", () => {
  const data = fixture();
  run(data, 580);
  assert.deepEqual(run(data, 573), { current: null, previous: null, latest: null });
  assert.deepEqual(run(data, 575).current, detection("INSIDE-RISE", 574, 575));
  assert.equal(run(data, 575).previous, null);
  assert.deepEqual(run(data, 580).previous, detection("INSIDE-FALL", 576, 577));
});

test("future samples and samples beyond data.asOf cannot leak into replay history", () => {
  const data = fixture();
  const expected = run(data, 575);
  data.spx.push(bar(950, 9999)); data.spy.push(bar(950, 999));
  data.quotes.push({ ...data.quotes.at(-1), timestamp: stamp(950), underlying_timestamp: stamp(950), bid: 100, ask: 100 });
  assert.deepEqual(run(data, 575), expected);
  data.asOf = 575;
  assert.deepEqual(run(data, 577).latest, expected.latest);
  assert.equal(run(data, 578).current, null, "asOf does not make stale data current at a later cutoff");
});

test("changing day or measurement contract starts with that scope's samples only", () => {
  const data = fixture();
  run(data, 580);
  assert.deepEqual(run({ ...data, date: "2026-09-14" }, 580), { current: null, previous: null, latest: null });
  assert.deepEqual(run({ ...data, measurement: { ...data.measurement, strike: 1210 } }, 580), { current: null, previous: null, latest: null });
});

test("mixed dates, expiries, rights, symbols and strikes cannot contaminate selected history", () => {
  const data = fixture();
  const expected = run(data, 580);
  data.spx.push(bar(574, 99999, previousDate)); data.spy.push(bar(569, 9999, previousDate));
  for (const changes of [
    { timestamp: stamp(574, previousDate), underlying_timestamp: stamp(574, previousDate) },
    { expiration: previousDate }, { right: "PUT" }, { symbol: "SPX" }, { strike: 1205 },
  ]) data.quotes.push({ ...data.quotes[4], ...changes, bid: 100, ask: 100 });
  assert.deepEqual(run(data, 580), expected);
});

test("settings changes recompute history rather than carrying an old match", () => {
  const data = fixture();
  for (const quote of data.quotes) { quote.bid *= 0.95; quote.ask *= 1.05; }
  assert.ok(run(data, 580).latest);
  assert.deepEqual(run(data, 580, { ...defaults, maxSpread: 0.01 }), { current: null, previous: null, latest: null });
  assert.ok(run(data, 580).latest);
});

test("missing samples never advance detection times and stale readings have no current match", () => {
  const data = fixture([1, 2, 3, 4, 5], [107, 107, 107, 107, 107]);
  assert.deepEqual(run(data, 576).current, detection("INSIDE-RISE", 574, 574));
  const stale = run(data, 590);
  assert.equal(stale.current, null);
  assert.deepEqual(stale.previous, detection("INSIDE-RISE", 574, 574));
  assert.deepEqual(stale.latest, stale.previous);
});

test("partial gaps use readout freshness and stop matching when any required stream is stale", () => {
  for (const stream of ["spx", "spy", "quotes"]) {
    const data = fixture(Array.from({ length: 11 }, (_, i) => i + 1), Array(11).fill(107));
    data[stream] = data[stream].filter((sample) => sample.timestamp <= stamp(574));
    assert.deepEqual(run(data, 576).current, detection("INSIDE-RISE", 574, 576),
      `${stream} remains fresh for the next two actual observations of the other streams`);
    const result = run(data, 580);
    assert.equal(result.current, null);
    assert.deepEqual(result.previous, detection("INSIDE-RISE", 574, 576),
      `${stream} becoming stale cannot advance the last match beyond 576`);
  }
});

test("stale price input and invalid premium or price samples cannot record new detections", () => {
  for (const change of [
    (data) => { data.spx = data.spx.slice(0, 2); },
    (data) => { data.spy = data.spy.slice(0, 3); },
    (data) => { data.quotes[4].ask = 100; },
    (data) => { data.quotes[4].underlying_timestamp = stamp(570); },
    (data) => { data.spx[4].close = NaN; },
  ]) {
    const data = fixture(); change(data);
    assert.deepEqual(run(data, 574), { current: null, previous: null, latest: null });
  }
  const data = fixture(); data.quotes[5].bid = 0;
  const result = run(data, 575);
  assert.equal(result.current, null);
  assert.deepEqual(result.previous, detection("INSIDE-RISE", 574, 574));
});

test("premarket and out-of-session observations cannot originate episodes", () => {
  const data = fixture();
  assert.deepEqual(run(data, 569), { current: null, previous: null, latest: null });
  data.session.close = 576;
  const result = run(data, 960);
  assert.equal(result.current, null);
  assert.deepEqual(result.previous, detection("INSIDE-RISE", 574, 575));
});

test("history construction does not mutate loaded session data", () => {
  const data = fixture();
  data.spx.reverse(); data.spy.reverse(); data.quotes.reverse();
  const original = structuredClone(data);
  assert.deepEqual(run(data, 580).current, detection("INSIDE-RISE", 579, 580));
  assert.deepEqual(data, original);
});
