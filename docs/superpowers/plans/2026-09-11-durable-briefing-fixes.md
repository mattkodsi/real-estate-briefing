# Durable briefing fixes implementation plan

User-approved scope: fix the complete September 11 audit and GitHub failures; preserve the approved mobile layout. Implementation uses independent bounded worker, extraction, and research tasks plus integrated publication/summary/delivery fixes. The prior audits in /private/tmp/cre-new-briefing-audit/Audit.md and /private/tmp/cre-briefing-audit-update/Update.md are the evidence specification.

## Global constraints
- No invented source URLs, articles, receipt times or entity identities.
- Do not merge a person with a company, a parent with a subsidiary, or related legal concepts.
- Preserve historical research even when its source cannot be recovered; distinguish verified unavailable from a working article.
- One-row header/navigation, finger-tracking reader transitions and existing spacing stay intact.
- Publication repair uses fresh reads and compare-and-swap; no stale whole-database overwrite.
- Reader receipt means service-worker observation; display acknowledgement means browser API success, neither means human reading.
- Test on branch, review, verify real GitHub browser execution, deploy compatible backend before frontend, verify hosted assets and current data.

## Tasks
- [x] Worker: one interpreter for dependency install and execution, real Chromium smoke; publish failed status for initialization crashes; backup recognizes failed primary.
- [x] Extraction: shared conservative body-quality criteria; reject gates/navigation; retain genuine short articles; source/attempt/status fidelity; alternate coverage recovery; fixtures reproduce observed false-ready failure.
- [x] Research: evidence-based repair manifest for all 65 references and14 candidates, safe CAS application, reviewed relationships/unavailable provenance, incoming-reference validation.
- [x] Publication: apply extraction readiness, stale-summary invalidation, provenance checks and durable editorial guard against known ambiguous identities; enforce new-copy/data checks at write boundary.
- [x] Editorial repair: verify and correct MF1 downstream profiles, financing/size mismatches, short summaries, partial content and attribution; recover available missing-source coverage.
- [x] Summaries: require compact source-backed quickSummary in new publication; ready notification uses ranked complete short lines without truncating financial claims.
- [x] Timing: receipt mapping support without invented Gmail metadata; private token-authorized device acknowledgements; measured stages remain distinct in report/UI.
- [x] Integration: full tests, independent review, safe live migrations/functions, actual browser worker run, fresh data readbacks, mobile smoke and merge/release. Optional branch cleanup was blocked by automatic approval review and left intact.

## Evidence ledger
- Baseline: 65 JS/PostgreSQL + 50 Python tests passed on b033a08. Those checks did not exercise the broken hosted browser runtime.
- Gmail connector query for September 10–11 newsletters returned no results; not proof of an empty mailbox. Historical email-to-story timing cannot be reconstructed from this access.

Final evidence and explicit external/archival limitations: [durable-fixes-release.md](../../implementation/durable-fixes-release.md).
