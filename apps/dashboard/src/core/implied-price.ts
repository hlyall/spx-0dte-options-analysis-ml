import { finite } from "./engine.ts";

export type ParityQuote = {
  symbol: string;
  expiration: string;
  strike: number;
  right: string;
  timestamp: string;
  bid: number;
  ask: number;
  bid_size?: number;
  ask_size?: number;
};
export type ParityData = {
  quotes: ParityQuote[];
  index: { timestamp: string; price: number }[];
  rate: { created: string; rate: number } | null;
  quoteTimestampBasis?: "event" | "interval";
  indexTimestampBasis?: "event" | "interval";
};

// Theta's interval samples are exchange-local timestamps, without a timezone.
// Compare their exact sample times, never the browser's timezone or OHLC closes.
function sampleSecond(timestamp: string, date: string) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(timestamp);
  if (!match || match[1] !== date || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return NaN;
  return +match[2] * 3600 + +match[3] * 60 + +match[4] + Number(`0.${match[5] || "0"}`);
}

/** European put-call parity; an intraday spot estimate, not a directional forecast. */
export function impliedPrice(
  data: ParityData | undefined,
  date: string,
  strike: number | null,
  session: { open: number; close: number },
  cutoff: number,
  maxSpread = 0.25,
) {
  const unavailable = (reason: string, timestamp: string | null = null, stale = false) => ({
    status: stale ? "stale" as const : "unavailable" as const, reason, timestamp, point: null,
  });
  if (cutoff < session.open) return unavailable("The same-day call/put estimate starts with regular-session quotes.");
  if (!finite(strike) || strike <= 0) return unavailable("Select a liquid SPXW measurement contract to load its matching call and put.");
  // Interval labels advance even when an earlier quote is carried forward.
  // Equality of those labels cannot establish quote age or synchronization.
  if (data?.quoteTimestampBasis !== "event")
    return unavailable("Original call and put update times are unverified. Minute samples can repeat older quotes, so the estimate is withheld until actual quote timestamps are available.");
  const quotes = (data?.quotes ?? []).filter((q) => {
    const second = sampleSecond(q.timestamp, date);
    return q.symbol === "SPXW" && q.expiration === date && q.strike === strike &&
      ["CALL", "PUT"].includes(q.right.toUpperCase()) &&
      second >= session.open * 60 && second < session.close * 60 && second <= cutoff * 60;
  });
  const latest = Math.max(...quotes.map((q) => sampleSecond(q.timestamp, date)));
  if (!finite(latest)) return unavailable("No same-day call/put quotes are available at this sample time.");
  const atTime = quotes.filter((q) => sampleSecond(q.timestamp, date) === latest);
  const timestamp = atTime[0].timestamp;
  if (cutoff * 60 - latest > 120) return unavailable("The latest option sample is more than two minutes behind this view. The estimate is withheld.", timestamp, true);
  const calls = atTime.filter((q) => q.right.toUpperCase() === "CALL");
  const puts = atTime.filter((q) => q.right.toUpperCase() === "PUT");
  if (calls.length !== 1 || puts.length !== 1) return unavailable("A unique call and put must share the same strike, expiry and sample time. Waiting for a matched pair.", timestamp);
  const valid = (q: ParityQuote) => finite(q.bid) && finite(q.ask) && q.bid > 0 && q.ask >= q.bid &&
    (q.ask - q.bid) / ((q.ask + q.bid) / 2) <= maxSpread &&
    (q.bid_size === undefined || finite(q.bid_size) && q.bid_size > 0) &&
    (q.ask_size === undefined || finite(q.ask_size) && q.ask_size > 0);
  if (!valid(calls[0]) || !valid(puts[0])) return unavailable(`The latest pair has a missing, crossed, zero-size or wide quote. Both spreads must be within ${(maxSpread * 100).toFixed(0)}% of midpoint.`, timestamp);
  const leg = (q: ParityQuote) => ({ bid: q.bid, ask: q.ask, mid: (q.bid + q.ask) / 2 });
  const call = leg(calls[0]), put = leg(puts[0]);
  const supplied = data?.rate;
  const age = supplied ? (Date.parse(date) - Date.parse(supplied.created)) / 86400000 : NaN;
  // Use only an earlier dated observation, so EOD rate data cannot leak into replay.
  const rateUsable = !!supplied && finite(supplied.rate) && supplied.rate >= -5 && supplied.rate <= 50 && age >= 1 && age <= 7;
  const rate = { percent: rateUsable ? supplied!.rate : 0, created: rateUsable ? supplied!.created : null, assumed: !rateUsable };
  const minutesRemaining = session.close - latest / 60;
  // Prior SOFR is a financing proxy: simple ACT/360 over the remaining intraday time.
  // No cash dividend is modeled between this RTH sample and same-day PM settlement.
  const discount = 1 / (1 + rate.percent / 100 * minutesRemaining / (1440 * 360));
  const spot = call.mid - put.mid + strike * discount;
  const forward = strike + (call.mid - put.mid) / discount;
  const low = call.bid - put.ask + strike * discount;
  const high = call.ask - put.bid + strike * discount;
  if (![spot, forward, low, high].every((value) => finite(value) && value > 0)) return unavailable("The paired quotes do not produce a valid positive index-price estimate.", timestamp);
  const matches = data?.indexTimestampBasis === "event"
    ? data.index.filter((row) => sampleSecond(row.timestamp, date) === latest && finite(row.price) && row.price > 0)
    : [];
  const observed = matches.length === 1 ? matches[0].price : null;
  const gap = observed === null ? null : spot - observed;
  const comparison = observed === null ? "unmatched" : observed < low ? "above" : observed > high ? "below" : "inside";
  return {
    status: "ready" as const, reason: null, timestamp,
    point: { spot, forward, low, high, observed, gap, gapPct: gap === null ? null : gap / observed! * 100,
      comparison, timestamp, strike, call, put, minutesRemaining, rate, discount },
  };
}

export type ImpliedPrice = ReturnType<typeof impliedPrice>;
