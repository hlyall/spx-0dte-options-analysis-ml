import { NETWORK_SYMBOLS } from "./network-regime.ts";
import { newsTimestamp, newsSource, safeNewsUrl, classifyNewsHeadline, NEWS_CONTEXT_RULE_VERSION, NEWS_CONTEXT_MAX_AGE_MS, NEWS_CONTEXT_LOOKBACK_MS, type NewsContextResult, type NewsEvidence, type NewsArticle } from "./news-context.ts";
import { identifyNewsCompanies, NEWS_COMPANY_REGISTRY_AVAILABLE_AT } from "./news-companies.ts";

export const NEWS_LINK_RULE_VERSION = "news-links-v3";
type Sign = -1 | 0 | 1;
export type ObservedSpongeNode = { symbol: string; eligible: boolean; sign: Sign };
export type SignedSpongeLink = { source: string; target: string; signedCorrelation: number; strength: number };
export type NewsGraphRoute = {
  source: "NEWS"; target: string; kind: "rule" | "relevance"; strength: null; state: "active" | "held";
  /** A current topic link remains visible even if its price comparisons are held. */
  comparisonState: "active" | "held" | null; rules: string[]; relevance: string[];
};
export type NewsNodeInteraction = {
  id: string; path: string[]; ruleId: string; headline: string; url: string; expectedSign: -1 | 1 | null;
  observedSign: Sign | null; state: "agrees" | "conflicts" | "mixed" | "unavailable" | "context";
  sourceCorrelation: number | null; method: "headline-to-input" | "thematic-rule" | "historical-association" | "company-relevance" | "topic-relevance";
  tickers?: string[]; topics?: string[];
};
export type NewsSpongeInteractions = {
  ruleVersion: typeof NEWS_LINK_RULE_VERSION; status: "available" | "unavailable"; reason: string;
  newsState: NewsContextResult["classification"]; forecastInfluence: false; routes: NewsGraphRoute[]; interactions: NewsNodeInteraction[];
};
const sectorSet = new Set<string>(NETWORK_SYMBOLS);
const COMPUTING_TOPIC = /\b(?:AI|artificial intelligence|OpenAI|ChatGPT|Anthropic|machine learning|semiconductors?|chipmakers?|GPUs?|cloud computing|technology sector|tech sector)\b/i;
type RelevantRoute = { target: string; ruleId: string; method: "company-relevance" | "topic-relevance"; tickers: string[]; topics: string[] };

/** These edges mean "this story mentions this sector or topic", not that the
 * named company benefits or that a sector/index price should move. */
function relevanceRouting(title: string): RelevantRoute[] {
  const normalized = title.replace(/[\u2010-\u2015]/g, "-").replace(/\u2019/g, "'");
  const companies = identifyNewsCompanies(normalized), computing = COMPUTING_TOPIC.test(normalized);
  if (companies.length) {
    const sectors = new Map<string, Set<string>>();
    for (const company of companies) {
      if (!sectorSet.has(company.sector)) continue;
      const tickers = sectors.get(company.sector) ?? new Set<string>(); tickers.add(company.ticker); sectors.set(company.sector, tickers);
    }
    return [...sectors].map(([target, tickers]) => ({ target, ruleId: "company-mentioned-sector", method: "company-relevance",
      tickers: [...tickers], topics: computing ? ["Company reference", "AI / computing"] : ["Company reference"] }));
  }
  // With no listed issuer named, an explicit computing headline can have a
  // technology-topic link. Never infer MSFT/NVDA beneficiaries from OpenAI.
  return computing ? [{ target: "XLK", ruleId: "explicit-computing-topic", method: "topic-relevance", tickers: [], topics: ["AI / computing"] }] : [];
}

