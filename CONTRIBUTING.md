# Contributing

Keep the measurement and its interpretation separate. A provider adapter should preserve identity, units, source and availability times. An analysis engine should document its assumptions and reject insufficient inputs. A UI should show unavailable as unavailable, and synthetic as synthetic.

For a code change, include a concise explanation of the problem and resulting behavior. Add tests when they protect an economic or data-integrity invariant: completed bars, no future observations in replay, coherent quotes, units, payoffs, source failures or model validity. Use invented fixtures; never commit licensed data or personal account records.

Run `npm test`, `npm run typecheck` and `npm run build`. For provider work, report network smoke results separately from deterministic tests. A successful request today is not a long-term provider guarantee.

New providers implement the shared contract in `packages/market-data` and document capabilities, timestamps, rates, delays, rights and limitations. The dashboard and downloader must share the implementation. Keys remain in server-side environment variables or ignored configuration.

Research contributions identify the question, dataset scope, observation availability, train/validation/test chronology, execution assumptions, costs, exclusions, uncertainty and comparison baseline. Report the number of configurations examined. Preserve negative results. An improvement in coverage is not automatically an improvement in forecasting or trading returns.

For mathematical examples, keep assumptions, units and limitations explicit, cite primary references where appropriate, and run `npm run test:examples`. Full book manuscripts are maintained separately from this code repository.
