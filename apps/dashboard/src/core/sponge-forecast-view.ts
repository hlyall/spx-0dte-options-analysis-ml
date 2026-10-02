import type { SpongeNetworkResult } from "./sponge-network.ts";
import type { SpongeMissingResult } from "./sponge-missing.ts";

/** Select the displayed forecast and its diagnostics together. A held fallback
 * must not silently revert to the complete-input model's first missing sector. */
export function spongeForecastView({ additive, interaction, missing, showInteraction, holdReason = "",
  missingReady, missingError = "", sessionClose }: {
  additive: SpongeNetworkResult; interaction: SpongeNetworkResult; missing: SpongeMissingResult;
  showInteraction: boolean; holdReason?: string; missingReady: boolean; missingError?: string; sessionClose: number;
}) {
  const fallback = !showInteraction && additive.status !== "available" && additive.status !== "warming";
  const selected = showInteraction ? interaction : fallback ? missing : additive;
  const loading = fallback && !missingReady && !missingError;
  const fallbackError = fallback && !missingReady ? missingError || "Loading saved historical-correlation parameters." : "";
  const closeKnown = Number.isInteger(sessionClose) && sessionClose > 570 && sessionClose <= 1440;
  const noHorizonFits = closeKnown && selected.decisionMinute + 30 > sessionClose;
  const reason = holdReason || (noHorizonFits ? "No forecast horizon fits before the verified cash close." : "") || fallbackError || selected.reason;
  const estimated = !holdReason && !fallbackError && !noHorizonFits && fallback && missing.missingInputEstimate.mode === "estimated";
  const horizons = selected.horizons.map(horizon => {
    const pastClose = closeKnown && horizon.targetEndMinute > sessionClose;
    const override = holdReason || (pastClose ? "This horizon extends beyond the verified cash close." : "") || fallbackError;
    return {
      horizon,
      available: !override && horizon.status === "available",
      waiting: !holdReason && !pastClose && (loading || selected.status === "warming"),
      reason: override || horizon.reason || reason,
    };
  });
  return { selected, fallback, estimated, reason, horizons };
}
