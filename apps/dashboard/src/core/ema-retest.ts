import type { Bar } from "./engine.ts";
import type { MarketData } from "./service.ts";

export type EmaRetestSide = "bullish" | "bearish";
export type EmaRetestStage = "watching" | "confirmed" | "expired" | "invalidated" | "cancelled";
export type EmaRetestLevel = { name: string; low: number; high: number };
export type EmaRetestBar = Bar & {
  startMinute: number;
  /** Closing clock time: the 09:30–09:39 source candle ends at 09:40. */
  endMinute: number;
  ema: number | null;
  previousEma: number | null;
};
export type EmaRetestEpisode = {
  id: string;
  side: EmaRetestSide;
  status: EmaRetestStage;
  /** All episode times are closing-clock minutes, not source-bar start times. */
  crossedAt: number;
  retestedAt: number | null;
  endedAt: number | null;
  crossPrice: number;
  confirmationPrice: number | null;
  retestReference: number | null;
  confluence: EmaRetestLevel[];
  target: EmaRetestLevel | null;
  reason: string;
};
export type EmaRetestSideState = {
  side: EmaRetestSide;
  status: "idle" | EmaRetestStage;
  episode: EmaRetestEpisode | null;
};
export type EmaRetestResult = {
  status: "ready" | "premarket" | "warming" | "stale" | "unavailable";
  reason: string;
  /** Last eligible completed one-minute source timestamp, as an ET minute. */
  asOf: number;
  ema: number | null;
  latestBar: EmaRetestBar | null;
  bars: EmaRetestBar[];
  warmup: { bars: number; required: number; priorBars: number; seededFromPrior: boolean };
  freshness: { latestMinute: number | null; ageMinutes: number | null };
  bullish: EmaRetestSideState;
  bearish: EmaRetestSideState;
  history: EmaRetestEpisode[];
  levels: { above: EmaRetestLevel | null; below: EmaRetestLevel | null; overlapping: EmaRetestLevel[] };
};

export const EMA_RETEST_PERIOD = 8;
export const EMA_RETEST_INTERVAL = 10;
export const EMA_RETEST_WINDOW = 3;
export const EMA_RETEST_LEVEL_TOLERANCE = 2;
const alpha = 2 / (EMA_RETEST_PERIOD + 1);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function sourceMinute(bar: Bar, date: string): number | null {
  if (!bar.timestamp.startsWith(`${date}T`)) return null;
  const time = bar.timestamp.slice(11);
  if (!/^\d{2}:\d{2}:00(?:\.0+)?$/.test(time)) return null;
  const hour = Number(time.slice(0, 2)), minute = Number(time.slice(3, 5));
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function validBar(bar: Bar) {
  return [bar.open, bar.high, bar.low, bar.close].every((value) => finite(value) && value > 0) &&
    bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close);
}

function byMinute(bars: Bar[], date: string, open: number, limit: number) {
  const rows = new Map<number, Bar[]>();
  for (const bar of bars) {
    const at = sourceMinute(bar, date);
    if (at === null || at < open || at > limit) continue;
    const existing = rows.get(at) ?? [];
    rows.set(at, [...existing, bar]);
  }
  return rows;
}

function completedBar(rows: Map<number, Bar[]>, start: number): Bar | null {
  const sources: Bar[] = [];
  for (let at = start; at < start + EMA_RETEST_INTERVAL; at++) {
    const minute = rows.get(at);
    // Even identical duplicate rows cannot count as separate minute observations.
    if (minute?.length !== 1 || !validBar(minute[0])) return null;
    sources.push(minute[0]);
  }
  return {
    timestamp: sources[0].timestamp,
    open: sources[0].open,
    high: Math.max(...sources.map((bar) => bar.high)),
    low: Math.min(...sources.map((bar) => bar.low)),
    close: sources.at(-1)!.close,
    volume: sources.reduce((sum, bar) => sum + (finite(bar.volume) && bar.volume >= 0 ? bar.volume : 0), 0),
  };
}

function levelMap(levels: EmaRetestLevel[], price: number | null) {
  if (price === null) return { above: null, below: null, overlapping: [] };
  return {
    above: levels.filter((level) => level.low > price).sort((a, b) => a.low - b.low)[0] ?? null,
    below: levels.filter((level) => level.high < price).sort((a, b) => b.high - a.high)[0] ?? null,
    overlapping: levels.filter((level) => level.low <= price && level.high >= price),
  };
}

