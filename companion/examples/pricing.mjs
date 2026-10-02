import { pathToFileURL } from 'node:url';
import {
  blackScholes,
} from '../../apps/dashboard/src/analytics.mjs';
import {
  premiumSeries,
} from '../../apps/dashboard/src/core/engine.ts';

export const exampleInputs = {
  spot: 6000, strike: 6000, years: 1 / 365,
  iv: 0.20, rate: 0.04, right: 'CALL',
};

export function greekAudit(p = exampleInputs) {
  const value = blackScholes(p);
  if (!value) throw new Error('Invalid pricing inputs');
  const h = 0.25, e = 1e-5;
  const t = Math.min(1e-6, p.years / 10);
  const price = patch => blackScholes({ ...p, ...patch }).price;
  const up = price({ spot: p.spot + h });
  const down = price({ spot: p.spot - h });
  const difference = {
    delta: (up - down) / (2 * h),
    gamma: (up - 2 * value.price + down) / h ** 2,
    vega: (price({ iv: p.iv + e }) -
      price({ iv: p.iv - e })) / (2 * e * 100),
    theta: -(price({ years: p.years + t }) -
      price({ years: p.years - t })) / (2 * t * 365),
  };
  return { inputs: p, analytic: value, difference };
}

export function premiumQuotes(values) {
  return values.map((mid, i) => {
    const minute = String(30 + i).padStart(2, '0');
    const timestamp = `2026-10-02T09:${minute}:00.000`;
    return {
      timestamp, underlying_timestamp: timestamp,
      underlying_price: 6000, strike: 6100,
      right: 'CALL', expiration: '2026-10-02',
      symbol: 'SPXW', bid: mid - 0.01, ask: mid + 0.01,
    };
  });
}

export function premiumAudit() {
  const rows = premiumQuotes([1, 2, 3, 4, 5]);
  return premiumSeries(rows, 60, 3, 0.25).at(-1);
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({
    greeks: greekAudit(), premium: premiumAudit(),
  }, null, 2));
}
