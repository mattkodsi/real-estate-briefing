# Publication integrity implementation — September 11, 2026

Implemented in the isolated improvement worktree. No production writes, deployment, push, notification tests, or migration application were performed by this task.

## Behavior

- `publication.py` merges only content, image, URL, imageChecked and sourceBlocked differences from the filler baseline. Each field uses a three-way comparison; concurrent changes win. A source URL changed since fetch invalidates the entire fetched patch. Story deletion, ordering, headlines, summary, featured status, classification and another article are preserved. Accepted enrichment adds enrichedAt/enrichedBy; a changed day adds publishedAt/generatedAt with subsecond UTC precision.
- Both fillers start publication runs from current Supabase data, ignoring stale local files. `--no-push` continues to prefer local data. Status-only and image-check-only changes now persist. The local file is updated from the merged remote result only after successful publication.
- Four bounded atomic compare-and-swap attempts reload the remote day each time. Exhaustion and network errors fail visibly; there is no unsafe upsert fallback. Browser day failures are isolated so later days can still finish. Existing page navigation/network timeouts remain; a ten-minute processing budget stops scheduling additional articles/days and preserves completed partial enrichment. This is a soft budget, since an in-flight network operation can finish after its deadline.
- Dated publication selects exactly that day and its Monday week file. Explicit dated publication includes research registries only with `--registries`; historical day/week batch publication requires `--all-dates`. For existing cloud-routine compatibility, a no-argument invocation selects today in America/New_York and its matching week, plus only registries generated today ET. Older local registries are skipped, and a missing local today file fails clearly. Selected file shapes, matching dates, story IDs, HTTP(S) URLs and numeric amounts are validated before the batch's first mutation. Editorial replacements with older/equal generatedAt are rejected; concurrent replacements fail and require regeneration. An unchanged document is idempotent.
- Per-worker public operational rows replace the shared heartbeat written into the secrets table. Rows record state, lastRun, date, filled/failed counts and GitHub run ID. The watchdog helper reads the GitHub worker specifically, so another worker cannot impersonate its successful heartbeat. These are processing observations, not newsletter arrival timestamps.
- Browser preflight and fetch eligibility both include missing-image-only work. Workflow uses the matching Playwright Python container, avoiding fresh apt/Chromium dependency installation. Workflow-dispatch input travels through a quoted environment variable and strict date parsing.

## Migration and rollout requirements

Apply `supabase/migrations/202609110001_publication_integrity.sql` BEFORE releasing the Python workers. The new RPC is security-invoker, restricted to a fixed content-table allowlist, uses the caller's existing RLS/table access, and compares the complete expected JSON atomically. It exposes no service credential and intentionally preserves the accepted public content-write policy. Clients fail closed if the RPC is absent.

The migration retains replaced day/week JSON in a service-only revision table, including changes made by existing clients. Public clients cannot read subscriber article revisions. Public operational worker counters have explicit read/insert/update RLS and no delete grant. Revision retention currently has no purge schedule; operational storage monitoring/retention is still needed.

Existing bare `python3 scripts/push_data.py` cloud commands remain compatible, with narrowed today-only scope and same-day registry freshness guards. For repairs use `python3 scripts/push_data.py YYYY-MM-DD` and add `--registries` only when those files were intentionally rebuilt. Existing public clients can still write directly, and are not magically protected by the new client-side validation. This migration does not revoke their accepted permissions. The batch preflight is not a multi-table transaction: a network error after an earlier row succeeds yields a partial batch and an error; rerun safely after inspection.

## Verification

- Tests were written before implementation. A reproduction of the old whole-day replacement failed three meaningful assertions: concurrent editorial/other-story preservation, same-field conflict preservation, and changed-URL invalidation.
- `python3 -m unittest discover -s tests -p test_publication.py`: 14 passing tests, including merge, deletion, status removal, invalid documents, bounded conflicts, no-op, scope, remote-first loading, image-only eligibility, stale editorial rejection and failure exit status.
- Python compilation passed for publication.py, push_data.py, fill_content.py and fill_browser.py.
- Local PGlite PostgreSQL rehearsal passed: migration syntax, public-role atomic insert/update, stale expected JSON rejected, and old version retained. Rehearsal script: `/private/tmp/check_publication_sql.mjs`. This is not production migration verification.

## Remaining operational limits

GitHub image pull/install success and actual browser challenge behavior need a real workflow run. Worker status writes are best-effort and log warnings; setup/crash failures can leave a started/running row until the next run. The status table reflects each worker's latest checkpoint, not an append-only run history. No actual arrival-to-publication SLA was measured. Existing source reconnect checks may update health state during fetches; `--no-push` means no article publication, not a universally read-only fetch routine. No production monitoring notifications were triggered in tests.

## Independent review follow-up

See publication-review.md. The follow-up fixes fractional heartbeat parsing, active-primary handling, local no-push timestamp compatibility, starvation across bounded passes, and Edge primary-heartbeat migration. Per-story fillAttemptedAt joins the narrow merge allowlist; only attempted articles receive it. Current verification is 19 passing publication Python tests plus 3 passing heartbeat-policy Node tests. Deploy the updated Edge fill-content function after migration001, preserving its legacy heartbeat writes during rollout.
