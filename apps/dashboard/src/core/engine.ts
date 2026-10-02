export type Bar = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  sessionVwap?: number | null;
  rvol?: number | null;
  rvolBaselineBars?: number;
};
export type Quote = {
  timestamp: string;
  underlying_timestamp?: string;
  underlying_price?: number;
  bid: number;
  ask: number;
  strike: number;
  right: string;
  expiration: string;
  symbol: string;
  implied_vol?: number;
  gamma?: number;
  delta?: number;
  theta?: number;
  open_interest?: number;
  iv_error?: number;
};
export type PremiumPoint = {
  timestamp: string;
  time: string;
  underlying: number;
  mid: number;
  extrinsic: number;
  z: number | null;
  slope: number | null;
  iv: number | null;
  spread: number;
  valid: boolean;
  baselineBars: number;
  slopeBars: number;
};
export const OPENING_WARMUP_BARS = 5;
export function premiumBaselineLabel(point: PremiumPoint | undefined, lookback: number) {
  const bars = point?.baselineBars ?? 0;
  return bars < OPENING_WARMUP_BARS ? `Warmup · ${bars}/${OPENING_WARMUP_BARS} valid bars`
    : bars < lookback ? `Expanding baseline · ${bars}/${lookback} bars`
      : `Rolling baseline · ${bars} bars`;
}
export type Levels = {
  high: number;
  low: number;
  close: number;
  pmHigh: number | null;
  pmLow: number | null;
};
export const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
export const mean = (a: number[]) =>
  a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
export const minute = (s: string) =>
  Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
export const time = (s: string) => s.slice(11, 16);
export const rth = (bars: Bar[], close = 960) =>
  bars.filter((b) => minute(b.timestamp) >= 570 && minute(b.timestamp) < close);
