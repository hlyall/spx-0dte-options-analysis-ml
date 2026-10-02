# Range categories and pattern conditions

The portable application uses descriptive identifiers for six comparisons of SPY's premarket range with its prior-session range. These are observed geometries, not predictions or probabilities. SPY supplies traded volume and VWAP; the fixed SPXW call supplies the extrinsic-premium measurements. No fixed conversion of SPY levels into SPX strikes is implied.

| Identifier | Display name | Comparison |
| --- | --- | --- |
| INSIDE | Inside prior range | Both premarket endpoints are inside the prior range, including equality. |
| GAP-UP | Gap above prior range | Premarket low is strictly above the prior high. |
| GAP-DOWN | Gap below prior range | Premarket high is strictly below the prior low. |
| EXT-UP | Upper range extension | Premarket high exceeds the prior high; premarket low remains inside the prior range. |
| EXT-DOWN | Lower range extension | Premarket low is below the prior low; premarket high remains inside the prior range. |
| TWO-SIDED | Two-sided range expansion | Premarket exceeds both prior extremes. This takes precedence over either one-sided extension. |

The candidate table currently covers INSIDE, EXT-UP and EXT-DOWN. The other categories remain visible context without an implemented playbook entry. Invalid or absent range inputs remain unavailable.

## Nine candidates

Here, `z` measures the selected call's extrinsic premium relative to its rolling baseline. `slope` is the regression slope of **extrinsic premium**, not of z. The recovery/cooling conditions separately use the recent regression slope of z. A selected call's premium behavior does not establish implied-volatility behavior or a broad options-market consensus.

| Candidate | Detection condition |
| --- | --- |
| INSIDE-RISE | SPY close above premarket high, z > 0, premium slope > 0. |
| INSIDE-FALL | SPY close below premarket low, z < 0, premium slope < 0. |
| INSIDE-SELLING | SPY close below premarket low and the negative-z recovery condition. |
| EXT-UP-COOLING | Positive-z cooling condition; no current-price hold is required. |
| EXT-UP-REBOUND | Minimum of the last 30 available z readings < −1, current z > 0, configured closes above SPY VWAP. |
| EXT-UP-FAILURE | z < −1, premium slope < 0, SPY close below prior-session high. |
| EXT-DOWN-SELLING | z < −2, SPY close below prior-session low. |
| EXT-DOWN-REBOUND | Negative-z recovery condition and SPY close above prior-session low. |
| EXT-DOWN-RECOVERY | −2 ≤ z < 0, premium slope ≥ 0, configured closes above SPY VWAP. |

The positive-z cooling condition requires a prior z ≥ 2, current z > 0, and a recent z regression slope < −0.025 per observation. Negative-z recovery requires a prior z ≤ −2, current z < 0, and a recent z regression slope > 0.025. The prior extrema use `zs.slice(-30, -3)`; the trend uses the last ten available z readings and needs at least five. Conditions are evaluated in the table order within each range category; the first matching candidate becomes the active playbook.

## Detection is separate from execution confirmation

Momentum confirmation requires consecutive SPY closes on the relevant side of VWAP, a matching premium-z threshold, fewer than four strict VWAP crossings in the last fifteen bars, and neither premium recovery/cooling phase. Defaults are two closes and an absolute z threshold of one. Relative volume is displayed separately; it is not an additional gate in `executionConfirmation`.

Anticipation confirmation instead checks a recent crossing of the relevant prior-session boundary followed by the configured consecutive closes beyond it. EXT-UP uses the prior high; EXT-DOWN uses the prior low. This does not add a higher-low, retest, or volume-increase requirement.

Two candidates deliberately retain a limitation of the existing logic: INSIDE-SELLING is detected during a recovery phase that holds momentum confirmation neutral, and EXT-DOWN-RECOVERY has negative z that cannot meet the default bullish momentum threshold. Their appearance is diagnostic context, not permission to enter. Altering those rules would be a separately tested strategy change.

EXT-UP-COOLING and EXT-UP-FAILURE warn to review **bullish** exposure. EXT-UP-REBOUND and EXT-DOWN-REBOUND warn to review **bearish** exposure. Eligible warnings appear at detection, before execution confirmation. A warning is not a confirmed reversal or an order. Existing stale-data, verified-calendar, replay, acknowledgement and alert-timing safeguards remain in force.

## Interpretation and provenance

The published names and explanations were written from the portable code's comparisons and gates. Earlier reading influenced the project; its cited reading and source-code provenance remain credited. Descriptive renaming does not establish an original trading strategy, a measured predictive advantage, or permission to redistribute someone else's source material.

The portable app rebuilds session history from normalized observations. It does not persist or import legacy playbook identifiers, so there is no compatibility alias layer. This change does not migrate or modify any separately running dashboard.
