import { pathToFileURL } from 'node:url';
import {
  riskProfile, gammaProfile,
} from '../../apps/dashboard/src/analytics.mjs';
import {
  impliedPrice,
} from '../../apps/dashboard/src/core/implied-price.ts';

export const creditLegs = [
  { right: 'CALL', strike: 6000, premium: 3, quantity: -1 },
  { right: 'CALL', strike: 6010, premium: 1.3, quantity: 1 },
];

export function payoffAudit() {
  const rows = riskProfile(creditLegs, 6000, 80);
  return {
    samples: rows.length,
    chartMin: Math.min(...rows.map(row => row.pnl)),
    chartMax: Math.max(...rows.map(row => row.pnl)),
    atShortStrike: rows.find(row => row.price === 6000),
    atLongStrike: rows.find(row => row.price === 6010),
  };
}

export function parityData(rate = null) {
  const timestamp = '2026-10-02T10:00:00.000';
  const common = {
    symbol: 'SPXW', expiration: '2026-10-02',
    strike: 6000, timestamp, bid_size: 1, ask_size: 1,
  };
  return {
    quoteTimestampBasis: 'event',
    indexTimestampBasis: 'event', rate,
    quotes: [
      { ...common, right: 'CALL', bid: 12.9, ask: 13.1 },
      { ...common, right: 'PUT', bid: 11.9, ask: 12.1 },
    ],
    index: [{ timestamp, price: 6001 }],
  };
}

export function parityAudit(rate = null) {
  return impliedPrice(
    parityData(rate), '2026-10-02', 6000,
    { open: 570, close: 960 }, 600,
  );
}

export function gammaData() {
  const common = {
    strike: 6000, gamma: 0.001,
    timestamp: '2026-10-02T14:00:00.000Z',
    openInterestAsOf: '2026-10-01T21:00:00.000Z',
  };
  return [
    { ...common, right: 'CALL', openInterest: 1000 },
    { ...common, right: 'PUT', openInterest: 600 },
  ];
}

export function gammaAudit() {
  return gammaProfile(
    gammaData(), 6000, '2026-10-02T14:00:00.000Z',
  );
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({
    payoff: payoffAudit(), parity: parityAudit(),
    fundedParity: parityAudit({
      created: '2026-10-01', rate: 3.6,
    }), gamma: gammaAudit(),
  }, null, 2));
}
