export type RegimeExplanation = {
  code: string;
  name: string;
  geometry: string;
  meaning: string;
  impact: string;
  watch: string;
};

// Descriptions are derived from classifyRegime's range comparisons.
// Broader reading influences remain credited in the project provenance.
// These labels describe observed geometry, not a forecast or measured edge.
export const REGIME_GUIDE: RegimeExplanation[] = [
  {
    code: "INSIDE",
    name: "Inside prior range",
    geometry: "YDL ≤ PML ≤ PMH ≤ YDH",
    meaning: "Neither SPY premarket endpoint is outside the previous session high and low. Equality at a boundary stays in this category.",
    impact: "The engine can examine upward, downward, or premium-recovery candidates after this contained premarket. The category itself selects no trade direction.",
    watch: "Compare the current SPY close with PMH and PML, then inspect the fixed SPXW call’s premium z and slope. SPY levels are not SPX strike prices.",
  },
  {
    code: "GAP-UP",
    name: "Gap above prior range",
    geometry: "YDH < PML ≤ PMH",
    meaning: "Even the lowest observed SPY premarket price exceeds the previous session high. A low equal to that high is not a full gap.",
    impact: "The portable candidate table has no pattern for this category. A gap label therefore cannot produce a playbook entry signal.",
    watch: "Keep the prior high and premarket low visible as measured boundaries. Any trade interpretation needs evidence beyond this range classification.",
  },
  {
    code: "GAP-DOWN",
    name: "Gap below prior range",
    geometry: "PML ≤ PMH < YDL",
    meaning: "Even the highest observed SPY premarket price is below the previous session low. A high equal to that low is not a full gap.",
    impact: "The portable candidate table has no pattern for this category. The dashboard can show context without inventing a bearish entry.",
    watch: "Keep the prior low and premarket high visible as measured boundaries. A low opening range alone does not establish what price will do next.",
  },
  {
    code: "EXT-UP",
    name: "Upper range extension",
    geometry: "YDL ≤ PML ≤ YDH < PMH",
    meaning: "SPY traded above its previous-session high during premarket, but its premarket low remains within the previous range, including either endpoint.",
    impact: "Three implemented candidates examine premium cooling, a positive-premium recovery above VWAP, or weak premium below the prior high. They are separate conditions, not predicted outcomes.",
    watch: "Read the current close relative to the prior SPY high together with the candidate’s exact premium condition. Detection and execution confirmation are separate states.",
  },
  {
    code: "EXT-DOWN",
    name: "Lower range extension",
    geometry: "PML < YDL ≤ PMH ≤ YDH",
    meaning: "SPY traded below its previous-session low during premarket, but its premarket high remains within the previous range, including either endpoint.",
    impact: "Three implemented candidates distinguish very low premium below the prior low, recovering premium above that low, and a VWAP hold with nonfalling premium.",
    watch: "Check the prior SPY low, VWAP, and premium condition separately. A recovery candidate can be visible without passing its execution gate.",
  },
  {
    code: "TWO-SIDED",
    name: "Two-sided range expansion",
    geometry: "PML < YDL < YDH < PMH",
    meaning: "SPY premarket includes at least one price strictly above the prior high and at least one strictly below the prior low.",
    impact: "This comparison takes priority over either one-sided extension. The portable candidate table has no pattern for this category.",
    watch: "Retain both prior boundaries and both premarket endpoints as context. The wider observed range supplies no automatic directional preference.",
  },
];
