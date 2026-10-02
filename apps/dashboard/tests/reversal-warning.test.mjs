import test from "node:test";
import assert from "node:assert/strict";
import { advanceReversal, detectedReversalCode, isReversalCode, needsTabAttention, reversalCopy, startTabAttention } from "../src/core/reversal-warning.ts";

const sample = (cutoff = 656, overrides = {}) => ({
  scope: "2026-09-25|7745|live", cutoff, mode: "live", code: "EXT-UP-REBOUND", usable: true, ...overrides,
});
const acknowledge = (state) => ({ ...state, warning: { ...state.warning, acknowledged: true } });

test("each recognized code identifies its candidate direction and the opposite positions to review", () => {
  const expected = {
    "EXT-UP-COOLING": { direction: "bearish", positions: "bullish", candidate: "Bearish transition candidate", transition: "Bullish → bearish", review: "Check bullish positions", detail: "Positive premium z is falling after a prior high reading. This condition does not require a price decline; review bullish exposure." },
    "EXT-UP-FAILURE": { direction: "bearish", positions: "bullish", candidate: "Bearish failure candidate", transition: null, review: "Check bullish positions", detail: "Premium z is below −1, premium slope is negative, and SPY is below its prior high. Further downside is not established; review bullish exposure." },
    "EXT-UP-REBOUND": { direction: "bullish", positions: "bearish", candidate: "Bullish reversal candidate", transition: "Bearish → bullish", review: "Check bearish positions", detail: "Premium z has turned positive and SPY holds above VWAP. A sustained advance is not established; review bearish exposure." },
    "EXT-DOWN-REBOUND": { direction: "bullish", positions: "bearish", candidate: "Bullish reversal candidate", transition: "Bearish → bullish", review: "Check bearish positions", detail: "Negative premium z is recovering and SPY is above its prior low. A sustained advance is not established; review bearish exposure." },
  };
  for (const [code, copy] of Object.entries(expected)) {
    assert.equal(isReversalCode(code), true);
    assert.deepEqual(reversalCopy(code), copy);
    assert.notEqual(copy.direction, copy.positions);
  }
});

test("the primary bearish transition is not overridden by a coexisting earlier bullish recovery", () => {
  const candidates = [
    { code: "EXT-UP-COOLING", matches: true },
    { code: "EXT-UP-REBOUND", matches: true },
    { code: "EXT-UP-FAILURE", matches: false },
  ];
  assert.equal(candidates.find(candidate => candidate.matches).code, "EXT-UP-COOLING");
  const code = detectedReversalCode(candidates);
  assert.equal(code, "EXT-UP-COOLING");
  const state = advanceReversal(null, sample(656, { code }));
  assert.equal(state.current, true);
  assert.equal(state.warning.code, "EXT-UP-COOLING");
  assert.equal(reversalCopy(state.warning.code).direction, "bearish");
  assert.equal(needsTabAttention(state), true);
});

test("warning selection follows matched candidate order without letting unrelated badges hide a warning", () => {
  const cases = [
    [[{ code: "EXT-UP-FAILURE", matches: true }, { code: "EXT-UP-COOLING", matches: true }, { code: "EXT-UP-REBOUND", matches: true }], "EXT-UP-FAILURE"],
    [[{ code: "EXT-UP-REBOUND", matches: true }, { code: "EXT-UP-COOLING", matches: true }], "EXT-UP-REBOUND"],
    [[{ code: "EXT-DOWN-REBOUND", matches: true }, { code: "EXT-UP-FAILURE", matches: true }], "EXT-DOWN-REBOUND"],
    [[{ code: "EXT-DOWN-SELLING", matches: true }, { code: "EXT-UP-COOLING", matches: true }, { code: "EXT-UP-REBOUND", matches: true }], "EXT-UP-COOLING"],
    [[{ code: "EXT-UP-COOLING", matches: false }, { code: "EXT-UP-FAILURE", matches: false }, { code: "EXT-UP-REBOUND", matches: true }], "EXT-UP-REBOUND"],
    [[{ code: "INSIDE-RISE", matches: true }, { code: "EXT-UP-FAILURE", matches: true }], "EXT-UP-FAILURE"],
  ];
  for (const [candidates, expected] of cases) {
    const saved = structuredClone(candidates);
    assert.equal(detectedReversalCode(candidates), expected);
    assert.deepEqual(candidates, saved, "the helper must not reorder the engine's selected candidates");
  }
});