/**
 * Experimental price-pattern detection, independent of premium and entry gates.
 *
 * Source timestamps are ET minute starts. Ten-minute bars start at session.open;
 * a bar is eligible only when all ten distinct minutes are complete by cutoff.
 * The eight-close SMA seed is followed by EMA alpha=2/9. Available prior-session
 * RTH bars warm the EMA, including the last close used for today's first cross,
 * but never create prior-session signals. The session boundary carries the EMA;
 * missing, invalid or duplicate minutes reset it and cancel pending continuity.
 *
 * A cross starts a watch. One of the NEXT three completed candles must touch the
 * previous completed EMA and close on the intended side of its updated EMA.
 * An opposite cross cancels a watch; a later close on the wrong side invalidates
 * a confirmed retest. Levels are context only and must have been known before
 * the evaluated sample. Confluence and the next mapped level freeze at retest.
 */
export function buildEmaRetest(data: MarketData, cutoff: number, levels: EmaRetestLevel[] = []): EmaRetestResult {
  const { open, close } = data.session;
  const validClock = finite(open) && finite(close) && Number.isInteger(open) && Number.isInteger(close) &&
    open >= 0 && close > open && close <= 1440 && finite(cutoff) && finite(data.asOf);
  const limit = validClock ? Math.min(Math.floor(cutoff), Math.floor(data.asOf), close - 1) : -1;
  const observation = validClock ? Math.min(Math.floor(cutoff), close - 1) : -1;
  const knownLevels = levels.filter((level) => level.name.trim() && finite(level.low) && finite(level.high) &&
    level.low > 0 && level.high >= level.low).map((level) => ({ ...level }));
  const rows = byMinute(data.spx, data.date, open, limit);
  const prior = byMinute(data.priorSpx, data.previousDate, open, 1439);
  const validMinutes = [...rows.entries()].filter(([, samples]) => samples.length === 1 && validBar(samples[0])).map(([at]) => at);
  const latestMinute = validMinutes.length ? Math.max(...validMinutes) : null;
  const ageMinutes = latestMinute === null ? null : observation - latestMinute;
  const bars: EmaRetestBar[] = [];
  const history: EmaRetestEpisode[] = [];
  let ema: number | null = null;
  let previous: EmaRetestBar | null = null;
  let seeds: number[] = [];
  let priorBars = 0;
  let latestBucketMissing = false;

  const finish = (episode: EmaRetestEpisode, status: EmaRetestStage, at: number, reason: string) => {
    episode.status = status;
    episode.endedAt = at;
    episode.reason = reason;
  };
  const reset = (at: number) => {
    ema = null;
    seeds = [];
    previous = null;
    priorBars = 0;
    for (const episode of history) {
      if (episode.status === "watching" || episode.status === "confirmed")
        finish(episode, "cancelled", at, "Missing, invalid or duplicate source minutes interrupted the pattern; fresh EMA warmup is required.");
    }
  };
  const advance = (bar: Bar, start: number): EmaRetestBar => {
    const previousEma = ema;
    if (ema === null) {
      seeds.push(bar.close);
      if (seeds.length === EMA_RETEST_PERIOD) ema = seeds.reduce((sum, value) => sum + value, 0) / EMA_RETEST_PERIOD;
    } else {
      ema += alpha * (bar.close - ema);
    }
    return { ...bar, startMinute: start, endMinute: start + EMA_RETEST_INTERVAL, ema, previousEma };
  };

  if (validClock && prior.size && data.previousDate < data.date) {
    const last = Math.max(...prior.keys());
    // Include a partial final historical bucket as a gap, never as an EMA seed.
    for (let start = open; start <= last; start += EMA_RETEST_INTERVAL) {
      const bar = completedBar(prior, start);
      if (!bar) reset(start + EMA_RETEST_INTERVAL);
      else {
        previous = advance(bar, start);
        priorBars++;
      }
    }
  }

  if (validClock) for (let start = open; start + EMA_RETEST_INTERVAL - 1 <= limit; start += EMA_RETEST_INTERVAL) {
    const source = completedBar(rows, start);
    latestBucketMissing = !source;
    if (!source) {
      reset(start + EMA_RETEST_INTERVAL);
      continue;
    }
    const bar = advance(source, start);
    bars.push(bar);
    if (bar.ema !== null && previous?.ema !== null && previous) {
      const bullishCross = previous.close <= previous.ema && bar.close > bar.ema;
      const bearishCross = previous.close >= previous.ema && bar.close < bar.ema;
      for (const episode of history) {
        const bullish = episode.side === "bullish";
        const wrongSide = bullish ? bar.close < bar.ema : bar.close > bar.ema;
        if (episode.status === "confirmed" && wrongSide) {
          finish(episode, "invalidated", bar.endMinute, "A later completed 10-minute close moved to the wrong side of the updated 8-EMA.");
        } else if (episode.status === "watching") {
          const opposite = bullish ? bearishCross : bullishCross;
          const elapsed = (bar.endMinute - episode.crossedAt) / EMA_RETEST_INTERVAL;
          if (opposite) {
            finish(episode, "cancelled", bar.endMinute, "An opposite completed 10-minute EMA cross cancelled the retest watch.");
          } else if (elapsed > 0 && elapsed <= EMA_RETEST_WINDOW && bar.previousEma !== null &&
            bar.low <= bar.previousEma && bar.high >= bar.previousEma &&
            (bullish ? bar.close > bar.ema : bar.close < bar.ema)) {
            episode.status = "confirmed";
            episode.retestedAt = bar.endMinute;
            episode.confirmationPrice = bar.close;
            episode.retestReference = bar.previousEma;
            episode.confluence = knownLevels.filter((level) =>
              bar.previousEma! >= level.low - EMA_RETEST_LEVEL_TOLERANCE &&
              bar.previousEma! <= level.high + EMA_RETEST_LEVEL_TOLERANCE).map((level) => ({ ...level }));
            const map = levelMap(knownLevels, bar.close);
            episode.target = bullish ? map.above : map.below;
            episode.reason = `A later completed candle touched the prior 8-EMA and closed ${bullish ? "above" : "below"} its updated EMA. Entry permission is separate.`;
          } else if (elapsed >= EMA_RETEST_WINDOW) {
            finish(episode, "expired", bar.endMinute, "No qualifying retest within the next three completed 10-minute candles.");
          }
        }
      }
      // Creation happens after retest evaluation, so the crossing bar cannot also
      // confirm its own retest, even if its range straddles the EMA.
      if (bullishCross || bearishCross) {
        const side = bullishCross ? "bullish" : "bearish";
        // A close exactly on the EMA can precede another same-side cross. It
        // must not restart a live watch's clock or conceal a confirmed episode.
        if (!history.some((episode) => episode.side === side &&
          (episode.status === "watching" || episode.status === "confirmed"))) history.push({
          id: `${data.date}:${side}:${bar.endMinute}`,
          side, status: "watching", crossedAt: bar.endMinute, retestedAt: null, endedAt: null,
          crossPrice: bar.close, confirmationPrice: null, retestReference: null,
          confluence: [], target: null,
          reason: `Completed 10-minute ${bullishCross ? "reclaim" : "loss"} of the 8-EMA; waiting for a later retest within three candles.`,
        });
      }
    }
    previous = bar;
  }

  if (validClock && limit === close - 1) for (const episode of history) {
    if (episode.status === "watching") finish(episode, "expired", close,
      "The regular session ended before a qualifying later retest; the watch does not carry into another session.");
  }

  const latestBar = bars.at(-1) ?? null;
  let status: EmaRetestResult["status"] = "ready";
  let reason = "Completed SPX candles are current. EMA retest detection and new-entry permission are separate.";
  if (!validClock) {
    status = "unavailable";
    reason = "A valid session and completed-minute observation time are required.";
  } else if (observation < open) {
    status = "premarket";
    reason = "Waiting for today's completed regular-session SPX candles. Prior-session bars only warm the EMA.";
  } else if (latestMinute === null) {
    status = "unavailable";
    reason = "No valid, unique current-session SPX minute observations are available.";
  } else if (ageMinutes !== null && ageMinutes > 2) {
    status = "stale";
    reason = `The latest valid SPX minute is ${ageMinutes} minutes behind the requested observation; earlier detections are historical context.`;
  } else if (latestBucketMissing) {
    status = "unavailable";
    reason = "A completed 10-minute candle has missing, invalid or duplicate source minutes. The EMA and pattern sequence have reset.";
  } else if (!latestBar || ema === null) {
    status = "warming";
    reason = !latestBar
      ? "Waiting for today's first complete 10-minute SPX candle."
      : `EMA warmup requires eight consecutive complete 10-minute closes; ${seeds.length} are available after the last gap.`;
  }
  const sideState = (side: EmaRetestSide): EmaRetestSideState => {
    const episode = history.filter((item) => item.side === side).at(-1) ?? null;
    return { side, status: episode?.status ?? "idle", episode };
  };
  return {
    status, reason, asOf: limit, ema, latestBar, bars,
    warmup: { bars: Math.min(seeds.length, EMA_RETEST_PERIOD), required: EMA_RETEST_PERIOD, priorBars, seededFromPrior: ema !== null && priorBars > 0 },
    freshness: { latestMinute, ageMinutes },
    bullish: sideState("bullish"), bearish: sideState("bearish"), history,
    levels: levelMap(knownLevels, latestBar?.close ?? null),
  };
}
