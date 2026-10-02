# Market-data connections

The dashboard and the separate downloader import the same server-side package, `packages/market-data`. Both read a private `config/providers.json` (or `SPX_FEED_CONFIG`), falling back to the shipped `config/providers.default.json` and the same environment variables. No browser receives credentials. Every adapter is read-only. There are no account, order, exercise, cancellation, or execution endpoints.

## What works without credentials

The default configuration enables four free public sources. A provider being enabled means it can be attempted; it does not promise entitlement or uninterrupted access.

| Provider | Included capability | Meaning and limits |
|---|---|---|
| Yahoo Finance chart | SPX, SPY, stocks/ETFs and supported index quotes; intraday/daily bars | Best-effort undocumented chart endpoint. Quote time is preserved. Exact entitlement and delivery delay are **unknown** to this adapter; it is never labeled verified real time. Lookback and symbol coverage vary. |
| Stooq | Daily CSV bars and last daily close | End-of-day only. Can return a provider access block. The adapter reports that failure without bypassing it. |
| FRED | Daily DGS10 / US10Y Treasury yield observation | Daily, potentially revised data. Not an intraday TNX quote and never substituted for TNX. Observation date is not release time. |
| Federal Reserve Board | Official press-release RSS | Current official headlines with publication and locally first-seen timestamps. It is not a complete corporate, AI, earnings, or market-news service. |

No free no-key source included here guarantees executable SPX option quotes, Greeks, OI, or a historical intraday option-chain archive. Until an entitled connection is configured, those panels should show unavailable. The separate synthetic demonstration is explicitly labeled and does not silently replace an unavailable real feed. No downloaded market data is distributed in this repository.

As of the integration check on October 1, 2026: Yahoo SPX bars, FRED DGS10 and Fed RSS returned data; Stooq returned HTTP 403. Free feeds can change or become unavailable. Provider errors are part of the capability status, not zero prices or an all-clear risk signal.

## Optional Theta Terminal v3

Run the terminal using your own ThetaData account and subscription. Point this project at it; this project does not launch, stop, change, or reconfigure an existing terminal.

```sh
THETA_BASE_URL=http://127.0.0.1:25503/v3 npm start
THETA_BASE_URL=http://127.0.0.1:25503/v3 npm run download -- --provider theta --kind bars --symbol SPX --date 2026-09-30 --interval 1m
```

`THETA_BASE_URL` enables this adapter for this process. Local HTTP is allowed only on loopback; remote URLs must use HTTPS. Do not embed credentials in that URL. The terminal owns authentication and market-data entitlements. Reading from an existing terminal does not give this project permission to distribute its data.

Included endpoints:

- Index/stock timestamped last price or trade.
- Index/stock intraday OHLCV, with explicit date and interval.
- One-expiry option snapshot, default bounded strike window; explicit contract selection is supported.
- Single-contract sampled historical NBBO quotes via the downloader. A sampled quote is the last quote at that time, not a bar, a guaranteed fill, or a chain reconstructed from present-day contracts.

The snapshot first attempts Theta's all-Greeks snapshot, which includes its own bid/ask. If entitlement fails, it falls back to quotes with missing Greeks set to null. Greek values are withheld when the embedded underlying timestamp is missing or more than 60 seconds from the Greek timestamp. OI is joined only on the exact contract identity, with a separate timestamp no later than the option quote. The OI business date is not asserted because the response does not supply it. Theta vega is divided by 100 to express premium points per one volatility percentage point, as its documentation requires. Theta theta and Tradier theta/vega retain the provider-reported convention and carry explicit `greeksUnits` labels; do not assume a universal calendar-day/percentage-point scale.

Theta local timestamps are converted using America/New_York daylight-saving rules. Zero/malformed OHLC and crossed/empty quotes are rejected, with a count. Index volume remains null. A daily observation is never expanded into minute bars. HTTP pagination is capped and can only follow the same terminal origin and historical read paths.

## Optional Tradier

```sh
TRADIER_TOKEN=your_token TRADIER_SANDBOX=true npm start
```

Prefer a private `.env` file, supported by the root npm commands, or a shell/environment secret manager. Never commit a real token. Set `TRADIER_SANDBOX=false` only to select the user's production **market-data** endpoint; no broker write methods exist in this project.

