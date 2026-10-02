import { identifyNewsCompanies, findNewsCompanyMentions, NEWS_COMPANY_REGISTRY_AVAILABLE_AT, NEWS_COMPANIES, type NewsCompany } from "./news-companies.ts";

/** Context-only rules: none of these records or labels enter the 35-feature forecast. */
export const NEWS_CONTEXT_RULE_VERSION = "news-context-v2";
export type NewsRuleVersion = "news-context-v1" | typeof NEWS_CONTEXT_RULE_VERSION;
export const NEWS_CONTEXT_MAX_AGE_MS = 300_000;
export const NEWS_CONTEXT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const NEWS_POLL_CACHE_MS = 60_000;
export const LEGACY_NEWS_SOURCES = [
  { id: "calendar", name: "Forex Factory · USD calendar", url: "https://nfs.faireconomy.media/ff_calendar_thisweek.json", hosts: ["www.forexfactory.com"], maxAgeMs: 7230000 },
  { id: "bea_calendar", name: "BEA · release calendar", url: "https://apps.bea.gov/API/signup/release_dates.json", hosts: ["www.bea.gov", "apps.bea.gov"], maxAgeMs: 7230000 },
  { id: "michigan", name: "University of Michigan · releases", url: "https://www.sca.isr.umich.edu/", hosts: ["www.sca.isr.umich.edu"], maxAgeMs: 630000 },
  { id: "fed", name: "Federal Reserve · releases", url: "https://www.federalreserve.gov/feeds/press_all.xml", hosts: ["www.federalreserve.gov"], maxAgeMs: 300000 },
  { id: "fed_speeches", name: "Federal Reserve · speeches", url: "https://www.federalreserve.gov/feeds/speeches.xml", hosts: ["www.federalreserve.gov"], maxAgeMs: 300000 },
  { id: "bea", name: "BEA · releases", url: "https://apps.bea.gov/rss/rss.xml", hosts: ["www.bea.gov", "apps.bea.gov"], maxAgeMs: 300000 },
  { id: "bls", name: "BLS · CPI releases", url: "https://www.bls.gov/feed/cpi.rss", hosts: ["www.bls.gov"], maxAgeMs: 300000 },
  { id: "cnbc", name: "CNBC · top news", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", hosts: ["www.cnbc.com"], maxAgeMs: 300000 },
  { id: "yahoo", name: "Yahoo Finance · syndicated news", url: "https://finance.yahoo.com/news/rssindex", hosts: ["finance.yahoo.com"], maxAgeMs: 300000 },
] as const;
export const NEWS_SOURCES = [...LEGACY_NEWS_SOURCES,
  { id: "cnbc_tech", name: "CNBC · technology", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html", hosts: ["www.cnbc.com"], maxAgeMs: 300000 },
  { id: "nvidia_news", name: "NVIDIA · official releases", url: "https://nvidianews.nvidia.com/releases.xml", hosts: ["nvidianews.nvidia.com", "blogs.nvidia.com"], maxAgeMs: 300000 },
  { id: "microsoft_blog", name: "Microsoft · official blog", url: "https://blogs.microsoft.com/feed/", hosts: ["blogs.microsoft.com"], maxAgeMs: 300000 },
  { id: "apple_newsroom", name: "Apple · official newsroom", url: "https://www.apple.com/newsroom/rss-feed.rss", hosts: ["www.apple.com"], maxAgeMs: 300000 },
  { id: "google_blog", name: "Google · official blog", url: "https://blog.google/rss/", hosts: ["blog.google"], maxAgeMs: 300000 },
  { id: "openai_news", name: "OpenAI · official announcements", url: "https://openai.com/news/rss.xml", hosts: ["openai.com"], maxAgeMs: 300000 },
  { id: "amazon_news", name: "Amazon · official newsroom", url: "https://www.aboutamazon.com/rss/feed.rss", hosts: ["www.aboutamazon.com"], maxAgeMs: 300000 },
] as const;
export type NewsSourceId = typeof NEWS_SOURCES[number]["id"];
export type NewsDirection = "HEADWIND" | "TAILWIND";
export type NewsClassification = NewsDirection | "MIXED" | "UNCERTAIN" | "UNAVAILABLE";
export type NewsArticle = {
  id: string; sourceId: NewsSourceId; title: string; summary: string; url: string; publishedAt: string; recorderReceivedAt: string;
  firstObservedAt: string; assessedAt: string;
};
export type NewsSourceHealth = {
  id: NewsSourceId; name: string; url: string; status: "ok" | "stale" | "error";
  checkedAt: string | null; lastSuccessAt: string | null; error: string | null; acceptedItems: number; rejectedItems: number;
};
export type NewsScheduledEvent = {
  id: string; title: string; sourceId: NewsSourceId; url: string; scheduledAt: string; knownAsOf: string;
  forecast: string | null; previous: string | null;
  status: "scheduled; outcome not inferred";
};
export type NewsSnapshot = {
  schemaVersion: 1; id: string; observedAt: string; ruleVersion: NewsRuleVersion;
  providerStatus: "ok" | "stale" | "error"; providerAsOf: string | null; error: string | null;
  sources: NewsSourceHealth[]; articles: NewsArticle[]; scheduledEvents: NewsScheduledEvent[];
};
export type NewsEvidence = { article: NewsArticle; direction: NewsDirection; ruleId: string; matchedCue: string;
  scope?: "macro" | "company" | "industry"; affectedTickers?: string[]; affectedSectors?: string[] };
export type NewsRelevantHeadline = { article: NewsArticle; topics: string[]; affectedTickers: string[]; affectedSectors: string[];
  classification: "HEADWIND" | "TAILWIND" | "MIXED" | "UNCERTAIN"; reason: string; evidence: NewsEvidence[] };
export type NewsContextResult = {
  classification: NewsClassification; status: "available" | "no_evidence" | "stale" | "unavailable"; reason: string;
  cutoff: string; observedAt: string | null; ruleVersion: NewsRuleVersion; forecastInfluence: false;
  evidence: NewsEvidence[]; sourceHealth: NewsSourceHealth[]; scheduledEvents: NewsScheduledEvent[];
  relevantHeadlines: NewsRelevantHeadline[];
  coverage: { healthy: number; total: number; partial: boolean }; consideredArticles: number; unclassifiedArticles: number;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const newsTimestamp = (value: unknown): number | null => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? Date.parse(value) : null;
export const newsSource = (id: unknown) => NEWS_SOURCES.find(source => source.id === id);

/** Article links are display-only and must stay on the public source's explicit HTTPS host allowlist. */
export function safeNewsUrl(value: unknown, sourceId: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const source = newsSource(sourceId); if (!source) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !source.hosts.some(host => host === url.hostname)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key.toLowerCase())) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

/** Validates the public projection stored by the browser; never trusts arbitrary archived URLs or timestamps. */
export function isNewsSnapshot(value: unknown): value is NewsSnapshot {
  if (!record(value) || value.schemaVersion !== 1 || !["news-context-v1", NEWS_CONTEXT_RULE_VERSION].includes(String(value.ruleVersion)) || typeof value.id !== "string" || value.id.length > 200 ||
      newsTimestamp(value.observedAt) === null || !["ok", "stale", "error"].includes(String(value.providerStatus)) ||
      value.providerAsOf !== null && newsTimestamp(value.providerAsOf) === null || value.error !== null && typeof value.error !== "string" ||
      !Array.isArray(value.sources) || value.sources.length !== (value.ruleVersion === "news-context-v1" ? LEGACY_NEWS_SOURCES.length : NEWS_SOURCES.length) || !Array.isArray(value.articles) || value.articles.length > 200 ||
      !Array.isArray(value.scheduledEvents) || value.scheduledEvents.length > 30) return false;
  const ids = new Set<string>();
  for (const source of value.sources) {
    if (!record(source)) return false;
    const definition = (value.ruleVersion === "news-context-v1" ? LEGACY_NEWS_SOURCES : NEWS_SOURCES).find(item => item.id === source.id);
    if (!definition || ids.has(definition.id) || source.name !== definition.name || source.url !== definition.url || !["ok", "stale", "error"].includes(String(source.status)) ||
        source.checkedAt !== null && newsTimestamp(source.checkedAt) === null || source.lastSuccessAt !== null && newsTimestamp(source.lastSuccessAt) === null ||
        source.error !== null && typeof source.error !== "string" || !finite(source.acceptedItems) || !Number.isInteger(source.acceptedItems) || source.acceptedItems < 0 ||
        !finite(source.rejectedItems) || !Number.isInteger(source.rejectedItems) || source.rejectedItems < 0) return false;
    ids.add(definition.id);
  }
  for (const article of value.articles) {
    if (!record(article) || typeof article.id !== "string" || !/^news-[a-f0-9]{64}$/.test(article.id) || typeof article.title !== "string" || !article.title || article.title.length > 600 ||
        /[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(article.title) || !safeNewsUrl(article.url, article.sourceId) ||
        typeof article.summary !== "string" || article.summary.length > 1600 || /[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(article.summary) ||
        !ids.has(String(article.sourceId)) || [article.publishedAt, article.recorderReceivedAt, article.firstObservedAt, article.assessedAt].some(value => newsTimestamp(value) === null)) return false;
  }
  return value.scheduledEvents.every(event => record(event) && typeof event.id === "string" && /^event-[a-f0-9]{64}$/.test(event.id) &&
    typeof event.title === "string" && event.title.length > 0 && event.title.length <= 600 && !/[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(event.title) &&
    ids.has(String(event.sourceId)) && !!safeNewsUrl(event.url, event.sourceId) && newsTimestamp(event.scheduledAt) !== null && newsTimestamp(event.knownAsOf) !== null &&
    event.status === "scheduled; outcome not inferred" &&
    [event.forecast, event.previous].every(value => value === null || typeof value === "string" && value.length <= 100));
}

type HeadlineRule = { id: string; direction: NewsDirection; pattern: RegExp };
const UP = "(?:rise[sn]?|rose|rising|climbs?|climbed|climbing|surges?|surged|surging|jumps?|jumped|jumping|rallies|rallied|rally|gains?|gained)";
const DOWN = "(?:falls?|fell|falling|drops?|dropped|dropping|declines?|declined|declining|slides?|slid|sliding|slumps?|slumped|retreats?|retreated)";
const OIL = "\\b(?:oil(?: prices?)?|(?:brent|wti)(?: crude)?(?: prices?)?|crude(?: oil)?(?: prices?)?)\\s+(?:(?:prices?|futures)\\s+)?(?:(?:is|are|were|was)\\s+)?";
const YIELDS = "\\b(?:treasury|u\\.?s\\.? treasury|government bond) yields?\\s+(?:(?:is|are|were|was)\\s+)?";
/** Fixed, untrained associations. These cues describe potential costs/funding/policy pressure, not SPX return forecasts. */
const HEADLINE_RULES: HeadlineRule[] = [
  { id: "oil-rising-cost-pressure", direction: "HEADWIND", pattern: new RegExp(OIL + UP + "\\b", "i") },
  { id: "oil-falling-cost-relief", direction: "TAILWIND", pattern: new RegExp(OIL + DOWN + "\\b", "i") },
  { id: "yields-rising-funding-pressure", direction: "HEADWIND", pattern: new RegExp(YIELDS + "(?:" + UP + "|hits? (?:a )?(?:new )?(?:\\d+-year high|highest level))\\b", "i") },
  { id: "yields-falling-funding-relief", direction: "TAILWIND", pattern: new RegExp(YIELDS + DOWN + "\\b", "i") },
  { id: "inflation-hotter-than-expected", direction: "HEADWIND", pattern: /\b(?:inflation|cpi|pce|consumer prices?|producer prices?)\b[^;.!?]{0,45}\b(?:hotter|higher|above)[ -]+(?:than[ -]+)?(?:expected|expectations|forecast)\b|\b(?:hotter|higher)[ -]+than[ -]+expected[ -]+(?:inflation|cpi|pce)\b/i },
  { id: "inflation-cooler-than-expected", direction: "TAILWIND", pattern: /\b(?:inflation|cpi|pce|consumer prices?|producer prices?)\b[^;.!?]{0,45}\b(?:cooler|lower|below)[ -]+(?:than[ -]+)?(?:expected|expectations|forecast)\b|\b(?:cooler|lower)[ -]+than[ -]+expected[ -]+(?:inflation|cpi|pce)\b/i },
  { id: "fed-actual-rate-hike", direction: "HEADWIND", pattern: /\b(?:fed|federal reserve|fomc)\s+(?:raises?|raised|hikes?|hiked|increases?|increased)\s+(?:(?:its|the|benchmark|interest|policy|key|federal|funds)\s+){0,5}rates?\b/i },
  { id: "fed-actual-rate-cut", direction: "TAILWIND", pattern: /\b(?:fed|federal reserve|fomc)\s+(?:cuts?|cut|lowers?|lowered|reduces?|reduced)\s+(?:(?:its|the|benchmark|interest|policy|key|federal|funds)\s+){0,5}rates?\b/i },
  { id: "tariffs-raised-cost-pressure", direction: "HEADWIND", pattern: /\b(?:raises?|raised|increases?|increased|hikes?|hiked|imposes?|imposed)\s+(?:(?:new|additional|higher|import)\s+){0,3}tariffs?\b|\btariffs?\s+(?:(?:are|were|have been)\s+)?(?:raised|increased|hiked|imposed)\b/i },
  { id: "tariffs-reduced-cost-relief", direction: "TAILWIND", pattern: /\b(?:cuts?|cut|lowers?|lowered|reduces?|reduced|removes?|removed|lifts?|lifted)\s+(?:(?:the|existing|import)\s+){0,3}tariffs?\b|\btariffs?\s+(?:(?:are|were|have been)\s+)?(?:cut|lowered|reduced|removed|lifted)\b/i },
];
const AMBIGUOUS = /\b(?:not|never|no longer|denies|denied|unlikely|without|may|might|could|would|will|should|if|predicts?|predicted|expects? to|expected to|forecasts? to|forecasted to|set to|poised to|likely to|hopes? to|seeks? to)\b/i;

function classifyMacroHeadline(title: string): { direction: NewsDirection; ruleId: string; matchedCue: string }[] {
  if (typeof title !== "string" || title.length > 600 || title.includes("?")) return [];
  const clauses = title.replace(/[\u2010-\u2015]/g, "-").split(/;|\b(?:but|while|however|although)\b/i);
  const matches: { direction: NewsDirection; ruleId: string; matchedCue: string }[] = [];
  for (const rule of HEADLINE_RULES) for (const clause of clauses) {
    if (AMBIGUOUS.test(clause)) continue;
    const match = clause.match(rule.pattern);
    if (match) { matches.push({ direction: rule.direction, ruleId: rule.id, matchedCue: match[0] }); break; }
  }
  return matches;
}

type HeadlineMatch = Omit<NewsEvidence, "article">;
const COMPANY_UNCERTAIN = /\b(?:not|never|no longer|denies?|denied|unlikely|without|may|might|could|would|will|should|if|rumou?rs?|reportedly|considers?|considering|plans? to|seeks? to|aims? to|expected to|expects? to|set to|poised to)\b/i;
const RETROSPECTIVE_COMPANY = /^(?:why|how|explainer|lessons? from|looking back)\b|\b(?:last year|last month|years? ago|historical|in retrospect|back in|in 20\d{2}|during 20\d{2})\b/i;
const COMPANY_TOPICS: { name: string; pattern: RegExp }[] = [
  { name: "Earnings / guidance", pattern: /\b(?:earnings|revenue|profit|sales|EPS|guidance|outlook|results|forecast)\b/i },
  { name: "AI / computing", pattern: /\b(?:AI|artificial intelligence|generative AI|data centers?|datacenters?|GPU|GPUs|accelerators?|chatgpt|openai)\b/i },
  { name: "Semiconductors", pattern: /\b(?:chips?|semiconductors?|GPU|GPUs|accelerators?|chipmaking|foundry)\b/i },
  { name: "Investment / spending", pattern: /\b(?:capex|capital expenditure|spending|investment|invests?|investing|funding)\b/i },
  { name: "Cyber / outages", pattern: /\b(?:cyberattack|ransomware|data breach|security breach|outage|offline|service disruption)\b/i },
  { name: "Regulation / trade", pattern: /\b(?:regulator|regulatory|antitrust|lawsuit|fines?|FDA|approval|export (?:ban|controls?|restrictions?|licenses?)|tariffs?)\b/i },
  { name: "Company developments", pattern: /\b(?:acquisition|acquires?|merger|deal|contract|orders?|shipments?|demand|launch(?:es)?|unveils?|recall|bankruptcy|dividend|buyback|repurchase|CEO|resigns?|layoffs?)\b/i },
];
type CompanyRule = { id: string; direction: NewsDirection; pattern: RegExp };
const COMPANY_RULES: CompanyRule[] = [
  { id: "company-guidance-raised", direction: "TAILWIND", pattern: /^(?:raises?|raised|lifts?|lifted|increases?|increased|boosts?|boosted)\s+(?:(?:its|full-year|quarterly|annual|revenue|profit|earnings|sales|EPS)\s+){0,5}(?:guidance|outlook|forecast)\b/i },
  { id: "company-guidance-lowered", direction: "HEADWIND", pattern: /^(?:cuts?|cut|lowers?|lowered|reduces?|reduced|slashes?|slashed|withdraws?|withdrew)\s+(?:(?:its|full-year|quarterly|annual|revenue|profit|earnings|sales|EPS)\s+){0,5}(?:guidance|outlook|forecast)\b/i },
  { id: "company-outlook-disappoints", direction: "HEADWIND", pattern: /^(?:(?:revenue|profit|earnings|sales|EPS)\s+)?(?:guidance|outlook|forecast)\s+(?:falls? short|disappoints?|misses? (?:estimates|expectations)|below (?:estimates|expectations))\b/i },
  { id: "company-earnings-beat", direction: "TAILWIND", pattern: /^(?:(?:reports?|reported|posts?|posted)\s+)?(?:(?:quarterly|annual|first-quarter|second-quarter|third-quarter|fourth-quarter|Q[1-4])\s+)?(?:earnings|revenue|profit|sales|EPS|results)\s+(?:beat|beats|exceed|exceeds|exceeded|above|ahead of)\s+(?:(?:analyst|analysts'|Wall Street)\s+)?(?:estimates|expectations|forecasts)\b|^(?:beats?|beat)\s+(?:(?:earnings|revenue|profit|sales|EPS)\s+)?(?:estimates|expectations|forecasts)\b/i },
  { id: "company-earnings-miss", direction: "HEADWIND", pattern: /^(?:(?:reports?|reported|posts?|posted)\s+)?(?:(?:quarterly|annual|first-quarter|second-quarter|third-quarter|fourth-quarter|Q[1-4])\s+)?(?:earnings|revenue|profit|sales|EPS|results)\s+(?:miss|misses|missed|below|fall short of)\s+(?:(?:analyst|analysts'|Wall Street)\s+)?(?:estimates|expectations|forecasts)\b|^(?:misses?|missed)\s+(?:(?:earnings|revenue|profit|sales|EPS)\s+)?(?:estimates|expectations|forecasts)\b/i },
  { id: "company-demand-strength", direction: "TAILWIND", pattern: /^(?:reports?|reported|sees?|saw)\s+(?:stronger|strong|record|surging|growing|accelerating)\s+(?:(?:AI|cloud|chip|data.center|customer)\s+){0,3}demand\b|^(?:(?:AI|cloud|chip|data.center|customer)\s+){0,3}demand\s+(?:grows?|grew|surges?|surged|accelerates?|accelerated|strengthens?|strengthened)\b/i },
  { id: "company-demand-weakness", direction: "HEADWIND", pattern: /^(?:reports?|reported|sees?|saw)\s+(?:weaker|weak|slowing|falling|declining|softening)\s+(?:(?:AI|cloud|chip|data.center|customer)\s+){0,3}demand\b|^(?:(?:AI|cloud|chip|data.center|customer)\s+){0,3}demand\s+(?:falls?|fell|weakens?|weakened|slows?|slowed|declines?|declined)\b/i },
  { id: "company-operational-disruption", direction: "HEADWIND", pattern: /^(?:reports?|reported|confirms?|confirmed|suffers?|suffered|hit by|is hit by|faces?)\s+(?:(?:a|an|major|global|cloud|service|widespread|customer)\s+){0,4}(?:outage|cyberattack|ransomware attack|data breach|security breach|service disruption)\b|^(?:cloud|services?|platform)\s+(?:is |are )?(?:offline|down|hit by (?:an? )?outage)\b/i },
  { id: "company-regulatory-pressure", direction: "HEADWIND", pattern: /^(?:faces?|faced|hit by|is hit by)\s+(?:(?:a|an|new|EU|US|U\.S\.|antitrust|regulatory|federal)\s+){0,4}(?:probe|investigation|lawsuit|fine|export ban|export restrictions?)\b|^(?:halts?|halted|suspends?|suspended|stops?|stopped)\s+(?:(?:its|AI|chip|GPU|China)\s+){0,4}(?:shipments|exports)\b/i },
  { id: "company-operational-recovery", direction: "TAILWIND", pattern: /^(?:restores?|restored|resumes?|resumed)\s+(?:(?:its|cloud|online|customer|normal)\s+){0,3}(?:services?|operations|shipments)\s+(?:after|following)\s+(?:(?:a|an|the|major|global)\s+){0,3}(?:outage|disruption|halt)\b/i },
];

function companyCues(title: string): { matches: HeadlineMatch[]; companies: NewsCompany[]; topics: string[]; relevant: boolean } {
  const normalized = title.replace(/[\u2010-\u2015]/g, "-").replace(/\u2019/g, "'"), companies = identifyNewsCompanies(normalized);
  const topics = COMPANY_TOPICS.filter(topic => topic.pattern.test(normalized)).map(topic => topic.name);
  const ecosystem = /\b(?:AI|artificial intelligence|OpenAI|ChatGPT|Anthropic|semiconductors?|chipmakers?|technology sector|tech sector|cloud computing)\b/i.test(normalized);
  const relevant = ecosystem || companies.length > 0;
  const matches: HeadlineMatch[] = [];
  if (!relevant || title.includes("?") || RETROSPECTIVE_COMPANY.test(normalized)) return { matches, companies, topics: topics.length ? topics : [companies.length ? "Company developments" : "AI / technology"], relevant };
  const clauses = normalized.split(/;|\b(?:but|while|however|although|whereas|despite|as)\b/i);
  const add = (company: NewsCompany, rule: CompanyRule, matchedCue: string) => {
    const existing = matches.find(item => item.ruleId === rule.id && item.affectedTickers?.some(ticker => NEWS_COMPANIES.find(issuer => issuer.ticker === ticker)?.issuerKey === company.issuerKey));
    if (existing) { if (!existing.affectedTickers!.includes(company.ticker)) existing.affectedTickers!.push(company.ticker); }
    else matches.push({ direction: rule.direction, ruleId: rule.id, matchedCue, scope: "company", affectedTickers: [company.ticker], affectedSectors: [company.sector] });
  };
  for (const rawClause of clauses) {
    const clause = rawClause.trim(), mentions = findNewsCompanyMentions(clause);
    // Subject spans end before the next named issuer, so another company's
    // lowered outlook cannot become the first company's earnings signal.
    for (let i = 0; i < mentions.length; i++) {
      const mention = mentions[i], next = mentions.slice(i + 1).find(item => item.company.issuerKey !== mention.company.issuerKey);
      const tail = clause.slice(mention.end, next?.start ?? clause.length).replace(/^\s*(?:'s\s+)?(?:\([^)]*\)\s*)?/, "").trim();
      if (COMPANY_UNCERTAIN.test(tail) || COMPANY_UNCERTAIN.test(clause.slice(0, mention.start))) continue;
      if (next && /\b(?:forecast|outlook|estimate|rating|price target)s?\b/i.test(tail) && /\b(?:for|on|about|at)\s*$/i.test(tail)) continue;
      for (const rule of COMPANY_RULES) { const matched = tail.match(rule.pattern); if (matched) add(mention.company, rule, `${mention.text} ${matched[0]}`); }
      const prefix = clause.slice(0, mention.start).trim();
      if (!next && /\b(?:bans?|banned|restricts?|restricted|blocks?|blocked)\s+(?:(?:AI|chip|semiconductor)\s+)?exports?\s+(?:by|from|of)\s*$/i.test(prefix))
        add(mention.company, { id: "company-export-restriction", direction: "HEADWIND", pattern: /./ }, clause);
      if (/\b(?:fines?|fined|sues?|sued|investigates?|investigated)\s*$/i.test(prefix))
        add(mention.company, { id: "company-regulatory-action", direction: "HEADWIND", pattern: /./ }, clause);
      if (/\b(?:FDA|regulator)\s+(?:approves?|approved)\s*$/i.test(prefix))
        add(mention.company, { id: "company-regulatory-approval", direction: "TAILWIND", pattern: /./ }, clause);
    }
    if (!mentions.length && companies.length === 1 && /^(?:its\s+)?(?:earnings|revenue|profit|sales|EPS|results|guidance|outlook|AI demand|cloud demand)\b/i.test(clause) && !COMPANY_UNCERTAIN.test(clause)) {
      const tail = clause.replace(/^its\s+/i, "");
      for (const rule of COMPANY_RULES) { const matched = tail.match(rule.pattern); if (matched) add(companies[0], rule, matched[0]); }
    }
    if (!mentions.length && !COMPANY_UNCERTAIN.test(clause)) {
      const rules: CompanyRule[] = [
        { id: "industry-ai-chip-demand-strength", direction: "TAILWIND", pattern: /\b(?:AI chip|semiconductor|GPU) demand\s+(?:grows?|grew|surges?|surged|accelerates?|accelerated)\b/i },
        { id: "industry-ai-chip-demand-weakness", direction: "HEADWIND", pattern: /\b(?:AI chip|semiconductor|GPU) demand\s+(?:weakens?|weakened|slows?|slowed|falls?|fell|declines?|declined)\b/i },
        { id: "industry-chip-export-restriction", direction: "HEADWIND", pattern: /\b(?:tightens?|tightened|imposes?|imposed|expands?|expanded)\s+(?:new\s+)?(?:(?:AI|chip|semiconductor)\s+){1,3}export (?:controls?|restrictions?|ban)\b/i },
        { id: "industry-chip-export-relief", direction: "TAILWIND", pattern: /\b(?:eases?|eased|lifts?|lifted|removes?|removed)\s+(?:(?:AI|chip|semiconductor)\s+){1,3}export (?:controls?|restrictions?|ban)\b/i },
      ];
      for (const rule of rules) { const match = clause.match(rule.pattern); if (match) matches.push({ direction: rule.direction, ruleId: rule.id, matchedCue: match[0], scope: "industry", affectedTickers: [], affectedSectors: ["XLK"] }); }
    }
  }
  return { matches, companies, topics: topics.length ? topics : [companies.length ? "Company developments" : "AI / technology"], relevant };
}

/** Company cues describe the named issuer's potential pressure, never an
 * automatic index forecast. Generic AI spending and launches remain uncertain. */
export function classifyNewsHeadline(title: string): HeadlineMatch[] {
  if (typeof title !== "string" || title.length > 600) return [];
  return [...classifyMacroHeadline(title), ...companyCues(title).matches];
}

/** Assess only a snapshot that existed at cutoff. Browser archive selection belongs to the caller. */
export function calculateNewsContext(snapshot: NewsSnapshot | null | undefined, cutoff: string): NewsContextResult {
  const result: NewsContextResult = { classification: "UNAVAILABLE", status: "unavailable", reason: "No point-in-time public news snapshot is available.",
    cutoff, observedAt: null, ruleVersion: NEWS_CONTEXT_RULE_VERSION, forecastInfluence: false, evidence: [], sourceHealth: [], scheduledEvents: [], relevantHeadlines: [],
    coverage: { healthy: 0, total: NEWS_SOURCES.length, partial: true }, consideredArticles: 0, unclassifiedArticles: 0 };
  const at = newsTimestamp(cutoff);
  if (at === null) { result.reason = "The news cutoff must be an exact UTC timestamp."; return result; }
  if (!isNewsSnapshot(snapshot)) return result;
  const observed = newsTimestamp(snapshot.observedAt)!;
  if (observed > at) { result.reason = "This news snapshot was first observed after the selected cutoff."; return result; }
  result.observedAt = snapshot.observedAt;
  result.ruleVersion = snapshot.ruleVersion;
  result.sourceHealth = snapshot.sources.map(source => {
    const definition = newsSource(source.id)!, checked = newsTimestamp(source.checkedAt), success = newsTimestamp(source.lastSuccessAt);
    const fresh = checked !== null && success !== null && checked <= observed && success <= observed && at - checked <= definition.maxAgeMs && at - success <= definition.maxAgeMs;
    return source.status === "ok" && !fresh ? { ...source, status: "stale" as const, error: "The source was not fresh at the selected cutoff." } : { ...source };
  });
  const healthy = new Set(result.sourceHealth.filter(source => source.status === "ok").map(source => source.id));
  result.coverage = { healthy: healthy.size, total: snapshot.sources.length, partial: healthy.size !== snapshot.sources.length };
  const providerAsOf = newsTimestamp(snapshot.providerAsOf);
  if (snapshot.providerStatus !== "ok") {
    result.status = snapshot.providerStatus === "stale" ? "stale" : "unavailable";
    result.reason = snapshot.error || "The public news recorder is unavailable; previous evidence is not a current reading."; return result;
  }
  if (at - observed > NEWS_CONTEXT_MAX_AGE_MS || providerAsOf === null || providerAsOf > observed || at - providerAsOf > NEWS_CONTEXT_MAX_AGE_MS) {
    result.status = "stale"; result.reason = "The public news snapshot is stale; its earlier classification is not carried forward."; return result;
  }
  if (!healthy.size) { result.reason = "No approved public source is fresh and available at the cutoff."; return result; }
  result.scheduledEvents = snapshot.scheduledEvents.filter(event => healthy.has(event.sourceId) && newsTimestamp(event.knownAsOf)! <= observed &&
    newsTimestamp(event.knownAsOf)! <= at && newsTimestamp(event.scheduledAt)! >= at && newsTimestamp(event.scheduledAt)! <= at + NEWS_CONTEXT_LOOKBACK_MS);
  const latest = new Map<string, NewsArticle>();
  for (const article of snapshot.articles) {
    const published = newsTimestamp(article.publishedAt)!, received = newsTimestamp(article.recorderReceivedAt)!, firstObserved = newsTimestamp(article.firstObservedAt)!, assessed = newsTimestamp(article.assessedAt)!;
    if (published > received || received > firstObserved || firstObserved > assessed || assessed > observed || assessed > at || published > at) continue;
    const key = safeNewsUrl(article.url, article.sourceId)!, previous = latest.get(key);
    const rank = (item: NewsArticle) => [item.recorderReceivedAt, item.firstObservedAt, item.publishedAt, item.id].join("|");
    if (!previous || rank(article) > rank(previous)) latest.set(key, article);
  }
  // First honor the latest known correction, even if its publication date has
  // moved outside the lookback. An ineligible correction suppresses the old cue.
  const articles = [...latest.values()].filter(article => healthy.has(article.sourceId) && at - newsTimestamp(article.publishedAt)! <= NEWS_CONTEXT_LOOKBACK_MS)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  result.consideredArticles = articles.length;
  for (const article of articles) {
    // A current holdings registry must not assert issuer/sector membership in a
    // replay from before its actual verification and new-rule assessment.
    const registryReady = at >= Date.parse(NEWS_COMPANY_REGISTRY_AVAILABLE_AT) && newsTimestamp(article.assessedAt)! >= Date.parse(NEWS_COMPANY_REGISTRY_AVAILABLE_AT);
    const company = snapshot.ruleVersion === NEWS_CONTEXT_RULE_VERSION && registryReady ? companyCues(article.title) : null;
    const matches = [...classifyMacroHeadline(article.title), ...company?.matches ?? []];
    if (!matches.length) result.unclassifiedArticles++;
    result.evidence.push(...matches.map(match => ({ article, ...match })));
    if (company?.relevant) {
      const directions = new Set(company.matches.map(match => match.direction));
      const classification = directions.size > 1 ? "MIXED" : directions.has("HEADWIND") ? "HEADWIND" : directions.has("TAILWIND") ? "TAILWIND" : "UNCERTAIN";
      result.relevantHeadlines.push({ article, topics: company.topics,
        affectedTickers: [...new Set([...company.companies.map(item => item.ticker), ...company.matches.flatMap(item => item.affectedTickers ?? [])])],
        affectedSectors: [...new Set([...company.companies.map(item => item.sector), ...company.matches.flatMap(item => item.affectedSectors ?? [])])],
        classification, evidence: company.matches.map(match => ({ article, ...match })),
        reason: classification === "UNCERTAIN" ? "Relevant company or AI news; the headline does not establish an unambiguous directional effect. Product, spending, partnership or share-price coverage alone does not establish future returns." :
          "Potential pressure on the explicitly named issuer or industry, not a measured sector-wide effect or SPX prediction. Fixed, untrained headline rules." });
    }
  }
  if (!result.evidence.length) {
    if (result.relevantHeadlines.length) {
      result.status = "available"; result.classification = "UNCERTAIN";
      result.reason = "Relevant company or AI headlines are available, but their directional effect is uncertain. Missing direction is not neutral; forecast probabilities are unchanged.";
      return result;
    }
    result.status = "no_evidence";
    result.reason = articles.length ? "Fresh headlines are available, but none contain an unambiguous fixed directional cue. Missing direction is not neutral." : "No eligible headline was published and observed before this cutoff within the 24-hour window.";
    return result;
  }
  const directions = new Set(result.evidence.map(item => item.direction));
  result.classification = directions.size > 1 ? "MIXED" : result.evidence[0].direction;
  result.status = "available";
  result.reason = `${result.classification === "MIXED" ? "Headlines contain opposing potential pressures." : result.classification === "HEADWIND" ? "Headlines suggest potential cost, funding, policy or named-company pressure." : "Headlines suggest potential cost, funding, policy or named-company relief."} This is unweighted context, not an SPX direction forecast. Fixed untrained headline rules; forecast probabilities are unchanged.${result.coverage.partial ? " Coverage is partial; stale or failed sources are excluded." : ""}`;
  return result;
}
