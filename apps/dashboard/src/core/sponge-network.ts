import type { Bar } from "./engine.ts";
import { NETWORK_SYMBOLS, type NetworkContext } from "./network-regime.ts";

export const SPONGE_NETWORK_FEATURES = [
  "spx_return_5", "spx_return_15", "spx_return_volatility_30", "spy_vwap_gap", "sector_signed_breadth",
  ...NETWORK_SYMBOLS.flatMap(symbol => [`${symbol}_return_5`, `${symbol}_vwap_gap`]),
  "bullish_cluster_fraction", "bearish_cluster_fraction", "bullish_edge_weight_fraction", "bearish_edge_weight_fraction",
] as const;
export const SPONGE_NETWORK_BAND = [0.45, 0.55] as const;
export const SPONGE_MACRO_SYMBOLS = ["USO", "TNX"] as const;
export const SPONGE_MACRO_FEATURES = [...SPONGE_NETWORK_FEATURES,
  "USO_return_5", "USO_vwap_gap", "TNX_change_5_bps", "TNX_change_from_open_bps",
] as const;
export type SpongeNetworkDirection = "bullish" | "bearish" | "neutral";
export type SpongeNetworkPriceBar = Omit<Bar, "volume"> & { volume?: number };
export type SpongeNetworkInput = { spxBars: SpongeNetworkPriceBar[]; spyBars: Bar[]; sectorContext: NetworkContext[]; macroContext?: NetworkContext[] };
export type SpongeNetworkLink = { source: string; target: string; weight: number };
export type SpongeNetworkNode = {
  symbol: string; eligible: boolean; reason: string; sign: -1 | 0 | 1;
  close: number | null; vwap: number | null; fiveMinuteReturn: number | null; vwapGap: number | null;
};
export type SpongeGraphMetadata = {
  id: string; validMonth: string; validFrom: string; validThrough: string; trainingThrough: string;
  trainingRows: number; trainingDays: number; threshold: number; links: readonly SpongeNetworkLink[];
};
export type SpongeFeatureContribution = { feature: string; value: number; standardized: number; coefficient: number; logOdds: number };
export type SpongeNodeContribution = { symbol: string; logOdds: number; returnLogOdds: number; vwapLogOdds: number };
export type SpongeMacroNode = {
  symbol: typeof SPONGE_MACRO_SYMBOLS[number]; family: "oil" | "rates"; eligible: boolean; reason: string;
  close: number | null; fiveMinuteReturn: number | null; vwap: number | null; vwapGap: number | null;
  yieldPercent: number | null; change5Bps: number | null; changeFromOpenBps: number | null;
};
export type SpongeMacroContribution = {
  symbol: typeof SPONGE_MACRO_SYMBOLS[number]; family: "oil" | "rates"; logOdds: number; featureContributions: SpongeFeatureContribution[];
};
export type SpongeNetworkHorizon = {
  minutes: 30 | 60; status: "available" | "unavailable"; reason: string; direction: SpongeNetworkDirection | null;
  probabilityUp: number | null; probabilityDown: number | null; modelId: string | null; trainingThrough: string | null;
  validMonth: string | null; trainingUpProbability: number | null; targetEndMinute: number;
  intercept: number | null; logOdds: number | null;
  featureContributions: SpongeFeatureContribution[]; nodeContributions: SpongeNodeContribution[]; macroContributions: SpongeMacroContribution[];
};
export type SpongeNetworkResult = {
  experimental: true; status: "available" | "warming" | "unavailable"; reason: string;
  asOf: number; decisionMinute: number; sessionDate: string; graph: SpongeGraphMetadata | null; nodes: SpongeNetworkNode[];
  macroNodes: SpongeMacroNode[]; macroCoverage: { eligible: number; total: 0 | 2 };
  coverage: { eligible: number; total: 11; fraction: number }; features: Record<string, number> | null; featureVector: number[] | null;
  displayBand: typeof SPONGE_NETWORK_BAND; bandBacktested: false; studiedDecisionMinute: boolean; horizons: SpongeNetworkHorizon[];
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validDate = (date: unknown): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const validPrice = (bar: SpongeNetworkPriceBar) => [bar.open, bar.high, bar.low, bar.close].every(value => finite(value) && value > 0) &&
  bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close);
const blankNode = (symbol: string): SpongeNetworkNode => ({ symbol, eligible: false, reason: "Live sector history is unavailable.", sign: 0,
  close: null, vwap: null, fiveMinuteReturn: null, vwapGap: null });

