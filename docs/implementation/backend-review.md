# Independent backend and preference review

Reviewed implementation reports, migrations 202609110002/003 and their prerequisite contracts, cookie-capture authentication, notification dispatch and durable delivery helpers, rates/market handlers, profile handler/database mutation path, profile-store, and the current root app integration. No production services were called. Passing tests were not rerun except the handler suite for the newly confirmed rates defect.

## Findings

### Fixed: rates refresh could regress SOFR and erase averages (P2)

Before the review fix, `rates-live` guarded only Treasury date regression. A synthetically complete Treasury response dated September 11 plus SOFR dated September 1 replaced the September 10 cached SOFR, wrote null 90/180-day averages, and returned success without stale marking. This contradicted last-good preservation.

Fixed in commit `bbba378` (plus a subsequent literal-tuple typing cleanup): require valid observation dates for Treasury, SOFR and SOFR averages; reject each date's regression; require finite 30/90/180-day averages. Any failure returns the complete marked last-good response and never writes the partial refresh. Relevant code: `supabase/functions/rates-live/index.ts:142-158`.

The new mocked-handler regression failed before the fix. Afterward `node --test tests/backend-handlers.test.mjs` passed all eight reported tests, including four scenarios: regressed SOFR, regressed averages, missing 90-day average, and missing SOFR date. Reproduction artifact: `/private/tmp/review_rates_regression.mjs`. All fetches used synthetic responses.

### Fixed: separate browser tabs could overwrite each other's offline queue (P2)

`js/profile-store.js` keeps one in-memory pending array per store instance but persists it by replacing a single shared `briefing_pending_v3_<profile>` localStorage key (persist at line 40, enqueue at lines 54-56). Two same-origin tabs initialized before either edit do not observe one another's enqueue. Tab A queues article A offline; tab B queues article B offline and replaces the shared durable array; closing/reopening leaves only B. No storage failure is thrown, so A is silently lost if A closes before sending.

Reproduced with two real createProfileStore instances and one in-memory implementation of shared localStorage: after A then B enqueue, a third store's overlay was `{"read":["article-b"]}`. Database cross-device deltas do not solve this browser-local persistence race. A robust fix can use independent per-operation durable keys or atomic IndexedDB storage, and acknowledge/remove only the sender's operation IDs. A storage-event listener alone does not make read-modify-write atomic. Root authorized the fix after the read-only reproduction. The queue now persists each immutable operation under its UUID key, rescans before sending, removes only acknowledged IDs, and uses Web Locks to serialize upgraded tabs' network sends. Legacy v3 operations retain their UUIDs during migration; v2 snapshots retain legacy replacement semantics. New regressions first reproduced both lost additions and resurrection of an acknowledged scalar, then passed with the journal implementation. Additional tests cover edits from another tab during a send and stable-ID v3 migration.

## Contracts assessed without new blocking findings

- Publisher tickets require private pipeline authority to issue, contain domain-scoped random capability material, store only hashes, and consume/replace cookies transactionally. Capture and issue RPC execution is revoked from anon/authenticated/public and granted to service_role. Direct cookie replacement is gated at the Edge before calling the null-ticket branch. Browser ticket capture never returns a backend credential.
- Replacing the existing audit_finish_push function retains its existing service-only grant. Transient exhaustion records failed without deleting endpoints; explicit gone/404/410 still prunes. New discovery data is private behind a service-only RPC.
- Quiet hours are checked before discovery/draining, so overnight work remains available at the morning run. Installation baselines yesterday to prevent the initial archive blast, while subsequent discoveries can include late prior-day items. Date-scoped readiness and event links match the updated frontend. As already reported, mixed watch/breaking concurrent dispatches are not unified under one transaction; same-event delivery is still durable and leased.
- Preference mutation batches validate before mutation, serialize on the profile row, and bind persistent receipts to profile plus operation ID/payload. A response-loss replay cannot resurrect an already removed set member. The existing root callback now forwards mutations and calls observe before overlay during activation, including cached activation. Existing legacy full-array writes intentionally retain replacement semantics.
- Market Pulse retains failed/regressed individual series with observed dates. Shared fetch timeout/error handling prevents false cache-write success. Public force no longer bypasses freshness. Concurrent market refreshes remain an acknowledged boundary.

## Deployment caveats retained

These checks are local/mocked and source-level. They do not establish hosted Deno execution, real device delivery, actual ticket capture, or production RPC privileges after migration. Migrations and backend handlers must precede dependent frontend release. Both concrete review findings have been fixed locally. The journal and client/handler suite pass 13 tests. Cross-tab display updates are not pushed live; reactivation, queue reads and successful flushes observe shared pending work. Environments without Web Locks fall back to in-context serialization: durable per-operation writes still prevent lost offline enqueues, but simultaneous scalar sends across distinct browser tabs lack that lock guarantee. Scalar preferences otherwise retain the explicitly accepted server arrival-order semantics, including cross-device response-loss retries. Old clients still writing v2/v3 queues or full arrays must upgrade before these guarantees apply.