test("an opposite-direction warning starts immediately and resets prior acknowledgment", () => {
  for (const [earlier, next] of [["EXT-UP-REBOUND", "EXT-UP-COOLING"], ["EXT-DOWN-REBOUND", "EXT-UP-FAILURE"], ["EXT-UP-COOLING", "EXT-DOWN-REBOUND"], ["EXT-UP-FAILURE", "EXT-UP-REBOUND"]]) {
    for (const reviewed of [false, true]) {
      const first = advanceReversal(null, sample(656, { code: earlier }));
      const previous = reviewed ? acknowledge(first) : first, saved = structuredClone(previous);
      const opposite = advanceReversal(previous, sample(656, { code: next }));
      assert.equal(opposite.warning.code, next);
      assert.equal(opposite.warning.acknowledged, false);
      assert.notEqual(opposite.warning.id, previous.warning.id);
      assert.equal(opposite.warning.detectedAt, 656, "a direction change does not wait for a new candle or five clear minutes");
      assert.notEqual(reversalCopy(opposite.warning.code).direction, reversalCopy(previous.warning.code).direction);
      assert.equal(needsTabAttention(opposite), true);
      assert.deepEqual(previous, saved, "the earlier side and acknowledgment remain immutable");
    }
  }
});

test("a retained warning keeps its original side when the named candidate disappears", () => {
  for (const code of ["EXT-UP-COOLING", "EXT-UP-FAILURE", "EXT-UP-REBOUND", "EXT-DOWN-REBOUND"]) {
    const first = advanceReversal(null, sample(656, { code }));
    const retained = advanceReversal(first, sample(657, { code: "INSIDE-RISE" }));
    assert.equal(retained.current, false);
    assert.deepEqual(retained.warning, first.warning);
    assert.deepEqual(reversalCopy(retained.warning.code), reversalCopy(code));
    assert.equal(needsTabAttention(retained), true);
    const repeat = advanceReversal(retained, sample(658, { code }));
    assert.equal(repeat.warning.id, first.warning.id);
    assert.equal(repeat.warning.detectedAt, 656);
  }
});

test("stale opposite-side samples preserve earlier warnings and only fresh recovery can change direction", () => {
  for (const [firstCode, oppositeCode] of [["EXT-UP-REBOUND", "EXT-UP-COOLING"], ["EXT-UP-FAILURE", "EXT-DOWN-REBOUND"]]) {
    const staleOrigin = advanceReversal(null, sample(655, { code: oppositeCode, usable: false }));
    assert.equal(staleOrigin.warning, null);
    const first = acknowledge(advanceReversal(staleOrigin, sample(656, { code: firstCode })));
    const staleOpposite = advanceReversal(first, sample(657, { code: oppositeCode, usable: false }));
    assert.deepEqual(staleOpposite.warning, first.warning);
    assert.equal(staleOpposite.current, false);
    assert.equal(needsTabAttention(staleOpposite), false);
    const freshOpposite = advanceReversal(staleOpposite, sample(658, { code: oppositeCode }));
    assert.equal(freshOpposite.warning.code, oppositeCode);
    assert.equal(freshOpposite.warning.acknowledged, false);
    assert.equal(needsTabAttention(freshOpposite), true);
  }
});

