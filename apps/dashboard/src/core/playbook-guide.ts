type PlaybookExplanation = {
  suffixMeaning: string;
  meaning: string;
  impact: string;
  confirmation: string;
  invalidation: string;
};

const structure: Record<string, string> = {
  "INSIDE": "SPY premarket endpoints are within the prior-session range.",
  "EXT-UP": "SPY premarket reaches above the prior high, with its low inside the prior range.",
  "EXT-DOWN": "SPY premarket reaches below the prior low, with its high inside the prior range.",
};

/** Code-derived explanations. These fields do not add signal rules. */
export const PLAYBOOK_GUIDE: Record<string, PlaybookExplanation> = {
  "INSIDE-RISE": {
    suffixMeaning: "Price above premarket high",
    meaning: "SPY closes above its premarket high; premium z is positive and extrinsic-premium slope is positive.",
    impact: "This is a bullish candidate based on SPY price and one fixed call’s extrinsic premium. It is not a forecast of an SPX return.",
    confirmation: "Execution also needs the configured consecutive SPY closes above VWAP and positive z threshold. Relative volume is displayed separately.",
    invalidation: "Candidate ends if price returns to or below the premarket high, z is nonpositive, or premium slope is nonpositive.",
  },
  "INSIDE-FALL": {
    suffixMeaning: "Price below premarket low",
    meaning: "SPY closes below its premarket low; premium z is negative and extrinsic-premium slope is negative.",
    impact: "This is a bearish candidate based on SPY price and one fixed call’s extrinsic premium. It does not establish how far SPX may fall.",
    confirmation: "Execution also needs the configured consecutive SPY closes below VWAP and negative z threshold. Relative volume is displayed separately.",
    invalidation: "Candidate ends if price returns to or above the premarket low, z is nonnegative, or premium slope is nonnegative.",
  },
  "INSIDE-SELLING": {
    suffixMeaning: "Lower price with premium recovery",
    meaning: "SPY is below its premarket low while negative premium z is recovering from a prior reading at or below −2.",
    impact: "Price weakness and a rising negative z-score coexist here. The recovery condition does not establish a bottom, and this candidate cannot pass its current momentum gate.",
    confirmation: "This combination flags a bearish candidate, but its premium-recovery phase keeps the separate momentum gate neutral.",
    invalidation: "Candidate ends when SPY is no longer below the premarket low or the negative-premium recovery condition ends.",
  },
  "EXT-UP-COOLING": {
    suffixMeaning: "Positive premium z-score fading",
    meaning: "A prior premium z reached at least +2; current z stays positive and its recent trend falls below −0.025 per observation.",
    impact: "The review warning concerns bullish exposure. No current-price hold, implied-volatility collapse, or price reversal is required by the candidate predicate.",
    confirmation: "Warning appears on detection. Separate execution confirmation needs a recent downward crossing of the prior SPY high and the configured closes below it.",
    invalidation: "Candidate ends when the positive-premium cooling condition ends. A price hold above the prior high prevents bearish execution confirmation.",
  },
  "EXT-UP-REBOUND": {
    suffixMeaning: "Premium turns positive above VWAP",
    meaning: "Premium z is now positive after a reading below −1 within the last 30 available z readings; SPY has the configured closes above VWAP.",
    impact: "The review warning concerns bearish exposure. The predicate does not verify an early selloff, a base, higher lows, or an increase in volume.",
    confirmation: "Warning appears on detection. Separate execution confirmation needs a recent upward crossing of the prior SPY high and the configured closes above it.",
    invalidation: "Candidate ends if z is nonpositive, the recent low no longer qualifies, or the SPY VWAP hold fails.",
  },
  "EXT-UP-FAILURE": {
    suffixMeaning: "Weak premium below prior high",
    meaning: "Premium z is below −1 with a negative extrinsic-premium slope, while SPY closes below its prior-session high.",
    impact: "The review warning concerns bullish exposure. A prior failed rally or rejected zero crossing is not required; the current price and premium conditions are sufficient.",
    confirmation: "Warning appears on detection. Execution also needs matching bearish SPY VWAP and premium-z confirmation.",
    invalidation: "Candidate ends if z reaches −1 or higher, premium slope is nonnegative, or SPY reaches its prior high.",
  },
  "EXT-DOWN-SELLING": {
    suffixMeaning: "Low premium below prior low",
    meaning: "Premium z is below −2 while SPY closes below its prior-session low.",
    impact: "The candidate describes low relative premium with price below a boundary. It does not identify capitulation, a bottom, or dealer activity.",
    confirmation: "Execution also needs matching bearish SPY VWAP and premium-z confirmation; the candidate alone does not pass that gate.",
    invalidation: "Candidate ends if z reaches −2 or higher or SPY reaches its prior low.",
  },
  "EXT-DOWN-REBOUND": {
    suffixMeaning: "Premium recovery above prior low",
    meaning: "Negative premium z is recovering from a prior reading at or below −2, and SPY closes above its prior-session low.",
    impact: "The review warning concerns bearish exposure. A base, higher low, and participation increase are not separately tested by this predicate.",
    confirmation: "Warning appears on detection. Separate execution confirmation needs a recent upward crossing of the prior SPY low and the configured closes above it.",
    invalidation: "Candidate ends if SPY returns to or below its prior low or the negative-premium recovery condition ends.",
  },
  "EXT-DOWN-RECOVERY": {
    suffixMeaning: "VWAP hold with nonfalling premium",
    meaning: "Premium z lies from −2 inclusive to zero exclusive, premium slope is nonnegative, and SPY has the configured closes above VWAP.",
    impact: "The candidate combines a VWAP hold with premium that is still below its average. It is diagnostic context, not an executable bullish signal under the current gate.",
    confirmation: "This bullish candidate remains behind the momentum gate: negative z cannot also meet its positive-z execution threshold.",
    invalidation: "Candidate ends if z leaves [−2, 0), premium slope turns negative, or the SPY VWAP hold fails.",
  },
};

export function explainPlaybook(code: string | null | undefined) {
  if (!code || !Object.hasOwn(PLAYBOOK_GUIDE, code)) return null;
  const separator = code.lastIndexOf("-");
  const regime = code.slice(0, separator), suffix = code.slice(separator + 1);
  return { code, regime, suffix, structure: structure[regime], ...PLAYBOOK_GUIDE[code] };
}