Tradier's sandbox data is delayed 15 minutes, with index quotes and Greeks unavailable. Production market data needs the appropriate account/entitlement; production **index data is also delayed 15 minutes**, even when entitled stock and option quotes are real time. [Tradier's FAQ](https://docs.tradier.com/docs/faq) documents this distinction. Greeks may update hourly and keep their own timestamp; they are not represented as quote-synchronous observations. The adapter accepts option bid/ask pairs only when both timestamps exist and are within 60 seconds. Current OI has no business-date timestamp in this interface. Tradier historical option chains are not supported by this adapter.

## Provider contract

```js
import {createMarketDataClient} from '../packages/market-data/src/index.mjs';
const client = await createMarketDataClient();
const bars = await client.bars({symbol:'SPX', start:'2026-09-30', end:'2026-09-30', interval:'5m'});
const quote = await client.quote('SPY');
const chain = await client.options({symbol:'SPXW', expiration:'2026-10-02'});
const news = await client.news({limit:10});
console.log(bars.status, bars.source, bars.warnings);
```

All operations return `{schemaVersion:1, status, data, source, warnings, attempts}`. `status` is `ok`, `partial` (present data plus limitations), or `unavailable`. `data` is null when unavailable. `source` includes `provider`, `asOf`, `oldestAsOf`, `retrievedAt`, `timezone`, `mode`, `delaySeconds` and attribution. Unknown delay is null, never zero. Historical/daily/synthetic data is never relabeled live. A real-time provider mode describes its service, not a guarantee that the last quote is fresh: use `asOf` and market-session state.

Bars contain symbol, UTC timestamp, open/high/low/close, nullable volume, interval, and timestamp kind. `bar-open` requires the full interval to have elapsed before using its close. `session-date` is a daily date marker with no intraday availability claim. Quotes contain symbol, last, timestamp and nullable bid/ask. Option rows add contract root, expiration, strike, CALL/PUT right, bid/ask, nullable Greeks/IV/OI and their separate timestamps when supplied. The router does not substitute different intervals or fake options when a capability fails.

The router's priority lists choose the first available enabled source. Explicit `provider` pins the source and disables failover for that request. Intraday and daily bars never substitute for each other. Mixed providers are not implicitly treated as a coherent chain. In-memory caching defaults to 60 seconds and preserves original observation/retrieval times; requests are serialized per origin with a 500 ms gap. HTTP 429 and selected server errors have bounded retries; unauthorized requests do not.

### Add a provider

Create a module that returns an object with `id`, `name`, `capabilities`, and the implemented async methods. Return the same envelopes; unsupported methods must be absent or explicitly unavailable. Add the provider to `plugins`, set its enabled flag and priority in the supplied configuration. The following complete runnable example uses an explicit synthetic observation, not a source impersonation:

```js
import {createMarketDataClient, loadConfig} from './packages/market-data/src/index.mjs';
import {result} from './packages/market-data/src/common.mjs';
const config = await loadConfig();
config.providers.example = {enabled:true};
config.priority.quote = ['example'];
const plugin = {
  id:'example', name:'Example synthetic plugin', free:true, requiresCredentials:false,
  capabilities:{quote:true,bars:[],options:false,optionHistory:false,news:false},
  async quote({symbol}) {
    return result('example', {symbol,last:5000,bid:null,ask:null,timestamp:'2026-01-02T15:00:00Z'},
      {mode:'synthetic',attribution:'Illustrative example only'});
  }
};
const client = await createMarketDataClient({config,plugins:[plugin]});
console.log(await client.quote('SPX'));
```

The constructor injection is also how the test suite supplies deterministic fake transports. Production plugins should keep keys in server-only closures, validate symbol identity and timestamps, report entitlement restrictions, implement bounded pagination, and add fixtures containing invented values. Never check purchased responses or private account data into tests. New built-in plugins can be registered in `src/index.mjs`; no UI rewrite is needed when they obey the contract.

## Rights and primary documentation

The MIT license covers this project's code, not third-party data, exchange entitlements, API access, books, or news. Before publishing a hosted deployment, establish the right to display/redistribute each feed. Yahoo explicitly prohibits redistribution and calls its information informational; this default connection is for local personal research. This project neither republishes its data nor claims an official Yahoo API agreement. Stooq and all other sources retain their terms. Do not bypass access restrictions.

[Tradier's FAQ](https://docs.tradier.com/docs/faq) limits API entitlement to personal use unless the user is a Tradier Partner. [ThetaData's standard terms](https://www.thetadata.net/terms-and-conditions) limit individual use to personal, noncommercial activity and restrict redistribution; a separate product agreement can provide different rights. This open-source adapter does not expand either provider's license or grant rights to publish downloaded archives.

Primary references checked October 1, 2026; Tradier's FAQ and ThetaData's terms rechecked October 2, 2026:

- [Yahoo exchanges, delays and provider restrictions](https://help.yahoo.com/kb/finance/article-exchanges-data-delays-sln2310.html)
- [Stooq SPX historical-data page](https://stooq.com/q/d/?s=%5Espx)
- [FRED DGS10 definition and source](https://fred.stlouisfed.org/series/DGS10)
- [Federal Reserve RSS feed directory](https://www.federalreserve.gov/feeds/feeds.htm)
- [Theta stock historical OHLC](https://docs.thetadata.us/operations/stock_history_ohlc.html)
- [Theta index historical OHLC](https://docs.thetadata.us/operations/index_history_ohlc.html)
- [Theta option snapshot quote](https://docs.thetadata.us/operations/option_snapshot_quote.html)
- [Theta option historical quote semantics](https://docs.thetadata.us/operations/option_history_quote.html)
- [Theta all-Greeks snapshots](https://docs.thetadata.us/operations/option_snapshot_greeks_all.html)
- [Theta open-interest snapshots](https://docs.thetadata.us/operations/option_snapshot_open_interest.html)
- [ThetaData use and redistribution terms](https://www.thetadata.net/terms-and-conditions)
- [Tradier market-data availability and Greeks](https://docs.tradier.com/docs/market-data)
- [Tradier environments](https://docs.tradier.com/docs/endpoints)
- [Tradier usage/redistribution FAQ](https://docs.tradier.com/docs/faq)
- [Tradier time-and-sales lookback limits](https://docs.tradier.com/reference/brokerage-api-markets-get-timesales)

- [Theta Greek model and unit conventions](https://thetadata.net/docs/Articles/Data-And-Requests/Option-Greeks.html)
