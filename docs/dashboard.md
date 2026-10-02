# Dashboard guide

The portable dashboard is a separate application. It does not launch, modify, or depend on the author's existing dashboard, recorder, broker session, or machine-specific directories. Its default address is **http://127.0.0.1:8787**.

## Start

Use Node.js 22.18 or newer, from the repository root:

```sh
npm ci
npm run build
npm start
```

Open the printed local address. Root commands load a local `.env` file when present; copy `.env.example` if you need overrides. Stop the foreground server with Ctrl-C. Choose another `PORT` if 8787 is occupied. The normal bind address is loopback; exposing it to a network requires your own authenticated proxy and deployment review.

## Three views

| View | What it displays | Important boundary |
| --- | --- | --- |
| Connected feeds | Available observations from configured sources; public sources are attempted by default | Provider timestamps and delay modes remain visible. Fetching now does not make a quote live. |
| Synthetic demo | A deterministic, invented session, options chain, Greeks, news and sector history | The conspicuous synthetic banner applies to every value. These are not historical returns or recommendations. |
| Archive replay | Normalized observations downloaded into `data/downloads` | Only completed bars and observations available at the selected cutoff are eligible. Missing inputs stay unavailable. |

Select a view, then refresh. Demo/replay have a date, a minute slider and a play/pause control. Connected data refreshes at most once per minute while the tab is visible. A server cache also limits duplicate requests. Demo uses an invented October 1, 2026 session; moving its date control does not create real history.

The app includes price/context charts, current and last detected playbooks, premium z-score, EMA retests, conditional gamma exposure, a rolling sector network, news routes, a persistent-model panel, an options chain and an editable expiration-payoff laboratory. A detected eligible reversal changes the page theme immediately; confirmation remains a separate entry gate. A hidden connected-feed tab flashes its title when a reversal is detected, except when reduced motion is requested. Demo and replay do not issue hidden-tab alerts.

The payoff laboratory uses signed quantities (positive buys; negative sells), a 100 multiplier, premiums in index points and expiration intrinsic value. Its P/L excludes fees, slippage and interim Greek changes. It does not send orders.

## Midnight Network theme

The dashboard shares the books’ Midnight Network palette: midnight navy surfaces, ivory typography, cyan price and positive-direction marks, and gold reference levels, premium charts and news links. A decorative curve motif echoes the cover artwork; it does not represent market observations. Charts use the same CSS color tokens as the interface. Bearish marks and eligible reversal warnings remain red, and a detected reversal still changes the whole page theme immediately. The layout adapts to phones; keyboard focus remains visible and reduced-motion preferences are respected. No external fonts or image services are required.

## Range and pattern labels

The portable app uses INSIDE, GAP-UP, GAP-DOWN, EXT-UP, EXT-DOWN and TWO-SIDED range labels. See [pattern conditions](dashboard-patterns.md) for all nine candidates, their actual code predicates, and the separate confirmation gates. Names describe observations; they do not assert a profitable strategy. Session history is rebuilt with these identifiers from raw observations.

## Feed requirements and labels

See [feeds](feeds.md) for adapter capabilities and configuration. The minute-based engines accept **1-minute bars only**. Daily yield history and delayed or unknown-delay index data can supply context where displayed, but cannot silently replace current intraday inputs. SPX uses cash-index prices; SPY supplies its own traded volume and VWAP. The app does not invent SPX volume or treat SPY prices as SPX points.

Public defaults do not promise a current SPX options chain. With no eligible options source, premium/Greek/GEX panels explain missing inputs. An entitled Theta terminal or another supported adapter can provide more observations. Option snapshot assembly keeps the latest observation per exact SPXW contract inside a 60-second window; this is a **partial observed chain**, not proof of complete market coverage. Gamma additionally requires spot/quote coherence and valid Greek/OI timestamps. Call-positive/put-negative GEX is an inventory assumption, not observed dealer positioning.

