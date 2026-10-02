import { NETWORK_SYMBOLS, type NetworkContext } from "./network-regime.ts";
import { calculateSpongeNetwork, parseSpongeNetworkBundle, spongeNetworkDirection, SPONGE_MACRO_FEATURES,
  type SpongeNetworkBundle, type SpongeNetworkInput, type SpongeNetworkResult, type SpongeNetworkHorizon,
  type SpongeNetworkFit, type SpongeNetworkLink, type SpongeNetworkPriceBar } from "./sponge-network.ts";

export const SPONGE_MISSING_RAW_FEATURES = [...SPONGE_MACRO_FEATURES.slice(0, 4),
  ...SPONGE_MACRO_FEATURES.slice(5, 27), ...SPONGE_MACRO_FEATURES.slice(31)] as const;
export type SpongeMissingVersion = {
  id: string; source_version_id: string; source_model_ids: Record<"30" | "60", string>;
  valid_from: string; valid_to: string; train_start: string; train_end: string; training_rows: number; training_days: number;
  mean: number[]; scale: number[]; covariance: number[][];
};
export type SpongeMissingBundle = {
  schema_version: 1; model_kind: "persistent-sponge-missing-features"; generated_at: string; latest_version_id: string;
  input_bundle: SpongeNetworkBundle; input_bundle_sha256: string; raw_feature_order: string[];
  policy: { covariance_shrinkage: 0.2; ridge: 1e-8; min_training_rows: 350; min_training_days: 80;
    max_missing_nodes: 2; max_missing_features: 4; min_complete_sector_nodes: 9; required_core_features: string[];
    max_observed_abs_z: 6; max_estimated_abs_z: 6; draws: 64; seed: 20261001; sensitivity_quantiles: number[] };
  standard_normal_draws: number[][]; versions: SpongeMissingVersion[]; unavailable_folds: unknown[];
};
export type SpongeEstimatedFeature = { feature: string; symbol: string; value: number; conditionalStd: number;
  marginalStd: number; varianceExplained: number; reason: string };