/** Neutral is a weak binary directional estimate, never an estimated flat-price probability. */
export function spongeNetworkDirection(probabilityUp: number): SpongeNetworkDirection | null {
  if (!finite(probabilityUp) || probabilityUp < 0 || probabilityUp > 1) return null;
  return probabilityUp > SPONGE_NETWORK_BAND[1] ? "bullish" : probabilityUp < SPONGE_NETWORK_BAND[0] ? "bearish" : "neutral";
}

function minuteBook(bars: SpongeNetworkPriceBar[], date: string, cutoff: number, symbol: string, needsVolume: boolean) {
  const book = new Map<number, SpongeNetworkPriceBar[]>(), invalid = new Set<number>();
  for (const bar of bars) {
    if (!bar || typeof bar.timestamp !== "string" || !bar.timestamp.startsWith(`${date}T`)) continue;
    const clock = bar.timestamp.slice(11);
    if (!/^\d{2}:\d{2}:/.test(clock)) continue;
    const hour = Number(clock.slice(0, 2)), minute = Number(clock.slice(3, 5)), at = hour * 60 + minute;
    if (hour >= 24 || minute >= 60 || at < 570 || at > cutoff) continue;
    if (!/^\d{2}:\d{2}:00(?:\.0+)?$/.test(clock)) { invalid.add(at); continue; }
    const rows = book.get(at) ?? []; rows.push(bar); book.set(at, rows);
  }
  return (minute: number): SpongeNetworkPriceBar => {
    const rows = book.get(minute);
    if (invalid.has(minute)) throw new Error(`${symbol}: off-grid source timestamp at minute ${minute}.`);
    if (!rows || rows.length !== 1) throw new Error(`${symbol}: missing or duplicate completed minute ${minute}.`);
    if (!validPrice(rows[0]) || needsVolume && (!finite(rows[0].volume) || rows[0].volume < 0))
      throw new Error(`${symbol}: invalid ${needsVolume ? "OHLCV" : "price"} at minute ${minute}.`);
    return rows[0];
  };
}

function prefixVWAP(book: ReturnType<typeof minuteBook>, cutoff: number, symbol: string): number {
  let weighted = 0, volume = 0;
  for (let minute = 570; minute <= cutoff; minute++) {
    const bar = book(minute); weighted += (bar.high + bar.low + bar.close) / 3 * bar.volume!; volume += bar.volume!;
  }
  if (!(volume > 0) || !finite(weighted) || !finite(volume) || !finite(weighted / volume) || !(weighted / volume > 0))
    throw new Error(`${symbol}: cumulative RTH VWAP is unavailable.`);
  return weighted / volume;
}

function liveNode(context: NetworkContext[], symbol: string, cutoff: number, date: string): SpongeNetworkNode {
  const node = blankNode(symbol), entries = context.filter(entry => entry?.symbol === symbol);
  try {
    if (entries.length !== 1 || !Array.isArray(entries[0].bars)) throw new Error(`${symbol}: missing or duplicate symbol context.`);
    const book = minuteBook(entries[0].bars, date, cutoff, symbol, true), vwap = prefixVWAP(book, cutoff, symbol);
    const close = book(cutoff).close, fiveMinuteReturn = close / book(cutoff - 5).close - 1, vwapGap = close / vwap - 1;
    if (!finite(fiveMinuteReturn) || !finite(vwapGap)) throw new Error(`${symbol}: nonfinite live feature.`);
    return { ...node, eligible: true, reason: "Complete aligned regular-session OHLCV prefix.", close, vwap, fiveMinuteReturn, vwapGap,
      sign: fiveMinuteReturn > 0 && vwapGap > 0 ? 1 : fiveMinuteReturn < 0 && vwapGap < 0 ? -1 : 0 };
  } catch (error) { return { ...node, reason: error instanceof Error ? error.message : `${symbol}: invalid live history.` }; }
}

const blankMacroNode = (symbol: typeof SPONGE_MACRO_SYMBOLS[number]): SpongeMacroNode => ({
  symbol, family: symbol === "USO" ? "oil" : "rates", eligible: false, reason: "Macro input history is unavailable.",
  close: null, fiveMinuteReturn: null, vwap: null, vwapGap: null, yieldPercent: null, change5Bps: null, changeFromOpenBps: null,
});

