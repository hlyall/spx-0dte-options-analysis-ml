import type { Bar } from "./engine.ts";

export const NETWORK_SYMBOLS = ["XLK", "XLF", "XLY", "XLP", "XLE", "XLU", "XLV", "XLI", "XLB", "XLRE", "XLC"] as const;
export const NETWORK_PARAMETERS = Object.freeze({
  version: "sector-network-v1", sessionOpen: 570, returnWindow: 60, directionWindow: 5,
  correlationThreshold: 0.6, minimumSectors: 9, universeSize: 11,
  coordinatedSize: 7, dispersedMaximumSize: 3, dispersedMaximumNetBreadth: 3,
  growthLag: 5, vwapMethod: "cumulative-rth-hlc3-volume", returnMethod: "simple-close-to-close",
});
export type NetworkStatus = "premarket" | "warming" | "unavailable" | "bullish_coordinated" | "bearish_coordinated" | "dispersed" | "unresolved";
export type NetworkContext = { symbol: string; bars: Bar[] };
export type NetworkSector = {
  symbol: string; eligible: boolean; reason: string; sign: -1 | 0 | 1;
  close: number | null; vwap: number | null; fiveMinuteReturn: number | null;
};
export type NetworkLink = { source: string; target: string; correlation: number; sign: -1 | 0 | 1 };
export type NetworkCluster = { symbols: string[]; size: number; fraction: number };
export type NetworkRegimeResult = {
  experimental: true; status: NetworkStatus; reason: string; asOf: number; sessionDate: string;
  parameters: typeof NETWORK_PARAMETERS;
  warmup: { requiredBars: number; elapsedBars: number; firstEligibleMinute: number };
  coverage: { eligible: number; total: number; minimum: number; fraction: number; symbols: string[]; excluded: string[] };
  sectors: NetworkSector[];
  /** All positive Pearson links meeting the threshold; sign=0 is not a same-sign directional link. */
  links: NetworkLink[];
  bullishCluster: NetworkCluster; bearishCluster: NetworkCluster;
  largestClusterFraction: number | null; signedBreadth: number | null; meanCorrelation: number | null;
  /** Fixed-universe fraction changes; unavailable if the eligible universe changed or was warming. */
  clusterGrowth: number | null; bullishGrowth: number | null; bearishGrowth: number | null;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const emptyCluster = (): NetworkCluster => ({ symbols: [], size: 0, fraction: 0 });
const firstEligible = NETWORK_PARAMETERS.sessionOpen + NETWORK_PARAMETERS.returnWindow;
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;

function sourceMinute(bar: Bar, date: string): number | null {
  if (typeof bar.timestamp !== "string" || !bar.timestamp.startsWith(`${date}T`)) return null;
  const time = bar.timestamp.slice(11);
  // Inputs are normalized ET minute starts. Zoned/mid-minute timestamps must be normalized by the source adapter.
  if (!/^\d{2}:\d{2}:00(?:\.0+)?$/.test(time)) return null;
  const hour = Number(time.slice(0, 2)), minute = Number(time.slice(3, 5));
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function identifiableMinute(bar: Bar, date: string): number | null {
  if (typeof bar.timestamp !== "string" || !bar.timestamp.startsWith(`${date}T`)) return null;
  const time = bar.timestamp.slice(11);
  if (!/^\d{2}:\d{2}:/.test(time)) return null;
  const hour = Number(time.slice(0, 2)), minute = Number(time.slice(3, 5));
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function validBar(bar: Bar) {
  return [bar.open, bar.high, bar.low, bar.close].every((x) => finite(x) && x > 0) &&
    bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close) &&
    finite(bar.volume) && bar.volume >= 0;
}

type Prepared = { symbol: string; rows: Map<number, Bar[]>; invalidMinutes: Set<number>; duplicateContext: boolean };
type Eligible = { sector: NetworkSector; returns: number[] };

function prepare(context: NetworkContext[], date: string, limit: number): Prepared[] {
  return NETWORK_SYMBOLS.map((symbol) => {
    const entries = context.filter((entry) => entry.symbol === symbol);
    const rows = new Map<number, Bar[]>();
    const invalidMinutes = new Set<number>();
    if (entries.length === 1) for (const bar of entries[0].bars) {
      const at = sourceMinute(bar, date);
      const identified = at ?? identifiableMinute(bar, date);
      // A malformed/off-grid row cannot vanish beside an otherwise valid row
      // from the same minute. Quarantine its identity without using its price.
      // Filter by the requested cutoff before recording any invalid evidence.
      if (identified === null || identified < NETWORK_PARAMETERS.sessionOpen || identified > limit) continue;
      if (at === null) { invalidMinutes.add(identified); continue; }
      const existing = rows.get(at) ?? [];
      existing.push(bar);
      rows.set(at, existing);
    }
    return { symbol, rows, invalidMinutes, duplicateContext: entries.length > 1 };
  });
}

function sectorAt(input: Prepared, at: number): Eligible {
  const sector: NetworkSector = { symbol: input.symbol, eligible: false, reason: "", sign: 0, close: null, vwap: null, fiveMinuteReturn: null };
  const fail = (reason: string): Eligible => ({ sector: { ...sector, reason }, returns: [] });
  if (input.duplicateContext) return fail("Duplicate symbol contexts.");
  if (at < firstEligible) return fail("Needs 61 completed regular-session bars for 60 returns.");
  let weighted = 0, volume = 0;
  for (let minute = NETWORK_PARAMETERS.sessionOpen; minute <= at; minute++) {
    if (input.invalidMinutes.has(minute)) return fail(`Invalid source timestamp at minute ${minute}.`);
    const rows = input.rows.get(minute);
    if (!rows?.length) return fail(`Missing regular-session minute ${minute}.`);
    if (rows.length !== 1) return fail(`Duplicate regular-session minute ${minute}.`);
    const bar = rows[0];
    if (!validBar(bar)) return fail(`Invalid OHLCV at minute ${minute}.`);
    weighted += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    volume += bar.volume;
  }
  if (!(volume > 0) || !finite(volume) || !finite(weighted)) return fail("Cumulative regular-session VWAP is unavailable.");
  const vwap = weighted / volume;
  if (!finite(vwap) || vwap <= 0) return fail("Cumulative regular-session VWAP is unavailable.");
  const returns: number[] = [];
  for (let minute = at - NETWORK_PARAMETERS.returnWindow + 1; minute <= at; minute++)
    returns.push(input.rows.get(minute)![0].close / input.rows.get(minute - 1)![0].close - 1);
  if (!returns.every(finite)) return fail("Nonfinite trailing return.");
  const mean = returns.reduce((sum, x) => sum + x, 0) / returns.length;
  const variance = returns.reduce((sum, x) => sum + (x - mean) ** 2, 0);
  if (!finite(variance) || variance <= 0) return fail("Trailing return variance is zero or unavailable.");
  const close = input.rows.get(at)![0].close;
  const prior = input.rows.get(at - NETWORK_PARAMETERS.directionWindow)![0].close;
  const fiveMinuteReturn = close / prior - 1;
  if (!finite(fiveMinuteReturn)) return fail("Nonfinite five-minute return.");
  const sign = close > prior && close > vwap ? 1 : close < prior && close < vwap ? -1 : 0;
  return { sector: { ...sector, eligible: true, reason: "Complete aligned regular-session history.", sign, close, vwap, fiveMinuteReturn }, returns };
}

function correlation(a: number[], b: number[]): number {
  const ma = a.reduce((sum, x) => sum + x, 0) / a.length;
  const mb = b.reduce((sum, x) => sum + x, 0) / b.length;
  let xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    xx += x * x; yy += y * y; xy += x * y;
  }
  return Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy)));
}

