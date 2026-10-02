import type { MarketData } from "./service.ts";
import { impliedPrice } from "./implied-price.ts";
import {
  type Levels,
  minute,
  rth,
  addParticipation,
  classifyRegime,
  dayType,
  premiumSeries,
  posture,
  confirmation,
  divergence,
  expectedMove,
  executionConfirmation,
  PLAYBOOK,
} from "./engine.ts";
export type Settings = {
  lookback: number;
  slopeBars: number;
  threshold: number;
  confirming: number;
  rvolThreshold: number;
  maxSpread: number;
  minRunway: number;
};
export const defaults: Settings = {
  lookback: 60,
  slopeBars: 3,
  threshold: 1,
  confirming: 2,
  rvolThreshold: 1.2,
  maxSpread: 0.25,
  minRunway: 5,
};
export function readout(data: MarketData, cutoff: number, settings: Settings) {
  const spx = rth(data.spx, data.session.close).filter(
    (x) => minute(x.timestamp) <= cutoff,
  );
  const spy = addParticipation(
    rth(data.spy, data.session.close).filter(
      (x) => minute(x.timestamp) <= cutoff,
    ),
  );
  const pm = data.spy.filter((x) => minute(x.timestamp) < 570);
  const prev = data.priorSpy,
    prevX = data.priorSpx;
  const levels: Levels = {
    high: prev.length ? Math.max(...prev.map((x) => x.high)) : NaN,
    low: prev.length ? Math.min(...prev.map((x) => x.low)) : NaN,
    close: data.priorSpyClose ?? NaN,
    pmHigh: pm.length ? Math.max(...pm.map((x) => x.high)) : null,
    pmLow: pm.length ? Math.min(...pm.map((x) => x.low)) : null,
  };
  const regime = classifyRegime(levels),
    day = dayType(spy, levels, settings.confirming);
  const quotes = data.quotes.filter((x) => minute(x.timestamp) <= cutoff);
  const points = premiumSeries(
    quotes,
    settings.lookback,
    settings.slopeBars,
    settings.maxSpread,
  );
  const vol = posture(points),
    confirm = confirmation(
      spy,
      points,
      settings.threshold,
      settings.confirming,
      settings.rvolThreshold,
    );
  const price = spx.at(-1)?.close ?? null,
    spyPrice = spy.at(-1)?.close ?? null;
  const anchor = spx[0]?.open ?? null,
    em = anchor
      ? expectedMove(
          anchor,
          data.openingIvTimestamp && minute(data.openingIvTimestamp) <= cutoff
            ? data.openingIv
            : null,
          data.session.close - data.session.open,
        )
      : null;
  const ratio = anchor && spy[0]?.open ? anchor / spy[0].open : null;
  const xLevels = [
    {
      name: "YDH",
      value: prevX.length ? Math.max(...prevX.map((x) => x.high)) : null,
      color: "#7da9e9",
      proxy: false,
    },
    {
      name: "YDL",
      value: prevX.length ? Math.min(...prevX.map((x) => x.low)) : null,
      color: "#7da9e9",
      proxy: false,
    },
    { name: "PDC", value: data.priorSpxClose, color: "#afb5c5", proxy: false },
    {
      name: "PMH ≈",
      value: ratio && levels.pmHigh ? ratio * levels.pmHigh : null,
      color: "#c59afb",
      proxy: true,
    },
    {
      name: "PML ≈",
      value: ratio && levels.pmLow ? ratio * levels.pmLow : null,
      color: "#c59afb",
      proxy: true,
    },
    {
      name: "EM +1σ",
      value: em && anchor ? anchor + em : null,
      color: "#dca862",
      proxy: false,
    },
    {
      name: "EM −1σ",
      value: em && anchor ? anchor - em : null,
      color: "#dca862",
      proxy: false,
    },
  ];
  const historyZ = points.filter((x) => x.z !== null).slice(-30),
    priorMin = Math.min(...historyZ.map((x) => x.z!));
  const last = spy.at(-1),
    z = vol.z;
  const variantCandidates = PLAYBOOK.filter(
    (p) => p.regime === regime.code,
  ).map((p) => {
    let matches = false;
    if (z !== null && last) {
      switch (p.code) {
        case "INSIDE-RISE":
          matches =
            !!levels.pmHigh &&
            last.close > levels.pmHigh &&
            z > 0 &&
            vol.slope! > 0;
          break;
        case "INSIDE-FALL":
          matches =
            !!levels.pmLow &&
            last.close < levels.pmLow &&
            z < 0 &&
            vol.slope! < 0;
          break;
        case "INSIDE-SELLING":
          matches =
            !!levels.pmLow &&
            last.close < levels.pmLow &&
            vol.phase === "negative-recovery";
          break;
        case "EXT-UP-COOLING":
          matches = vol.phase === "positive-decay";
          break;
        case "EXT-UP-REBOUND":
          matches = priorMin < -1 && z > 0 && confirm.above;
          break;
        case "EXT-UP-FAILURE":
          matches = z < -1 && vol.slope! < 0 && last.close < levels.high;
          break;
        case "EXT-DOWN-SELLING":
          matches = z < -2 && last.close < levels.low;
          break;
        case "EXT-DOWN-REBOUND":
          matches =
            vol.phase === "negative-recovery" && last.close > levels.low;
          break;
        case "EXT-DOWN-RECOVERY":
          matches = z < 0 && z >= -2 && vol.slope! >= 0 && confirm.above;
          break;
      }
    }
    return { ...p, matches };
  });
  const active = variantCandidates.find((x) => x.matches) ?? null;
  const latestPremium = points.at(-1);
  const stale =
    !latestPremium ||
    cutoff - minute(latestPremium.timestamp) > 2 ||
    !last ||
    cutoff - minute(last.timestamp) > 2 ||
    !spx.length ||
    cutoff - minute(spx.at(-1)!.timestamp) > 2;
  return {
    spx,
    spy,
    levels,
    regime,
    day,
    points,
    vol,
    confirm,
    price,
    spyPrice,
    anchor,
    em,
    ratio,
    xLevels,
    active,
    execution: executionConfirmation(
      active,
      spy,
      levels,
      confirm,
      settings.confirming,
    ),
    variantCandidates,
    divergences: divergence(points),
    stale,
    implied: impliedPrice(data.parity, data.date, data.measurement.strike, data.session, cutoff, settings.maxSpread),
  };
}
