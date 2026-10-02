export type WarningMode = "live" | "replay" | "historical";
export type ReversalCode = "EXT-UP-COOLING" | "EXT-UP-FAILURE" | "EXT-UP-REBOUND" | "EXT-DOWN-REBOUND";
export type ReversalCopy = {
  direction: "bullish" | "bearish";
  positions: "bullish" | "bearish";
  candidate: string;
  transition: string | null;
  review: string;
  detail: string;
};
export type ReversalSample = {
  scope: string;
  cutoff: number;
  mode: WarningMode;
  code: string | null;
  usable: boolean;
};
export type ReversalWarning = {
  id: string;
  code: ReversalCode;
  detectedAt: number;
  mode: WarningMode;
  acknowledged: boolean;
};
export type ReversalState = {
  scope: string;
  cutoff: number;
  warning: ReversalWarning | null;
  lastMatch: number | null;
  clearMinutes: number;
  lastClearMinute: number | null;
  current: boolean;
  usable: boolean;
};

export function isReversalCode(code: string | null): code is ReversalCode {
  return code === "EXT-UP-COOLING" || code === "EXT-UP-FAILURE" || code === "EXT-UP-REBOUND" || code === "EXT-DOWN-REBOUND";
}

/** Candidate direction describes a warning, never confirmed price follow-through. */
export function reversalCopy(code: ReversalCode): ReversalCopy {
  if (code === "EXT-UP-COOLING") return {
    direction: "bearish", positions: "bullish", candidate: "Bearish transition candidate",
    transition: "Bullish → bearish", review: "Check bullish positions",
    detail: "Positive premium z is falling after a prior high reading. This condition does not require a price decline; review bullish exposure.",
  };
  if (code === "EXT-UP-FAILURE") return {
    direction: "bearish", positions: "bullish", candidate: "Bearish failure candidate",
    transition: null, review: "Check bullish positions",
    detail: "Premium z is below −1, premium slope is negative, and SPY is below its prior high. Further downside is not established; review bullish exposure.",
  };
  return {
    direction: "bullish", positions: "bearish", candidate: "Bullish reversal candidate",
    transition: "Bearish → bullish", review: "Check bearish positions",
    detail: code === "EXT-UP-REBOUND"
      ? "Premium z has turned positive and SPY holds above VWAP. A sustained advance is not established; review bearish exposure."
      : "Negative premium z is recovering and SPY is above its prior low. A sustained advance is not established; review bearish exposure.",
  };
}

/** Preserve selected candidate order; skip only unmatched or unrelated patterns. */
export function detectedReversalCode(candidates: readonly { code: string; matches: boolean }[]): ReversalCode | null {
  for (const candidate of candidates) {
    if (candidate.matches && isReversalCode(candidate.code)) return candidate.code;
  }
  return null;
}

/** Entry eligibility never suppresses a position-review warning. */
export function advanceReversal(previous: ReversalState | null, sample: ReversalSample): ReversalState {
  const reset = !previous || previous.scope !== sample.scope || sample.cutoff < previous.cutoff;
  const state: ReversalState = reset
    ? { scope: sample.scope, cutoff: sample.cutoff, warning: null, lastMatch: null, clearMinutes: 0, lastClearMinute: null, current: false, usable: sample.usable }
    : { ...previous, cutoff: sample.cutoff, usable: sample.usable };
  state.current = sample.usable && isReversalCode(sample.code);
  if (!sample.usable) {
    state.clearMinutes = 0;
    state.lastClearMinute = null;
    return state;
  }
  if (!state.current || !isReversalCode(sample.code)) {
    if (state.lastClearMinute !== sample.cutoff) {
      state.clearMinutes = state.lastClearMinute === sample.cutoff - 1 ? state.clearMinutes + 1 : 1;
      state.lastClearMinute = sample.cutoff;
    }
    return state;
  }
  // Retain an unreviewed warning when the short-lived pattern disappears.
  // After acknowledgment, require five completed minutes without a match to rearm.
  const newEpisode = !state.warning || state.warning.code !== sample.code ||
    (state.warning.acknowledged && state.clearMinutes >= 5);
  if (newEpisode) state.warning = {
    id: `${sample.scope}:${sample.code}:${sample.cutoff}`,
    code: sample.code,
    detectedAt: sample.cutoff,
    mode: sample.mode,
    acknowledged: false,
  };
  state.lastMatch = sample.cutoff;
  state.clearMinutes = 0;
  state.lastClearMinute = null;
  return state;
}

export function needsTabAttention(state: ReversalState | null) {
  return !!state?.usable && state.warning?.mode === "live" && !state.warning.acknowledged;
}

/** A small browser adapter keeps notification cleanup and visibility behavior testable. */
export type AttentionBrowser = {
  hidden: () => boolean;
  title: () => string;
  setTitle: (title: string) => void;
  reducedMotion: () => boolean;
  onVisibility: (listener: () => void) => () => void;
  every: (listener: () => void, ms: number) => () => void;
};

export function startTabAttention(browser: AttentionBrowser, title: string, onHidden: () => void) {
  const original = browser.title();
  let cancelTimer: (() => void) | undefined;
  const sync = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    browser.setTitle(original);
    if (!browser.hidden()) return;
    browser.setTitle(title);
    onHidden();
    if (browser.reducedMotion()) return;
    let showingWarning = true;
    cancelTimer = browser.every(() => {
      showingWarning = !showingWarning;
      browser.setTitle(showingWarning ? title : original);
    }, 1500);
  };
  const removeListener = browser.onVisibility(sync);
  sync();
  return () => {
    cancelTimer?.();
    removeListener();
    browser.setTitle(original);
  };
}