export function classifyRegime(l: Levels) {
  const { high: h, low: l0, pmHigh: ph, pmLow: pl } = l;
  if (![h, l0, ph, pl].every(finite) || h <= l0 || ph! < pl!)
    return {
      code: "—",
      name: "Premarket unavailable",
      why: "A valid premarket range and prior session are required.",
    };
  if (pl! > h)
    return {
      code: "GAP-UP",
      name: "Gap above prior range",
      why: "The entire premarket range is above the prior high.",
    };
  if (ph! < l0)
    return {
      code: "GAP-DOWN",
      name: "Gap below prior range",
      why: "The entire premarket range is below the prior low.",
    };
  if (ph! > h && pl! < l0)
    return {
      code: "TWO-SIDED",
      name: "Two-sided range expansion",
      why: "SPY premarket includes prices above the prior high and below the prior low.",
    };
  if (ph! > h)
    return {
      code: "EXT-UP",
      name: "Upper range extension",
      why: "SPY premarket reaches above the prior high; its low remains inside the prior range.",
    };
  if (pl! < l0)
    return {
      code: "EXT-DOWN",
      name: "Lower range extension",
      why: "SPY premarket reaches below the prior low; its high remains inside the prior range.",
    };
  return {
    code: "INSIDE",
    name: "Inside prior range",
    why: "Both SPY premarket endpoints lie within the prior session high and low.",
  };
}
export function addParticipation(bars: Bar[]) {
  const history: number[] = [];
  return bars.map((b, i) => {
    // ThetaData supplies cumulative VWAP, anchored to the request's start_time.
    // The adapter requests regular-session bars separately from premarket.
    if (i && Date.parse(b.timestamp + "Z") - Date.parse(bars[i - 1].timestamp + "Z") !== 60000)
      history.length = 0;
    const valid = finite(b.volume) && b.volume >= 0;
    if (!valid) history.length = 0;
    const priorBars = history.length;
    const baseline = priorBars >= OPENING_WARMUP_BARS - 1 ? mean(history) : null;
    if (valid) history.push(b.volume);
    if (history.length > 20) history.shift();
    return {
      ...b,
      sessionVwap: finite(b.vwap) && b.vwap > 0 ? b.vwap : null,
      rvol: baseline && baseline > 0 ? b.volume / baseline : null,
      rvolBaselineBars: priorBars,
    };
  });
}
export function regression(a: number[]) {
  if (a.length < 2) return null;
  const center = (a.length - 1) / 2,
    avg = mean(a)!;
  return (
    a.reduce((s, y, i) => s + (i - center) * (y - avg), 0) /
    a.reduce((s, _, i) => s + (i - center) ** 2, 0)
  );
}
export function premiumSeries(
  quotes: Quote[],
  lookback = 60,
  slopeBars = 3,
  maxSpread = 0.25,
): PremiumPoint[] {
  const history: number[] = [];
  const window = Math.max(OPENING_WARMUP_BARS, lookback);
  let previousTimestamp: string | null = null;
  return [...quotes]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((q) => {
      const mid = (q.bid + q.ask) / 2;
      const underlying = q.underlying_price ?? NaN;
      const intrinsic =
        q.right.toUpperCase() === "CALL"
          ? Math.max(0, underlying - q.strike)
          : Math.max(0, q.strike - underlying);
      const ex = mid - intrinsic,
        spread = mid > 0 ? (q.ask - q.bid) / mid : Infinity;
      const synced =
        !!q.underlying_timestamp &&
        Math.abs(
          Date.parse(q.timestamp + "Z") -
            Date.parse(q.underlying_timestamp + "Z"),
        ) <= 60000;
      if (
        previousTimestamp &&
        Date.parse(q.timestamp + "Z") - Date.parse(previousTimestamp + "Z") !==
          60000
      )
        history.length = 0;
      previousTimestamp = q.timestamp;
      const valid =
        finite(ex) &&
        underlying > 0 &&
        q.bid > 0 &&
        q.ask >= q.bid &&
        spread <= maxSpread &&
        ex >= -0.05 &&
        synced;
      if (!valid)
        history.length = 0; // A gap cannot masquerade as consecutive one-minute evidence.
      else history.push(Math.max(0, ex));
      const sample = history.slice(-window),
        avg = mean(sample);
      const sd =
        avg !== null
          ? Math.sqrt(
              sample.reduce((s, x) => s + (x - avg) ** 2, 0) / sample.length,
            )
          : 0;
      const z =
        valid && sample.length >= OPENING_WARMUP_BARS && sd > 1e-8
          ? (Math.max(0, ex) - avg!) / sd
          : null;
      return {
        timestamp: q.timestamp,
        time: time(q.timestamp),
        underlying,
        mid,
        extrinsic: valid ? Math.max(0, ex) : NaN,
        z,
        slope:
          history.length >= OPENING_WARMUP_BARS
            ? regression(history.slice(-slopeBars))
            : null,
        baselineBars: sample.length,
        slopeBars: Math.min(history.length, slopeBars),
        iv:
          finite(q.implied_vol) &&
          q.implied_vol > 0 &&
          Math.abs(q.iv_error ?? 0) < 0.05
            ? q.implied_vol
            : null,
        spread,
        valid,
      };
    });
}
export function dayType(bars: Bar[], levels: Levels, confirming = 2) {
  const ph = levels.pmHigh,
    pl = levels.pmLow;
  if (ph === null || pl === null)
    return {
      name: "Developing",
      detail:
        "Waiting for premarket structure and completed regular-session bars.",
      pmr: null,
      side: "neutral",
    };
  if (!bars.length)
    return {
      name: "Developing",
      detail: "Premarket structure is still forming.",
      pmr: ((ph - pl) / (levels.high - levels.low)) * 100,
      side: "neutral",
    };
  const pmr = ((ph - pl) / (levels.high - levels.low)) * 100;
  let firstBreak: Bar | undefined,
    side = "neutral";
  for (let i = confirming - 1; i < bars.length; i++) {
    const span = bars.slice(i - confirming + 1, i + 1);
    if (span.every((b) => b.close > ph) || span.every((b) => b.close < pl)) {
      firstBreak = bars[i];
      side = span[0].close > ph ? "bull" : "bear";
      break;
    }
  }
  const tol = (ph - pl) * 0.025;
  // Count separate visits, never adjacent candles as separate tests.
  const visits = (test: (b: Bar) => boolean) =>
    bars.reduce(
      (s, b, i) => s + (test(b) && (!i || !test(bars[i - 1])) ? 1 : 0),
      0,
    );
  if (pmr <= 30 && firstBreak && minute(firstBreak.timestamp) < 600)
    return {
      name: `Double distribution / trend`,
      detail: `Narrow PMR; ${side === "bull" ? "upside" : "downside"} acceptance in the first 30 minutes. Developing classification.`,
      pmr,
      side,
    };
  if (pmr > 30 && pmr < 70 && firstBreak && minute(firstBreak.timestamp) >= 600)
    return {
      name: "Expanded typical",
      detail: "Mid-sized PMR; later acceptance beyond the premarket balance.",
      pmr,
      side,
    };
  if (
    !firstBreak &&
    visits((b) => b.high >= ph - tol) >= 2 &&
    visits((b) => b.low <= pl + tol) >= 2
  )
    return {
      name: "Trading range",
      detail: "Both premarket boundaries have been revisited; no qualifying break has occurred.",
      pmr,
      side: "neutral",
    };
  if (pmr >= 70 && !firstBreak)
    return {
      name: "Typical / contained",
      detail:
        "Wide premarket range; the regular session remains within its extremes.",
      pmr,
      side: "neutral",
    };
  return {
    name: "Sideways / indecisive",
    detail: "No complete day-type signature yet. Require clear structure.",
    pmr,
    side: "neutral",
  };
}
export function posture(points: PremiumPoint[]) {
  const p = points.at(-1),
    zs = points.filter((x) => x.z !== null),
    recent = zs.slice(-10);
  if (!p?.valid || p.z === null || p.slope === null)
    return {
      name: p?.valid && p.baselineBars >= OPENING_WARMUP_BARS && p.z === null ? "No premium variation" : "Warming up",
      detail: p?.valid && p.baselineBars >= OPENING_WARMUP_BARS && p.z === null
        ? "Premium is flat across the current baseline; a z-score needs nonzero variation."
        : "Readings begin after five consecutive valid one-minute observations, then expand toward the selected lookback.",
      phase: "unknown",
      z: null,
      slope: p?.slope ?? null,
      shape: p?.valid && p.baselineBars >= OPENING_WARMUP_BARS && p.z === null ? "Flat premium baseline" : "Insufficient baseline",
    };
  const z = p.z,
    slope = p.slope;
  const prior = zs.slice(-30, -3),
    high = Math.max(...prior.map((x) => x.z!)),
    low = Math.min(...prior.map((x) => x.z!));
  const trend = recent.length >= 5 ? regression(recent.map((x) => x.z!))! : 0;
  const positiveDecay = high >= 2 && z > 0 && trend < -0.025;
  const negativeRecovery = low <= -2 && z < 0 && trend > 0.025;
  const phase = positiveDecay
    ? "positive-decay"
    : negativeRecovery
      ? "negative-recovery"
      : slope > 0.005
        ? "expansion"
        : slope < -0.005
          ? "compression"
          : "balanced";
  return {
    name: positiveDecay
      ? "Positive premium z-score falling"
      : negativeRecovery
        ? "Negative premium z-score rising"
        : slope > 0.005
          ? "Extrinsic expanding"
          : slope < -0.005
            ? "Extrinsic compressing"
            : "Balanced premium",
    phase,
    z,
    slope,
    shape: positiveDecay
      ? "Positive z with a falling recent trend"
      : negativeRecovery
        ? "Negative z with a rising recent trend"
        : "Neither premium recovery condition is met",
    detail: positiveDecay
      ? "A prior z-score reached +2 or higher; z remains positive while its recent regression slope is below −0.025 per observation."
      : negativeRecovery
        ? "A prior z-score reached −2 or lower; z remains negative while its recent regression slope is above +0.025 per observation."
        : "Read premium direction together with price. Z-score alone is not directional.",
  };
}
export function confirmation(
  bars: Bar[],
  points: PremiumPoint[],
  threshold = 1,
  confirming = 2,
  rvolThreshold = 1.2,
) {
  const p = points.at(-1),
    last = bars.at(-1),
    span = bars.slice(-confirming),
    state = posture(points);
  const above =
    span.length === confirming &&
    span.every(
      (b, i) =>
        i === 0 || minute(b.timestamp) - minute(span[i - 1].timestamp) === 1,
    ) &&
    span.every((b) => finite(b.sessionVwap) && b.close > b.sessionVwap!);
  const below =
    span.length === confirming &&
    span.every(
      (b, i) =>
        i === 0 || minute(b.timestamp) - minute(span[i - 1].timestamp) === 1,
    ) &&
    span.every((b) => finite(b.sessionVwap) && b.close < b.sessionVwap!);
  const crosses = bars
    .slice(-15)
    .reduce(
      (s, b, i, a) =>
        i &&
        finite(b.sessionVwap) &&
        finite(a[i - 1].sessionVwap) &&
        (b.close - b.sessionVwap!) * (a[i - 1].close - a[i - 1].sessionVwap!) <
          0
          ? s + 1
          : s,
      0,
    );
  const normalization = ["positive-decay", "negative-recovery"].includes(
    state.phase,
  );
  const direction =
    p?.z !== null && p?.z !== undefined && !normalization && crosses < 4
      ? above && p.z >= threshold
        ? "long"
        : below && p.z <= -threshold
          ? "short"
          : "neutral"
      : "neutral";
  return {
    direction,
    above,
    below,
    crosses,
    normalization,
    participation: finite(last?.rvol) && last!.rvol! >= rvolThreshold,
    rvol: last?.rvol ?? null,
    structure: above
      ? "Accepted above SPY VWAP"
      : below
        ? "Accepted below SPY VWAP"
        : "VWAP acceptance unconfirmed",
  };
}
export const directionLabel = (side: string) =>
  side === "long" ? "Bullish"
    : side === "short" ? "Bearish"
      : side === "both" ? "Bullish → Bearish" : "Neutral";

