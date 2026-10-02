import type { Bar } from "./engine.ts";
import { calculateNetworkRegime, type NetworkContext } from "./network-regime.ts";

export const NETWORK_FORECAST_FEATURES = [
  "spx_return_5", "spx_return_15", "spx_return_volatility_30", "spy_vwap_gap", "sector_signed_breadth",
  "bullish_cluster_fraction", "bearish_cluster_fraction", "bullish_growth_5", "bearish_growth_5", "mean_correlation",
] as const;
export const NETWORK_FORECAST_BAND = [0.45, 0.55] as const;
export type NetworkForecastDirection = "bullish" | "bearish" | "neutral";
export type NetworkForecastPriceBar = Omit<Bar, "volume"> & { volume?: number };
export type NetworkForecastInput = { spxBars: NetworkForecastPriceBar[]; spyBars: Bar[]; sectorContext: NetworkContext[] };
export type NetworkForecastModel = {
  id: string; horizon_minutes: number; valid_month: string; valid_from: string; valid_through: string;
  train_start: string; train_end: string; training_rows: number; training_days: number;
  mean: number[]; scale: number[]; beta: number[]; training_up_fraction: number; source: string;
  feature_order: string[]; converged: boolean;
};
export type NetworkForecastBundle = {
  schema_version: number; model_family: string; exported_at?: string; feature_order: string[];
  decision_policy: { min_cutoff_minute: number; horizons: number[]; completed_rth_bars_only: boolean; session_bound: boolean };
  display_policy: { neutral_band: number[]; neutral_includes_boundaries: boolean; is_backtested: boolean };
  models: NetworkForecastModel[]; provenance?: unknown; limitations?: string[];
};
export type ForecastModelBundle = NetworkForecastBundle;
export type NetworkForecastHorizon = {
  minutes: 30 | 60; status: "available" | "unavailable"; reason: string;
  direction: NetworkForecastDirection | null; probabilityUp: number | null; probabilityDown: number | null;
  modelId: string | null; trainingThrough: string | null; validMonth: string | null;
  trainingUpProbability: number | null; targetEndMinute: number;
};
export type NetworkForecastResult = {
  experimental: true; status: "available" | "warming" | "unavailable"; reason: string;
  asOf: number; decisionMinute: number; sessionDate: string;
  features: Record<typeof NETWORK_FORECAST_FEATURES[number], number> | null; featureVector: number[] | null;
  displayBand: typeof NETWORK_FORECAST_BAND; bandBacktested: false;
  /** The direction study sampled five hourly decisions; every-minute display is an unvalidated extension. */
  studiedDecisionMinute: boolean; horizons: NetworkForecastHorizon[];
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const validDate = (date: unknown): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const validPrice = (bar: NetworkForecastPriceBar) => [bar.open, bar.high, bar.low, bar.close].every(n => finite(n) && n > 0) &&
  bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close);

/** This is a display convention, not a calibrated neutral/flat-price probability. */
export function networkForecastDirection(probabilityUp: number): NetworkForecastDirection | null {
  if (!finite(probabilityUp) || probabilityUp < 0 || probabilityUp > 1) return null;
  return probabilityUp > NETWORK_FORECAST_BAND[1] ? "bullish" : probabilityUp < NETWORK_FORECAST_BAND[0] ? "bearish" : "neutral";
}

function minuteBook(bars: NetworkForecastPriceBar[], date: string, cutoff: number, symbol: "SPX" | "SPY") {
  const book = new Map<number, NetworkForecastPriceBar[]>(), invalid = new Set<number>();
  for (const bar of bars) {
    if (typeof bar.timestamp !== "string" || !bar.timestamp.startsWith(`${date}T`)) continue;
    const clock = bar.timestamp.slice(11);
    if (!/^\d{2}:\d{2}:/.test(clock)) continue;
    const hour = Number(clock.slice(0, 2)), minute = Number(clock.slice(3, 5)), at = hour * 60 + minute;
    if (hour >= 24 || minute >= 60 || at < 570 || at > cutoff) continue;
    if (!/^\d{2}:\d{2}:00(?:\.0+)?$/.test(clock)) { invalid.add(at); continue; }
    const rows = book.get(at) ?? []; rows.push(bar); book.set(at, rows);
  }
  return (minute: number): NetworkForecastPriceBar => {
    const rows = book.get(minute);
    if (invalid.has(minute)) throw new Error(`${symbol}: off-grid source timestamp at minute ${minute}.`);
    if (!rows || rows.length !== 1) throw new Error(`${symbol}: missing or duplicate completed minute ${minute}.`);
    if (!validPrice(rows[0]) || symbol === "SPY" && (!finite(rows[0].volume) || rows[0].volume < 0))
      throw new Error(`${symbol}: invalid ${symbol === "SPY" ? "OHLCV" : "price"} at minute ${minute}.`);
    return rows[0];
  };
}

