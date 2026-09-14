# Publication Trace Implementation Plan

**Goal:** Add an append-only timeline from first observed email read through processing, publication, later changes, retries and notification observations without changing UI/editorial behavior.

**Architecture:** Private database event log and independent write-observation triggers; authenticated edge ingest/report endpoint; Python local durable JSONL spool and bounded batch export; correlated stage/run IDs in workers. Producer time and database observation time remain distinct. External newsletter routines must explicitly log phases that happen outside this repository; their adherence needs live verification.

**Scope:** Add instrumentation only. Do not silently repair unrelated audit defects or claim old history is complete. No raw emails/article bodies/source URLs/credentials in event metadata. Telemetry outage must not abort publication; local spool and warnings expose missing remote logs. Database publication observations are atomic with the write, but fail open on telemetry-only errors. Abrupt death leaves an unfinished phase, never a fabricated success.

- [ ] Write behavioral tests for private SQL log, direct writes/rollback/no-op, worker error paths, durable replay/idempotency, and metadata safety.
- [ ] Add migration and authenticated bounded ingest/report endpoint; instrument standby without changing its decisions.
- [ ] Add Python trace library/CLI; instrument routines, extraction attempts, publication validation/conflicts/noops and workflow setup outcomes.
- [ ] Document the required external routine contract and actual coverage; preserve no-window Mini compatibility.
- [ ] Run complete regression tests, review code, canary-test additive database/endpoint changes, merge and verify deployment/worker evidence where authorized and available.

Production deployment must distinguish code shipped, database installed, instrumentation observed, and external email phases verified. No synthetic receipt times or retrospective completion claims.