test("reversal detection requires a match and recognizes EXT-DOWN-REBOUND", () => {
  for (const candidates of [
    [],
    [{ code: "EXT-UP-COOLING", matches: false }, { code: "EXT-UP-REBOUND", matches: false }],
    [{ code: "EXT-DOWN-REBOUND", matches: false }, { code: "EXT-DOWN-RECOVERY", matches: true }],
  ]) {
    const code = detectedReversalCode(candidates);
    assert.equal(code, null);
    const state = advanceReversal(null, sample(656, { code }));
    assert.equal(state.warning, null);
    assert.equal(needsTabAttention(state), false);
  }
  const code = detectedReversalCode([
    { code: "EXT-DOWN-SELLING", matches: false },
    { code: "EXT-DOWN-REBOUND", matches: true },
    { code: "EXT-DOWN-RECOVERY", matches: true },
  ]);
  assert.equal(code, "EXT-DOWN-REBOUND");
  const state = advanceReversal(null, sample(656, { code }));
  assert.equal(state.current, true);
  assert.equal(needsTabAttention(state), true);
});

test("both directions warn on detection before a new entry is cleared", () => {
  for (const code of ["EXT-UP-COOLING", "EXT-UP-FAILURE", "EXT-UP-REBOUND", "EXT-DOWN-REBOUND"]) {
    const state = advanceReversal(null, sample(656, { code, allChecks: false, executionPassed: false }));
    assert.equal(state.current, true);
    assert.equal(state.warning.code, code);
    assert.equal(state.warning.acknowledged, false);
    assert.equal(needsTabAttention(state), true);
  }
  for (const code of [null, "EXT-DOWN-RECOVERY", "EXT-DOWN-SELLING", "INSIDE-RISE", "UNKNOWN-PATTERN"]) {
    assert.equal(isReversalCode(code), false);
    assert.equal(advanceReversal(null, sample(656, { code })).warning, null);
  }
  assert.equal(needsTabAttention(null), false);
});

test("a short-lived candidate leaves an unreviewed warning to inspect", () => {
  const first = advanceReversal(null, sample());
  const saved = structuredClone(first);
  const gone = advanceReversal(first, sample(657, { code: "UNKNOWN-PATTERN" }));
  assert.deepEqual(first, saved, "advancing must not mutate the previous render's state");
  assert.equal(gone.current, false);
  assert.deepEqual(gone.warning, first.warning);
  assert.equal(needsTabAttention(gone), true);
  const muchLater = advanceReversal(gone, sample(675));
  assert.equal(muchLater.warning.id, first.warning.id, "an unreviewed episode is retained across a long disappearance");
});

test("acknowledgment survives repeat polls and a brief candidate flicker", () => {
  let state = acknowledge(advanceReversal(null, sample()));
  const id = state.warning.id;
  for (const minute of [656, 656, 657]) state = advanceReversal(state, sample(minute));
  state = advanceReversal(state, sample(658, { code: null }));
  state = advanceReversal(state, sample(659, { code: "UNKNOWN-PATTERN" }));
  state = advanceReversal(state, sample(660));
  assert.equal(state.warning.id, id);
  assert.equal(state.warning.acknowledged, true);
  assert.equal(state.current, true);
  assert.equal(needsTabAttention(state), false);
});

test("five completed fresh no-match minutes rearm a reviewed episode on recurrence", () => {
  const initial = acknowledge(advanceReversal(null, sample(650)));
  let state = initial;
  for (let minute = 651; minute <= 655; minute++) {
    state = advanceReversal(state, sample(minute, { code: null }));
    assert.equal(state.warning.id, initial.warning.id);
    assert.equal(needsTabAttention(state), false);
  }
  state = advanceReversal(state, sample(656));
  assert.notEqual(state.warning.id, initial.warning.id);
  assert.equal(state.warning.detectedAt, 656);
  assert.equal(state.warning.acknowledged, false);
  assert.equal(needsTabAttention(state), true);

  let short = initial;
  for (let minute = 651; minute <= 654; minute++) short = advanceReversal(short, sample(minute, { code: null }));
  short = advanceReversal(short, sample(655));
  assert.equal(short.warning.id, initial.warning.id, "four no-match minutes are insufficient");
});

