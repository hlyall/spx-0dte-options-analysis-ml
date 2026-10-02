export function premiumDollars(points, contracts = 1) {
  if (!Number.isFinite(points)) {
    throw new Error('Finite premium required');
  }
  if (!Number.isInteger(contracts) || contracts < 1) {
    throw new Error('Positive whole contracts required');
  }
  return 100 * points * contracts;
}