export type SpongeMissingEstimate = {
  mode: "observed" | "estimated" | "unavailable"; observedRawFeatureCount: number; totalRawFeatureCount: 30;
  estimatedFeatures: SpongeEstimatedFeature[]; estimatedNodes: string[]; covarianceId: string | null; trainingThrough: string | null;
};
export type SpongeMissingHorizon = SpongeNetworkHorizon & { sensitivityLow: number | null; sensitivityHigh: number | null; directionStable: boolean | null };
export type SpongeMissingResult = Omit<SpongeNetworkResult, "horizons"> & { missingInputEstimate: SpongeMissingEstimate; horizons: SpongeMissingHorizon[] };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, wanted: readonly unknown[]) => Array.isArray(value) && value.length === wanted.length && value.every((item, i) => item === wanted[i]);
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const symbolFor = (feature: string) => feature.startsWith("spx_") ? "SPX" : feature.startsWith("spy_") ? "SPY" : feature.split("_")[0];
function requireValid(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(`Invalid missing-input bundle: ${reason}`); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Only absent observations or no-qualifying-price rows may be estimated. Corrupt
 * source identity, malformed prices and duplicate/off-grid records fail closed. */
class ObservationIssue extends Error {
  fatal: boolean;
  constructor(message: string, fatal = false) { super(message); this.fatal = fatal; }
}
type Price = SpongeNetworkPriceBar & { count?: unknown; source_valid?: unknown; identity_valid?: unknown };
function minuteBook(rows: SpongeNetworkPriceBar[], date: string, cutoff: number, symbol: string, volume: boolean, oil = false) {
  const book = new Map<number, Price[]>(), offGrid = new Set<number>();
  for (const bar of rows) {
    if (!bar || typeof bar.timestamp !== "string" || !bar.timestamp.startsWith(`${date}T`)) continue;
    const time = bar.timestamp.slice(11);
    if (!/^\d{2}:\d{2}:/.test(time)) throw new ObservationIssue(`${symbol}: malformed source timestamp.`, true);
    const hour = Number(time.slice(0, 2)), minute = Number(time.slice(3, 5)), at = hour * 60 + minute;
    if (hour > 23 || minute > 59) throw new ObservationIssue(`${symbol}: malformed source timestamp.`, true);
    if (at < 570 || at > cutoff) continue;
    if (!/^\d{2}:\d{2}:00(?:\.0+)?$/.test(time)) { offGrid.add(at); continue; }
    const values = book.get(at) ?? []; values.push(bar); book.set(at, values);
  }
  return (at: number): Price => {
    const values = book.get(at);
    if (offGrid.has(at)) throw new ObservationIssue(`${symbol}: off-grid source timestamp at minute ${at}.`, true);
    if (!values) throw new ObservationIssue(`${symbol}: missing completed minute ${at}.`);
    if (values.length !== 1) throw new ObservationIssue(`${symbol}: duplicate completed minute ${at}.`, true);
    const bar = values[0], prices = [bar.open, bar.high, bar.low, bar.close];
    if (bar.source_valid !== undefined && bar.source_valid !== true || bar.identity_valid !== undefined && bar.identity_valid !== true)
      throw new ObservationIssue(`${symbol}: invalid source or instrument identity at minute ${at}.`, true);
    if (volume && (!finite(bar.volume) || bar.volume < 0)) throw new ObservationIssue(`${symbol}: malformed volume at minute ${at}.`, true);
    if (oil && bar.count !== undefined && (!finite(bar.count) || bar.count < 0)) throw new ObservationIssue(`${symbol}: malformed trade count at minute ${at}.`, true);
    if (prices.every(price => price === 0)) throw new ObservationIssue(`${symbol}: no qualifying price at minute ${at}.`);
    if (!prices.every(price => finite(price) && price > 0) || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close))
      throw new ObservationIssue(`${symbol}: malformed OHLC at minute ${at}.`, true);
    if (oil && (!(bar.volume! > 0) || bar.count !== undefined && (!finite(bar.count) || bar.count <= 0)))
      throw new ObservationIssue(`${symbol}: no qualifying traded oil-fund bar at minute ${at}.`);
    return bar;
  };
}
function contextBook(context: NetworkContext[], symbol: string, date: string, cutoff: number) {
  const matches = context.filter(entry => entry?.symbol === symbol);
  if (!matches.length) throw new ObservationIssue(`${symbol}: source history unavailable.`);
  if (matches.length !== 1 || !Array.isArray(matches[0].bars)) throw new ObservationIssue(`${symbol}: malformed or duplicate symbol context.`, true);
  return minuteBook(matches[0].bars, date, cutoff, symbol, symbol !== "TNX", symbol === "USO");
}
function vwap(book: ReturnType<typeof minuteBook>, cutoff: number, symbol: string) {
  let weighted = 0, volume = 0, absent: ObservationIssue | null = null;
  // A legitimate early gap must never conceal corrupt data later in the prefix.
  for (let at = 570; at <= cutoff; at++) {
    try { const bar = book(at); weighted += (bar.high + bar.low + bar.close) / 3 * bar.volume!; volume += bar.volume!; }
    catch (error) { if (!(error instanceof ObservationIssue) || error.fatal) throw error; absent ??= error; }
  }
  if (absent) throw absent;
  if (!(volume > 0) || !finite(weighted / volume)) throw new ObservationIssue(`${symbol}: cumulative volume is unavailable.`);
  return weighted / volume;
}
function requiredPrices(book: ReturnType<typeof minuteBook>, minutes: number[]): Price[] {
  let absent: ObservationIssue | null = null;
  const prices = minutes.map(minute => {
    try { return book(minute); }
    catch (error) { if (!(error instanceof ObservationIssue) || error.fatal) throw error; absent ??= error; return null; }
  });
  if (absent) throw absent;
  return prices as Price[];
}
type RawInputs = { values: Record<string, number | null>; reasons: Record<string, string>; fatal: string[] };
function rawInputs(input: SpongeNetworkInput, cutoff: number, date: string): RawInputs {
  const values: Record<string, number | null> = {}, reasons: Record<string, string> = {}, fatal: string[] = [];
  const capture = (feature: string, get: () => number) => {
    try { const value = get(); if (!finite(value)) throw new ObservationIssue(`${feature}: nonfinite feature.`, true); values[feature] = value; }
    catch (error) { values[feature] = null; reasons[feature] = error instanceof Error ? error.message : "Invalid input.";
      if (!(error instanceof ObservationIssue) || error.fatal) fatal.push(reasons[feature]); }
  };
  const spx = () => minuteBook(input.spxBars, date, cutoff, "SPX", false), spy = () => minuteBook(input.spyBars, date, cutoff, "SPY", true);
  capture("spx_return_5", () => { const book = spx(); return book(cutoff).close / book(cutoff - 5).close - 1; });
  capture("spx_return_15", () => { const book = spx(); return book(cutoff).close / book(cutoff - 15).close - 1; });
  capture("spx_return_volatility_30", () => {
    const book = spx(), returns = Array.from({ length: 30 }, (_, i) => book(cutoff - 29 + i).close / book(cutoff - 30 + i).close - 1);
    const mean = returns.reduce((sum, value) => sum + value, 0) / 30;
    return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 30);
  });
  capture("spy_vwap_gap", () => { const book = spy(); return book(cutoff).close / vwap(book, cutoff, "SPY") - 1; });
  for (const symbol of [...NETWORK_SYMBOLS, "USO"]) {
    const book = () => contextBook(symbol === "USO" ? input.macroContext ?? [] : input.sectorContext, symbol, date, cutoff);
    capture(`${symbol}_return_5`, () => { const prices = book(); return prices(cutoff).close / prices(cutoff - 5).close - 1; });
    capture(`${symbol}_vwap_gap`, () => { const prices = book(), weighted = vwap(prices, cutoff, symbol); return prices(cutoff).close / weighted - 1; });
  }
  const rates = () => contextBook(input.macroContext ?? [], "TNX", date, cutoff);
  capture("TNX_change_5_bps", () => { const [current, prior] = requiredPrices(rates(), [cutoff, cutoff - 5]); return (current.close - prior.close) * 10; });
  capture("TNX_change_from_open_bps", () => { const [current, open] = requiredPrices(rates(), [cutoff, 570]); return (current.close - open.open) * 10; });
  return { values, reasons, fatal };
}

