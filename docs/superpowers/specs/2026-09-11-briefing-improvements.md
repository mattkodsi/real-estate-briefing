# CRE Briefing reliability and reading experience

User authorization: September 11, 2026: “great. plan it out, then go,” following the full September 10 audit and a proposed staged implementation/release.

## Product intent
A New York real estate reader should find the important news immediately on a phone, understand actors and figures precisely, open a readable article, and trust the app to retain saved items and deliver updates. Keep the serif CRE masthead, paper/card palette, blue editorial accent and existing URLs. Domain: daily edition, headline hierarchy, source attribution, transaction record, market calendar, research desk. Color world: paper white, ink charcoal, slate, blue annotation, amber masthead rule. Signature: a ranked daily edition connected to an accumulated CRE research record. Avoid equal-weight dashboard tiles, decorative financial charts and overlapping summary layers.

## Architecture
Preserve the no-build static frontend and compatible Supabase JSON views. Introduce small shared modules where they make correctness testable. Enrichment must merge only changes to the article it fetched and never replace newer editorial fields or another article. Add backward-compatible server operations and migrations before changing dependent clients. Retain last-good data on transient failures. Record processing timestamps and worker identity without inventing newsletter arrival times.

## Requirements
1. Share concurrent reads; bound requests; paginate registries; defer archive/full-body warming; use lightweight archive data for map/history; prevent stale renders.
2. Cache successful public data only; preserve compatible offline data through shell updates; protect reading from automatic reload; report saved offline state truthfully.
3. Mobile: 440x956 CSS viewport for iPhone 17 Pro Max approximation, plus 390px and desktop. Allow zoom; 44px primary control targets; readable metadata and 17px reader body; accessible overlays and links; reduced motion. Show headlines before lengthy optional synthesis. Preserve user-selected theme and reader size.
4. Preserve strict story ranking; use honest end-of-list and analytical labels. Comps must use qualifying sales with matching amount/size and separate asset groups. Missing/partial dates must never show Invalid Date. Show latest storyline development first. Search must expose additional results.
5. Secure cookie capture without exposing backend credentials or disabling owner reconnect. Scope publication; retain revisions; reject stale writes and malformed documents. Keep the explicitly accepted public content-write policy unchanged unless replacement authorization is available.
6. Notifications: bounded coherent copy, focused links, distinguish permanent device invalidation from exhausted transient jobs, discover late prior-day stories without unwanted archival blasts. No test notifications to real devices without explicit request.
7. Preference set changes must merge across devices while preserving removals and queued offline edits. Maintain backward compatibility with older clients.
8. Track per-worker activity, per-article enrichment and publication times; isolate failures; improve workflow setup and argument safety. No claimed arrival-to-delivery SLA without actual observations.
9. Version production-owned missing functions, preserve last-good market series, and label forward-rate approximations honestly. Correct verifiable current content errors with narrowly scoped publication; do not bulk rewrite historical research through guesses.
10. Restore regression coverage, make deployment staging explicit and verify live assets. Record unverified external ingestion configuration, actual iPhone behavior, and any blocked production steps accurately.

## Delivery boundary
Implement and test in an isolated branch, then release verified compatible changes. Larger architecture is migrated only when the current deployment can be inspected and exercised safely. No new paid infrastructure or wholesale framework rewrite. The completion record must distinguish implemented, deployed, verified, and externally blocked work; every audit recommendation receives a disposition.
