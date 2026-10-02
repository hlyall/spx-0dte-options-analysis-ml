// Invented inputs for Figure 5.1; not historical market evidence.
import {mkdirSync,writeFileSync} from 'node:fs';
import {blackScholes} from '../../apps/dashboard/src/analytics.mjs';
const inputs = {
  spot: 6000, strike: 6000, years: 1 / 365,
  iv: .20, rate: .04, right: 'CALL'
};
const base = blackScholes(inputs);
const rows = Array.from({length: 81}, (_, i) => {
  const move = i - 40;
  return {
    move,
    exact: blackScholes({...inputs, spot: inputs.spot + move}).price
      - base.price,
    delta: base.delta * move,
    quadratic: base.delta * move + .5 * base.gamma * move ** 2
  };
});
const path = new URL('../research/greek-curve.json', import.meta.url);
mkdirSync(new URL('../research/', import.meta.url), {recursive: true});
writeFileSync(path, JSON.stringify({synthetic: true, inputs, base, rows},
  null, 2) + '\n');
