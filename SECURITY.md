# Security boundaries

The application is a local read-only research service. Bind to loopback unless you deliberately configure a different host. It is not an authenticated public hosting product. Provider credentials stay server-side; the browser receives normalized observations and sanitized status information.

Do not commit `.env`, private provider/calendar configuration, `data/`, `models/`, account records or purchased source files. Inspect both the working tree and Git history before publishing. Model weights and market-data derivatives may have their own source and redistribution constraints.

The archive reader checks file integrity and confines reads to the configured archive. The downloader uses bounded requests, an exclusive write lock and atomic files. A manually removed lock must not belong to another active process. Source failures do not authorize bypassing provider restrictions.

Do not post credentials, raw private provider responses or account information in an issue. Describe the affected component, reproduction using invented values, runtime version and expected behavior. If a key has been exposed, revoke it through the issuing provider; deleting it from a later commit does not remove the earlier exposure.

The project does not enforce broker stops, guarantee notification delivery or submit orders. No trade decision should depend on the assumption that this local process cannot be interrupted.
