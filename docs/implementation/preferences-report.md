# Preference concurrency

Implemented atomic set deltas for saved, read, learnedTerms, starEvents and watchPlayers. New clients diff against the observed local state, queue ordered durable operations and send stable UUIDs. The database authenticates through the unchanged private-session path, locks the profile row, validates the complete mutation batch, and records receipts before committing the merge. Retrying an acknowledged-but-lost add after another device removed it cannot resurrect it. Scalar preferences retain last-write semantics.

Client integration (root owns app.js):

- Change the createProfileStore transport callback to `async (slug, changes, mutations) => (await readerApi("patch", slug, { changes, mutations })).data`.
- In activateProfile, immediately before the existing `data = prefStore.overlay(slug, data)`, call `prefStore.observe(slug, data)`. This also covers activation from cached preferences while offline.
- Keep existing enqueue calls and failure/retry UI. Call observe before overlay at any future server refresh entry point.

Deployment order:

1. Apply additive migration 202609110003_profile_set_deltas.sql.
2. Deploy reader-profile handler with mutation validation.
3. Deploy frontend profile-store.js and app integration with normal version bump.

Do not reverse this order: the older server ignores an unknown mutations property, which would acknowledge without applying deltas. This work has made no production writes or deployments.

Compatibility and boundaries:

- Older clients can still submit full arrays. Such clients necessarily retain replacement semantics and can overwrite concurrent deltas. Convergence protection requires both devices to upgrade; no missing baseline is invented for legacy writes.
- Old pending v2 snapshots migrate once with legacy replacement semantics because the original baseline was never stored. New v3 edits use deltas.
- Same-key conflicts use server arrival order; operations on independent keys merge. Saved-story metadata uses the same story key.
- Receipts do not expire, preserving arbitrarily old offline retry idempotency; storage growth is proportional to set edits. Future compaction requires a client acknowledgment horizon, not a blind TTL.
- Durable writes can fail when device storage is full; edits remain in memory and the existing app error path reports this. Closing before successful persistence can still lose those edits.

Verification: 12 passing Node behavioral tests across client queue, Edge validation and isolated PostgreSQL (PGlite). Coverage includes stale-device independent adds/removes, response-loss retries after competing removal, edits during sends, rebase overlays, saved keys/metadata, retained legacy pending writes, storage failure, malformed batch rollback, receipt collision rejection, profile isolation, unauthenticated rejection, legacy patch compatibility and revoked anonymous RPC execution. The baseline SQL failed the delta-add assertion before the migration was enabled. Client and handler tests also failed before implementation.

The database fixture replaces only the hashing implementation with a deterministic local digest because pgcrypto is unavailable in PGlite; production auth control flow and private session checks are exercised unchanged. PGlite checks the actual migration SQL but is not a multi-connection production load test. Run with `PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js node --test tests/profile*.test.*` (defaults to the temporary runtime installed for this task).