test("stale observations cannot originate an alert or erase an existing warning", () => {
  const staleFirst = advanceReversal(null, sample(656, { usable: false }));
  assert.equal(staleFirst.warning, null);
  assert.equal(staleFirst.current, false);
  assert.equal(needsTabAttention(staleFirst), false);
  const first = advanceReversal(staleFirst, sample(657));
  assert.equal(first.warning.detectedAt, 657);
  const stale = advanceReversal(first, sample(658, { usable: false }));
  assert.equal(stale.warning.id, first.warning.id);
  assert.equal(stale.current, false);
  assert.equal(needsTabAttention(stale), false);
  const recovered = advanceReversal(stale, sample(659));
  assert.equal(recovered.warning.id, first.warning.id);
  assert.equal(needsTabAttention(recovered), true);
});

test("a stale gap does not count as fresh evidence that an acknowledged candidate disappeared", () => {
  let state = acknowledge(advanceReversal(null, sample(650)));
  const id = state.warning.id;
  for (let minute = 651; minute <= 658; minute++) state = advanceReversal(state, sample(minute, { usable: false, code: null }));
  state = advanceReversal(state, sample(659));
  assert.equal(state.warning.id, id);
  assert.equal(state.warning.acknowledged, true);
  assert.equal(needsTabAttention(state), false);
});

test("missing polls cannot establish five observed no-match minutes", () => {
  const initial = acknowledge(advanceReversal(null, sample(650)));
  const later = advanceReversal(initial, sample(660));
  assert.equal(later.warning.id, initial.warning.id);
  assert.equal(later.warning.acknowledged, true);
});

test("repeated polls of one nonmatching minute cannot rearm an acknowledged warning", () => {
  let state = acknowledge(advanceReversal(null, sample(650)));
  const id = state.warning.id;
  for (let poll = 0; poll < 8; poll++) state = advanceReversal(state, sample(651, { code: null }));
  state = advanceReversal(state, sample(652));
  assert.equal(state.warning.id, id);
  assert.equal(state.warning.acknowledged, true);
});

test("a missing or stale minute breaks the fresh no-match streak", () => {
  for (const gap of ["missing", "stale"]) {
    let state = acknowledge(advanceReversal(null, sample(650)));
    const id = state.warning.id;
    for (let minute = 651; minute <= 653; minute++) state = advanceReversal(state, sample(minute, { code: null }));
    if (gap === "stale") state = advanceReversal(state, sample(654, { code: null, usable: false }));
    for (let minute = 655; minute <= 657; minute++) state = advanceReversal(state, sample(minute, { code: null }));
    state = advanceReversal(state, sample(658));
    assert.equal(state.warning.id, id, `${gap} data cannot bridge the two short no-match runs`);
    assert.equal(state.warning.acknowledged, true);
  }
});

test("scope changes and backward replay discard future warnings and acknowledgments", () => {
  const later = acknowledge(advanceReversal(null, sample(670, { mode: "replay", scope: "replay:day-a" })));
  const back = advanceReversal(later, sample(650, { mode: "replay", scope: "replay:day-a", code: null }));
  assert.equal(back.warning, null);
  assert.equal(back.lastMatch, null);
  assert.equal(back.current, false);
  const forward = advanceReversal(back, sample(656, { mode: "replay", scope: "replay:day-a" }));
  assert.equal(forward.warning.detectedAt, 656);
  assert.equal(forward.warning.acknowledged, false);
  const changedScope = advanceReversal(forward, sample(680, { scope: "different-contract", code: null }));
  assert.equal(changedScope.warning, null);
  assert.equal(changedScope.lastMatch, null);
});

test("replay and historical previews never request live tab attention", () => {
  for (const code of ["EXT-UP-COOLING", "EXT-UP-FAILURE", "EXT-UP-REBOUND", "EXT-DOWN-REBOUND"]) for (const mode of ["replay", "historical"]) {
    const live = advanceReversal(null, sample(656, { code }));
    assert.equal(needsTabAttention(live), true);
    let state = advanceReversal(live, sample(656, { code, mode, scope: `2026-09-25|7745|${mode}` }));
    assert.equal(state.warning.mode, mode);
    assert.equal(state.current, true);
    assert.equal(needsTabAttention(state), false);
    assert.equal(reversalCopy(state.warning.code).direction, reversalCopy(code).direction);
    state = advanceReversal(state, sample(657, { mode, scope: state.scope, code: null }));
    assert.ok(state.warning);
    assert.equal(needsTabAttention(state), false);
  }
});