function liveMacroNode(context: NetworkContext[], symbol: typeof SPONGE_MACRO_SYMBOLS[number], cutoff: number, date: string): SpongeMacroNode {
  const node = blankMacroNode(symbol);
  if (symbol === "USO") {
    try {
      const entries = context.filter(entry => entry?.symbol === symbol);
      if (entries.length !== 1 || !Array.isArray(entries[0].bars)) throw new Error(`${symbol}: missing or duplicate symbol context.`);
      const book = minuteBook(entries[0].bars, date, cutoff, symbol, true);
      for (let minute = 570; minute <= cutoff; minute++) {
        const bar = book(minute) as SpongeNetworkPriceBar & { count?: unknown; source_valid?: unknown; identity_valid?: unknown };
        if (!(bar.volume! > 0) || bar.count !== undefined && (!finite(bar.count) || bar.count <= 0) ||
            bar.source_valid !== undefined && bar.source_valid !== true || bar.identity_valid !== undefined && bar.identity_valid !== true)
          throw new Error(`${symbol}: every required oil-fund bar needs positive traded volume and any supplied trade count; no filling.`);
      }
    } catch (error) { return { ...node, reason: error instanceof Error ? error.message : `${symbol}: invalid oil-fund history.` }; }
    const oil = liveNode(context, symbol, cutoff, date);
    return { ...node, eligible: oil.eligible, reason: oil.reason, close: oil.close, fiveMinuteReturn: oil.fiveMinuteReturn, vwap: oil.vwap, vwapGap: oil.vwapGap };
  }
  try {
    const entries = context.filter(entry => entry?.symbol === symbol);
    if (entries.length !== 1 || !Array.isArray(entries[0].bars)) throw new Error(`${symbol}: missing or duplicate symbol context.`);
    const book = minuteBook(entries[0].bars, date, cutoff, symbol, false);
    // TNX is quoted as ten times the 10-year yield in percent. No volume, VWAP,
    // interpolation or carry-forward is meaningful for this yield-index input.
    const required = [cutoff, cutoff - 5, 570].map(minute => book(minute) as SpongeNetworkPriceBar & { source_valid?: unknown; identity_valid?: unknown });
    if (required.some(bar => bar.source_valid !== undefined && bar.source_valid !== true || bar.identity_valid !== undefined && bar.identity_valid !== true))
      throw new Error(`${symbol}: a required yield-index source bar is invalid.`);
    const close = required[0].close, prior = required[1].close, open = required[2].open;
    const yieldPercent = close / 10, change5Bps = (close - prior) * 10, changeFromOpenBps = (close - open) * 10;
    if (![yieldPercent, change5Bps, changeFromOpenBps].every(finite)) throw new Error(`${symbol}: nonfinite yield change.`);
    return { ...node, eligible: true, reason: "Exact completed TNX prices; quoted index ÷ 10 is yield percent.", close, yieldPercent, change5Bps, changeFromOpenBps };
  } catch (error) { return { ...node, reason: error instanceof Error ? error.message : `${symbol}: invalid yield-index history.` }; }
}

/** Shared feed/scorer eligibility rules; no graph, fitted model or wall time is used. */
export function inspectSpongeMacroInputs(context: NetworkContext[], cutoff: number, date: string): SpongeMacroNode[] {
  if (!Array.isArray(context) || !validDate(date) || !finite(cutoff) || !Number.isInteger(cutoff) || cutoff < 570 || cutoff > 1439)
    return SPONGE_MACRO_SYMBOLS.map(blankMacroNode);
  return SPONGE_MACRO_SYMBOLS.map(symbol => liveMacroNode(context, symbol, cutoff, date));
}

