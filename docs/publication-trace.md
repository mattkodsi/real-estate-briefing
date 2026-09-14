# Publication timeline

The owner requires an event history for every routine and every observed phase, from the first email read through publication and subsequent updates. Logging is additive: it does not alter ranking, summaries, notification eligibility or the UI.

## What the records mean

Each event has an immutable UUID, run ID, producer, stage, status, linked record, and two distinct clocks:

- `observed_at`: when the producer actually observed the event. Capture immediately, not after the routine finishes.
- `recorded_at`: when the database inserted the event. Network delay/replay can make this later. For database events this is the write observation inside the transaction, not exact transaction commit time.

`source=database` is independent evidence of a saved row change; it survives only if the business transaction commits. `source=producer` describes a worker's reported activity. Caller-supplied correlation headers are labels, not authenticated identity proof for publicly writable editorial tables.

A process completing means the program returned; it does not prove every article was filled. Article outcomes and `degraded` status preserve that distinction. A request completing is distinct from a successful publication. An unfinished start without an end means completion is unknown; never infer it. Summaries can be published before full article content; enrichment is a subsequent publication, not a rewritten initial timestamp.

The standby and scheduled notification dispatcher log their actual run/discovery/extraction/enqueue/drain paths with Supabase attribution. Manual `push-send` is unchanged internally; its resulting notification-job changes are still database-observed.

Database triggers cover days, weeks, players, terms, threads, campaigns, events, metrics, worker heartbeats, fill claims and notification jobs. Story additions, removals, array-order moves and card/brief transitions are logged with changed field names and hashes, without full content. No-op writes do not pretend to be changes. Notification provider/device observations retain their existing meanings; they do not prove the user read an alert.

## Organization and attainment details

The hierarchy is **run → stage/span → deliverable → subsequent updates**. Nested spans carry `span_id` and `parent_span_id`. Every producer event includes an execution context; GitHub is detected from its runtime, local processes default to `local-process`, and an external routine must explicitly set `BRIEFING_EXECUTOR` (for example `claude-routine`, `codex-routine`, or `mac-mini`). Never identify a local process as a Mini merely because it runs on macOS.

The event's producer names the actual worker/routine; `details.executor` names its execution platform, `method` identifies Playwright, direct HTTP, Supabase proxy, parser, database trigger or compare-and-swap as appropriate. Actual AI callers supply `provider` and `model`; the logging helper never guesses them. Workflow/run IDs, attempt numbers, durations, input/artifact hashes and outcome counts are recorded when observed. Missing metadata remains absent. This distinguishes an article obtained by a GitHub browser from one recovered through a Supabase proxy.

CLI `begin`/`event`/`end` accept `--executor`, `--method`, `--provider` and `--model`. Set executor consistently for each event or through `BRIEFING_EXECUTOR`; set the model only on stages that actually called it. For each source email connected to a story, emit a `story.source` event with the story entity key and that email's source hash, so a merged story's route can be followed back to every read email without copying the email itself.

## Required external newsletter routine contract

The generator's Gmail/AI operations happen outside this repository. The following hooks are required for those routines, but installing them in source does not prove an external scheduler has adopted them. Verify a real run containing these events before claiming end-to-end coverage.

1. At actual routine entry, run `python3 scripts/pipeline_trace.py begin --producer newsletter-routine`. Persist the printed UUID in the routine's state as `RUN_ID`; export `BRIEFING_RUN_ID` for every child publishing/filling command. Environment variables do not necessarily persist across separate tool calls, so carry the ID explicitly.
2. Record `email.search` started/completed around the actual mailbox search, even when zero messages arrive.
3. Before retrieving each message record `email.read` started; immediately after retrieval record completed. Set `--entity-type email --entity-key HASH --source-hash HASH`, where HASH is SHA-256 of the actual Gmail message ID. Never log the raw ID, subject, sender, body, access token, or full source URL. `--receipt-at` is optional and must come from Gmail's real receipt metadata; omit it when unavailable. It is NOT the read timestamp.
4. Record started/completed/failed around actual `email.parse`, `stories.dedupe`, `stories.summarize`, `stories.rank`, `stories.classify`, `stories.geocode`, `edition.compose`, `edition.validate`, `week.update`, and applicable registry maintenance. Record each separate AI attempt/retry. Use the same run ID. Skip only stages not executed and record why through the integration API; don't emit a pretend successful phase.
5. For story phases use `--entity-type story --entity-key YYYY-MM-DD/STORY_ID`. Link hashes to story IDs using the same run and existing sourceReceipts; do not manufacture receipt data or modify old observations.
6. Publish using the existing publisher, with `BRIEFING_RUN_ID` set. It automatically records validation, requests, skipped writes, successful acknowledgements, conflicts and exceptions. Full article workers share the ID when part of the same routine, or use a new ID for an independent later run. Database events still link those separate runs by day/story.
7. End with `python3 scripts/pipeline_trace.py end --run-id "$RUN_ID" --producer newsletter-routine --status completed`, or failed/degraded as actually appropriate. Run `python3 scripts/pipeline_trace.py flush`. If logging fails, report incomplete coverage in the routine outcome; do not invent missing events retrospectively.