function fakeBrowser({ hidden = false, reducedMotion = false } = {}) {
  let title = "0DTE OS";
  const listeners = new Set();
  const timers = new Set();
  const periods = [];
  const writes = [];
  return {
    port: {
      hidden: () => hidden,
      title: () => title,
      setTitle: (next) => { title = next; writes.push(next); },
      reducedMotion: () => reducedMotion,
      onVisibility: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      every: (listener, ms) => { timers.add(listener); periods.push(ms); return () => timers.delete(listener); },
    },
    visibility(next) { hidden = next; for (const listener of [...listeners]) listener(); },
    tick() { for (const timer of [...timers]) timer(); },
    get title() { return title; },
    get timerCount() { return timers.size; },
    get listenerCount() { return listeners.size; },
    periods,
    writes,
  };
}

test("tab attention starts only when hidden and stops flashing immediately when visible", () => {
  const browser = fakeBrowser();
  let hiddenCalls = 0;
  const stop = startTabAttention(browser.port, "Warning", () => hiddenCalls++);
  assert.equal(browser.title, "0DTE OS");
  assert.equal(browser.timerCount, 0);
  assert.equal(browser.listenerCount, 1);
  assert.equal(hiddenCalls, 0);
  browser.visibility(true);
  assert.equal(browser.title, "Warning");
  assert.equal(browser.timerCount, 1);
  assert.equal(hiddenCalls, 1);
  assert.deepEqual(browser.periods, [1500]);
  browser.tick(); assert.equal(browser.title, "0DTE OS");
  browser.tick(); assert.equal(browser.title, "Warning");
  browser.visibility(false);
  assert.equal(browser.title, "0DTE OS");
  assert.equal(browser.timerCount, 0);
  browser.tick(); assert.equal(browser.title, "0DTE OS");
  browser.visibility(true);
  assert.equal(browser.timerCount, 1);
  assert.equal(hiddenCalls, 2, "episode-level desktop deduplication belongs to the caller");
  stop();
  assert.equal(browser.title, "0DTE OS");
  assert.equal(browser.timerCount, 0);
  assert.equal(browser.listenerCount, 0);
  browser.visibility(true); browser.tick();
  assert.equal(browser.title, "0DTE OS");
  assert.equal(hiddenCalls, 2);
});

test("reduced motion keeps a steady hidden-tab warning with no animation timer", () => {
  const browser = fakeBrowser({ hidden: true, reducedMotion: true });
  let hiddenCalls = 0;
  const stop = startTabAttention(browser.port, "Warning", () => hiddenCalls++);
  assert.equal(browser.title, "Warning");
  assert.equal(browser.timerCount, 0);
  assert.equal(hiddenCalls, 1);
  browser.tick(); assert.equal(browser.title, "Warning");
  browser.visibility(false); assert.equal(browser.title, "0DTE OS");
  stop();
  assert.equal(browser.listenerCount, 0);
  assert.equal(browser.title, "0DTE OS");
});

test("repeated visibility events replace timers and cleanup restores the original title", () => {
  const browser = fakeBrowser({ hidden: true });
  const stop = startTabAttention(browser.port, "Warning", () => {});
  browser.visibility(true); browser.visibility(true);
  assert.equal(browser.timerCount, 1);
  browser.tick(); assert.equal(browser.title, "0DTE OS");
  stop();
  assert.equal(browser.timerCount, 0);
  assert.equal(browser.listenerCount, 0);
  assert.equal(browser.title, "0DTE OS");
  const count = browser.writes.length;
  browser.tick(); browser.visibility(false);
  assert.equal(browser.writes.length, count, "disposed callbacks cannot overwrite later page titles");
});
