# CRE Briefing Improvements Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent implementation packages; root owns integration and release. Track steps in docs/implementation/progress.md.

**Goal:** Make the audited app reliable, faster, and easier to read on iPhone while retaining its editorial identity.

**Architecture:** Keep the static frontend and existing Supabase views. Add tested, compatible helpers and migrations for publication, preferences and delivery. Ship only after integration checks.

**Tech Stack:** JavaScript, Python, PostgreSQL, Supabase Edge/Deno, GitHub Pages.

**Spec:** docs/superpowers/specs/2026-09-11-briefing-improvements.md

## Global constraints
- Preserve no-build deployment and existing hash links.
- No production mutation from tests; no test notifications to real devices.
- Keep owner-accepted public content writes; authenticate privileged services.
- Isolate work in /private/tmp/cre-briefing-improvements on codex/briefing-audit-improvements.
- Use synthetic fixtures for regression tests; never commit subscriber article bodies or credentials.
- All changes require covering behavioral tests where risk warrants them and browser checks for UI.

## Task 1: Publication integrity and delivery processing
Files: scripts/fill_content.py, fill_browser.py, push_data.py, new scripts/publication.py; .github/workflows/fill-content.yml; new tests/test_publication.py; additive Supabase migration if needed.
- [x] Reproduce a stale filler replacing a newer story; test merging concurrent editorial changes and changed URLs using synthetic days.
- [x] Implement article-field merge with optimistic concurrency, bounded retry and timestamps; preserve all non-enrichment fields; fail publication visibly.
- [x] Scope date publication to its day/week; require explicit registry publication; validate ids, dates, URLs and amount types before writes.
- [x] Record per-worker progress; align image-only eligibility; bound processing and avoid shell interpolation/fresh apt dependency failures.
- [x] Test failure, retry, conflict and no-op paths; document operational limits.

## Task 2: Backend security, notifications and market data
Files: supabase/functions/store-session, rates-live, market-pulse (source recovered from audit); push-dispatch; shared helpers; additive migration; tests/backend*.test.mjs.
- [x] Test unauthenticated cookie capture rejection and valid owner capture without real secrets.
- [x] Implement authorized, bounded domain-specific capture compatible with owner workflow; version deployed source and inspect all callers.
- [x] Test notification length/urgency/discovery and retry exhaustion. Implement bounded copy, focused URLs, late-day discovery and separate failed jobs from gone devices.
- [x] Preserve last-good market series and reject failed cache writes; use explicit approximation labels.
- [x] Rehearse migrations and server behavior locally; hand root exact deploy order and any blockers.

## Task 3: Frontend loading and offline reliability
Files: js/app.js data getters/route guards/prewarm, sw.js, new js/data-client.js if appropriate, tests/frontend-data.test.cjs and tests/service-worker.test.cjs.
- [x] Reproduce 20 concurrent registry loads; require one request and successful retry after a failure.
- [x] Share in-flight requests, paginate deterministic queries, bound timeouts and prevent empty-cache poisoning.
- [x] Replace full-day map/history warming with light records; defer optional downloads and verify offline persistence.
- [x] Test cached 503/offline recovery; store only good public data, preserve data between versions and defer disruptive reloads.
- [x] Test route races and perform fresh-browser request-count measurement.

## Task 4: Mobile interface and editorial structure
Files: js/app.js renderers, css/style.css, index.html; tests/ui fixtures/browser verification.
- [x] Preserve paper/ink/blue/serif identity with 4px spacing rhythm; top headline is the focal point; optional synthesis is expandable.
- [x] Enable zoom, enlarge touch targets, improve contrast/type, focus trapping/return and semantic links, and reduced-motion behavior.
- [x] Preserve global importance ordering, latest-first storylines, honest list endings, valid partial dates, discoverable Saved and Settings and simpler labels.
- [x] Validate sales-only comparisons with asset separation, price meaning, sample/date coverage; expose search continuation.
- [x] Inspect light/dark at 440x956, 390px and desktop, reader/dialog/map/desk/search flows.

## Task 5: Cross-device preferences and information quality
Files: js/profile-store.js, reader-profile handler, additive preference migration, js/app.js queue integration, scripts publication quality checks, CLAUDE.md.
- [x] Reproduce two devices saving different stories and offline remove/add conflicts.
- [x] Implement idempotent set deltas with compatibility for older clients, persistent pending state and visible failures.
- [x] Tighten generation contract for actor identification, metric populations, dated-event source proof, typed transaction amounts and push microcopy.
- [x] Correct only independently verified content errors through freshness-checked patches; retain revision evidence.

## Task 6: Integration, release and audit disposition
Files: scripts/deploy.sh, tests runner, docs/implementation/*.
- [x] Run syntax checks, Python/Node behavioral tests and isolated database tests; review the complete diff for security and regressions.
- [x] Verify browser flows and compare requests and headline placement with audit baseline.
- [x] Make deploy stage only intended files; verify version alignment and hosted asset hashes; retain rollback commit.
- [x] Deploy compatible migrations/functions/frontend in dependency order; verify hosted behavior without sending notifications.
- [x] Record every finding's disposition and external limitations. Do not claim actual iPhone or arrival latency verification from emulation.

Implementation and tests completed. Release verification and remaining external boundaries are recorded in docs/implementation/release-report.md; checked items do not certify physical-device tests or external generator adoption.