/** Fixed thematic routes have no fitted weights. A headline's direction is not an SPX probability. */
function routing(evidence: NewsEvidence, newsRuleVersion: NewsContextResult["ruleVersion"], decision: number): { targets: string[]; sign: -1 | 1; method: "headline-to-input" | "thematic-rule" } | null {
  const rule = evidence.ruleId;
  if (rule === "oil-rising-cost-pressure") return { targets: ["USO"], sign: 1, method: "headline-to-input" };
  if (rule === "oil-falling-cost-relief") return { targets: ["USO"], sign: -1, method: "headline-to-input" };
  if (rule === "yields-rising-funding-pressure") return { targets: ["TNX"], sign: 1, method: "headline-to-input" };
  if (rule === "yields-falling-funding-relief") return { targets: ["TNX"], sign: -1, method: "headline-to-input" };
  if (["inflation-hotter-than-expected", "fed-actual-rate-hike"].includes(rule)) return { targets: [...NETWORK_SYMBOLS], sign: -1, method: "thematic-rule" };
  if (["inflation-cooler-than-expected", "fed-actual-rate-cut"].includes(rule)) return { targets: [...NETWORK_SYMBOLS], sign: 1, method: "thematic-rule" };
  if (rule === "tariffs-raised-cost-pressure") return { targets: ["XLI", "XLY", "XLB"], sign: -1, method: "thematic-rule" };
  if (rule === "tariffs-reduced-cost-relief") return { targets: ["XLI", "XLY", "XLB"], sign: 1, method: "thematic-rule" };
  if (newsRuleVersion === NEWS_CONTEXT_RULE_VERSION && decision >= Date.parse(NEWS_COMPANY_REGISTRY_AVAILABLE_AT) &&
      (newsTimestamp(evidence.article.assessedAt) ?? -Infinity) >= Date.parse(NEWS_COMPANY_REGISTRY_AVAILABLE_AT)) {
    // Reconstruct the named scope from the headline, rather than accepting an
    // arbitrary sector or transferring the publisher's identity to its subject.
    const cue = classifyNewsHeadline(evidence.article.title).find(item => item.ruleId === rule && item.direction === evidence.direction &&
      (item.scope === "industry" && evidence.scope === "industry" || item.scope === "company" && evidence.scope === "company" &&
        item.affectedTickers?.some(ticker => evidence.affectedTickers?.includes(ticker))));
    const targets = cue?.affectedSectors?.filter(symbol => sectorSet.has(symbol));
    if (targets?.length) return { targets: [...new Set(targets)], sign: cue!.direction === "TAILWIND" ? 1 : -1, method: "thematic-rule" };
  }
  return null;
}

