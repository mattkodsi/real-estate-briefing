# Backend reliability implementation

Implemented locally; no production deployment, database write, or device notification was performed by this task.

## Cookie capture

Recovered the deployed `store-session` source and replaced anonymous cookie writes with private owner authority. The owner is the holder of `AUDIT_PIPELINE_SECRET`, never an arbitrary reader profile. Direct CLI capture sends that credential only from the operator environment. `python3 scripts/trd_session.py --issue-ticket --domain therealdeal.com` issues a random 256-bit, domain-scoped, ten-minute ticket. The browser sends `captureToken`; it never receives the pipeline credential. Only the ticket hash enters the database. Ticket consumption, cookie replacement and nonsecret connection status are one transaction, so replay/concurrent consumption cannot both succeed and failed writes roll back consumption. Supported domains are therealdeal.com, inman.com and bisnow.com, with www normalized. Requests and cookie sizes are bounded; cookie CR/LF is rejected. No vault read is exposed.

Frontend integration: prompt for the fresh ticket when reconnecting, send it transiently in the publisher bookmarklet request, and explain the owner command. A permanent bookmarklet must prompt for a fresh ticket each time rather than embedding a ticket that expires. The CLI's existing --cookie path now stops with a clear explanation if the private environment credential is absent. Legacy WordPress mode also authenticates its final save.

## Notifications

Added complete, bounded fallback copy (38-codepoint heading, 130-codepoint body) instead of cutting potentially misleading financial claims mid-sentence. Watch bundles use bounded generic copy with an exact story or dated edition destination. Events link to `#/calendar?event=<id>`; root owns event focus behavior. Briefing-ready goes to its date.

Explicit `pushEligible` true/false controls urgency regardless of cadence. During the external-generator transition, absent eligibility falls back to special + featured + nonbrief. Thus cadence alone no longer triggers breaking alerts; the transitional fallback should be removed only after external prompts are verified. The generation contract must supply complete pushTitle/pushBody and explicit eligibility.

Discovery covers today and yesterday, while migration baselines existing yesterday stories as ineligible. New late stories become eligible without an archive backfill. Existing durable event/device keys preserve idempotency. Cross-reason dedupe is profile-scoped; a watch-only reader still receives a story another reader received as breaking. It checks recent durable breaking jobs and watch reservations. This prevents sequential dispatcher duplicates; existing enqueue/lease RPCs still provide per-event atomicity. Concurrent independent dispatches with mixed watch/breaking timing are not a new unified story-reason reservation transaction.

Retry exhaustion changes the job to `failed`, preserving the endpoint. Only the existing explicit 404/410/gone provider classification deletes subscriptions. Devices deleted by the old deployed retry-cap cannot be reconstructed and must resubscribe. This task did not replay failed jobs or test-send notifications.

## Market data

Recovered production-owned rates-live and market-pulse into version control. All requests now have a twelve-second timeout and reject non-2xx responses, including cache writes. Rates preserve the complete old response when upstream data is missing, regressed, or incomplete. Market Pulse retains each failed or regressed series with its actual observation date and `stale:true`; it fails the refresh if no national series succeeds. Failed cache writes return marked last-good data, not a false persisted-success response. Public `force` no longer bypasses Market Pulse freshness caching. Forward metadata explicitly describes the Treasury par-yield-as-zero-yield approximation, not an OIS curve or forecast of SOFR. Root owns visible forward/staleness labels.

The last-good behavior is per refresh attempt, not a new distributed cache lock. Concurrent refreshes and the existing public cache table policies are unchanged.

## Deployment order and checks

1. Confirm the existing private `AUDIT_PIPELINE_SECRET` is configured on the backend and securely available to the operator. Do not put it into the frontend or publish it in a ticket. If absent, owner reconnect requires secure operator configuration before rollout.
2. Apply `202609110002_backend_reliability.sql` (depends on the existing reader/backend audit and retry-cap migrations). Apply immediately before deploying the dispatcher so the yesterday baseline is current. This adds service-only capture RPCs/table, the failed job state, bounded watch payload, and discovery table/RPC. Public content write policy remains unchanged.
3. Deploy store-session, rates-live, market-pulse, push-dispatch with the shared helper files and config.toml. Do not invoke push-dispatch as a verification probe because it can send real notifications.
4. Release the compatible frontend ticket prompt, focused calendar route, approximation/stale labels and the updated CLI. Update and verify the externally scheduled generator's urgency/microcopy contract.
5. Verify deployed source/config and read-only market responses. Owner reconnect requires a real operator ticket/cookie capture; that was not simulated against production.

## Local evidence

`node --test tests/backend-reliability.test.mjs tests/backend-handlers.test.mjs` passes synthetic auth, bounded copy, urgency, date-boundary discovery, retained series, actual handler upstream/cache failures, and profile-specific breaking/watch dedupe. Handler tests replace every network request and never contact services.

`PGLITE_MODULE=/private/tmp/cre-test-runtime/node_modules/@electric-sql/pglite/dist/index.js node --test tests/backend-database.test.mjs` passes isolated PostgreSQL migration execution, service-only permissions, domain mismatch, one-use and expired tickets, transient exhaustion retaining endpoints, explicit gone pruning, and yesterday baseline versus late arrival. The test skips explicitly without this optional local runtime; no production connection URL is accepted. The migration was exercised against synthetic prerequisite tables, not a full production schema dump.

All four function entrypoints parse via Node's TypeScript stripping. This is syntax and mocked runtime verification, not Deno hosted compatibility or real iPhone push rendering certification. No Deno executable was available in this task environment.
