/** Offline teaching arithmetic. All example inputs are invented.
 * Not the historical strategy engine or a broker execution model.
 */
import { pathToFileURL } from 'node:url';

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name}: invalid integer`);
  }
  return value;
}

export function pointCents(text) {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text)) {
    throw new TypeError('Use nonnegative decimal points');
  }
  const [whole, fraction = ''] = text.split('.');
  return integer(+whole * 100 + +fraction.padEnd(2, '0'),
    'point cents');
}

export function roundTripCents(legs, {
  multiplier = 100,
  feePerSideCents = 100,
  adversePointCents = 0,
} = {}) {
  integer(multiplier, 'multiplier', 1);
  integer(feePerSideCents, 'fee');
  integer(adversePointCents, 'adverse movement');
  if (!Array.isArray(legs) || !legs.length) {
    throw new TypeError('At least one priced leg required');
  }
  let grossCents = 0, costsCents = 0;
  for (const leg of legs) {
    const q = leg.quantity;
    if (!Number.isSafeInteger(q) || q === 0) {
      throw new TypeError('Whole signed quantity required');
    }
    integer(leg.entry, 'entry points');
    integer(leg.exit, 'exit points');
    const cash = q * (leg.exit - leg.entry) * multiplier;
    const cost = 2 * Math.abs(q) *
      (feePerSideCents + adversePointCents * multiplier);
    integer(cash, 'leg cash', Number.MIN_SAFE_INTEGER);
    integer(cost, 'leg costs');
    grossCents += cash;
    costsCents += cost;
    integer(grossCents, 'gross cash', Number.MIN_SAFE_INTEGER);
    integer(costsCents, 'total costs');
  }
  const netCents = grossCents - costsCents;
  for (const value of [grossCents, costsCents, netCents]) {
    integer(value, 'cash result', Number.MIN_SAFE_INTEGER);
  }
  return { grossCents, costsCents, netCents };
}

function instant(text) {
  if (typeof text !== 'string' ||
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(text)) {
    throw new TypeError('Explicit timestamp offset required');
  }
  const value = Date.parse(text);
  if (!Number.isFinite(value)) throw new TypeError('Bad time');
  const date = text.slice(0, 10);
  const normalized = new Date(`${date}T00:00:00Z`)
    .toISOString().slice(0, 10);
  if (normalized !== date) throw new TypeError('Bad date');
  return value;
}

export function assertChronology(record) {
  const names = ['barEnd', 'availableAt', 'decisionAt',
    'entryAt', 'exitAt', 'deadlineAt'];
  const values = names.map(name => instant(record[name]));
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) {
      throw new RangeError(`${names[i]} precedes prior stage`);
    }
  }
  return true;
}

export function assertTrainingCutoff(labelsThrough, decisionAt) {
  if (instant(labelsThrough) >= instant(decisionAt)) {
    throw new RangeError('Training outcomes overlap decision');
  }
  return true;
}

export function brier(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new TypeError('Brier score needs observed outcomes');
  }
  let total = 0;
  for (const { p, y } of rows) {
    if (!Number.isFinite(p) || p < 0 || p > 1 ||
        (y !== 0 && y !== 1)) {
      throw new TypeError('Invalid probability or outcome');
    }
    total += (p - y) ** 2;
  }
  return total / rows.length;
}

export function maxDrawdownCents(dailyCents) {
  if (!Array.isArray(dailyCents) || !dailyCents.length) {
    throw new TypeError('At least one eligible session needed');
  }
  let equity = 0, peak = 0, drawdown = 0;
  for (const pnl of dailyCents) {
    integer(pnl, 'daily P/L', Number.MIN_SAFE_INTEGER);
    equity += pnl;
    integer(equity, 'equity', Number.MIN_SAFE_INTEGER);
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
    integer(drawdown, 'drawdown');
  }
  return drawdown;
}

export function inventedExample() {
  const legs = [
    { quantity: -1, entry: pointCents('2.00'),
      exit: pointCents('1.20') },
    { quantity: 1, entry: pointCents('0.80'),
      exit: pointCents('0.50') },
  ];
  const forecasts = [
    { p: 0.7, y: 1 }, { p: 0.6, y: 0 },
    { p: 0.4, y: 1 }, { p: 0.3, y: 0 },
  ];
  return {
    label: 'INVENTED TEACHING DATA; NOT RESEARCH RESULTS',
    base: roundTripCents(legs),
    stress: roundTripCents(legs, {
      feePerSideCents: 200, adversePointCents: 5,
    }),
    brier: brier(forecasts),
    constantHalfBrier: brier(forecasts.map(({ y }) =>
      ({ p: 0.5, y }))),
    drawdownCents: maxDrawdownCents([4600, 0, -10000, 2200]),
  };
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(inventedExample(), null, 2));
}