Example phase (execute at that point, not as a post-run reconstruction):

```sh
python3 scripts/pipeline_trace.py event --run-id "$RUN_ID" --stage stories.rank --status started --entity-type day --entity-key 2026-09-14
# Perform the actual ranking here.
python3 scripts/pipeline_trace.py event --run-id "$RUN_ID" --stage stories.rank --status completed --entity-type day --entity-key 2026-09-14
```

For a command-driven routine, `python3 scripts/pipeline_trace.py run --producer mini-worker -- COMMAND ARGUMENTS` records process lifecycle and passes `BRIEFING_RUN_ID` to children. It cannot observe an arbitrary command's internal AI/email phases unless that command uses the hooks above. These commands run without windows; they require no browser UI or persistent Codex session.

## Storage and access

The private `pipeline_events` table is append-only. Anonymous and normal app users cannot read or insert events directly. Database triggers observe existing editorial writes with their current permissions unchanged. The service-role RPC `pipeline_record_events` accepts bounded, sanitized batches and deduplicates event UUIDs. The `pipeline-trace` edge endpoint uses the existing dedicated `AUDIT_PIPELINE_SECRET` for ingest and reporting; credentials are supplied via environment, never committed or displayed.

Python writes restrictive-permission JSONL files under gitignored `data/pipeline-trace/` before upload. `BRIEFING_TRACE_DIR` may point to persistent private storage on the Mini. Replayed events retain their original UUID and observation time. Acknowledgements are separate `.acked` files; do not delete an unacknowledged spool. Remote events remain when local acknowledged files are removed by a deliberate retention policy. No automatic destructive retention policy is installed.

Logging fails open so it cannot block normal publication. Python retains events locally when possible and warns on unavailable logging. Disk failure may lose an event; an ephemeral GitHub runner may lose its local spool if remote logging remains unavailable when the job ends. Edge workers have bounded best-effort remote logging and no durable local disk; failed edge emissions leave a coverage gap. Database logging failure warns and permits the original write. Therefore this is comprehensive instrumentation of known paths, not an absolute lossless guarantee under every outage. Zero-loss enforcement would require making logging a publication dependency, a separate behavioral decision.

No historical events are backfilled. Existing timestamps and publication revisions remain available as older evidence, with their limitations. App reads/scrolls/taps are not tracked by this change.

## Read a log

```sh
python3 scripts/pipeline_trace.py report --run-id "$RUN_ID"
python3 scripts/pipeline_trace.py report --entity-type story --entity-key 2026-09-14/STORY_ID
python3 scripts/pipeline_trace.py report --since 2026-09-14T00:00:00Z --format json
```

Reports are bounded to 500 rows per page. Follow `next_cursor` / `NEXT CURSOR` by repeating the same filters with `--cursor VALUE`; a full page is not evidence that the log ends there. Query by run for processing history; query by story for all later updates across runs. Sort producer stages by their observed times when inspecting a replay, and retain the database clock to expose ingestion delay. Unsynchronized clocks must not be treated as precise network duration; local stage duration uses a monotonic clock.

## Deployment and verification boundary

1. Apply additive migration `202609140001_publication_trace.sql`.
2. Deploy `pipeline-trace` with custom authentication and the instrumented standby and scheduled notification dispatcher functions.
3. Ship the worker/workflow changes and updated external routine instructions.
4. Verify unauthorized access fails, an authenticated canary is readable, direct database writes are observed without content leakage, and no-op/rollback paths behave correctly.
5. Verify an actual scheduled worker run and, separately, an external newsletter run from email read through publication. Keep coverage unverified until those events arrive.

No frontend release/version change is needed. The 16-item repair log is not marked resolved by adding instrumentation.