function cholesky(matrix: number[][]): number[][] {
  const out = matrix.map(row => row.map(() => 0));
  for (let i = 0; i < matrix.length; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i][j]; for (let k = 0; k < j; k++) value -= out[i][k] * out[j][k];
    if (i === j) { if (!(value > 0) || !finite(value)) throw new Error("Covariance is not positive definite."); out[i][j] = Math.sqrt(value); }
    else out[i][j] = value / out[j][j];
  }
  return out;
}
function solve(lower: number[][], vector: number[]): number[] {
  const n = vector.length, intermediate = Array(n).fill(0), out = Array(n).fill(0);
  for (let i = 0; i < n; i++) { let v = vector[i]; for (let j = 0; j < i; j++) v -= lower[i][j] * intermediate[j]; intermediate[i] = v / lower[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let v = intermediate[i]; for (let j = i + 1; j < n; j++) v -= lower[j][i] * out[j]; out[i] = v / lower[i][i]; }
  return out;
}
function graphFeatures(raw: Record<string, number>, links: readonly SpongeNetworkLink[]) {
  const features = { ...raw }, signs = new Map<string, number>(NETWORK_SYMBOLS.map(symbol => {
    const a = raw[`${symbol}_return_5`], b = raw[`${symbol}_vwap_gap`]; return [symbol, a > 0 && b > 0 ? 1 : a < 0 && b < 0 ? -1 : 0];
  }));
  features.sector_signed_breadth = [...signs.values()].reduce((a, b) => a + b, 0) / 11;
  const totalWeight = links.reduce((sum, edge) => sum + edge.weight, 0);
  for (const [name, sign] of [["bullish", 1], ["bearish", -1]] as const) {
    const active = new Set([...signs].filter(([, value]) => value === sign).map(([symbol]) => symbol)), seen = new Set<string>(); let largest = 0;
    for (const symbol of active) {
      if (seen.has(symbol)) continue;
      const queue = [symbol]; seen.add(symbol);
      for (let i = 0; i < queue.length; i++) for (const link of links) {
        const next = link.source === queue[i] ? link.target : link.target === queue[i] ? link.source : null;
        if (next && active.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
      largest = Math.max(largest, queue.length);
    }
    features[`${name}_cluster_fraction`] = largest / 11;
    features[`${name}_edge_weight_fraction`] = totalWeight ? links.reduce((sum, link) => sum + (signs.get(link.source) === sign && signs.get(link.target) === sign ? link.weight : 0), 0) / totalWeight : 0;
  }
  return features;
}
function score(model: SpongeNetworkFit, features: Record<string, number>) {
  const contributions = model.feature_order.map((feature, i) => {
    const standardized = (features[feature] - model.mean[i]) / model.scale[i];
    return { feature, value: features[feature], standardized, coefficient: model.beta[i + 1], logOdds: standardized * model.beta[i + 1] };
  });
  const logOdds = contributions.reduce((sum, item) => sum + item.logOdds, model.beta[0]);
  if (!finite(logOdds) || contributions.some(item => !finite(item.logOdds))) throw new Error("Conditional model score is numerically invalid.");
  const probabilityUp = logOdds >= 0 ? 1 / (1 + Math.exp(-logOdds)) : Math.exp(logOdds) / (1 + Math.exp(logOdds));
  return { contributions, logOdds, probabilityUp };
}

const validated = new WeakSet<object>();
/** Detached, frozen monthly conditioning parameters. No live fitting occurs. */
export function parseSpongeMissingBundle(value: unknown): SpongeMissingBundle {
  if (value && typeof value === "object" && validated.has(value)) return value as SpongeMissingBundle;
  let raw: unknown;
  try { raw = structuredClone(value); } catch { throw new Error("Invalid missing-input bundle: export cannot be copied."); }
  requireValid(record(raw) && raw.schema_version === 1 && raw.model_kind === "persistent-sponge-missing-features", "unsupported schema.");
  const input = parseSpongeNetworkBundle(raw.input_bundle);
  requireValid(input.schema_version === 2, "the original macro model is required."); raw.input_bundle = input;
  requireValid(typeof raw.input_bundle_sha256 === "string" && /^[a-f0-9]{64}$/.test(raw.input_bundle_sha256), "source fingerprint missing.");
  requireValid(exact(raw.raw_feature_order, SPONGE_MISSING_RAW_FEATURES), "raw feature order differs.");
  const policy = raw.policy;
  requireValid(record(policy) && policy.covariance_shrinkage === .2 && policy.ridge === 1e-8 && policy.min_training_rows === 350 && policy.min_training_days === 80 &&
    policy.max_missing_nodes === 2 && policy.max_missing_features === 4 && policy.min_complete_sector_nodes === 9 &&
    exact(policy.required_core_features, SPONGE_MISSING_RAW_FEATURES.slice(0, 4)) && policy.max_observed_abs_z === 6 && policy.max_estimated_abs_z === 6 &&
    policy.draws === 64 && policy.seed === 20261001 && exact(policy.sensitivity_quantiles, [.1, .9]), "conditioning policy differs.");
  requireValid(Array.isArray(raw.standard_normal_draws) && raw.standard_normal_draws.length === 64 &&
    raw.standard_normal_draws.every(row => Array.isArray(row) && row.length === 4 && row.every(finite)), "64 saved four-dimensional sensitivity draws are required.");
  const draws = raw.standard_normal_draws as number[][];
  requireValid(draws.slice(0, 32).every((row, i) => row.every((n, j) => n === -draws[i + 32][j])), "sensitivity draws must be antithetic.");
  requireValid(Array.isArray(raw.versions) && raw.versions.length > 0 && Array.isArray(raw.unavailable_folds), "dated versions are required.");
  const ids = new Set<string>(), months = new Set<string>(); let latest: SpongeMissingVersion | null = null;
  for (const item of raw.versions) {
    requireValid(record(item) && typeof item.id === "string" && item.id.length > 0 && !ids.has(item.id), "duplicate or absent version identity."); ids.add(item.id);
    const source = input.versions.find(version => version.id === item.source_version_id);
    requireValid(source && item.valid_from === source.valid_from && item.valid_to === source.valid_to && !months.has(source.valid_from), "source validity month differs."); months.add(source.valid_from);
    const modelIds = item.source_model_ids;
    requireValid(record(modelIds) && exact(Object.keys(modelIds).sort(), ["30", "60"]) &&
      ["30", "60"].every(horizon => modelIds[horizon] === source.models[horizon as "30" | "60"].macro_sponge.id), "source model identity differs.");
    requireValid(validDate(item.train_start) && validDate(item.train_end) && item.train_start >= source.train_start && item.train_start <= item.train_end &&
      item.train_end <= source.train_end && item.train_end < source.valid_from && finite(item.training_rows) && Number.isInteger(item.training_rows) && item.training_rows >= 350 &&
      finite(item.training_days) && Number.isInteger(item.training_days) && item.training_days >= 80 && item.training_days <= item.training_rows &&
      item.training_days <= Math.floor((Date.parse(item.train_end) - Date.parse(item.train_start)) / 86400000) + 1, "prior-only training coverage is invalid.");
    requireValid(Array.isArray(item.mean) && item.mean.length === 30 && item.mean.every(finite) && Array.isArray(item.scale) && item.scale.length === 30 &&
      item.scale.every(n => finite(n) && n > 0), "raw transforms are invalid.");
    requireValid(Array.isArray(item.covariance) && item.covariance.length === 30 && item.covariance.every(row => Array.isArray(row) && row.length === 30 && row.every(finite)), "covariance must be 30 by 30.");
    const covariance = item.covariance as number[][];
    requireValid(covariance.every((row, i) => row.every((n, j) => Math.abs(n - covariance[j][i]) <= 1e-12 && (i !== j || Math.abs(n - 1) <= 1e-10))), "covariance symmetry or units differ.");
    try { cholesky(covariance); } catch { throw new Error("Invalid missing-input bundle: covariance is not positive definite."); }
    if (!latest || source.valid_from > latest.valid_from) latest = item as unknown as SpongeMissingVersion;
  }
  requireValid(raw.latest_version_id === latest?.id, "latest version identity differs.");
  const result = freeze(raw) as unknown as SpongeMissingBundle; validated.add(result); return result;
}

/** Exposed for cross-language numerical parity checks. Operates solely on saved
 * moments and the supplied primitive observations; it never changes source bars. */
export function conditionSpongeMissingFeatures(rawValues: Record<string, number | null>, version: SpongeMissingVersion, ridge = 1e-8) {
  const missing: number[] = [], observed: number[] = [];
  SPONGE_MISSING_RAW_FEATURES.forEach((name, i) => { if (finite(rawValues[name])) observed.push(i); else missing.push(i); });
  const z = observed.map(i => (rawValues[SPONGE_MISSING_RAW_FEATURES[i]]! - version.mean[i]) / version.scale[i]);
  if (z.some(value => !finite(value) || Math.abs(value) > 6)) throw new Error("Observed inputs exceed the saved model's six-standard-deviation guard.");
  const a = observed.map(i => observed.map(j => version.covariance[i][j] + (i === j ? ridge : 0))), lower = cholesky(a), solved = solve(lower, z);
  const cross = missing.map(i => observed.map(j => version.covariance[i][j]));
  const conditionalMean = cross.map(row => row.reduce((sum, value, j) => sum + value * solved[j], 0));
  if (conditionalMean.some(value => !finite(value) || Math.abs(value) > 6)) throw new Error("Estimated inputs exceed the saved model's six-standard-deviation guard.");
  const solvedCross = cross.map(row => solve(lower, row));
  const covariance = missing.map((i, row) => missing.map((j, col) => version.covariance[i][j] - cross[row].reduce((sum, value, k) => sum + value * solvedCross[col][k], 0)));
  for (let i = 0; i < covariance.length; i++) for (let j = i; j < covariance.length; j++) {
    const average = (covariance[i][j] + covariance[j][i]) / 2; covariance[i][j] = covariance[j][i] = average;
  }
  const values = { ...rawValues } as Record<string, number>;
  missing.forEach((i, j) => { values[SPONGE_MISSING_RAW_FEATURES[i]] = version.mean[i] + version.scale[i] * conditionalMean[j]; });
  if (Object.values(values).some(value => !finite(value))) throw new Error("Estimated features are numerically invalid.");
  return { values, missing, observed, conditionalMean, covariance, lower: missing.length ? cholesky(covariance) : [] };
}
const quantile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b), at = (sorted.length - 1) * p, lo = Math.floor(at); return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo); };
/** Shared production and cross-language audit path for feature-level conditioning,
 * nonlinear graph reconstruction and fixed conditional-sensitivity draws. */
