import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {premiumDollars} from './data-contract.mjs';
import {easternToUtc, cleanBars, result} from
  '../../packages/market-data/src/common.mjs';
import {writeArchive, readArchive, verifyArchive} from
  '../../packages/market-data/src/archive.mjs';

test('premium units and invalid contract counts', () => {
  assert.equal(premiumDollars(3.95), 395);
  assert.equal(premiumDollars(3.95, 2), 790);
  assert.throws(() => premiumDollars(null));
  assert.throws(() => premiumDollars(1, 0.5));
});

test('New York timestamps preserve DST and reject ambiguity', () => {
  assert.equal(easternToUtc('2026-09-30T09:44:00'),
    '2026-09-30T13:44:00.000Z');
  assert.equal(easternToUtc('2026-11-01T01:30:00'), null);
  assert.equal(easternToUtc('2026-03-08T02:30:00'), null);
});

const bar = {
  symbol: 'SPX', timestamp: '2026-09-30T13:44:00.000Z',
  timestampKind: 'bar-open', interval: '1m',
  open: 7700, high: 7702, low: 7699, close: 7701,
  volume: null
};

test('structural validation rejects conflicting duplicate bars', () => {
  assert.equal(cleanBars([bar, {...bar}]).rows.length, 1);
  assert.throws(() => cleanBars([bar, {...bar, close: 7700}]));
  assert.equal(cleanBars([{...bar, high: 7690}]).rejected, 1);
});

test('real archive enforces bar completion and file integrity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spx-companion-'));
  try {
    const query = {kind: 'bars', symbol: 'SPX',
      start: '2026-09-30', end: '2026-09-30', interval: '1m'};
    const envelope = result('invented-fixture', [bar],
      {mode: 'synthetic'});
    const entry = await writeArchive({directory, query, envelope});
    assert.equal(await verifyArchive({directory, entry}), true);
    const before = await readArchive({directory, symbol: 'SPX',
      asOf: '2026-09-30T13:44:59.000Z'});
    const complete = await readArchive({directory, symbol: 'SPX',
      asOf: '2026-09-30T13:45:00.000Z'});
    assert.equal(before.rows.length, 0);
    assert.equal(complete.rows.length, 1);
    await appendFile(join(directory, entry.file), '\n');
    assert.equal(await verifyArchive({directory, entry}), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
