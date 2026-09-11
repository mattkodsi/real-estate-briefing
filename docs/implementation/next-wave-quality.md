# Research quality inventory — 2026-09-11

Read-only baseline of the public Supabase tables, exported privately to `/private/tmp/cre-next-wave-quality`. The export contains subscriber article text and must not be committed. The offline report emits identifiers, counts and structural findings, with no article bodies or URLs. Tables were verified against `scripts/push_data.py` and the actual endpoint responses. There were no live writes during this inventory.

## Coverage and counts

- 59 daily editions, July 14–September 10, 2026; 2,424 stories. There was no September 11 edition in this export.
- 623 player rows, including one internal `_candidates` row excluded from research counts: 622 player profiles; 108 terms; 77 threads (tales); 4 campaigns (sagas); 45 events; 170 metrics.
- 13 unresolved exact normalized name/alias candidate groups: 10 players and 3 terms. Zero exact-title candidate groups among threads or campaigns does **not** establish that their scopes are distinct.
- One already-resolved term alias, `485x → 485-x`, is excluded from unresolved candidate and active-term collision counts. The current dictionary consumer skips the alias row and redirects links. Player aliases do not have this redirect support.
- Story references inspected: 1,026 player mentions, 192 term mentions, 252 thread entries, 157 campaign branch references (1,627 total).
- 73 reference findings: 69 IDs absent from their cited daily edition, 4 missing IDs. By registry: players 56, terms 6, threads 5, campaigns 6. No referenced dates were absent from this export.
- Two story references point to absent threads; two repeated date/ID pairs occur within a registry record. Repetition is a review signal, not permission to delete.

Normalization applies Unicode NFKC, case folding, punctuation-to-space and whitespace cleanup. It does not use fuzzy similarity, corporate-suffix removal or shared article URLs. Matching aliases can still indicate related but distinct entities or concepts.

## Prioritized repair queue

1. **Confirmed wrong player mention target:** `players/zohran-mamdani`, `mentions[4]`, date `2026-09-02`, role `subject`. Its title is “How A&E's Douglas Eisenberg Became the Face of Mamdani's Anti-Real Estate Agenda,” but the stored ID is `mamdani-legionnaires-dueling-plans`. The same exported daily edition contains that exact title at `eisenberg-mamdani-anti-re-profile`. Proposed repair: change only that mention's ID to the latter, preserving the actual Legionnaires mention at index 5. The two objects are not identical; deleting one would lose a distinct article. Re-read and compare the current record before any write.
2. **Strong player canonicalization evidence:** `60-guilders` / `sixty-guilders` both have the exact primary name “60 Guilders,” type company, and buyer role on `2026-07-29/sentry-realty-60-guilders-midtown-office`. `ryman-hospitality` / `ryman-hospitality-properties` both have the primary name “Ryman Hospitality Properties,” type company, and buyer role on `2026-08-11/ryman-1-4b-grande-lakes-orlando`. These are strong identity candidates. Preserve incoming links, mentions, watch identifiers and existing records; establish player redirect support before applying an alias-based consolidation. No destructive merge is proposed.
3. **Broken links:** restore source-grounded IDs for the 69 missing targets and four null IDs before removing anything. Null-ID records are `acadia-realty-trust` (2026-08-27), `clarion-partners` (2026-08-21), `kings-capital` (2026-07-24), and `witkoff` (2026-07-23). Some missing targets may be renamed or consolidated stories, so a failed lookup proves a broken reference in this snapshot, not a nonexistent underlying story.
4. **Absent thread targets:** July 28 `stories[17]` references `vesta-heartland-hostile-takeover`; September 1 `stories[15]` references `nyc-conversion-safety-crackdown`. Reconcile against source evidence and current tale registry before creating a thread or changing the link.
5. **Campaign repeated reference:** `mamdani-housing-agenda` repeats `2026-09-09/unlock-our-housing-nyc-tenant-coalition` across its branch references. Cross-branch relevance may be intentional. Inspect the branch purposes before editing.

## Other exact-name/alias candidates