export function evaluateSpongeMissingFeatures(rawValues: Record<string, number | null>, version: SpongeMissingVersion, bundle: SpongeMissingBundle) {
  const modelVersion = bundle.input_bundle.versions.find(item => item.id === version.source_version_id);
  if (!modelVersion) throw new Error("The original monthly model is unavailable.");
  const conditioned = conditionSpongeMissingFeatures(rawValues, version, bundle.policy.ridge), features = graphFeatures(conditioned.values, modelVersion.graph.edges);
  const drawFeatures = bundle.standard_normal_draws.map(draw => {
    const values = { ...conditioned.values };
    conditioned.missing.forEach((index, row) => {
      const z = conditioned.conditionalMean[row] + conditioned.lower[row].reduce((sum, value, column) => sum + value * draw[column], 0);
      values[SPONGE_MISSING_RAW_FEATURES[index]] = version.mean[index] + version.scale[index] * z;
    });
    return graphFeatures(values, modelVersion.graph.edges);
  });
  const horizons = (["30", "60"] as const).map(key => {
    const model = modelVersion.models[key].macro_sponge, scored = score(model, features), sensitivity = drawFeatures.map(draw => score(model, draw).probabilityUp);
    const low = quantile(sensitivity, .1), high = quantile(sensitivity, .9);
    return { minutes: Number(key), model, scored, sensitivity, low, high,
      stable: spongeNetworkDirection(low) === spongeNetworkDirection(high) && spongeNetworkDirection(low) === spongeNetworkDirection(scored.probabilityUp) };
  });
  return { conditioned, features, horizons };
}
function empty(base: SpongeNetworkResult): SpongeMissingResult {
  return { ...base, missingInputEstimate: { mode: "unavailable", observedRawFeatureCount: 0, totalRawFeatureCount: 30,
    estimatedFeatures: [], estimatedNodes: [], covarianceId: null, trainingThrough: null },
    horizons: base.horizons.map(horizon => ({ ...horizon, sensitivityLow: null, sensitivityHigh: null, directionStable: null })) };
}

