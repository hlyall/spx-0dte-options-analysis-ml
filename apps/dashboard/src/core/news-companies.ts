/** Small illustrative issuer registry, not an index membership dataset. */
export type NewsCompany = { ticker: string; name: string; sector: string; issuerKey: string; aliases: readonly string[] };
export const NEWS_COMPANY_REGISTRY_META = { version: "illustrative-issuers-v1", verifiedAt: "2026-10-01T00:00:00.000Z", coverage: "Illustrative issuer examples only; not complete SPX coverage." } as const;
export const NEWS_COMPANY_REGISTRY_AVAILABLE_AT = NEWS_COMPANY_REGISTRY_META.verifiedAt;
export const NEWS_COMPANIES: readonly NewsCompany[] = [
  {"ticker": "NVDA", "name": "Nvidia", "sector": "XLK", "issuerKey": "NVDA", "aliases": ["Nvidia"]},
  {"ticker": "AAPL", "name": "Apple", "sector": "XLK", "issuerKey": "AAPL", "aliases": ["Apple"]},
  {"ticker": "MSFT", "name": "Microsoft", "sector": "XLK", "issuerKey": "MSFT", "aliases": ["Microsoft"]},
  {"ticker": "AMZN", "name": "Amazon", "sector": "XLY", "issuerKey": "AMZN", "aliases": ["Amazon", "Amazon Web Services", "AWS"]},
  {"ticker": "GOOGL", "name": "Alphabet", "sector": "XLC", "issuerKey": "GOOGL", "aliases": ["Alphabet", "Google"]},
  {"ticker": "META", "name": "Meta Platforms", "sector": "XLC", "issuerKey": "META", "aliases": ["Meta Platforms", "Facebook", "Instagram"]},
  {"ticker": "TSLA", "name": "Tesla", "sector": "XLY", "issuerKey": "TSLA", "aliases": ["Tesla"]},
  {"ticker": "JPM", "name": "JPMorgan", "sector": "XLF", "issuerKey": "JPM", "aliases": ["JPMorgan", "JPMorgan Chase"]},
  {"ticker": "XOM", "name": "ExxonMobil", "sector": "XLE", "issuerKey": "XOM", "aliases": ["ExxonMobil", "Exxon Mobil"]},
  {"ticker": "WMT", "name": "Walmart", "sector": "XLP", "issuerKey": "WMT", "aliases": ["Walmart"]},
  {"ticker": "CAT", "name": "Caterpillar", "sector": "XLI", "issuerKey": "CAT", "aliases": ["Caterpillar"]},
  {"ticker": "LLY", "name": "Eli Lilly", "sector": "XLV", "issuerKey": "LLY", "aliases": ["Eli Lilly"]},
];
export type NewsCompanyMention = { company: NewsCompany; start: number; end: number; text: string };
const patterns = NEWS_COMPANIES.map(company => ({ company, patterns: [
  ...company.aliases.map(alias => new RegExp(`(^|[^A-Za-z0-9])(${escape(alias)})(?=$|[^A-Za-z0-9])`, "gi")),
  new RegExp(`(^|[^A-Za-z0-9])((?:\\$|(?:NASDAQ|NYSE|AMEX)\\s*:\\s*)${escape(company.ticker)})(?=$|[^A-Za-z0-9])`, "gi"),
] }));
/** Exact named issuer references only. Publisher identity never supplies a subject. */
export function findNewsCompanyMentions(text: string): NewsCompanyMention[] {
  if (typeof text !== "string" || text.length > 600) return [];
  const matches: NewsCompanyMention[] = [];
  for (const entry of patterns) for (const pattern of entry.patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index! + match[1].length, end = start + match[2].length, after = text.slice(end);
      if (entry.company.ticker === "AAPL" && /^\s+(?:growers?|orchards?|crops?|harvest|pie|juice|cider|fruit)\b/i.test(after) ||
          entry.company.ticker === "AMZN" && /^\s+(?:river|rainforest|basin|jungle)\b/i.test(after) ||
          entry.company.ticker === "META" && /^-(?:analysis|analyses|study|data)\b/i.test(after) ||
          entry.company.ticker === "CAT" && /^\s+(?:infestation|larvae|larva|insects?)\b/i.test(after) ||
          entry.company.ticker === "V" && /^\s+(?:applicants?|applications?|requirements?|polic(?:y|ies)|restrictions?|permits?|immigration)\b/i.test(after)) continue;
      if (!matches.some(item => item.company.ticker === entry.company.ticker && item.start === start && item.end === end))
        matches.push({ company: entry.company, start, end, text: match[2] });
    }
  }
  return matches.sort((a, b) => a.start - b.start || b.end - a.end || a.company.ticker.localeCompare(b.company.ticker))
    .filter((item, index, all) => !all.slice(0, index).some(prior => prior.company.issuerKey === item.company.issuerKey && prior.start <= item.start && prior.end >= item.end));
}
export function identifyNewsCompanies(text: string): NewsCompany[] {
  const found = new Map<string, NewsCompany>();
  for (const mention of findNewsCompanyMentions(text)) if (!found.has(mention.company.ticker)) found.set(mention.company.ticker, mention.company);
  return [...found.values()];
}
