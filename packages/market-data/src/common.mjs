import { createHash } from 'node:crypto';

export const VERSION = 1;
export const num = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const iso = value => { if (value === null || value === undefined || value === '') return null; const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toISOString() : null; };
export function symbolName(value) {
  const symbol = String(value || '').toUpperCase();
  if (!/^[A-Z0-9^=._/-]{1,40}$/.test(symbol)) throw new Error('Invalid market symbol');
  return symbol;
}
export function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || iso(`${value}T00:00:00Z`)?.slice(0, 10) !== value) throw new Error('Expected valid YYYY-MM-DD date');
  return value;
}
export function rangeBounds(start, end) {
  dateOnly(start); dateOnly(end);
  if (start > end) throw new Error('Start date must not be after end date');
  return [Date.parse(`${start}T00:00:00Z`), Date.parse(`${end}T00:00:00Z`) + 86400000];
}
export function filterDates(rows, start, end) {
  rangeBounds(start, end);
  // A trading-session date is authoritative for local-market bars around UTC boundaries.
  return rows.filter(row => (row.date || row.timestamp?.slice(0, 10)) >= start && (row.date || row.timestamp?.slice(0, 10)) <= end);
}
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const split = line => { const cells = []; let cell = '', quoted = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') { if (quoted && line[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (ch === ',' && !quoted) { cells.push(cell); cell = ''; } else cell += ch; } cells.push(cell); return cells; };
  const headers = split(lines.shift() || '').map(v => v.replace(/^\uFEFF/, '').trim());
  return lines.filter(Boolean).map(line => Object.fromEntries(split(line).map((value, index) => [headers[index], value])));
}
export function validBar(row) {
  return !!iso(row.timestamp) && !(row.timestampKind==='bar-open'&&/^\d+[mh]$/.test(row.interval||'')&&Date.parse(row.timestamp)%60000!==0) && [row.open, row.high, row.low, row.close].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) && row.high >= Math.max(row.open, row.close, row.low) && row.low <= Math.min(row.open, row.close, row.high) && (row.volume === null || (Number.isFinite(row.volume) && row.volume >= 0));
}
export function cleanBars(rows) {
  const seen = new Map(); let rejected = 0;
  for (const row of rows) { if (!validBar(row)) { rejected++; continue; } if (seen.has(row.timestamp)) { if (JSON.stringify(seen.get(row.timestamp)) !== JSON.stringify(row)) throw new Error('Conflicting duplicate bar timestamps'); continue; } seen.set(row.timestamp, row); }
  return { rows: [...seen.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)), rejected };
}
export function validOption(row) {
  return ['CALL', 'PUT'].includes(row.right) && row.strike > 0 && /^\d{4}-\d{2}-\d{2}$/.test(row.expiration) && !!iso(row.timestamp) && row.bid !== null && row.ask !== null && row.bid >= 0 && row.ask >= row.bid && row.ask > 0;
}
export function source(provider, data, extra = {}) {
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const timestamps = rows.map(row => row.timestamp || row.publishedAt).filter(Boolean).sort();
  return { provider, asOf: timestamps.at(-1) || null, oldestAsOf: timestamps.at(0) || null, retrievedAt: new Date().toISOString(), timezone: 'America/New_York', mode: 'unknown', delaySeconds: null, attribution: provider, ...extra };
}
export function result(provider, data, extra = {}, warnings = []) {
  const hasData = Array.isArray(data) ? data.length > 0 : data !== null;
  return { schemaVersion: VERSION, status: hasData ? (warnings.length ? 'partial' : 'ok') : 'unavailable', data, source: source(provider, data, extra), warnings };
}
export const unavailable = (provider, reason, extra = {}) => result(provider, null, extra, [reason]);

// Theta timestamps are exchange-local wall clock values, not UTC. DST offsets are derived
// with Intl; never append Z to a provider's naive New York time.
export function easternToUtc(value) {
  if (!value || typeof value !== 'string') return null;
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(value)) return iso(value);
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  try { dateOnly(match[1]); } catch { return null; }
  if(Number(match[2])>23||Number(match[3])>59||Number(match[4])>59)return null;
  const target = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${(match[5] || '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(target)) return null;
  let actual = target;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(formatter.formatToParts(actual).map(x => [x.type, x.value]));
    const displayed = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${String(actual % 1000).padStart(3, '0')}Z`);
    actual += target - displayed;
  }
  const matchesWallTime=stamp=>{const p=Object.fromEntries(formatter.formatToParts(stamp).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`===`${match[1]}T${match[2]}:${match[3]}:${match[4]}`;};
  if(!matchesWallTime(actual)||matchesWallTime(actual-3600000)||matchesWallTime(actual+3600000))return null;
  return new Date(actual).toISOString();
}
export function todayEastern(now = new Date()) { return new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'}).format(now); }
export function safeError(error) {
  const value = String(error?.message || error);
  if (/HTTP \d{3}/.test(value)) return value.match(/HTTP \d{3}/)[0];
  if (/timeout|abort/i.test(value)) return 'Provider request timed out';
  if (/fetch|ECONN|ENOTFOUND|network/i.test(value)) return 'Provider connection unavailable';
  // Provider response bodies and arbitrary exception strings may contain secrets.
  return 'Provider data unavailable or failed validation';
}
