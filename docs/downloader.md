# Separate historical downloader

The command-line downloader runs independently of the dashboard. It imports exactly the same provider configuration and authentication path. No separately entered credentials, broker account access, or order tools are involved. Start from the repository directory with Node 22.18 or newer.

```sh
npm run providers
npm run download -- --kind bars --symbols SPX,SPY --start 2026-09-25 --end 2026-09-30 --interval 1d
npm run download -- --kind bars --symbol SPX --date 2026-09-30 --interval 5m
```

Without optional subscriptions, Yahoo is the default attempt for bars; its allowable intraday lookback is limited and may change. Stooq is a daily-only fallback when accessible. Requests retain exact symbols, requested interval, provider identity and source timestamps. No-key historical option data is not promised. You can always explore the clearly labeled synthetic dashboard demonstration without an external connection.

## Theta examples

```sh
THETA_BASE_URL=http://127.0.0.1:25503/v3 npm run download -- \
  --provider theta --kind bars --symbol SPX --date 2026-09-30 --interval 1m

THETA_BASE_URL=http://127.0.0.1:25503/v3 npm run download -- \
  --provider theta --kind option-history --symbol SPXW \
  --date 2026-09-30 --expiration 2026-09-30 --strike 7700 --right CALL --interval 1m

THETA_BASE_URL=http://127.0.0.1:25503/v3 npm run download -- \
  --provider theta --kind bars --symbol SPY --date 2026-09-30 --interval 1m \
  --start-time 07:30:00 --end-time 09:45:00
```

Use strikes, expirations, roots and historical dates appropriate to the study. These are syntax examples, not recommended trades or verified historical contracts. For overnight SPXW, a terminal's supported trading-session date semantics must be verified against its raw timestamp boundaries; do not infer a prior-evening window by renaming a cash-session file. This CLI applies explicit exchange-local start/end times within the supplied date and does not invent overnight data. Historical contract downloads require an explicit strike and right to bound volume. Run separate commands for additional legs. Snapshot Greeks/OI are not substituted into an older quote history.

## Current snapshots

```sh
npm run download -- --kind options --symbol SPXW --expiration 2026-10-02
npm run download -- --kind news
```

An option snapshot needs a configured entitled provider. These commands capture the current observation and retrieval times. They reject past dates. They do not create a historical chain for yesterday by using today's OI or Greeks. Options retain independent contract and quote timestamps; a chain does not imply all legs are synchronized. Fed RSS records first-seen time; downloading an old headline today does not make its current text available to an earlier replay.

## Archive layout and resumption

The default destination is `data/downloads/`, ignored by Git. Override with `--out directory`; point the dashboard archive configuration at that same destination for playback. Each dated request produces normalized NDJSON and a root `manifest.json`:

```text
data/downloads/
  manifest.json
  yahoo/bars/SPX/2026-09-30-<request-hash>.ndjson
  theta/option-history/SPXW/2026-09-30-<request-hash>.ndjson
```

Each NDJSON line includes the row's source envelope. The manifest records query parameters, schema version, provider, kind, symbol, interval, expiration, source and retrieval times, SHA-256, row count, warnings and failed-provider attempts. It contains no keys or private connection URLs. Status is `complete`, `partial`, or `unavailable`. `partial` may indicate usable observations plus a limitation such as uncertain delay, rejected bad rows or incomplete Greeks; it does not assert complete market coverage. `complete` means a successfully validated response, not proof that every market event was captured.

Historical-job resume is automatic. Current option/news captures receive a unique acquisition timestamp on every invocation and preserve successive snapshots. The downloader verifies the hash and row count before skipping a saved successful/partial request. Corrupt files and unavailable requests are fetched again. `--overwrite` forces re-download. Each file and manifest is replaced atomically; an exclusive directory lock prevents simultaneous writers from losing manifest entries. A terminated process can leave `.writer.lock`; inspect running processes before manually removing that lock. The tool never silently removes a lock another process might own.

Requests are split by date and symbol, serialized, and limited to 31 calendar days unless `--max-days` is set (hard cap 3,660). Provider-specific lookback restrictions still apply. Weekends/holidays with no observations remain unavailable rather than zero-valued market days. Retry and timeout rules come from the shared configuration. The request identity includes interval, source selection, expiration, strike, right and time filters. Source changes are not silently merged into one instrument's history.

Exit status 0 means requests were saved or verified/resumed; 2 means at least one request was unavailable, while successful jobs remain saved; 1 means argument/configuration/program failure. Source failures are recorded without printing raw provider response bodies or tokens. Protect your local archive according to its provider terms; it is not public repository content.

## Replay rules

The common `readArchive({directory,symbol,kind,start,end,asOf,provider,interval})` verifies every selected file's checksum before reading. It refuses file paths or symlinks outside the configured archive directory. A cutoff includes only completed intraday bars, observations at/before the cutoff, and headlines first seen by that time. Bid/ask sides after the cutoff invalidate a quote; later Greek/OI/underlying timestamps cause those fields to be withheld. Daily date markers have no known intraday availability and are excluded from time-of-day replay. Choose source and interval explicitly when several are archived; the data layer preserves those identities instead of averaging them together. Use exchange-session calendars and corporate-action handling in a strategy-specific study; this reader is not a backtest engine.

The archive does not certify lookahead-free data: providers can revise old bars, daily fundamentals and news after their original publication. For strict point-in-time research, record prospectively and preserve acquisition versions. Downloaded historical bars are labeled historical, not represented as a tape captured in real time.

## Validation commands

```sh
node --test packages/market-data/tests/*.test.mjs
node tools/downloader/cli.mjs --help
```

Tests cover timestamp/DST conversion, missing/invalid bars, crossed quotes, source failover, HTTP retry behavior, credential redaction, bounded pagination, exact-identity OI joins, stale underlying Greeks, manifest checksums, safe archive paths, replay cutoffs, snapshot-date restrictions and idempotent resume. Network smoke checks are separate from deterministic tests because provider availability is not under this project's control.