export const PLAYBOOK = [
  {
    code: "INSIDE-RISE",
    regime: "INSIDE",
    name: "Price above premarket high",
    side: "long",
    type: "Momentum",
    signature: "SPY closes above its premarket high; premium z is positive and extrinsic-premium slope is positive.",
    trigger: "Execution also needs the configured consecutive SPY closes above VWAP and positive z threshold. Relative volume is displayed separately.",
    invalidation: "Candidate ends if price returns to or below the premarket high, z is nonpositive, or premium slope is nonpositive.",
  },
  {
    code: "INSIDE-FALL",
    regime: "INSIDE",
    name: "Price below premarket low",
    side: "short",
    type: "Momentum",
    signature: "SPY closes below its premarket low; premium z is negative and extrinsic-premium slope is negative.",
    trigger: "Execution also needs the configured consecutive SPY closes below VWAP and negative z threshold. Relative volume is displayed separately.",
    invalidation: "Candidate ends if price returns to or above the premarket low, z is nonnegative, or premium slope is nonnegative.",
  },
  {
    code: "INSIDE-SELLING",
    regime: "INSIDE",
    name: "Lower price with premium recovery",
    side: "short",
    type: "Momentum",
    signature: "SPY is below its premarket low while negative premium z is recovering from a prior reading at or below −2.",
    trigger: "This combination flags a bearish candidate, but its premium-recovery phase keeps the separate momentum gate neutral.",
    invalidation: "Candidate ends when SPY is no longer below the premarket low or the negative-premium recovery condition ends.",
  },
  {
    code: "EXT-UP-COOLING",
    regime: "EXT-UP",
    name: "Positive premium z-score fading",
    side: "both",
    type: "Anticipation",
    signature: "A prior premium z reached at least +2; current z stays positive and its recent trend falls below −0.025 per observation.",
    trigger: "Warning appears on detection. Separate execution confirmation needs a recent downward crossing of the prior SPY high and the configured closes below it.",
    invalidation: "Candidate ends when the positive-premium cooling condition ends. A price hold above the prior high prevents bearish execution confirmation.",
  },
  {
    code: "EXT-UP-REBOUND",
    regime: "EXT-UP",
    name: "Premium turns positive above VWAP",
    side: "long",
    type: "Anticipation",
    signature: "Premium z is now positive after a reading below −1 within the last 30 available z readings; SPY has the configured closes above VWAP.",
    trigger: "Warning appears on detection. Separate execution confirmation needs a recent upward crossing of the prior SPY high and the configured closes above it.",
    invalidation: "Candidate ends if z is nonpositive, the recent low no longer qualifies, or the SPY VWAP hold fails.",
  },
  {
    code: "EXT-UP-FAILURE",
    regime: "EXT-UP",
    name: "Weak premium below prior high",
    side: "short",
    type: "Momentum",
    signature: "Premium z is below −1 with a negative extrinsic-premium slope, while SPY closes below its prior-session high.",
    trigger: "Warning appears on detection. Execution also needs matching bearish SPY VWAP and premium-z confirmation.",
    invalidation: "Candidate ends if z reaches −1 or higher, premium slope is nonnegative, or SPY reaches its prior high.",
  },
  {
    code: "EXT-DOWN-SELLING",
    regime: "EXT-DOWN",
    name: "Low premium below prior low",
    side: "short",
    type: "Momentum",
    signature: "Premium z is below −2 while SPY closes below its prior-session low.",
    trigger: "Execution also needs matching bearish SPY VWAP and premium-z confirmation; the candidate alone does not pass that gate.",
    invalidation: "Candidate ends if z reaches −2 or higher or SPY reaches its prior low.",
  },
  {
    code: "EXT-DOWN-REBOUND",
    regime: "EXT-DOWN",
    name: "Premium recovery above prior low",
    side: "long",
    type: "Anticipation",
    signature: "Negative premium z is recovering from a prior reading at or below −2, and SPY closes above its prior-session low.",
    trigger: "Warning appears on detection. Separate execution confirmation needs a recent upward crossing of the prior SPY low and the configured closes above it.",
    invalidation: "Candidate ends if SPY returns to or below its prior low or the negative-premium recovery condition ends.",
  },
  {
    code: "EXT-DOWN-RECOVERY",
    regime: "EXT-DOWN",
    name: "VWAP hold with nonfalling premium",
    side: "long",
    type: "Momentum",
    signature: "Premium z lies from −2 inclusive to zero exclusive, premium slope is nonnegative, and SPY has the configured closes above VWAP.",
    trigger: "This bullish candidate remains behind the momentum gate: negative z cannot also meet its positive-z execution threshold.",
    invalidation: "Candidate ends if z leaves [−2, 0), premium slope turns negative, or the SPY VWAP hold fails.",
  },
];
export function divergence(points: PremiumPoint[]) {
  const clean = points.filter((x) => x.valid),
    events: {
      side: string;
      first: PremiumPoint;
      second: PremiumPoint;
      confirmedAt: string | null;
      trigger: number;
    }[] = [];
  for (const kind of ["low", "high"]) {
    const pivots = clean.filter(
      (p, i) =>
        i >= 2 &&
        i < clean.length - 2 &&
        minute(clean[i + 2].timestamp) - minute(clean[i - 2].timestamp) === 4 &&
        clean
          .slice(i - 2, i + 3)
          .every((x) =>
            kind === "low"
              ? p.underlying <= x.underlying
              : p.underlying >= x.underlying,
          ),
    );
    for (let i = 1; i < pivots.length; i++) {
      const a = pivots[i - 1],
        b = pivots[i],
        gap = minute(b.timestamp) - minute(a.timestamp);
      if (
        gap < 5 ||
        gap > 40 ||
        b.underlying <= a.underlying ||
        b.extrinsic > a.extrinsic
      )
        continue;
      const between = clean.filter(
        (x) => x.timestamp > a.timestamp && x.timestamp < b.timestamp,
      );
      if (!between.length) continue;
      const trigger =
        kind === "low"
          ? Math.max(...between.map((x) => x.underlying))
          : Math.min(...between.map((x) => x.underlying));
      const confirmed = clean.find(
        (x) =>
          minute(x.timestamp) > minute(b.timestamp) + 2 &&
          (kind === "low" ? x.underlying > trigger : x.underlying < trigger),
      );
      events.push({
        side: kind === "low" ? "bullish" : "bearish",
        first: a,
        second: b,
        trigger,
        confirmedAt: confirmed?.timestamp ?? null,
      });
    }
  }
  return events
    .sort((a, b) => a.second.timestamp.localeCompare(b.second.timestamp))
    .slice(-6);
}
export function expectedMove(
  anchor: number,
  iv: number | null,
  sessionMinutes: number,
) {
  return iv !== null && iv > 0 && anchor > 0
    ? anchor * iv * Math.sqrt(sessionMinutes / 525600)
    : null;
}

