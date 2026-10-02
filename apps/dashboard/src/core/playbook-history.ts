import { finite, minute, type Bar } from "./engine.ts";
import { readout, type Settings } from "./readout.ts";
import type { MarketData } from "./service.ts";

export type PlaybookDetection = {
  code: string;
  name: string;
  firstDetectedAt: number;
  lastDetectedAt: number;
};

export type PlaybookHistory = {
  current: PlaybookDetection | null;
  previous: PlaybookDetection | null;
  latest: PlaybookDetection | null;
};

const validBar = (bar: Bar | undefined) => !!bar &&
  [bar.open, bar.high, bar.low, bar.close].every((value) => finite(value) && value > 0) &&
  bar.high >= bar.low;

function candidate(view: ReturnType<typeof readout>) {
  return !view.stale && view.points.at(-1)?.valid &&
    validBar(view.spx.at(-1)) && validBar(view.spy.at(-1))
    ? view.active : null;
}

/** Rebuild the selected session's episodes from its samples, including on reload or replay. */
export function buildPlaybookHistory(data: MarketData, cutoff: number, settings: Settings): PlaybookHistory {
  const empty: PlaybookHistory = { current: null, previous: null, latest: null };
  const limit = Math.min(cutoff, data.asOf, data.session.close - 1);
  if (!finite(limit) || limit < data.session.open) return empty;

  const inDay = (sample: { timestamp: string }) =>
    sample.timestamp.slice(0, 10) === data.date &&
    finite(minute(sample.timestamp)) && minute(sample.timestamp) <= limit;
  const inSession = (sample: { timestamp: string }) =>
    inDay(sample) && minute(sample.timestamp) >= data.session.open;
  const byTime = (a: { timestamp: string }, b: { timestamp: string }) => a.timestamp.localeCompare(b.timestamp);
  // readout assumes one session and one measurement call. Keep those assumptions
  // explicit here so changing date/contract cannot retain another scope's history.
  const scoped: MarketData = {
    ...data,
    spx: data.spx.filter(inSession).sort(byTime),
    spy: data.spy.filter(inDay).sort(byTime),
    quotes: data.quotes.filter((quote) => inSession(quote) &&
      quote.symbol === "SPXW" && quote.expiration === data.date &&
      quote.strike === data.measurement.strike && quote.right.toUpperCase() === "CALL").sort(byTime),
  };
  const samples = [...new Set([...scoped.spx, ...scoped.spy, ...scoped.quotes]
    .filter(inSession).map((sample) => minute(sample.timestamp)))].sort((a, b) => a - b);
  const episodes: PlaybookDetection[] = [];
  let matching = false;
  for (const at of samples) {
    const active = candidate(readout(scoped, at, settings));
    const latest = episodes.at(-1);
    if (!active) {
      matching = false;
    } else if (matching && latest?.code === active.code) {
      latest.lastDetectedAt = at;
    } else {
      episodes.push({ code: active.code, name: active.name, firstDetectedAt: at, lastDetectedAt: at });
      matching = true;
    }
  }

  // A fresh reading may still be current between samples, but that does not
  // manufacture another observation or move the episode's detection timestamp.
  const now = cutoff < data.session.close ? candidate(readout(scoped, cutoff, settings)) : null;
  const latest = episodes.at(-1) ?? null;
  const current = now && matching && latest?.code === now.code ? latest : null;
  return { current, previous: current ? episodes.at(-2) ?? null : latest, latest };
}