function largestCluster(sectors: NetworkSector[], links: NetworkLink[], sign: -1 | 1): NetworkCluster {
  const symbols = sectors.filter((sector) => sector.eligible && sector.sign === sign).map((sector) => sector.symbol);
  const seen = new Set<string>();
  let largest: string[] = [];
  for (const symbol of symbols) {
    if (seen.has(symbol)) continue;
    const component: string[] = [], queue = [symbol];
    seen.add(symbol);
    while (queue.length) {
      const current = queue.shift()!;
      component.push(current);
      for (const link of links) {
        if (link.sign !== sign) continue;
        const next = link.source === current ? link.target : link.target === current ? link.source : null;
        if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    if (component.length > largest.length) largest = component;
  }
  // Fixed symbol ordering also resolves equal-size component ties deterministically.
  largest = NETWORK_SYMBOLS.filter((symbol) => largest.includes(symbol));
  return { symbols: largest, size: largest.length, fraction: largest.length / NETWORK_PARAMETERS.universeSize };
}

function atMinute(prepared: Prepared[], at: number, date: string): NetworkRegimeResult {
  const samples = prepared.map((input) => sectorAt(input, at));
  const sectors = samples.map((sample) => sample.sector), usable = samples.filter((sample) => sample.sector.eligible);
  const result: NetworkRegimeResult = {
    experimental: true, status: "unavailable", reason: "Fewer than nine of eleven sectors have complete aligned data.", asOf: at, sessionDate: date,
    parameters: NETWORK_PARAMETERS,
    warmup: { requiredBars: 61, elapsedBars: Math.max(0, at - NETWORK_PARAMETERS.sessionOpen + 1), firstEligibleMinute: firstEligible },
    coverage: { eligible: usable.length, total: 11, minimum: 9, fraction: usable.length / 11,
      symbols: usable.map((sample) => sample.sector.symbol), excluded: sectors.filter((sector) => !sector.eligible).map((sector) => sector.symbol) },
    sectors, links: [], bullishCluster: emptyCluster(), bearishCluster: emptyCluster(),
    largestClusterFraction: null, signedBreadth: null, meanCorrelation: null, clusterGrowth: null, bullishGrowth: null, bearishGrowth: null,
  };
  if (at < NETWORK_PARAMETERS.sessionOpen) {
    result.status = "premarket"; result.reason = "Regular-session sector network begins after 09:30 ET."; return result;
  }
  if (at < firstEligible) {
    result.status = "warming"; result.reason = "Needs 61 completed RTH bars; first reading is available at 10:31 ET."; return result;
  }
  if (usable.length < NETWORK_PARAMETERS.minimumSectors) return result;
  let sumCorrelation = 0, pairs = 0;
  for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
    const r = correlation(usable[i].returns, usable[j].returns);
    if (!finite(r)) { result.reason = "Numerically invalid pairwise correlation."; return result; }
    sumCorrelation += r; pairs++;
    if (r >= NETWORK_PARAMETERS.correlationThreshold) {
      const a = usable[i].sector, b = usable[j].sector;
      result.links.push({ source: a.symbol, target: b.symbol, correlation: r, sign: a.sign === b.sign ? a.sign : 0 });
    }
  }
  result.meanCorrelation = sumCorrelation / pairs;
  result.bullishCluster = largestCluster(sectors, result.links, 1);
  result.bearishCluster = largestCluster(sectors, result.links, -1);
  const netBreadth = usable.reduce((sum, sample) => sum + sample.sector.sign, 0);
  result.signedBreadth = netBreadth / NETWORK_PARAMETERS.universeSize;
  const largest = Math.max(result.bullishCluster.size, result.bearishCluster.size);
  result.largestClusterFraction = largest / NETWORK_PARAMETERS.universeSize;
  if (result.bullishCluster.size >= NETWORK_PARAMETERS.coordinatedSize) {
    result.status = "bullish_coordinated"; result.reason = "At least seven sectors form a bullish correlated component.";
  } else if (result.bearishCluster.size >= NETWORK_PARAMETERS.coordinatedSize) {
    result.status = "bearish_coordinated"; result.reason = "At least seven sectors form a bearish correlated component.";
  } else if (largest <= NETWORK_PARAMETERS.dispersedMaximumSize && Math.abs(netBreadth) <= NETWORK_PARAMETERS.dispersedMaximumNetBreadth) {
    result.status = "dispersed"; result.reason = "Sector participation is dispersed; this does not establish a future trading range.";
  } else {
    result.status = "unresolved"; result.reason = "Participation does not meet a fixed coordinated or dispersed condition.";
  }
  return result;
}

/**
 * Experimental descriptive network; no fitted parameters, probability or trading instruction.
 * Source timestamps are naive ET minute starts. cutoffMinute is the inclusive LAST COMPLETED
 * bar, not the current clock minute. Sixty simple close-to-close returns require 61 contiguous
 * RTH bars. Each sector also needs a complete session prefix for its own cumulative HLC3-volume
 * VWAP. No prior-session seed, forward fill, future bar, pairwise deletion or partial VWAP.
 * Equal timestamps (including identical duplicate rows), identifiable off-grid session minutes,
 * and duplicate symbol contexts quarantine that sector. Nine eligible sectors are required;
 * fractions always divide by the fixed eleven.
 * Positive Pearson links >=0.6 connect same-sign nodes for directional components. Node sign
 * requires strict agreement between five-minute price change and current price vs own VWAP.
 * Growth compares t and t-5 only when both meet coverage and their eligible symbols match.
 * Caller owns exchange calendar, real-time freshness and replay/live labeling.
 */
export function calculateNetworkRegime(context: NetworkContext[], cutoffMinute: number, sessionDate: string, sessionClose = 960): NetworkRegimeResult {
  const validClock = finite(cutoffMinute) && Number.isInteger(cutoffMinute) && cutoffMinute >= 0 && cutoffMinute <= 1439 &&
    finite(sessionClose) && Number.isInteger(sessionClose) && sessionClose > NETWORK_PARAMETERS.sessionOpen && sessionClose <= 1440;
  if (!validClock || !validDate(sessionDate)) {
    const result = atMinute(prepare([], "", -1), -1, sessionDate);
    result.status = "unavailable"; result.reason = "Invalid session date, cutoff or cash-session close."; return result;
  }
  const at = Math.min(cutoffMinute, sessionClose - 1), prepared = prepare(context, sessionDate, at);
  const result = atMinute(prepared, at, sessionDate);
  if (result.largestClusterFraction === null) return result;
  const prior = atMinute(prepared, at - NETWORK_PARAMETERS.growthLag, sessionDate);
  if (prior.largestClusterFraction !== null && result.coverage.symbols.join(",") === prior.coverage.symbols.join(",")) {
    result.clusterGrowth = result.largestClusterFraction - prior.largestClusterFraction;
    result.bullishGrowth = result.bullishCluster.fraction - prior.bullishCluster.fraction;
    result.bearishGrowth = result.bearishCluster.fraction - prior.bearishCluster.fraction;
  }
  return result;
}
