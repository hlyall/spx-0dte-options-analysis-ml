import { NETWORK_SYMBOLS } from "./network-regime.ts";
import { calculateSpongeNetwork, parseSpongeNetworkBundle, spongeNetworkDirection, SPONGE_MACRO_FEATURES,
  type SpongeNetworkBundle, type SpongeNetworkInput, type SpongeNetworkResult, type SpongeNetworkHorizon,
  type SpongeNetworkFit, type SpongeNetworkGraph, type SpongeFeatureContribution } from "./sponge-network.ts";

export const SPONGE_INTERACTION_NODE_ORDER = [...NETWORK_SYMBOLS, "USO", "TNX"] as const;
export const SPONGE_INTERACTION_FEATURES = [...SPONGE_MACRO_FEATURES,
  "USO_sector_alignment", "USO_sector_propagated_pressure", "TNX_sector_alignment", "TNX_sector_propagated_pressure",
] as const;
export type SpongeInteractionLink = { source: string; target: string; signedCorrelation: number; strength: number; kind: "sector-sector" | "macro-sector" };
export type SpongeInteractionLiveNode = {
  symbol: typeof SPONGE_INTERACTION_NODE_ORDER[number]; family: "sector" | "oil" | "rates";
  eligible: boolean; observationSign: -1 | 0 | 1 | null; reason: string; asOf: number;
};
export type SpongeInteractionEdgeState = {
  source: string; target: string; active: boolean; sourceObservationSign: -1 | 0 | 1 | null; targetObservationSign: -1 | 0 | 1 | null;
  alignment: number | null; propagatedPressure: number | null;
};
export type SpongeInteractionGraphMetadata = {
  id: string; validMonth: string; validFrom: string; validThrough: string; trainingThrough: string;
  trainingRows: number; trainingDays: number; nodeOrder: readonly string[]; links: readonly SpongeInteractionLink[]; topKPerMacro: 3;
};
export type SpongeInteractionContribution = SpongeFeatureContribution & { macroSymbol: "USO" | "TNX"; kind: "alignment" | "propagated_pressure" };
export type SpongeInteractionHorizon = SpongeNetworkHorizon & {
  interactionContributions: SpongeInteractionContribution[]; interactionLogOdds: number | null;
  additiveProbabilityUp: number | null; additiveModelId: string | null;
};
export type SpongeInteractionResult = Omit<SpongeNetworkResult, "horizons"> & {
  interactionGraph: SpongeInteractionGraphMetadata | null; liveNodes: SpongeInteractionLiveNode[]; edgeStates: SpongeInteractionEdgeState[];
  horizons: SpongeInteractionHorizon[]; newsAffectsProbability: false;
};

