# Next-wave disposition — September 11, 2026

This is a bounded second wave, not completion of the entire original audit. The approved frontend remains v153; this wave changes backend rules, pipeline observation, offline audit tools and five research links.

## Completed

- Atomic notification arbitration: breaking/watch alerts now share a service-only profile/day/story reservation inside their existing enqueue transactions. Old RPC signatures and device leases remain compatible. Both legacy push-log directions and changed watched actors retain historical suppression. Independent review found the legacy-log edge case before deployment; regression tests now cover it.
- Future delivery observations: provider-success acknowledgment and latest attempt-finish times are recorded transactionally. Existing rows remain untimed. The publisher preserves an observed firstPublishedAt for new stories and never backdates legacy stories. Provider acceptance is not phone receipt.
- Repeatable private-export reports: delivery timing coverage/intervals and research-quality candidates/references. No new public telemetry endpoint or subscriber-content artifact was added.
- Five source-checked player reference IDs repaired and verified, preserving every other data field.

## Deployment verification

Migrations 202609110004 and 202609110005 applied together with migration-history entries. Deployment followed a 02:45 ET preflight within the existing notification quiet period, with zero active delivery leases. Four hosted function bodies match the reviewed source exactly. Anonymous enqueue/watch/finish execution remains denied; service enqueue remains authorized. Job count stayed 28; 11 existing story reservations were retained; historical acceptance timestamps stayed null. No dispatcher or test notification was invoked.

Full suite: 65 JavaScript/PostgreSQL checks and 50 Python checks (115 total), zero failures. Database tests are isolated PGlite, not a real multi-session load test. Public UI files were unchanged. Private pre-change function definitions are retained at `/private/tmp/cre-next-wave-functions-before.json`; keep new history tables when fixing forward rather than deleting deduplication evidence.

## Measured limitations and next work

- The 2,424-story baseline has only two summary timestamps and no content-readiness timestamps. No defensible historical processing latency or mailbox-to-device SLA can be computed.
- Mailbox searches through the available connector returned no matching newsletters even without date filters. This is unavailable receipt evidence, not proof of an empty mailbox. External generator adoption of the updated publisher remains unverified.
- GitHub's eight inspected filler runs were all scheduled (not manual) and successful, but their recorded starts were not a dependable half-hour cadence; for example September 10 starts at 13:54, 17:20, 19:51 and 22:00 UTC. Scheduled runs are not a delivery guarantee. Worker observation table was empty at baseline; new observations must accumulate during future processing.
- After repairs: 69 unresolved story-reference findings, 13 possible duplicate groups, two missing thread targets. These require source/identity review; overlapping names are not permission to delete or merge.
- Real iPhone delivery/notification rendering, publisher-cookie reconnect, market refresh locking, slimmer lookup/full-text search, revision/receipt retention and larger storage changes remain outstanding. No new UI redesign was included.
