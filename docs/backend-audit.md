# Backend audit changes (prepared, not deployed)

The four edge functions now reject privileged calls unless `x-audit-secret` matches the nonempty `AUDIT_PIPELINE_SECRET` edge environment secret. A public/anonymous JWT alone is not authorization. Public `GET push-send?setup=1` remains available and never writes; if keys are absent, an authorized `POST ?setup=1` initializes them with conflict-ignore plus reread, avoiding a key-generation race.

## Release dependencies

1. Back up existing schema and preserve existing VAPID keys. Apply `202609060002_backend_audit.sql` before the functions. It creates private job tables/RPCs and revokes client grants on `push_log`; it does not modify public article write policies. Only the service role may execute the new security-definer RPCs.
2. Configure a strong random `AUDIT_PIPELINE_SECRET` in the edge environment and the pipeline/Actions/owner environments. Store the same value privately for the two existing pg_cron jobs: `fill-content-standby` and `push-dispatch`. Update their request headers to include `x-audit-secret`. Never embed this value in browser code, tracked config, or logs. Leave the unrelated rates/market-pulse/Carnelian jobs alone.
3. Update `scripts/fetch_article.py`, `scripts/probe_fetch.py`, and `scripts/monitor_sources.py` to send that environment secret on their proxy/push calls. Other direct invokers of these endpoints must do the same. Keep the public VAPID GET caller unchanged.
4. Deploy the four functions with the matching explicit gateway setting in `supabase/config.toml`. These endpoints can use `verify_jwt=false` because they enforce the dedicated secret themselves; this is also necessary for the public VAPID read with a publishable key that is not a JWT. Change the setting only together with the guarded implementation. Current live settings were inspected read-only by the coordinator: push-send true v2, push-dispatch true v2, fill-content true v3, fetch-proxy false v3.
5. In an isolated staging environment, verify Deno edge `node:http`/`node:https` compatibility, HTTPS certificate validation/SNI against a public news site, correct cookie delivery on the same host, cross-host cookie stripping, and the authenticated cron headers. Run real-device push checks only with a test subscription. None of these production actions has been performed.

## Outbound article fetch

Both article paths share `audit-fetch.mjs`. It rejects credentials, non-HTTP(S) URLs, nonstandard ports, local names, nonpublic IPv4, IPv6 outside the permitted global-unicast range, and mixed public/private DNS answers. The actual connection uses a validated IP as its hostname, preserving the original HTTP Host and TLS server name. This avoids a second DNS lookup/rebinding window. Each redirect repeats validation and pinning; at most six requests are made. Subscriber cookies are fetched for an exact stored host (optional `www.` normalization), and are sent only to the exact initial host over HTTPS, never copied to another host. No registrable-domain/public-suffix guesses are made.

The complete DNS/redirect/body operation has a 15-second deadline. Streaming responses abort above six million bytes instead of buffering an unbounded page. Non-2xx article responses are not extracted by the filler.

## Durable notification semantics

Each event and device endpoint has one durable queued payload. Claims recheck the current subscription and preferences, cancel revoked jobs, and refresh subscription keys. Watch bundles remove stories whose players are no longer watched before delivery. Insert-on-conflict-do-nothing preserves both pending work and prior successes. Database row locks and `SKIP LOCKED` grant one five-minute tokenized lease at a time. Known provider successes become `sent` and are never claimed again; transient provider failures retry with capped exponential backoff across later dates and runs. Gone subscriptions (404/410) become terminal and are pruned by exact endpoint. A failed database acknowledgment stops the worker. Previously recorded `push_log` event IDs remain suppressed at the upgrade boundary: the old design did not record device outcomes, so historical failed sends cannot be reliably reconstructed.

This is at-least-once delivery across an ambiguous crash: a provider can accept a message immediately before the worker dies or loses its database acknowledgment. Lease recovery can redeliver in that window; stable notification tags reduce duplicate visible notifications. Exactly-once external delivery requires provider-side idempotency, which web push does not provide. There are no duplicate sends after a durably recorded success. The database tests cover duplicate enqueue/claim and stale-token fencing; PGlite serializes connections, so a separate multi-session PostgreSQL load test remains a staging check.

Watch alerts reserve stable profile/day/story keys transactionally, then queue one bundle per profile/run. A story mentioning several watched players produces one item, and reruns cannot enqueue those stories again. Manual callers may supply a stable `notificationId` and reuse it on request retries; otherwise a new ID is returned. A manual send claims only its own event, leaving scheduled work queued. Scheduled dispatch preserves the 9 PM–7 AM ET quiet period, including retries.

## Filler progress and publication

`audit_claim_fill` durably reserves up to four eligible story/URL pairs, prioritizes never-attempted stories, and immediately assigns exponential retry backoff (15 minutes through 24 hours). Persistent failures therefore cannot monopolize each invocation. URL changes create a new candidate. The filler publishes with a JSON compare-and-swap RPC; concurrent day publication wins, and a lost compare-and-swap reports `conflict:true` without falsely advancing the heartbeat. The extracted work is retried on a later eligible run.

## Verification and rollback

`tests/backend-*.test.mjs` covers address/redirect/deadline/cookie controls, actual loopback socket pinning and streamed body limits, real handler authorization/public setup behavior, mocked provider outcomes, and the actual migration in PGlite with synthetic tables. No production network/DB boundary is used by the tests. Run `npm ci` then `npm test` with Node 24 or later; PGlite is a committed development dependency. All 49 CRE tests pass, including real loopback transport checks. The five CRE Edge Functions pass Deno 2.9.6 checks; the pinned transport also fetched https://example.com successfully under Deno with normal certificate validation. This is a local runtime check, not verification of the hosted Supabase runtime. Python pipeline caller tests pass (2 tests).

Rollback should stop the affected cron jobs before replacing functions. Preserve the new queue and sent rows; deleting them loses retry/deduplication history. Prefer fixing forward. Reverting only the functions would restore the original authorization and first-writer/failed-delivery defects; reverting gateway settings or secrets alone can break callers. The SQL is additive except the deliberate private `push_log` grant revoke.

## Existing routine compatibility — release prerequisite

Claude lists active cloud routines `CRE Briefing [Hourly]` and `CRE Briefing [Half Past]`. The hourly routine is connected to this repository, Gmail and Supabase, and instructs runs to read `CLAUDE.md`. Complete inspection of both routines and their environments is a release gate. Their intended content-table/publication contract is unchanged, but `fetch_article.py`, `probe_fetch.py`, and `monitor_sources.py` now require `AUDIT_PIPELINE_SECRET` in the execution environment. Configure and verify it in every routine environment before deploying guarded endpoints. Existing in-flight runs must finish before cutover.

The GitHub Actions `Fill article content` workflow also invokes `monitor_sources.main()` indirectly through `fill_browser.py`. Its step maps the repository Actions secret of the same name to the environment. Set that repository secret before release. The Mac watchdog launches the same scripts and requires the secret in its process environment too. Do not assume updating repository scripts configures cloud or local execution environments automatically. The player-image workflow does not use these protected calls.

Do not deploy the CRE migration/functions/frontend until all actual caller environments are inventoried and verified. Keep the old production version running if any caller cannot yet supply the secret; do not re-open protected endpoints as a compatibility shortcut.