/** News context traverses actual saved macro-sector links; its qualitative messages never enter the fitted score. */
export function calculateNewsSpongeInteractions(news: NewsContextResult | null, nodes: ObservedSpongeNode[], links: readonly SignedSpongeLink[],
  decisionISO: string, pricesHeld: boolean): NewsSpongeInteractions {
  const result: NewsSpongeInteractions = { ruleVersion: NEWS_LINK_RULE_VERSION, status: "unavailable", reason: "No eligible news observation for this decision.",
    newsState: "UNAVAILABLE", forecastInfluence: false, routes: [], interactions: [] };
  const decision = newsTimestamp(decisionISO), assessed = newsTimestamp(news?.cutoff), observed = newsTimestamp(news?.observedAt);
  if (!news || news.status !== "available" || decision === null || assessed === null || observed === null || assessed > decision || observed > decision ||
    decision - assessed > NEWS_CONTEXT_MAX_AGE_MS || decision - observed > NEWS_CONTEXT_MAX_AGE_MS) return result;
  result.status = "available"; result.newsState = news.classification;
  result.reason = pricesHeld ? "News is available; price comparisons are held until the market snapshot is current." : "News routes show agreement or conflict with current node observations. They are untrained context, not an extra probability adjustment.";
  const bySymbol = new Map(nodes.map(node => [node.symbol, node])), routes = new Map<string, NewsGraphRoute>(), seen = new Set<string>();
  const directions = new Set<string>();
  const healthy = new Set(news.sourceHealth.filter(source => {
    const definition = newsSource(source.id), checked = newsTimestamp(source.checkedAt), success = newsTimestamp(source.lastSuccessAt);
    return definition && source.status === "ok" && checked !== null && success !== null && checked <= assessed && success <= assessed && checked <= observed && success <= observed &&
      decision - checked <= definition.maxAgeMs && decision - success <= definition.maxAgeMs;
  }).map(source => source.id));
  const eligibleArticle = (article: NewsArticle) => {
    const published = newsTimestamp(article.publishedAt), received = newsTimestamp(article.recorderReceivedAt), first = newsTimestamp(article.firstObservedAt), assessment = newsTimestamp(article.assessedAt);
    return !!safeNewsUrl(article.url, article.sourceId) && healthy.has(article.sourceId) && published !== null && received !== null && first !== null && assessment !== null &&
      published <= received && received <= first && first <= assessment && assessment <= observed && assessment <= assessed && assessment <= decision &&
      decision - published <= NEWS_CONTEXT_LOOKBACK_MS;
  };
  for (const evidence of news.evidence) {
    const route = routing(evidence, news.ruleVersion, decision); if (!route) continue;
    const article = evidence.article;
    if (!eligibleArticle(article)) continue;
    directions.add(evidence.direction);
    for (const target of route.targets) {
      const node = bySymbol.get(target), held = pricesHeld || !node?.eligible;
      const existing = routes.get(target) ?? { source: "NEWS" as const, target, kind: "rule" as const, strength: null,
        state: held ? "held" as const : "active" as const, comparisonState: held ? "held" as const : "active" as const, rules: [], relevance: [] };
      if (!existing.rules.includes(evidence.ruleId)) existing.rules.push(evidence.ruleId);
      routes.set(target, existing);
      const add = (path: string[], sign: -1 | 1, method: NewsNodeInteraction["method"], sourceCorrelation: number | null, inheritedHold: boolean) => {
        const endpoint = bySymbol.get(path.at(-1)!), unavailable = inheritedHold || pricesHeld || !endpoint?.eligible;
        const id = evidence.article.id + ":" + evidence.ruleId + ":" + path.join(">");
        if (seen.has(id)) return; seen.add(id);
        result.interactions.push({ id, path, ruleId: evidence.ruleId, headline: evidence.article.title, url: evidence.article.url,
          expectedSign: sign, observedSign: unavailable ? null : endpoint!.sign,
          state: unavailable ? "unavailable" : endpoint!.sign === 0 ? "mixed" : endpoint!.sign === sign ? "agrees" : "conflicts", method, sourceCorrelation });
      };
      add(["NEWS", target], route.sign, route.method, null, held);
      if (target !== "USO" && target !== "TNX") continue;
      for (const link of links) {
        const sector = link.source === target ? link.target : link.target === target ? link.source : null;
        if (!sector || !sectorSet.has(sector) || !Number.isFinite(link.signedCorrelation) || !Number.isFinite(link.strength) || link.signedCorrelation === 0 ||
          Math.abs(link.signedCorrelation) > 1 || Math.abs(link.strength - Math.abs(link.signedCorrelation)) > 1e-12) continue;
        add(["NEWS", target, sector], (route.sign * Math.sign(link.signedCorrelation)) as -1 | 1, "historical-association", link.signedCorrelation, held);
      }
    }
  }
  let visibleRelevance = false;
  if (news.ruleVersion === NEWS_CONTEXT_RULE_VERSION && decision >= Date.parse(NEWS_COMPANY_REGISTRY_AVAILABLE_AT)) {
    for (const item of news.relevantHeadlines ?? []) {
      const article = item.article;
      if (!eligibleArticle(article) || (newsTimestamp(article.assessedAt) ?? -Infinity) < Date.parse(NEWS_COMPANY_REGISTRY_AVAILABLE_AT)) continue;
      // Do not trust caller-provided affectedSectors, tickers, classification or
      // topic tags. Resolve the named subjects again from the approved headline.
      for (const relevance of relevanceRouting(article.title)) {
        visibleRelevance = true;
        const existing = routes.get(relevance.target) ?? { source: "NEWS" as const, target: relevance.target, kind: "relevance" as const,
          strength: null, state: "active" as const, comparisonState: null, rules: [], relevance: [] };
        if (!existing.relevance.includes(relevance.ruleId)) existing.relevance.push(relevance.ruleId);
        existing.state = "active"; routes.set(relevance.target, existing);
        const path = ["NEWS", relevance.target], id = article.id + ":" + relevance.ruleId + ":" + path.join(">");
        if (seen.has(id)) continue; seen.add(id);
        result.interactions.push({ id, path, ruleId: relevance.ruleId, headline: article.title, url: article.url,
          expectedSign: null, observedSign: null, state: "context", sourceCorrelation: null,
          method: relevance.method, tickers: relevance.tickers, topics: relevance.topics });
      }
    }
  }
  result.routes = [...routes.values()];
  result.newsState = directions.size > 1 ? "MIXED" : directions.has("HEADWIND") ? "HEADWIND" : directions.has("TAILWIND") ? "TAILWIND" : visibleRelevance ? "UNCERTAIN" : "UNAVAILABLE";
  if (visibleRelevance) result.reason = directions.size ?
    "News links include named-company or computing-topic relevance. Separate directional rules compare observations only when those prices are usable; relevance alone is not a headwind, tailwind or probability adjustment." :
    "Current company or computing headlines have relevance links, but no unambiguous directional cue. These links show context only: no price agreement/conflict is inferred and forecast probabilities are unchanged.";
  if (!result.routes.length) {
    const visibleUncertain = news.ruleVersion === NEWS_CONTEXT_RULE_VERSION && news.relevantHeadlines?.some(item => {
      return eligibleArticle(item.article) && (newsTimestamp(item.article.assessedAt) ?? -Infinity) >= Date.parse(NEWS_COMPANY_REGISTRY_AVAILABLE_AT);
    });
    if (visibleUncertain) { result.newsState = "UNCERTAIN"; result.reason = "Relevant company or AI news is current, but has no unambiguous directional route. It remains visible without changing probabilities."; }
    else { result.status = "unavailable"; result.reason = "No supported thematic route for the available news cues."; result.newsState = "UNAVAILABLE"; }
  }
  return result;
}