function bundleValid(bundle: NetworkForecastBundle | null | undefined): bundle is NetworkForecastBundle {
  return !!bundle && bundle.schema_version === 1 && bundle.model_family === "spx_direction_network_logistic" &&
    Array.isArray(bundle.feature_order) && bundle.feature_order.join("|") === NETWORK_FORECAST_FEATURES.join("|") &&
    bundle.decision_policy?.min_cutoff_minute === 635 && bundle.decision_policy.completed_rth_bars_only === true &&
    bundle.decision_policy.session_bound === true && Array.isArray(bundle.decision_policy.horizons) && bundle.decision_policy.horizons.join("|") === "30|60" &&
    Array.isArray(bundle.display_policy?.neutral_band) && bundle.display_policy.neutral_band.join("|") === "0.45|0.55" &&
    bundle.display_policy.neutral_includes_boundaries === true && bundle.display_policy.is_backtested === false && Array.isArray(bundle.models);
}

function modelError(model: NetworkForecastModel, date: string): string | null {
  const month = date.slice(0, 7), start = `${month}-01`;
  if (typeof model.id !== "string" || !model.id || model.valid_month !== month) return "Model identity or valid month is incorrect.";
  if (model.converged !== true || !Array.isArray(model.feature_order) || model.feature_order.join("|") !== NETWORK_FORECAST_FEATURES.join("|"))
    return "Model did not converge or its feature order is incompatible.";
  if (!validDate(model.valid_from) || !validDate(model.valid_through) || model.valid_from.slice(0, 7) !== month ||
      model.valid_through.slice(0, 7) !== month || date < model.valid_from || date > model.valid_through) return "Model is outside its dated validity window.";
  if (!validDate(model.train_start) || !validDate(model.train_end) || model.train_start > model.train_end || model.train_end >= start)
    return "Model training is not strictly earlier than the selected month.";
  if (!Number.isInteger(model.training_rows) || model.training_rows < 350 || !Number.isInteger(model.training_days) || model.training_days < 80)
    return "Model has insufficient recorded training coverage.";
  const n = NETWORK_FORECAST_FEATURES.length;
  if (!Array.isArray(model.mean) || model.mean.length !== n || !model.mean.every(finite) ||
      !Array.isArray(model.scale) || model.scale.length !== n || !model.scale.every(x => finite(x) && x > 0) ||
      !Array.isArray(model.beta) || model.beta.length !== n + 1 || !model.beta.every(finite) ||
      !finite(model.training_up_fraction) || model.training_up_fraction < 0 || model.training_up_fraction > 1)
    return "Model coefficients or training transforms are invalid.";
  return null;
}

/**
 * Scores the frozen network-augmented logistic model, not the sign of correlation.
 * Bars are naive ET opening labels; cutoff is the inclusive LAST COMPLETED bar.
 * The caller must withhold the result when any underlying feed is stale or replay
 * data is incomplete. This pure function does not read wall time or fetch data.
 * SPX uses exactly 31 consecutive price bars for 30 returns; cash-index volume
 * is unused and may be absent. SPY needs its full RTH
 * HLC3-volume VWAP prefix. Sector features come from the frozen network module.
 * Missing/duplicate/off-grid required minutes are unavailable, never interpolated.
 */
