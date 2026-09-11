# September 11 durable repairs

## Implemented and verified before frontend release

- GitHub uses one Python interpreter to install and run Playwright. CI launches real Chromium using the same setup as the production worker. Setup and execution failures publish a failed heartbeat so the backup can take over.
- Article quality checks reject subscriber gates, navigation and short fragments, while accepting genuine short articles. Alternate coverage can supply a matching article with its publisher, URL and body kept together. Concurrent editorial changes are protected by compare-and-swap.
- Source evidence, corrected identities and verified historical thread corrections survive older generator drafts. Publication rejects known source/entity contradictions, including contradictions exposed only after restoring reader text. These are targeted safeguards, not a general AI fact checker.
- All 38 September 11 stories have complete short summary lines. Ready notifications use complete ranked lines without chopping a claim midway through. Price badges preserve $1.25B rather than rounding it to $1.3B.
- Reviewed duplicate profiles consolidate in the app while retaining stored histories and followed aliases. Nine same-identity groups consolidate; five related but distinct groups remain separate. Incoming registry references must resolve or retain an existing evidence-reviewed unavailable marker.
- Notification-provider acceptance, service-worker receipt and successful notification-display API completion are separate observations. Receipt capabilities are per job, private, time bounded and inaccessible through public table/RPC reads. No test push was sent to readers.

## Production data repairs

92 records repaired with fresh preflight reads, exact compare-and-swap and full readback checks: three daily editions, one weekly edition, 70 player records, 11 terms, five story timelines, one campaign and one metric. Private before-images and evidence manifests were retained outside Git.

Corrections include Berkshire Residential Investments versus Berkshire Hathaway in the MF1 transaction and affected profiles; Extell's $1.25B financing in daily, weekly and profile records; Prada retail area and attribution; unresolved Taconic area instead of a misleading price per square foot; Alexander case status; the actual scope and proposed status of the Council stop-work bill; removal of the Jersey Mike's subscriber gate masquerading as article text; and August-only precision for the student-housing observation.

The 65 original research-reference findings were reviewed: 40 verified retargets and 25 unavailable originals preserved with explicit labels. The post-repair audit covers 1,644 registry references across 60 editions: zero unreviewed broken story references and zero undecided identity groups. Two remaining day-to-thread defects were then repaired: one verified Vesta retarget and one removed dangling conversion link with its original preserved.

## Evidence

- Local suite: 88 JavaScript/PostgreSQL tests plus 96 Python tests passed; syntax checks passed.
- [Real browser CI](https://github.com/mattkodsi/real-estate-briefing/actions/runs/34632835725) passed on b86b7b3.
- [Actual article worker](https://github.com/mattkodsi/real-estate-briefing/actions/runs/34632835511) completed successfully on September 11, 18:23:52 UTC. Its content step took about 85 seconds, recovered Lower Manhattan from alternate coverage, and reported five missing readers. The cancelled earlier verification run was deliberately stopped before repair publication; it was not a new runtime failure.
- Backend deployed: fill-content v7, push-dispatch v8, push-send v5, delivery-receipt v1; migration 20260911181139. Unauthorized privileged calls return 401, malformed receipts return 400, and a nonexistent receipt is safely ignored. Existing 30 jobs retained null device-observation timestamps.
- Browser checks at widths 320, 390 and 440: no document overflow; header and bottom navigation stay on one row; controls hide downscroll and return upscroll; reader fills the viewport. Satellite imagery renders. AEW appears once with merged history and a disabled, labeled unavailable source. Existing reader-swipe tests remain green; this is not a physical iPhone gesture/notification certification.

## Remaining external and archival limitations

Five September 11 readers remain unavailable after the real worker: Port Paradox, Fed rate decision, student housing, Jersey Mike's and Aimbridge/Gorman. Retrieved pages were restricted, incomplete or mismatched. They remain source links or honestly labeled partial stories; successful worker execution does not mean every publisher supplied a full article.

Historical email receipt times cannot be reconstructed from the available Gmail connector results. Source-receipt provenance is supported, but historical records have no verified mailbox observations. Device acknowledgements can only accumulate after the updated service worker receives future real notifications; API completion does not establish that a person saw or read one.

Archival evidence coverage remains incomplete: 652 priced stories lack full transaction classification/identity/status, 170 metrics lack population metadata, 188 observations lack complete source metadata, and 45 events lack official evidence fields. Eight historical event entries have unsupported month/day precision. These remain source-review work, not facts that can safely be invented by a bulk repair. Strict comparable-sale calculations exclude unverified legacy transaction records. Broad new day-to-thread existence enforcement also needs a batch overlay because days currently publish before their new timelines; reviewed known mistakes are guarded now.

## Release state

Released as **v154**, commit **cbfcdf5f6031eb772dfd099a11fa834e87ce95b2**. All nine hosted asset hashes match the reviewed local files. [Production regression checks](https://github.com/mattkodsi/real-estate-briefing/actions/runs/34633837414) and [Pages deployment](https://github.com/mattkodsi/real-estate-briefing/actions/runs/34633836145) passed. A fresh public-app browser session loaded all v154 scripts and displayed the $1.25B badge correctly at width 440 without document overflow. Fresh production readback confirms 38 short summaries, 33 valid reader bodies, and five explicitly unavailable readers. The primary heartbeat records completed, filled 1, failed 5 for the successful real worker run.

Optional removal of the merged branch and temporary checkout was rejected by automatic approval review because explicit cleanup authorization was absent. Both were left intact; release and production verification are unaffected.