| Registry keys | Evidence and limit |
| --- | --- |
| `nyu-langone` / `nyu-langone-health` | Same primary name and alias; different dated mentions of the Kips Bay theater dispute. Strong identity candidate; retain all distinct mentions. |
| `aew` / `aew-capital-management` | Reciprocal names/aliases; one mention already has a missing story target. Resolve that reference and entity scope first. |
| `burlington` / `burlington-stores` | Reciprocal names/aliases; verify the operating entity and preserve separate deals. |
| `jpmorgan` / `jpmorgan-chase` | Shared branded names; bank/business-unit scope needs review. |
| `stonemont` / `stonemont-financial-group` | Short-name/full-name alias match; verify actor identities in linked deals. |
| `apollo-global-advisors` / `apollo-global-management` | Shared “Apollo” alias is insufficient proof. Check whether the first name is an attribution error. |
| `brookfield` / `brookfield-properties` | Parent/platform overlap; do not collapse just because “Brookfield Properties” is also an alias. |
| `eqt` / `eqt-real-estate` | Parent/business-line overlap; shared EQT label is insufficient proof. |
| `delaware-statutory-trust` / `dst` | Both name the Delaware Statutory Trust concept and share DST alias; different mentions. Strong dictionary canonicalization candidate after definition review. |
| `bad-boy-guarantee` / `personal-guaranty` | Shared carve-out alias; broader personal guaranty and narrower carve-out guarantee must remain distinguishable. Review alias ownership. |
| `net-lease` / `triple-net-lease` | Shared NNN alias; net lease is a broader category. Review alias ownership rather than merging concepts. |

## Existing quality checks

`check_quality.check_document` runs once per day; registry checks run once across the export, with resolved dictionary alias rows excluded. Its findings are structural review flags, not independent factual verification.

| Finding | Count |
| --- | ---: |
| Missing amount type / transaction status / transaction identity | 652 each |
| Cards after briefs | 312 |
| Days above 30 cards | 6 |
| Non-boolean classification flags | 43 |
| Featured-order warnings | 62 |
| Featured capacity / missing featured / missing featured-keypoint coverage | 1 / 2 / 2 |
| Long key points | 9 |
| Missing explicit urgency for special cadence | 84 |
| Generic actor identification wording | 2 |
| Events without official source plus date evidence | 45 |
| Month-precision first-day placeholders | 8 |
| Metrics without full population/sector/geography/unit metadata | 170 |
| Metric observations lacking full source/period evidence | 188 |
| Active term alias collisions | 3 |

The latest edition, September 10, has nine priced stories missing each of amount type, transaction status and transaction identity, plus one long key point. Historical gaps should not be represented as new regressions. Event checks establish missing evidence fields, not that an event is false; metric checks likewise establish incomplete provenance rather than incorrect values.

## Reproduce and limitations

Run `python3 scripts/report_research_quality.py /private/tmp/cre-next-wave-quality` against the private exports. Six behavioral tests in `tests/test_research_quality_report.py` cover conservative candidate grouping, day-scoped references, partial exports, nested campaign references, repeated references, output privacy, input immutability, one-time registry checking, and resolved term aliases. The command is offline and never publishes.

The export was paginated in primary-key order (500-row requests) until each table returned a short page. It is a read-only snapshot taken over several requests, not a transactionally consistent cross-table dump. Missing registries are reported as unavailable evidence for registry links. Candidate absence is not semantic deduplication: similar titles, overlapping saga scopes, parent/subsidiary identities, and true article duplicates still require editorial inspection. No shared-URL article cleanup was performed.

## Repairs applied and verified

Five ID-only player mention repairs were applied in one transaction, each conditional on the original reference and a uniquely exact-title-matching story in the cited day. Fresh readbacks matched the expected player JSON exactly, with no other fields changed: Blue Owl Capital, BXP, Post Brothers, Verizon, and Zohran Mamdani. Private before-images are retained at `/private/tmp/cre-wave-reference-before.json`.

Post-repair inventory: 69 unresolved story-reference findings (down from 73), one repeated reference pair (down from two), two missing thread targets, and 13 unresolved name/alias candidate groups. The Mamdani repair fixed a wrong-but-existing destination rather than a missing destination, so it reduces the repeated-pair count instead of the missing-reference count. No uncertain records were removed or merged.

Alias diagnostics also cover missing targets, cycles and unsupported multi-hop chains; nine synthetic research-report tests pass.