function largestClusterFraction(nodes: SpongeNetworkNode[], links: readonly SpongeNetworkLink[], sign: -1 | 1): number {
  const active = new Set(nodes.filter(node => node.sign === sign).map(node => node.symbol)), seen = new Set<string>();
  let largest = 0;
  for (const symbol of active) {
    if (seen.has(symbol)) continue;
    const queue = [symbol]; seen.add(symbol);
    for (let i = 0; i < queue.length; i++) for (const link of links) {
      const next = link.source === queue[i] ? link.target : link.target === queue[i] ? link.source : null;
      if (next && active.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
    largest = Math.max(largest, queue.length);
  }
  return largest / NETWORK_SYMBOLS.length;
}

function extractFeatures(input: SpongeNetworkInput, cutoff: number, date: string, nodes: SpongeNetworkNode[], links: readonly SpongeNetworkLink[]) {
  const spx = minuteBook(input.spxBars, date, cutoff, "SPX", false), spy = minuteBook(input.spyBars, date, cutoff, "SPY", true);
  const last = spx(cutoff).close;
  const returns = Array.from({ length: 30 }, (_, i) => {
    const at = cutoff - 29 + i; return spx(at).close / spx(at - 1).close - 1;
  });
  const mean = returns.reduce((sum, value) => sum + value, 0) / 30;
  const volatility = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 30);
  const features: Record<string, number> = {
    spx_return_5: last / spx(cutoff - 5).close - 1,
    spx_return_15: last / spx(cutoff - 15).close - 1,
    spx_return_volatility_30: volatility, spy_vwap_gap: spy(cutoff).close / prefixVWAP(spy, cutoff, "SPY") - 1,
    sector_signed_breadth: nodes.reduce((sum, node) => sum + node.sign, 0) / NETWORK_SYMBOLS.length,
  };
  for (const node of nodes) {
    features[`${node.symbol}_return_5`] = node.fiveMinuteReturn!;
    features[`${node.symbol}_vwap_gap`] = node.vwapGap!;
  }
  const signs = new Map(nodes.map(node => [node.symbol, node.sign]));
  const totalWeight = links.reduce((sum, link) => sum + link.weight, 0);
  for (const [name, sign] of [["bullish", 1], ["bearish", -1]] as const) {
    features[`${name}_cluster_fraction`] = largestClusterFraction(nodes, links, sign);
    features[`${name}_edge_weight_fraction`] = totalWeight > 0 ? links.reduce((sum, link) => sum +
      (signs.get(link.source) === sign && signs.get(link.target) === sign ? link.weight : 0), 0) / totalWeight : 0;
  }
  return features;
}

export type SpongeNetworkFit = {
  id?: string; feature_order: string[]; mean: number[]; scale: number[]; beta: number[]; iterations: number;
  converged: boolean; training_rows: number; training_days: number; train_start: string; train_end: string;
  training_up_fraction?: number;
};
export type SpongeNetworkGraph = {
  id: string; node_order: string[]; adjacency: number[][]; edges: SpongeNetworkLink[]; threshold: number; weight_sum: number;
  training_rows: number; training_days: number; train_start: string; train_end: string;
};
export type SpongeNetworkVersion = {
  id: string; valid_from: string; valid_to: string; train_start: string; train_end: string; graph: SpongeNetworkGraph;
  models: Record<"30" | "60", Record<string, SpongeNetworkFit>>;
};
export type SpongeNetworkBundle = {
  schema_version: number; model_kind: string; latest_version_id: string; sectors: string[];
  base_features: string[]; node_features: string[]; graph_features: string[]; feature_order: string[];
  macro_features?: string[]; macro_inputs?: unknown;
  decision_policy: { backtested_decision_minutes: number[]; horizons: number[]; min_cutoff_minute: number;
    completed_rth_bars_only: boolean; strict_sector_count: number; other_minutes_validation: string; session_bound: boolean; required_macro_symbols?: string[] };
  versions: SpongeNetworkVersion[];
};

const validatedBundles = new WeakSet<object>();
const exactArray = (value: unknown, expected: readonly unknown[]): boolean => Array.isArray(value) && value.length === expected.length && value.every((item, i) => item === expected[i]);
const positiveInteger = (value: unknown, minimum: number): boolean => finite(value) && Number.isInteger(value) && value >= minimum;
function requireValid(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Invalid sponge bundle: ${message}`); }
function validTraining(value: Record<string, unknown>, from: string, through: string, validityStart: string, rows: number) {
  return validDate(value.train_start) && validDate(value.train_end) && value.train_start <= value.train_end &&
    value.train_start >= from && value.train_end <= through && value.train_end < validityStart &&
    positiveInteger(value.training_rows, rows) && positiveInteger(value.training_days, 80) &&
    Number(value.training_days) <= Number(value.training_rows) &&
    Number(value.training_days) <= Math.floor((Date.parse(value.train_end) - Date.parse(value.train_start)) / 86400000) + 1;
}
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value); for (const child of Object.values(value)) deepFreeze(child, seen); Object.freeze(value);
  }
  return value;
}

/** Validate a complete export and return a detached, recursively frozen snapshot. Throws on incompatibility. */
export function parseSpongeNetworkBundle(value: unknown): SpongeNetworkBundle {
  if (value && typeof value === "object" && validatedBundles.has(value)) return value as SpongeNetworkBundle;
  let bundle: unknown;
  try { bundle = structuredClone(value); } catch { throw new Error("Invalid sponge bundle: cannot copy export."); }
  requireValid(record(bundle), "expected an object.");
  const macro = bundle.schema_version === 2 && bundle.model_kind === "persistent-sector-sponge-macro";
  requireValid(macro || bundle.schema_version === 1 && bundle.model_kind === "persistent-sector-sponge", "unsupported schema or model kind.");
  const featureOrder = macro ? SPONGE_MACRO_FEATURES : SPONGE_NETWORK_FEATURES;
  requireValid(exactArray(bundle.sectors, NETWORK_SYMBOLS), "sector universe differs from the frozen eleven.");
  requireValid(exactArray(bundle.base_features, SPONGE_NETWORK_FEATURES.slice(0, 5)) &&
    exactArray(bundle.node_features, SPONGE_NETWORK_FEATURES.slice(5, 27)) &&
    exactArray(bundle.graph_features, SPONGE_NETWORK_FEATURES.slice(27)) && exactArray(bundle.feature_order, featureOrder), "feature order is incompatible.");
  if (macro) {
    requireValid(exactArray(bundle.macro_features, SPONGE_MACRO_FEATURES.slice(31)) && Array.isArray(bundle.macro_inputs) && bundle.macro_inputs.length === 2, "macro feature order or inputs are incompatible.");
    const [oil, rates] = bundle.macro_inputs;
    requireValid(record(oil) && oil.symbol === "USO" && oil.kind === "oil_futures_etf" && oil.source_endpoint === "/stock/history/ohlc" && oil.venue === "nqb" &&
      exactArray(oil.features, SPONGE_MACRO_FEATURES.slice(31, 33)), "USO must be the specified oil-fund OHLCV input.");
    requireValid(record(rates) && rates.symbol === "TNX" && rates.kind === "ten_year_treasury_yield_index" && rates.source_endpoint === "/index/history/ohlc" &&
      rates.quote_divisor_for_yield_percent === 10 && rates.quote_delta_multiplier_for_basis_points === 10 &&
      exactArray(rates.features, SPONGE_MACRO_FEATURES.slice(33)), "TNX yield units or source are incompatible.");
  }
  const policy = bundle.decision_policy;
  requireValid(record(policy) && exactArray(policy.backtested_decision_minutes, [636, 696, 756, 816, 876]) &&
    exactArray(policy.horizons, [30, 60]) && policy.min_cutoff_minute === 635 && policy.completed_rth_bars_only === true &&
    policy.strict_sector_count === 11 && policy.other_minutes_validation === "unvalidated" && policy.session_bound === true, "decision policy is incompatible.");
  if (macro) requireValid(exactArray(policy.required_macro_symbols, SPONGE_MACRO_SYMBOLS), "both frozen macro symbols must be required.");
  requireValid(Array.isArray(bundle.versions) && bundle.versions.length > 0, "no dated versions.");
  const identities = new Set<string>(), graphIdentities = new Set<string>(), modelIdentities = new Set<string>(), months = new Set<string>();
  let latest: { id: string; month: string } | null = null;
  for (const version of bundle.versions) {
    requireValid(record(version), "version must be an object.");
    requireValid(typeof version.id === "string" && version.id.length > 0 && !identities.has(version.id), "empty or duplicate version identity.");
    identities.add(version.id);
    requireValid(validDate(version.valid_from) && validDate(version.valid_to) && version.valid_from.endsWith("-01") &&
      version.valid_from.slice(0, 7) === version.valid_to.slice(0, 7) &&
      new Date(Date.parse(version.valid_to) + 86400000).toISOString().slice(8, 10) === "01", "version must cover one exact calendar month.");
    const month = version.valid_from.slice(0, 7);
    requireValid(!months.has(month), "duplicate validity month."); months.add(month);
    if (!latest || month > latest.month) latest = { id: version.id, month };
    requireValid(validDate(version.train_start) && validDate(version.train_end) && version.train_start <= version.train_end && version.train_end < version.valid_from,
      "version training must end strictly before its validity month.");
    const graph = version.graph;
    requireValid(record(graph) && typeof graph.id === "string" && graph.id.length > 0 && !graphIdentities.has(graph.id), "missing or duplicate graph identity.");
    graphIdentities.add(graph.id);
    requireValid(exactArray(graph.node_order, NETWORK_SYMBOLS) && graph.threshold === 0.6 &&
      validTraining(graph, version.train_start, version.train_end, version.valid_from, 10000), "graph universe, threshold or prior training coverage is invalid.");
    requireValid(Array.isArray(graph.adjacency) && graph.adjacency.length === 11 && graph.adjacency.every(row => Array.isArray(row) && row.length === 11 && row.every(finite)), "graph adjacency must be a finite 11 by 11 matrix.");
    requireValid(Array.isArray(graph.edges) && graph.edges.length <= 55 && finite(graph.weight_sum) && graph.weight_sum >= 0, "invalid graph edge list or total weight.");
    const edgeWeights = new Map<string, number>();
    for (const edge of graph.edges) {
      requireValid(record(edge) && typeof edge.source === "string" && typeof edge.target === "string" && finite(edge.weight) && edge.weight >= 0.6 && edge.weight <= 1, "invalid retained edge.");
      const source = NETWORK_SYMBOLS.findIndex(symbol => symbol === edge.source), target = NETWORK_SYMBOLS.findIndex(symbol => symbol === edge.target);
      requireValid(source >= 0 && target >= 0 && source !== target, "edge endpoint is outside the frozen universe or is a self-link.");
      const key = `${Math.min(source, target)}:${Math.max(source, target)}`;
      requireValid(!edgeWeights.has(key), "duplicate undirected edge."); edgeWeights.set(key, edge.weight);
    }
    const adjacency = graph.adjacency as number[][];
    for (let i = 0; i < 11; i++) for (let j = 0; j < 11; j++) {
      const expected = i === j ? 0 : edgeWeights.get(`${Math.min(i, j)}:${Math.max(i, j)}`) ?? 0;
      requireValid(Math.abs(adjacency[i][j] - expected) <= 1e-12, "adjacency and retained edges disagree.");
    }
    requireValid(Math.abs([...edgeWeights.values()].reduce((sum, weight) => sum + weight, 0) - graph.weight_sum) <= 1e-10, "graph total weight disagrees with its edges.");
    requireValid(record(version.models) && exactArray(Object.keys(version.models).sort(), ["30", "60"]), "expected precisely the 30 and 60 minute model groups.");
    for (const horizon of ["30", "60"]) {
      const models = version.models[horizon];
      requireValid(record(models), "missing horizon models.");
      const families: [string, number][] = macro ? [["baseline", 5], ["sector_sponge", 31], ["macro_sponge", 35]] : [["baseline", 5], ["individual", 27], ["sponge", 31]];
      requireValid(exactArray(Object.keys(models).sort(), families.map(([family]) => family).sort()), "model families are incompatible.");
      for (const [family, count] of families) {
        const model = models[family];
        requireValid(record(model) && model.converged === true && positiveInteger(model.iterations, 1) &&
          validTraining(model, version.train_start, version.train_end, version.valid_from, 350), "model convergence or prior training coverage is invalid.");
        requireValid(exactArray(model.feature_order, featureOrder.slice(0, count)) &&
          Array.isArray(model.mean) && model.mean.length === count && model.mean.every(finite) &&
          Array.isArray(model.scale) && model.scale.length === count && model.scale.every(value => finite(value) && value > 0) &&
          Array.isArray(model.beta) && model.beta.length === count + 1 && model.beta.every(finite), "model feature order or fitted transforms are invalid.");
        if (model.id !== undefined) {
          requireValid(typeof model.id === "string" && model.id.length > 0 && !modelIdentities.has(model.id), "empty or duplicate model identity.");
          modelIdentities.add(model.id);
        }
        if (model.training_up_fraction !== undefined) requireValid(finite(model.training_up_fraction) && model.training_up_fraction >= 0 && model.training_up_fraction <= 1, "invalid training up fraction.");
      }
    }
  }
  requireValid(bundle.latest_version_id === latest?.id, "latest version identity is inconsistent.");
  const result = deepFreeze(bundle) as unknown as SpongeNetworkBundle;
  validatedBundles.add(result); return result;
}

/**
 * Pure scoring of a persisted, prior-only graph and logistic weights. Never fits topology or coefficients.
 * Cutoff is the inclusive last COMPLETED bar, using naive ET opening timestamps. SPX requires trailing
 * price bars only; SPY and all eleven sectors require complete RTH OHLCV prefixes for HLC3-volume VWAP.
 * Zero-volume bars are valid but a zero-total prefix is not. The caller owns freshness, exchange-calendar
 * verification and the NQB volume-proxy disclosure; this function never reads wall time or fills gaps.
 * V2 additionally requires USO's complete positive-volume prefix and the exact TNX opening, t-5 and t
 * price bars. TNX quote changes multiply by ten to obtain basis points. Macros never change the graph.
 */
export function calculateSpongeNetwork(input: SpongeNetworkInput, cutoffMinute: number, sessionDate: string,
  source: SpongeNetworkBundle | null | undefined, sessionClose = 960): SpongeNetworkResult {
  const result: SpongeNetworkResult = {
    experimental: true, status: "unavailable", reason: "Persistent-network inputs are unavailable.", asOf: cutoffMinute,
    decisionMinute: cutoffMinute + 1, sessionDate, graph: null, nodes: NETWORK_SYMBOLS.map(blankNode),
    macroNodes: [], macroCoverage: { eligible: 0, total: 0 },
    coverage: { eligible: 0, total: 11, fraction: 0 }, features: null, featureVector: null,
    displayBand: SPONGE_NETWORK_BAND, bandBacktested: false, studiedDecisionMinute: [636, 696, 756, 816, 876].includes(cutoffMinute + 1),
    horizons: ([30, 60] as const).map(minutes => ({ minutes, status: "unavailable", reason: "Persistent-network inputs are unavailable.", direction: null,
      probabilityUp: null, probabilityDown: null, modelId: null, trainingThrough: null, validMonth: null, trainingUpProbability: null,
      targetEndMinute: cutoffMinute + 1 + minutes, intercept: null, logOdds: null, featureContributions: [], nodeContributions: [], macroContributions: [] })),
  };
  const unavailable = (reason: string) => { result.reason = reason; for (const horizon of result.horizons) horizon.reason = reason; return result; };
  if (!validDate(sessionDate) || !finite(cutoffMinute) || !Number.isInteger(cutoffMinute) || cutoffMinute < 0 || cutoffMinute > 1439 ||
      !finite(sessionClose) || !Number.isInteger(sessionClose) || sessionClose <= 570 || sessionClose > 1440)
    return unavailable("Invalid session date, completed-bar cutoff or cash close.");
  let bundle: SpongeNetworkBundle;
  try { bundle = parseSpongeNetworkBundle(source); }
  catch (error) { return unavailable(error instanceof Error ? error.message : "A valid persistent-network export is unavailable."); }
  const version = bundle.versions.find(item => sessionDate >= item.valid_from && sessionDate <= item.valid_to);
  if (!version) return unavailable("No prior-only persistent graph and model are valid for the selected session month.");
  const macro = bundle.schema_version === 2, featureOrder = macro ? SPONGE_MACRO_FEATURES : SPONGE_NETWORK_FEATURES;
  const modelFamily = macro ? "macro_sponge" : "sponge";
  if (macro) { result.macroNodes = SPONGE_MACRO_SYMBOLS.map(blankMacroNode); result.macroCoverage = { eligible: 0, total: 2 }; }
  const graph = version.graph;
  result.graph = { id: graph.id, validMonth: version.valid_from.slice(0, 7), validFrom: version.valid_from, validThrough: version.valid_to,
    trainingThrough: graph.train_end, trainingRows: graph.training_rows, trainingDays: graph.training_days, threshold: graph.threshold, links: graph.edges };
  for (const horizon of result.horizons) {
    const model = version.models[String(horizon.minutes) as "30" | "60"][modelFamily];
    horizon.modelId = model.id ?? `${version.id}:${modelFamily}:${horizon.minutes}`;
    horizon.trainingThrough = model.train_end; horizon.validMonth = version.valid_from.slice(0, 7);
    horizon.trainingUpProbability = model.training_up_fraction ?? null;
  }
  if (cutoffMinute < 635) {
    result.status = "warming"; return unavailable("First persistent-network forecast uses completed bars through 10:35 ET, displayed at 10:36 ET.");
  }
  if (result.decisionMinute + 30 > sessionClose) return unavailable("No forecast horizon fits before the verified cash close.");
  if (!input || !Array.isArray(input.spxBars) || !Array.isArray(input.spyBars) || !Array.isArray(input.sectorContext))
    return unavailable("SPX, SPY and all eleven sector price histories are required.");
  result.nodes = NETWORK_SYMBOLS.map(symbol => liveNode(input.sectorContext, symbol, cutoffMinute, sessionDate));
  const eligible = result.nodes.filter(node => node.eligible).length;
  result.coverage = { eligible, total: 11, fraction: eligible / 11 };
  if (macro) {
    result.macroNodes = inspectSpongeMacroInputs(Array.isArray(input.macroContext) ? input.macroContext : [], cutoffMinute, sessionDate);
    result.macroCoverage = { eligible: result.macroNodes.filter(node => node.eligible).length, total: 2 };
  }
  if (eligible !== 11) return unavailable(`All eleven sectors are required; ${eligible}/11 have complete aligned history. ${result.nodes.find(node => !node.eligible)?.reason ?? ""}`);
  if (macro && result.macroCoverage.eligible !== 2) return unavailable(`Both USO and TNX inputs are required. ${result.macroNodes.find(node => !node.eligible)?.reason ?? ""}`);
  try {
    const features = extractFeatures(input, cutoffMinute, sessionDate, result.nodes, graph.edges);
    if (macro) {
      const [oil, rates] = result.macroNodes;
      Object.assign(features, { USO_return_5: oil.fiveMinuteReturn, USO_vwap_gap: oil.vwapGap,
        TNX_change_5_bps: rates.change5Bps, TNX_change_from_open_bps: rates.changeFromOpenBps });
    }
    const vector = featureOrder.map(feature => features[feature]);
    if (!vector.every(finite)) throw new Error("Live sponge features contain a nonfinite value.");
    result.features = features; result.featureVector = vector;
    for (const horizon of result.horizons) {
      if (horizon.targetEndMinute > sessionClose) { horizon.reason = "This horizon extends beyond the verified cash close."; continue; }
      const model = version.models[String(horizon.minutes) as "30" | "60"][modelFamily];
      const contributions = featureOrder.map((feature, i) => {
        const standardized = (vector[i] - model.mean[i]) / model.scale[i];
        return { feature, value: vector[i], standardized, coefficient: model.beta[i + 1], logOdds: model.beta[i + 1] * standardized };
      });
      const z = contributions.reduce((sum, item) => sum + item.logOdds, model.beta[0]);
      if (!finite(z) || contributions.some(item => !finite(item.logOdds) || !finite(item.standardized))) { horizon.reason = "Model score is numerically invalid."; continue; }
      const probabilityUp = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
      const byFeature = new Map(contributions.map(item => [item.feature, item.logOdds]));
      const nodeContributions = NETWORK_SYMBOLS.map(symbol => {
        const returnLogOdds = byFeature.get(`${symbol}_return_5`)!, vwapLogOdds = byFeature.get(`${symbol}_vwap_gap`)!;
        return { symbol, logOdds: returnLogOdds + vwapLogOdds, returnLogOdds, vwapLogOdds };
      }).sort((a, b) => Math.abs(b.logOdds) - Math.abs(a.logOdds));
      const macroContributions: SpongeMacroContribution[] = macro ? SPONGE_MACRO_SYMBOLS.map(symbol => {
        const featureContributions = contributions.filter(item => item.feature.startsWith(`${symbol}_`));
        return { symbol, family: symbol === "USO" ? "oil" : "rates", logOdds: featureContributions.reduce((sum, item) => sum + item.logOdds, 0), featureContributions };
      }) : [];
      Object.assign(horizon, { status: "available", reason: "Experimental uncalibrated direction estimate; neutral is a weak binary estimate.",
        direction: spongeNetworkDirection(probabilityUp), probabilityUp, probabilityDown: 1 - probabilityUp,
        intercept: model.beta[0], logOdds: z, featureContributions: contributions.sort((a, b) => Math.abs(b.logOdds) - Math.abs(a.logOdds)), nodeContributions, macroContributions });
    }
    if (result.horizons.some(horizon => horizon.status === "available")) {
      result.status = "available"; result.reason = "Frozen historical graph and model; live features only. Contributions are log-odds, not causal effects or percentage points.";
    } else result.reason = result.horizons.map(horizon => `${horizon.minutes}m: ${horizon.reason}`).join(" ");
    return result;
  } catch (error) {
    result.features = null; result.featureVector = null;
    return unavailable(error instanceof Error ? error.message : "Invalid live price history.");
  }
}
