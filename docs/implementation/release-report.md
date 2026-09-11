# CRE Briefing audit improvements — September 11, 2026

## Release scope

The six-stage plan keeps the static app and its editorial identity. It addresses the audit's integrity, loading, mobile usability, saved-state, notification and factual-error priorities. It does not represent a replacement of the entire ingestion architecture or a certification that all historical AI output is correct.

## Audit disposition

| Area | Delivered | Remaining boundary |
|---|---|---|
| Initial loading | Shared in-flight registry requests, deterministic pagination, bounded request/body timeout, no broad startup prefetch; map library deferred | Registry payloads still include more than an ideal search index; no cellular or physical-iPhone benchmark |
| Mobile layout and visual hierarchy | Expandable daily/weekly synthesis, earlier headlines, importance order, readable metadata, persistent navigation, Saved and Settings shortcuts | Existing six-destination structure remains; several inherited secondary labels remain |
| Reader and accessibility | Zoom enabled; larger touch targets; 17px default reader; focus trap/return, Escape, keyboard interactions, reduced motion | Browser checks do not establish VoiceOver or installed iOS behavior |
| Map | Lazy library load, quieter base map, light archive data; explicit approximate-pin and reported-amount explanation | Historical geocodes still approximate; radius is not a verified investment aggregate |
| Search and research | Visible scope, continuation beyond 80 results, valid year/quarter/month labels, latest-first storylines | Some overlapping narrative umbrellas still need editorial consolidation; not a full-text index |
| Comparisons | Only explicitly closed sales with sale-price meaning enter medians; separate markets/assets, transaction dedupe, sample/date context | Historical entries lack verification fields and remain available as reference sales rather than certified comps |
| Market data | Versioned deployed source, deadlines, failed-write checks, last-good data and stale markers, honest forward approximation | No distributed refresh lock; forward curve remains an approximation, not SOFR/OIS pricing |
| Publication | Compare-and-swap, narrow three-way filler merge, bounded retries/runtime, scoped publishing, validation and retained day/week revisions | Daily JSON remains the storage unit; external generators that bypass these helpers can still write under the accepted public-write policy |
| Delivery measurement | Public worker activity, story summary/content-ready timestamps going forward, primary/standby heartbeat compatibility, fairer retry order | Gmail receipt times and physical-device receipt are not measured; no defensible end-to-end SLA yet |
| Saved/read/watch state | Atomic set deltas, idempotent receipts, persistent per-operation queue, multi-tab storage and locking | Older clients still use full-field replacement until upgraded; no instant cross-tab display broadcast; receipts need eventual storage policy |
| Notifications | Explicit urgency support, bounded complete fallback copy, dated/story/event destinations, late-arrival discovery, retries no longer delete valid endpoints | No test notifications sent; actual iPhone truncation/delivery remains unverified; overlapping independent watch/breaking runs are not one atomic reservation |
| Cookie capture | Owner-only vault writes, ten-minute domain-specific single-use tickets; private credentials never enter the app | Real publisher-cookie capture was not performed; owner authorization is required |
| Information quality | Structural/editorial checker and stronger generation contract; verified narrow data corrections | The checker cannot prove fact truth. External scheduled prompt adoption, all historical extraction correctness, and full canonical entity cleanup remain unverified |
| Release hygiene | Portable regression suite/CI, tracked formerly production-only functions, scoped deployment, served-byte verification | No broad framework rewrite; app.js remains large |

## Verification before frontend release

- All syntax checks passed. Latest integrated suite: 49 Node/JavaScript/PostgreSQL checks and 29 Python checks, no skips or failures. Later owner-ticket checks are additive and recorded in the final release note.
- Synthetic tests cover concurrent publication, source URL conflicts, stale writes, auth/tickets, retry exhaustion, market upstream/cache failures, profile conflict/replay/multi-tab persistence, HTTP 503/offline fallback and previous-version cache recovery.
- Browser checks at 440×956 (iPhone 17 Pro Max layout target), 390×844 and desktop, including light/dark feed, reader, map, weekly, directory, dictionary, storylines, Desk, history, calendar and search. No horizontal overflow in tested narrow layouts. Reader focus/Escape and stale-route rejection checked.
- Fresh mobile feed required three player pages and two term pages, versus 40 requests for each registry in the audit. No initial Mapbox or light-archive request. First headline around 385 CSS pixels from the top versus roughly 1,250 in the audit. These compare observed layouts/request counts, not controlled network latency.
- Three migrations applied atomically and recorded: 202609110001, 202609110002, 202609110003. Existing schema migration history was preserved.
- Six functions deployed: store-session, rates-live, market-pulse, push-dispatch, reader-profile, fill-content. Hosted probes returned store-session 405 on GET, fill-content 401 without authority, rates/market 200 JSON, reader-profile public list 200 with five profiles. Dispatcher was not invoked as a probe.

## Verified data corrections

Fresh-record compare-and-swap patches were read back successfully for September 10 and September 8 daily synthesis, the September 7 weekly overview, the existing FOMC meeting event, and both 485-x term records. Existing IDs and unrelated data were retained. Private before-images were retained locally; day/week replacements also enter the revision table.

- FOMC meeting corrected to September 15–16 from the [Federal Reserve calendar](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm). Event title made neutral; its original ID remains for existing links.
- 485x routes to canonical 485-x; merged mentions and corrected the wage threshold explanation from [HPD](https://www.nyc.gov/site/hpd/services-and-information/tax-incentives-485-x.page) and the [Comptroller](https://comptroller.nyc.gov/services/for-the-public/workers-rights/485-x/). It no longer says the richest benefits stop at 99 units.
- CBRE story now names Tenet Equity and Cerberus, based on its fetched primary article. The office story keeps the cited special-servicing statistic attached to the overall CMBS population. Original article bodies were preserved.

## Recovery and operations

Baseline frontend is commit 2da606e / v146. Roll back through a new versioned release, not an old cached asset mixture. Backend source is now versioned. Private pre-release function definitions are retained at /private/tmp/cre-backend-rollback-functions.sql. Do not revert the reader RPC while upgraded clients still send deltas; coordinate any rollback with frontend compatibility. New additive tables can remain during rollback. Revision retention and mutation receipts need an explicit longer-term storage policy.

The hosted ingestion schedule and provider availability still influence delivery. A scheduled half-hour workflow is not a thirty-minute delivery guarantee. The app's new activity panel deliberately distinguishes worker activity from newsletter-to-device timing.
