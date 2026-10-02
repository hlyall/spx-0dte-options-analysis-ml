# Feed, archive and dashboard integration audit

Audit date: October 1, 2026. Scope: the isolated `spx-machine-intelligence` deliverable. The existing local dashboard and existing Theta Terminal configuration were not changed.

## Validation

- `npm test`: 162 tests passed (133 dashboard, 29 market-data/archive), with no failures or skipped tests.
- `npm run build`: passed.
- `npm run typecheck`: passed.
- The 29 market-data tests include six independent integration checks for asynchronous option chains, exact root/expiry identity, interval and provider separation, future Greek/OI exclusion, archive-to-dashboard compatibility, symlink escape rejection, and news publication/first-seen cutoffs.
- Read-only network probes verified Yahoo intraday bars, FRED rates, Federal Reserve news, and configured Theta index/stock bars, option snapshots and single-contract historical quotes. Downloader atomic output and checksum resume were exercised. Stooq returned HTTP 403 and remained unavailable; no bypass was attempted. Tradier has deterministic adapter tests but was not tested with authenticated production credentials.

## Corrections verified

Replay uses the downloader's `option-history` kind and canonical OI timestamp. One-minute bars must have exact minute timestamps, complete before the selected cutoff, and come from one provider per symbol. Synthetic and observed archive rows cannot be mixed. Live option observations have a separate retrieval-completion cutoff; the displayed chain retains the latest observation per exact SPXW contract within a bounded 60-second window, with incomplete coverage explicitly reported. Gamma calculations exclude incoherent spot, future Greeks and invalid OI timestamps. News must have been both published and first observed before its replay cutoff, and untrained headline routes are not portrayed as learned forecast influence.

Archives validate checksums, row counts and real paths before reading. The HTTP server exposes an explicit three-file static allowlist, serves read-only GET endpoints, rejects unrecognized Host/Origin headers and does not expose `.env` or provider credentials. Model input freshness and dated cash-calendar availability gate forecasts and pattern alerts.

## Remaining limits

Free public sources do not provide a guaranteed complete, live SPX option chain; unknown source delay remains unknown. Yahoo access is best effort and Stooq may be unavailable. OI snapshot time does not establish the OI business date or dealer inventory. Sampled historical option quotes are not executable fills, and revised downloaded bars are not certified point-in-time records. Theta and Tradier require the user's own running service or entitlement. No credentials, licensed market dataset, trained production model, return guarantee or broker write capability is included.

Network-probe metadata is retained in `feeds-verification.json`; normalized downloaded observations and private configuration remain outside distributable source.