export function executionConfirmation(
  active: { type: string; side: string; regime: string } | null,
  bars: Bar[],
  levels: Levels,
  pricePremium: { direction: string },
  count = 2,
) {
  if (!active)
    return {
      passed: false,
      direction: "neutral",
      detail: "No contextual setup",
    };
  if (active.type === "Momentum") {
    const passed =
      pricePremium.direction !== "neutral" &&
      (active.side === pricePremium.direction || active.side === "both");
    return {
      passed,
      direction: passed ? pricePremium.direction : "neutral",
      detail: passed
        ? `${directionLabel(pricePremium.direction)} momentum aligned`
        : "SPY VWAP and premium z-score do not confirm this direction",
    };
  }
  // Anticipation checks a recent crossing of the prior-range boundary.
  // Its price test is separate from the neutral premium-recovery gate.
  const direction = active.side === "both" ? "short" : active.side;
  const boundary = active.regime === "EXT-DOWN" ? levels.low : levels.high;
  const span = bars.slice(-count),
    prior = bars.slice(-12, -count);
  const consecutive =
    span.length === count &&
    span.every(
      (b, i) =>
        i === 0 || minute(b.timestamp) - minute(span[i - 1].timestamp) === 1,
    );
  const held =
    consecutive &&
    finite(boundary) &&
    span.every((b) =>
      direction === "long" ? b.close > boundary : b.close < boundary,
    );
  const crossed = prior.some((b) =>
    direction === "long" ? b.close <= boundary : b.close >= boundary,
  );
  const passed = held && crossed;
  return {
    passed,
    direction: passed ? direction : "neutral",
    detail: passed
      ? `Confirmed ${direction === "long" ? "reclaim" : "rejection"} of ${active.regime === "EXT-DOWN" ? "YDL" : "YDH"}`
      : "Await a recent break and hold at the regime boundary",
  };
}