Greek units are adapter-specific. The demo has theta per calendar day and vega per volatility percentage point. Theta-data vega is normalized by its adapter; provider-reported theta or other unverified units retain their explicit labels. Never compare raw Greek values across sources without checking units.

## Historical playback

Use the separate [downloader](downloader.md) to populate the archive. Set `SPX_ARCHIVE_DIR` to a different directory if needed. The server reads the manifest; it never exposes arbitrary local files through HTTP. Checksums, row counts, provider identity and timestamps are checked by the shared archive reader.

Select `SPX_REPLAY_PROVIDER` if an archive contains multiple providers for the same symbol. The minute engine excludes non-1-minute bars, and quarantines symbols with conflicting provider histories. Synthetic and observed archives cannot be combined in one replay. Synthetic-only archives remain explicitly labeled synthetic.

A replay cutoff excludes future prices, quote sides, Greeks, OI, news publication and known news first-seen times. OI with no known as-of time is withheld during replay. The fixed measurement call is selected from the earliest eligible chain and the underlying price knowable then. A sparse sequence of current snapshots cannot recreate a complete historical chain or a continuous premium series. Prior intraday prints are not labeled official settlement or official closing values.

## Cash-session calendar

`config/cash-calendar.json` contains published NYSE cash-session holidays and early closes for 2026–2028, with its primary source URL. This sets analysis horizons; it is not an options-product trading-hours calendar or an emergency-closure service. Dates beyond the supplied coverage are unverified. Closed/unverified sessions suppress pattern alerts, execution gates and model forecasts. Minute engines currently assume a 09:30 cash open; a nonstandard open also holds those outputs.

For an exchange-announced change, create private `config/sessions.json` with a dated, sourced override. Bounds are minutes since midnight **America/New_York**; 570 is 09:30, 780 is 13:00.

```json
{
  "schemaVersion": 1,
  "sessions": {
    "2026-11-27": {
      "open": 570,
      "close": 780,
      "closed": false,
      "verified": true,
      "source": "Verified exchange schedule URL or explanation"
    }
  }
}
```

Only set `verified: true` after verifying the dated exchange notice. A global `SPX_SESSION_CLOSE` (legacy alias `SPX_REPLAY_CLOSE`) changes bounds but deliberately marks the calendar unverified, preventing an unsourced global setting from enabling signals. Eastern timestamps use date-aware daylight-saving conversion.

## Persistent learned models

No private trained model or licensed training dataset is bundled. The rolling correlation network is available independently; it is descriptive and is not the learned model's directional forecast. The persistent-model panel therefore starts as **Unavailable**. This is an intentional missing-evidence state.

If you own compatible, independently validated artifacts, put them in `models/` (or `SPX_MODEL_DIR`):

- `sponge-model.json`: retained sector/macro sponge schema.
- `sponge-interactions-model.json`: retained interaction schema.
- `sponge-missing-model.json`: retained missing-input reconstruction schema.

The missing-input bundle has priority, then interactions, then the base sponge. Core parsers validate schemas, feature order, dated versions, fitting windows, coverage and horizon requirements. Live inference also requires current completed bars from an eligible realtime source for SPX, SPY, all eleven sectors, oil and rates. Yahoo's unknown-delay status cannot silently meet that requirement. Invalid artifacts and insufficient evidence remain unavailable. A local file containing arbitrary coefficients is not automatically a validated model.

This release does **not** include the original private training pipeline or automatically train on new ticks. Replaying data does not retrain weights. The displayed dotted news links are qualitative relevance routes; they do not create learned forecast coefficients. The illustrative issuer registry contains twelve examples, not the full current S&P 500 membership.

## Verification and scope

Run `npm test`, `npm run typecheck` and `npm run build`. See [feature parity](dashboard-feature-parity.md), [migration](dashboard-migration.md), and [integration audit](release-integration-audit.md). The browser is a research interface with no brokerage actions, account credentials or order automation.