export type SpongeInteractionSavedEdge = { source: string; target: string; weight: number; kind: "sector" | "macro_sector" };
export type SpongeInteractionSavedGraph = {
  id: string; node_order: string[]; adjacency: number[][]; edges: SpongeInteractionSavedEdge[];
  macro_neighbors: Record<"USO" | "TNX", string[]>; macro_sector_correlations: Record<"USO" | "TNX", Record<string, number>>;
  correlation_matrix: number[][]; training_rows: number; training_days: number; train_start: string; train_end: string;
  rejected_return_rows: number; minimum_return_rows: number; minimum_training_days: number; selected_neighbors_per_macro: number;
  interaction_divisor: number; sector_graph_id: string; method: string;
};
export type SpongeInteractionVersion = {
  id: string; valid_from: string; valid_to: string; train_start: string; train_end: string;
  graph: SpongeNetworkGraph; interaction_graph: SpongeInteractionSavedGraph;
  models: Record<"30" | "60", { baseline: SpongeNetworkFit; additive: SpongeNetworkFit; interaction: SpongeNetworkFit }>;
};
export type SpongeInteractionBundle = {
  schema_version: 3; model_kind: "persistent-sector-sponge-interactions"; input_bundle: SpongeNetworkBundle; input_bundle_sha256: string;
  node_order: string[]; base_features: string[]; additive_features: string[]; interaction_features: string[]; feature_order: string[];
  decision_policy: SpongeNetworkBundle["decision_policy"]; latest_version_id: string; versions: SpongeInteractionVersion[];
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const exact = (value: unknown, expected: readonly unknown[]) => Array.isArray(value) && value.length === expected.length && value.every((item, i) => item === expected[i]);
const integerAtLeast = (value: unknown, minimum: number) => finite(value) && Number.isInteger(value) && value >= minimum;
const validIdentity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 240;
function requireValid(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Invalid interaction bundle: ${message}`); }
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameData(item, b[i]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a).sort(); return exact(Object.keys(b).sort(), keys) && keys.every(key => sameData(a[key], b[key]));
}
function trainingValid(item: Record<string, unknown>, version: Record<string, unknown>, minimumRows: number): boolean {
  return validDate(item.train_start) && validDate(item.train_end) && validDate(version.train_start) && validDate(version.train_end) && validDate(version.valid_from) &&
    item.train_start <= item.train_end && item.train_start >= version.train_start && item.train_end <= version.train_end && item.train_end < version.valid_from &&
    integerAtLeast(item.training_rows, minimumRows) && integerAtLeast(item.training_days, 80) && Number(item.training_days) <= Number(item.training_rows) &&
    Number(item.training_days) <= Math.floor((Date.parse(item.train_end) - Date.parse(item.train_start)) / 86400000) + 1;
}
function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value); Object.values(value).forEach(child => freeze(child, seen)); Object.freeze(value);
  }
  return value;
}
const validated = new WeakSet<object>();
const savedLinks = new WeakMap<SpongeInteractionSavedGraph, readonly SpongeInteractionLink[]>();

/** Validates a detached v3 snapshot and its genuine v2 input bundle. No topology or coefficients are fitted here. */
export function parseSpongeInteractionBundle(value: unknown): SpongeInteractionBundle {
  if (value && typeof value === "object" && validated.has(value)) return value as SpongeInteractionBundle;
  let bundle: unknown;
  try { bundle = structuredClone(value); } catch { throw new Error("Invalid interaction bundle: export cannot be copied."); }
  requireValid(record(bundle) && bundle.schema_version === 3 && bundle.model_kind === "persistent-sector-sponge-interactions", "unsupported schema or model kind.");
  const inputBundle = parseSpongeNetworkBundle(bundle.input_bundle);
  requireValid(inputBundle.schema_version === 2, "the genuine 35-feature v2 input bundle is required.");
  // This digest identifies the original v2 file bytes. The embedded JSON is independently
  // validated below; its original whitespace/number serialization is not reconstructed.
  requireValid(typeof bundle.input_bundle_sha256 === "string" && /^[a-f0-9]{64}$/.test(bundle.input_bundle_sha256), "missing v2 source-file fingerprint.");
  bundle.input_bundle = inputBundle;
  requireValid(exact(bundle.node_order, SPONGE_INTERACTION_NODE_ORDER) && exact(bundle.base_features, SPONGE_MACRO_FEATURES.slice(0, 5)) &&
    exact(bundle.additive_features, SPONGE_MACRO_FEATURES) && exact(bundle.interaction_features, SPONGE_INTERACTION_FEATURES.slice(35)) &&
    exact(bundle.feature_order, SPONGE_INTERACTION_FEATURES), "node or feature order is incompatible.");
  requireValid(sameData(bundle.decision_policy, inputBundle.decision_policy), "decision policy differs from the validated input protocol.");
  requireValid(Array.isArray(bundle.versions) && bundle.versions.length > 0, "no monthly interaction versions.");
  const ids = new Set<string>(), months = new Set<string>(), graphIds = new Set<string>(), modelIds = new Set<string>();
  let latest: { id: string; date: string } | null = null;
  for (const version of bundle.versions) {
    requireValid(record(version) && validIdentity(version.id) && !ids.has(version.id), "missing or duplicate version identity."); ids.add(version.id);
    requireValid(validDate(version.valid_from) && validDate(version.valid_to) && version.valid_from.endsWith("-01") && version.valid_from.slice(0, 7) === version.valid_to.slice(0, 7) &&
      new Date(Date.parse(version.valid_to) + 86400000).toISOString().slice(8, 10) === "01" && !months.has(version.valid_from), "versions must cover unique exact calendar months.");
    months.add(version.valid_from);
    if (!latest || version.valid_from > latest.date) latest = { id: version.id, date: version.valid_from };
    requireValid(validDate(version.train_start) && validDate(version.train_end) && version.train_start <= version.train_end && version.train_end < version.valid_from,
      "training must end strictly before the version's deployment month.");
    const inputVersion = inputBundle.versions.find(item => item.valid_from === version.valid_from && item.valid_to === version.valid_to);
    requireValid(inputVersion && sameData(version.graph, inputVersion.graph), "the preserved sector graph must exactly match the genuine monthly v2 graph.");
    const graph = version.interaction_graph;
    requireValid(record(graph) && validIdentity(graph.id) && !graphIds.has(graph.id), "missing or duplicate interaction graph identity."); graphIds.add(graph.id);
    requireValid(exact(graph.node_order, SPONGE_INTERACTION_NODE_ORDER) && graph.sector_graph_id === inputVersion.graph.id && trainingValid(graph, version, 10000) &&
      graph.minimum_return_rows === 10000 && graph.minimum_training_days === 80 && graph.selected_neighbors_per_macro === 3 && graph.interaction_divisor === 3 &&
      integerAtLeast(graph.rejected_return_rows, 0) && typeof graph.method === "string" && graph.method.length > 0, "graph policy, provenance or prior training coverage is invalid.");
    for (const name of ["adjacency", "correlation_matrix"]) requireValid(Array.isArray(graph[name]) && graph[name].length === 13 &&
      graph[name].every(row => Array.isArray(row) && row.length === 13 && row.every(value => finite(value) && value >= -1 && value <= 1)), "graph matrices must be finite 13 by 13 values bounded by one.");
    const adjacency = graph.adjacency as number[][], correlations = graph.correlation_matrix as number[][];
    for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
      requireValid(Math.abs(correlations[i][j] - correlations[j][i]) <= 1e-12 && (i !== j || Math.abs(correlations[i][i] - 1) <= 1e-12), "training correlation matrix is asymmetric or has an invalid diagonal.");
      requireValid(Math.abs(adjacency[i][j] - adjacency[j][i]) <= 1e-12 && (i !== j || adjacency[i][i] === 0), "selected adjacency is asymmetric or has a self-link.");
      if (i < 11 && j < 11) requireValid(adjacency[i][j] === inputVersion.graph.adjacency[i][j], "sector adjacency changed.");
    }
    requireValid(adjacency[11][12] === 0 && adjacency[12][11] === 0, "the protocol contains no direct USO–TNX edge.");
    requireValid(record(graph.macro_neighbors) && exact(Object.keys(graph.macro_neighbors).sort(), ["TNX", "USO"]) &&
      record(graph.macro_sector_correlations) && exact(Object.keys(graph.macro_sector_correlations).sort(), ["TNX", "USO"]), "macro neighbor/correlation identities are invalid.");
    for (const [macro, index] of [["USO", 11], ["TNX", 12]] as const) {
      const values = graph.macro_sector_correlations[macro];
      requireValid(record(values) && exact(Object.keys(values).sort(), [...NETWORK_SYMBOLS].sort()) && Object.values(values).every(finite), "all eleven signed macro-sector training correlations are required.");
      NETWORK_SYMBOLS.forEach((symbol, i) => requireValid(Math.abs(Number(values[symbol]) - correlations[index][i]) <= 1e-12, "macro correlations disagree with the full training matrix."));
      const expected = [...NETWORK_SYMBOLS].sort((a, b) => Math.abs(Number(values[b])) - Math.abs(Number(values[a])) || NETWORK_SYMBOLS.indexOf(a) - NETWORK_SYMBOLS.indexOf(b)).slice(0, 3);
      requireValid(exact(graph.macro_neighbors[macro], expected), "macro edges must be the exact strongest three absolute training correlations with fixed-order ties.");
      NETWORK_SYMBOLS.forEach((symbol, i) => requireValid(Math.abs(adjacency[index][i] - (expected.includes(symbol) ? Number(values[symbol]) : 0)) <= 1e-12, "selected macro adjacency disagrees with its saved neighbors."));
    }
    requireValid(Array.isArray(graph.edges) && graph.edges.length === inputVersion.graph.edges.length + 6, "expected preserved sector edges plus three edges per macro.");
    const seenEdges = new Set<string>();
    for (const edge of graph.edges) {
      requireValid(record(edge) && typeof edge.source === "string" && typeof edge.target === "string" && finite(edge.weight) && Math.abs(edge.weight) <= 1, "invalid signed edge.");
      const source = SPONGE_INTERACTION_NODE_ORDER.findIndex(symbol => symbol === edge.source), target = SPONGE_INTERACTION_NODE_ORDER.findIndex(symbol => symbol === edge.target);
      requireValid(source >= 0 && target >= 0 && source !== target, "edge endpoint is outside the frozen universe.");
      const key = `${Math.min(source, target)}:${Math.max(source, target)}`;
      requireValid(!seenEdges.has(key) && Math.abs(edge.weight - adjacency[source][target]) <= 1e-12, "duplicate edge or edge/adjacency disagreement."); seenEdges.add(key);
      if (source < 11 && target < 11) requireValid(edge.kind === "sector" && inputVersion.graph.edges.some(old =>
        (old.source === edge.source && old.target === edge.target || old.source === edge.target && old.target === edge.source) && old.weight === edge.weight), "sector edge differs from its preserved graph.");
      else requireValid(edge.kind === "macro_sector" && source >= 11 && target < 11 &&
        (graph.macro_neighbors[edge.source] as string[] | undefined)?.includes(edge.target), "macro edges must point from their macro node to a selected sector.");
    }
    requireValid(record(version.models) && exact(Object.keys(version.models).sort(), ["30", "60"]), "expected 30 and 60 minute model groups.");
    for (const horizon of ["30", "60"]) {
      const models = version.models[horizon];
      requireValid(record(models) && exact(Object.keys(models).sort(), ["additive", "baseline", "interaction"]), "model families must be baseline, additive and interaction.");
      for (const [family, count] of [["baseline", 5], ["additive", 35], ["interaction", 39]] as const) {
        const model = models[family];
        requireValid(record(model) && validIdentity(model.id) && !modelIds.has(model.id) && model.converged === true && integerAtLeast(model.iterations, 1) &&
          trainingValid(model, version, 350), "model identity, convergence or prior-only coverage is invalid."); modelIds.add(model.id);
        requireValid(exact(model.feature_order, SPONGE_INTERACTION_FEATURES.slice(0, count)) && Array.isArray(model.mean) && model.mean.length === count && model.mean.every(finite) &&
          Array.isArray(model.scale) && model.scale.length === count && model.scale.every(value => finite(value) && value > 0) &&
          Array.isArray(model.beta) && model.beta.length === count + 1 && model.beta.every(finite) && finite(model.training_up_fraction) && model.training_up_fraction >= 0 && model.training_up_fraction <= 1,
          "model feature order or fitted transforms are invalid.");
      }
      const baseline = models.baseline as SpongeNetworkFit, additive = models.additive as SpongeNetworkFit, interaction = models.interaction as SpongeNetworkFit;
      for (const model of [baseline, additive]) {
        requireValid(["train_start", "train_end", "training_rows", "training_days", "training_up_fraction"].every(key =>
          model[key as keyof SpongeNetworkFit] === interaction[key as keyof SpongeNetworkFit]), "compared model training coverage must match exactly.");
        requireValid(model.mean.every((value, i) => Math.abs(value - interaction.mean[i]) <= 1e-12) && model.scale.every((value, i) => Math.abs(value - interaction.scale[i]) <= 1e-12), "compared models must use the same input-row transforms.");
      }
    }
  }
  requireValid(bundle.latest_version_id === latest?.id, "latest version identity is inconsistent.");
  const result = freeze(bundle) as unknown as SpongeInteractionBundle; validated.add(result); return result;
}

function graphView(version: SpongeInteractionVersion): SpongeInteractionGraphMetadata {
  const graph = version.interaction_graph;
  let links = savedLinks.get(graph);
  if (!links) { links = freeze(graph.edges.map(edge => ({ source: edge.source, target: edge.target, signedCorrelation: edge.weight, strength: Math.abs(edge.weight),
    kind: edge.kind === "sector" ? "sector-sector" as const : "macro-sector" as const }))); savedLinks.set(graph, links); }
  return { id: graph.id, validMonth: version.valid_from.slice(0, 7), validFrom: version.valid_from, validThrough: version.valid_to,
    trainingThrough: graph.train_end, trainingRows: graph.training_rows, trainingDays: graph.training_days, nodeOrder: graph.node_order, links, topKPerMacro: 3 };
}
function liveNodes(base: SpongeNetworkResult, fresh: boolean): SpongeInteractionLiveNode[] {
  return SPONGE_INTERACTION_NODE_ORDER.map(symbol => {
    const sector = base.nodes.find(node => node.symbol === symbol), macro = base.macroNodes.find(node => node.symbol === symbol);
    const eligible = fresh && !!(sector?.eligible || macro?.eligible);
    let observationSign: -1 | 0 | 1 | null = null;
    if (eligible && sector) observationSign = sector.sign;
    else if (eligible && macro) {
      const a = symbol === "USO" ? macro.fiveMinuteReturn! : macro.change5Bps!, b = symbol === "USO" ? macro.vwapGap! : macro.changeFromOpenBps!;
      observationSign = a > 0 && b > 0 ? 1 : a < 0 && b < 0 ? -1 : 0;
    }
    return { symbol, family: symbol === "USO" ? "oil" : symbol === "TNX" ? "rates" : "sector", eligible, observationSign,
      reason: fresh ? sector?.reason ?? macro?.reason ?? "Input is unavailable." : "The underlying price snapshot is stale.", asOf: base.asOf };
  });
}
function emptyResult(base: SpongeNetworkResult): SpongeInteractionResult {
  return { ...base, interactionGraph: null, liveNodes: liveNodes(base, true), edgeStates: [], newsAffectsProbability: false,
    horizons: base.horizons.map(horizon => ({ ...horizon, status: "unavailable", direction: null, probabilityUp: null, probabilityDown: null,
      modelId: null, trainingThrough: null, validMonth: null, trainingUpProbability: null, intercept: null, logOdds: null,
      featureContributions: [], nodeContributions: [], macroContributions: [], interactionContributions: [], interactionLogOdds: null,
      additiveProbabilityUp: null, additiveModelId: null })) };
}
function score(model: SpongeNetworkFit, features: Record<string, number>): { contributions: SpongeFeatureContribution[]; logOdds: number; probability: number } | null {
  const contributions = model.feature_order.map((feature, i) => {
    const value = features[feature], standardized = (value - model.mean[i]) / model.scale[i];
    return { feature, value, standardized, coefficient: model.beta[i + 1], logOdds: model.beta[i + 1] * standardized };
  });
  const logOdds = contributions.reduce((sum, item) => sum + item.logOdds, model.beta[0]);
  if (!finite(logOdds) || contributions.some(item => !finite(item.standardized) || !finite(item.logOdds))) return null;
  return { contributions, logOdds, probability: logOdds >= 0 ? 1 / (1 + Math.exp(-logOdds)) : Math.exp(logOdds) / (1 + Math.exp(logOdds)) };
}

/** Frozen 13-node interactions affect the v3 forecast. News is deliberately absent from this numerical API.
 * The inclusive cutoff, complete inputs and cash-close rules are validated by the unchanged v2 module.
 * The caller owns real-time freshness; pass inputsFresh=false to hold forecasts and every edge activation. */
export function calculateSpongeInteractions(input: SpongeNetworkInput, cutoffMinute: number, sessionDate: string,
  source: SpongeInteractionBundle | null | undefined, sessionClose = 960, inputsFresh = true): SpongeInteractionResult {
  let bundle: SpongeInteractionBundle;
  try { bundle = parseSpongeInteractionBundle(source); }
  catch (error) {
    const result = emptyResult(calculateSpongeNetwork(input, cutoffMinute, sessionDate, null, sessionClose));
    result.reason = error instanceof Error ? error.message : "A valid interaction bundle is unavailable.";
    result.horizons.forEach(horizon => { horizon.reason = result.reason; }); return result;
  }
  const base = calculateSpongeNetwork(input, cutoffMinute, sessionDate, bundle.input_bundle, sessionClose), result = emptyResult(base);
  const unavailable = (reason: string) => { result.status = "unavailable"; result.reason = reason; result.horizons.forEach(horizon => { horizon.reason = reason; }); return result; };
  const version = bundle.versions.find(item => sessionDate >= item.valid_from && sessionDate <= item.valid_to);
  if (!version) return unavailable("No prior-only interaction graph and model are valid for the selected session month.");
  result.interactionGraph = graphView(version);
  const fresh = inputsFresh === true;
  result.liveNodes = liveNodes(base, fresh);
  for (const horizon of result.horizons) {
    const models = version.models[String(horizon.minutes) as "30" | "60"];
    horizon.modelId = models.interaction.id!; horizon.trainingThrough = models.interaction.train_end; horizon.validMonth = version.valid_from.slice(0, 7);
    horizon.trainingUpProbability = models.interaction.training_up_fraction!; horizon.additiveModelId = models.additive.id!;
  }
  const signs = new Map(result.liveNodes.map(node => [node.symbol as string, node.observationSign]));
  const completeInputs = fresh && base.features !== null && base.featureVector !== null;
  result.edgeStates = result.interactionGraph.links.map(link => {
    const a = signs.get(link.source) ?? null, b = signs.get(link.target) ?? null;
    const known = completeInputs && a !== null && b !== null;
    return { source: link.source, target: link.target, active: known && a !== 0 && b !== 0 && link.strength > 0,
      sourceObservationSign: a, targetObservationSign: b,
      alignment: known ? a * b * link.signedCorrelation / (link.kind === "macro-sector" ? 3 : 1) : null,
      propagatedPressure: known && link.kind === "macro-sector" ? a * Math.abs(b) * link.signedCorrelation / 3 : null };
  });
  if (!fresh) { result.features = null; result.featureVector = null; return unavailable("Underlying price feeds are stale; numerical forecasts and graph activations are held."); }
  if (!base.features || !base.featureVector) return result;
  const features = { ...base.features };
  for (const macro of ["USO", "TNX"] as const) {
    const edges = result.edgeStates.filter(edge => edge.source === macro);
    if (edges.length !== 3 || edges.some(edge => edge.alignment === null || edge.propagatedPressure === null)) return unavailable("Every selected macro-sector interaction requires both complete live node observations.");
    features[`${macro}_sector_alignment`] = edges.reduce((sum, edge) => sum + edge.alignment!, 0);
    features[`${macro}_sector_propagated_pressure`] = edges.reduce((sum, edge) => sum + edge.propagatedPressure!, 0);
  }
  result.features = features; result.featureVector = SPONGE_INTERACTION_FEATURES.map(feature => features[feature]);
  if (!result.featureVector.every(finite)) { result.features = null; result.featureVector = null; return unavailable("Interaction features contain a nonfinite value."); }
  for (const horizon of result.horizons) {
    if (horizon.targetEndMinute > sessionClose) { horizon.reason = "This horizon extends beyond the verified cash close."; continue; }
    const models = version.models[String(horizon.minutes) as "30" | "60"], full = score(models.interaction, features), additive = score(models.additive, features);
    if (!full || !additive) { horizon.reason = "The fitted interaction or comparison score is numerically invalid."; continue; }
    const byFeature = new Map(full.contributions.map(item => [item.feature, item]));
    const interactionContributions: SpongeInteractionContribution[] = SPONGE_INTERACTION_FEATURES.slice(35).map(feature => ({ ...byFeature.get(feature)!,
      macroSymbol: feature.startsWith("USO_") ? "USO" : "TNX", kind: feature.endsWith("alignment") ? "alignment" : "propagated_pressure" }));
    Object.assign(horizon, { status: "available", reason: "Experimental frozen interaction estimate; historical association is not causation.",
      direction: spongeNetworkDirection(full.probability), probabilityUp: full.probability, probabilityDown: 1 - full.probability,
      intercept: models.interaction.beta[0], logOdds: full.logOdds, additiveProbabilityUp: additive.probability,
      featureContributions: full.contributions.sort((a, b) => Math.abs(b.logOdds) - Math.abs(a.logOdds)),
      nodeContributions: NETWORK_SYMBOLS.map(symbol => {
        const returnLogOdds = byFeature.get(`${symbol}_return_5`)!.logOdds, vwapLogOdds = byFeature.get(`${symbol}_vwap_gap`)!.logOdds;
        return { symbol, logOdds: returnLogOdds + vwapLogOdds, returnLogOdds, vwapLogOdds };
      }).sort((a, b) => Math.abs(b.logOdds) - Math.abs(a.logOdds)),
      macroContributions: (["USO", "TNX"] as const).map(symbol => {
        const featureContributions = SPONGE_MACRO_FEATURES.slice(31).filter(feature => feature.startsWith(`${symbol}_`)).map(feature => byFeature.get(feature)!);
        return { symbol, family: symbol === "USO" ? "oil" : "rates", logOdds: featureContributions.reduce((sum, item) => sum + item.logOdds, 0), featureContributions };
      }), interactionContributions, interactionLogOdds: interactionContributions.reduce((sum, item) => sum + item.logOdds, 0) });
  }
  if (result.horizons.some(horizon => horizon.status === "available")) {
    result.status = "available"; result.reason = "Saved signed macro-sector interactions feed the 39-feature forecast. News is contextual only and contributes no numerical forecast input.";
  } else { result.status = "unavailable"; result.reason = result.horizons.map(horizon => `${horizon.minutes}m: ${horizon.reason}`).join(" "); }
  return result;
}
