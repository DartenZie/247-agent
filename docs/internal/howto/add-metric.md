# Add a metric

Anything worth graphing is a metric on the shared registry
(`packages/core/src/metrics.ts`), scraped as Prometheus text from `GET /metrics`.

1. **Choose the kind.** A counter where the thing happens (a run finished, an op was
   called, a request was denied); a gauge for a current level read at scrape time
   (runs in flight, the day's spend, the database size); a histogram for a duration.
   Done when you can say which of the three it is and what one increment means.
2. **Keep labels bounded.** Labels are a task name, a connector name, a model id, a
   status or a result, never an event id, a run id or anything user content can grow
   without bound. An event `type` is labelled only when the core or a task's config
   names it exactly, else `other` (see how `events_published_total` does it). Done when
   the set of label values is finite and known from the config.
3. **Register it** in `metrics.ts` with the `oa_` prefix, a unit suffix where there is
   one (`_seconds`, `_bytes`, `_usd`, `_total` for counters) and a help string. Done
   when `npm run build` passes.
4. **Record it where it happens.** A counter increments in the module that does the
   thing (bus, dispatcher, executor, scheduler, llm service, supervisor, proxy). A
   gauge is a `collect` callback registered in `core.ts`, so it is read at scrape time
   and survives a reload. Done when the value changes in a unit test of that module.
5. **Test it** in `metrics.test.ts` or the module's test: the name, the labels and one
   observed value. Done when `npm test` passes.
6. **Document it** in `docs/reference/metrics.md`, in the table, one row. Done when
   `node scripts/check-docs.mjs docs/reference` passes.
7. **Verify** with the `verify` skill: baseline, and the daemon rung reading `oa
   metrics` after the thing happened once.