/** Use prior learned cross-feature covariance only for missing primitive metrics.
 * SPX/SPY, source integrity, monthly validity, freshness and close limits remain
 * strict. Saved draws expose conditional sensitivity, never a calibrated CI. */
export function calculateSpongeMissing(input: SpongeNetworkInput, cutoffMinute: number, sessionDate: string,
  source: SpongeMissingBundle | null | undefined, sessionClose = 960, inputsFresh = true): SpongeMissingResult {
  let bundle: SpongeMissingBundle;
  try { bundle = parseSpongeMissingBundle(source); }
  catch (error) { const result = empty(calculateSpongeNetwork(input, cutoffMinute, sessionDate, null, sessionClose));
    result.reason = error instanceof Error ? error.message : "Missing-input parameters unavailable."; result.horizons.forEach(h => { h.reason = result.reason; }); return result; }
  const base = calculateSpongeNetwork(input, cutoffMinute, sessionDate, bundle.input_bundle, sessionClose), result = empty(base);
  const unavailable = (reason: string) => {
    result.status = base.status === "warming" ? "warming" : "unavailable"; result.reason = reason; result.features = null; result.featureVector = null;
    result.horizons.forEach(h => { Object.assign(h, { status: "unavailable", reason, direction: null, probabilityUp: null, probabilityDown: null,
      intercept: null, logOdds: null, featureContributions: [], nodeContributions: [], macroContributions: [], sensitivityLow: null, sensitivityHigh: null, directionStable: null }); });
    return result;
  };
  if (inputsFresh !== true) return unavailable("Underlying price feeds are stale; conditional estimates are held.");
  if (base.status === "available") {
    result.missingInputEstimate.mode = "observed"; result.missingInputEstimate.observedRawFeatureCount = 30; return result;
  }
  if (!base.graph || base.status === "warming" || !validDate(sessionDate) || !Number.isInteger(cutoffMinute) || cutoffMinute < 635 || cutoffMinute + 31 > sessionClose ||
    !input || !Array.isArray(input.spxBars) || !Array.isArray(input.spyBars) || !Array.isArray(input.sectorContext)) return unavailable(base.reason);
  const version = bundle.versions.find(item => sessionDate >= item.valid_from && sessionDate <= item.valid_to);
  if (!version) return unavailable("No prior-only missing-input parameters are valid for this session month.");
  result.missingInputEstimate.covarianceId = version.id; result.missingInputEstimate.trainingThrough = version.train_end;
  try {
    const raw = rawInputs(input, cutoffMinute, sessionDate), missingNames = SPONGE_MISSING_RAW_FEATURES.filter(feature => raw.values[feature] === null);
    const missingNodes = [...new Set(missingNames.map(symbolFor))];
    result.missingInputEstimate.observedRawFeatureCount = 30 - missingNames.length;
    result.missingInputEstimate.estimatedNodes = missingNodes;
    if (raw.fatal.length) return unavailable(`Source integrity prevents estimation. ${raw.fatal[0]}`);
    const coreMissing = missingNames.find(feature => SPONGE_MISSING_RAW_FEATURES.slice(0, 4).includes(feature));
    if (coreMissing) return unavailable(`SPX and SPY core inputs cannot be estimated. ${raw.reasons[coreMissing]}`);
    if (!missingNames.length) return unavailable(base.reason);
    if (missingNodes.length > 2 || missingNames.length > 4 || NETWORK_SYMBOLS.filter(symbol => !missingNodes.includes(symbol)).length < 9)
      return unavailable(`Historical-correlation fallback held: ${missingNodes.length} market nodes (${missingNodes.join(", ")}) have ${missingNames.length} missing features; ${30 - missingNames.length}/30 raw features are observed. The saved fallback supports at most two missing nodes, four missing features and at least nine fully observed sectors.`);
    const evaluation = evaluateSpongeMissingFeatures(raw.values, version, bundle), { conditioned, features } = evaluation;
    result.missingInputEstimate.estimatedFeatures = conditioned.missing.map((index, j) => ({ feature: SPONGE_MISSING_RAW_FEATURES[index],
      symbol: symbolFor(SPONGE_MISSING_RAW_FEATURES[index]), value: conditioned.values[SPONGE_MISSING_RAW_FEATURES[index]],
      conditionalStd: version.scale[index] * Math.sqrt(conditioned.covariance[j][j]), marginalStd: version.scale[index] * Math.sqrt(version.covariance[index][index]),
      varianceExplained: Math.max(0, Math.min(1, 1 - conditioned.covariance[j][j] / version.covariance[index][index])), reason: raw.reasons[SPONGE_MISSING_RAW_FEATURES[index]] }));
    result.features = features; result.featureVector = SPONGE_MACRO_FEATURES.map(feature => features[feature]);
    for (const horizon of result.horizons) {
      if (horizon.targetEndMinute > sessionClose) { horizon.reason = "This horizon extends beyond the verified cash close."; continue; }
      const { model, scored, low, high, stable } = evaluation.horizons.find(item => item.minutes === horizon.minutes)!;
      const byFeature = new Map(scored.contributions.map(item => [item.feature, item.logOdds]));
      Object.assign(horizon, { status: "available", reason: "Estimated missing metrics using frozen historical covariance; sensitivity is not a confidence interval.",
        direction: spongeNetworkDirection(scored.probabilityUp), probabilityUp: scored.probabilityUp, probabilityDown: 1 - scored.probabilityUp,
        intercept: model.beta[0], logOdds: scored.logOdds, featureContributions: scored.contributions.sort((a, b) => Math.abs(b.logOdds) - Math.abs(a.logOdds)),
        nodeContributions: NETWORK_SYMBOLS.map(symbol => {
          const returnLogOdds = byFeature.get(`${symbol}_return_5`)!, vwapLogOdds = byFeature.get(`${symbol}_vwap_gap`)!;
          return { symbol, logOdds: returnLogOdds + vwapLogOdds, returnLogOdds, vwapLogOdds };
        }).sort((a, b) => Math.abs(b.logOdds) - Math.abs(a.logOdds)),
        macroContributions: (["USO", "TNX"] as const).map(symbol => { const featureContributions = scored.contributions.filter(item => item.feature.startsWith(`${symbol}_`));
          return { symbol, family: symbol === "USO" ? "oil" : "rates", logOdds: featureContributions.reduce((sum, item) => sum + item.logOdds, 0), featureContributions }; }),
        sensitivityLow: low, sensitivityHigh: high, directionStable: stable });
    }
    if (!result.horizons.some(horizon => horizon.status === "available")) return unavailable("No conditional forecast horizon fits before the verified cash close.");
    result.status = "available"; result.reason = "Conditional estimate from the saved historical relationships; observed market coverage remains unchanged.";
    result.missingInputEstimate.mode = "estimated"; return result;
  } catch (error) { return unavailable(error instanceof Error ? error.message : "Conditional estimate unavailable."); }
}
