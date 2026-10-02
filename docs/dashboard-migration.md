# Independent installation and migration

1. Copy or clone this companion repository into a **new directory**. Do not install it over a running dashboard checkout.
2. Install Node.js 22.18+ and run `npm ci` in this repository. The app does not need the original frontend framework, recorder or broker account.
3. Run `npm start` and use port 8787. If occupied, choose another free `PORT`. No script stops, replaces or restarts another service.
4. Review public source timestamps. Configure additional entitled providers through this repository's private config or `.env`, following `feeds.md`.
5. Use this repository's downloader to create normalized, checksummed archives. Keep its destination separate from another recorder's active data directory. Existing raw snapshots require an explicit adapter/import process; pointing the app at arbitrary old files is insufficient.
6. If permitted by your data/model licenses, copy compatible frozen model files into this repository's ignored `models/` directory. Do not share private broker data, vendor datasets or model artifacts in Git without checking their rights.
7. Verify the desired session calendar and use sourced dated overrides when needed. Test a replay cutoff before relying on any displayed history.
8. Run the tests and build before publishing changes. The root `.gitignore` excludes local credentials, data and model directories; still review every staged file.

The companion has no hard-coded path to the author's original dashboard and no runtime dependency on it. The original local dashboard, its localhost ports, its configuration, model snapshots and historical recorder are not migration targets. They continue independently.

For a custom provider, implement the shared normalized contract described in `feeds.md`; retain exchange timestamps, interval semantics, exact contract identities, delay labels and data availability. Connect both the downloader and browser server through the same library. Never make the browser hold vendor credentials.

The default UI is intentionally more compact than the original app. Consult `dashboard-feature-parity.md` before assuming a private feature or model has been shipped. The synthetic demonstration is the quickest way to inspect the interface without importing any private data.