export function calculateNetworkForecast(
  input: NetworkForecastInput, cutoffMinute: number, sessionDate: string,
  bundle: NetworkForecastBundle | null | undefined, sessionClose = 960,
): NetworkForecastResult {
  const result: NetworkForecastResult = {
    experimental: true, status: "unavailable", reason: "Forecast inputs are unavailable.", asOf: cutoffMinute,
    decisionMinute: cutoffMinute + 1, sessionDate, features: null, featureVector: null,
    displayBand: NETWORK_FORECAST_BAND, bandBacktested: false, studiedDecisionMinute: [636, 696, 756, 816, 876].includes(cutoffMinute + 1),
    horizons: ([30, 60] as const).map(minutes => ({ minutes, status: "unavailable", reason: "Forecast inputs are unavailable.", direction: null,
      probabilityUp: null, probabilityDown: null, modelId: null, trainingThrough: null, validMonth: null,
      trainingUpProbability: null, targetEndMinute: cutoffMinute + 1 + minutes })),
  };
  const unavailable = (reason: string) => { result.reason = reason; for (const h of result.horizons) h.reason = reason; return result; };
  if (!validDate(sessionDate) || !finite(cutoffMinute) || !Number.isInteger(cutoffMinute) || cutoffMinute < 0 || cutoffMinute > 1439 ||
      !finite(sessionClose) || !Number.isInteger(sessionClose) || sessionClose <= 570 || sessionClose > 1440)
    return unavailable("Invalid session date, completed-bar cutoff or cash close.");
  if (cutoffMinute < 635) {
    result.status = "warming";
    return unavailable("The forecast needs completed sector growth and price history; first reading is at 10:36 ET.");
  }
  if (result.decisionMinute + 30 > sessionClose) return unavailable("No forecast horizon fits before the verified cash close.");
  if (!bundleValid(bundle)) return unavailable("A compatible dated model export is unavailable.");
  if (!input || !Array.isArray(input.spxBars) || !Array.isArray(input.spyBars) || !Array.isArray(input.sectorContext))
    return unavailable("SPX, SPY and sector price histories are required.");
  try {
    const network = calculateNetworkRegime(input.sectorContext, cutoffMinute, sessionDate, sessionClose);
    if (network.meanCorrelation === null || network.signedBreadth === null) return unavailable("Fewer than nine sectors have valid aligned network history.");
    if (network.bullishGrowth === null || network.bearishGrowth === null) return unavailable("Five-minute network growth is unavailable or its eligible sector universe changed.");
    const spx = minuteBook(input.spxBars, sessionDate, cutoffMinute, "SPX"), spy = minuteBook(input.spyBars, sessionDate, cutoffMinute, "SPY");
    const last = spx(cutoffMinute).close;
    const returns = Array.from({ length: 30 }, (_, i) => {
      const at = cutoffMinute - 29 + i;
      return spx(at).close / spx(at - 1).close - 1;
    });
    const mean = returns.reduce((sum, value) => sum + value, 0) / 30;
    const volatility = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 30);
    let weighted = 0, volume = 0;
    for (let minute = 570; minute <= cutoffMinute; minute++) {
      const bar = spy(minute); weighted += (bar.high + bar.low + bar.close) / 3 * bar.volume!; volume += bar.volume!;
    }
    if (!(volume > 0) || !finite(weighted) || !finite(volume) || !(weighted / volume > 0)) return unavailable("SPY cumulative RTH VWAP is unavailable.");
    result.features = {
      spx_return_5: last / spx(cutoffMinute - 5).close - 1,
      spx_return_15: last / spx(cutoffMinute - 15).close - 1,
      spx_return_volatility_30: volatility, spy_vwap_gap: spy(cutoffMinute).close / (weighted / volume) - 1,
      sector_signed_breadth: network.signedBreadth, bullish_cluster_fraction: network.bullishCluster.fraction,
      bearish_cluster_fraction: network.bearishCluster.fraction, bullish_growth_5: network.bullishGrowth,
      bearish_growth_5: network.bearishGrowth, mean_correlation: network.meanCorrelation,
    };
    result.featureVector = NETWORK_FORECAST_FEATURES.map(name => result.features![name]);
    if (!result.featureVector.every(finite)) { result.features = null; result.featureVector = null; return unavailable("Forecast features contain a nonfinite value."); }
    for (const horizon of result.horizons) {
      if (horizon.targetEndMinute > sessionClose) { horizon.reason = "This horizon extends beyond the verified cash close."; continue; }
      const candidates = bundle.models.filter(model => model?.horizon_minutes === horizon.minutes && model.valid_month === sessionDate.slice(0, 7));
      if (candidates.length !== 1) { horizon.reason = candidates.length ? "Duplicate model identities for this month and horizon." : "No prior-only model is available for this month and horizon."; continue; }
      const model = candidates[0], error = modelError(model, sessionDate);
      if (error) { horizon.reason = error; continue; }
      let z = model.beta[0];
      for (let i = 0; i < result.featureVector.length; i++) z += model.beta[i + 1] * (result.featureVector[i] - model.mean[i]) / model.scale[i];
      if (!finite(z)) { horizon.reason = "Model score is numerically invalid."; continue; }
      const probabilityUp = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
      Object.assign(horizon, { status: "available", reason: "Experimental model estimate; the display band is not backtested.",
        direction: networkForecastDirection(probabilityUp), probabilityUp, probabilityDown: 1 - probabilityUp,
        modelId: model.id, trainingThrough: model.train_end, validMonth: model.valid_month, trainingUpProbability: model.training_up_fraction });
    }
    if (result.horizons.some(h => h.status === "available")) {
      result.status = "available"; result.reason = "Experimental SPX direction estimate. Neutral means a weak directional estimate, not a flat-price probability.";
    } else result.reason = result.horizons.map(h => `${h.minutes}m: ${h.reason}`).join(" ");
    return result;
  } catch (error) {
    result.features = null; result.featureVector = null;
    return unavailable(error instanceof Error ? error.message : "Invalid price history.");
  }
}
