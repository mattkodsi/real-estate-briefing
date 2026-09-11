# Delivery measurement baseline — 2026-09-11

The offline report is available, but end-to-end delivery latency is not measurable from the current records. No historical timestamps were backfilled, mailbox receipt times inferred, notifications sent, or production records changed for this measurement.

## Observed baseline

A private read-only export of all 59 `days` rows covers July 14 through September 10, 2026. Running `scripts/report_delivery.py` against that export yields:

| Evidence | Count | Denominator |
| --- | ---: | ---: |
| Stories | 2,424 | 59 days |
| Valid `firstPublishedAt` | 0 | 2,424 stories |
| Valid `summaryPublishedAt` | 2 | 2,424 stories |
| Valid `contentReadyAt` | 0 | 2,424 stories |
| Valid `enrichedAt` | 0 | 2,424 stories |
| Valid `fillAttemptedAt` | 0 | 2,424 stories |
| Content currently at least 120 words | 1,997 | 2,424 stories |
| Valid summary-to-ready latency pairs | 0 | 2,424 stories |

All 2,424 latency pairs lack at least one endpoint. No malformed timestamps or backwards pairs were observed. Minimum, median, and maximum latency are **unavailable**, not zero. Existing full text does not establish when it became available.

A separate read-only aggregate database query at **2026-09-11 06:36:57 UTC** found:

- `publication_workers`: **0 rows**. This means no status observations in that table, not proof that no worker ran.
- `audit_push_jobs`: **28 jobs**: 18 `sent`, 10 `gone`; zero other states in this snapshot.
- The 18 sent jobs were created between September 8 at 12:10:03 UTC and September 10 at 22:50:01 UTC. The 10 gone jobs were created between September 8 at 12:00:02 UTC and September 9 at 12:00:05 UTC.
- The actual job schema has `created_at`, `next_attempt_at`, and `lease_until`, but no provider-acceptance or completion timestamp. **0/18 sent jobs have a measurable queue-to-provider-acceptance latency.** `next_attempt_at` is scheduling state, updated with backoff even when finishing a job; it is not acceptance evidence. Cleared lease fields are also not a completion clock.
- `sent` is provider acceptance recorded by the dispatcher, **not device receipt or display**. The 18/28 ratio is a snapshot state proportion, not a delivery success rate or device-level denominator.

Mailbox searches through the available connector returned no messages even when date restrictions were removed. That result does not establish an empty mailbox. There is no verified newsletter-receipt-to-story mapping in this baseline, so receipt-to-summary latency is unmeasured.

## Reproduce the offline report

```sh
python3 scripts/report_delivery.py /private/path/days.json
python3 scripts/report_delivery.py /private/path/days.json --jobs /private/path/jobs-aggregate.json
python3 -m unittest discover -s tests -p test_delivery_report.py
```

The day input is one day document, an array of day documents, or an array of exported rows shaped as `{"data": {"stories": [...]}}`. Each day must have a stories array of objects; malformed containers fail instead of silently reducing the denominator. Report counts refer to input rows/story entries; use a unique current export, not concatenated snapshots. The command performs no network access or writes and prints only aggregate results, never article text, URLs, story IDs, profiles, devices, or endpoints.

Optional job input is an array of aggregates with a known `state`, nonnegative integer `count`, optional `valid_latency_count`, and `latency_sum_seconds`. For example, the current baseline can use `[{"state":"sent","count":18},{"state":"gone","count":10}]`. Only `sent` rows may carry latency samples. Each counted latency must have a real creation/acceptance timestamp pair in the source export and a nonnegative elapsed duration; malformed, missing, and backwards pairs are excluded upstream. A positive sample count requires an explicit finite nonnegative sum. This tool cannot verify underlying pairs from aggregates alone. Unknown fields are discarded. For the original pre-migration baseline, omit latency fields; never derive them from retry schedules.

## Timestamp semantics and limits

The reporter shares `publication.timestamp` and `content_quality.assess_content` with publication code. It requires timezone-aware timestamps and evaluates current readiness from substantive article paragraphs and gate detection, including short complete reports. The historical baseline above used the former 120-word threshold and has not been recalculated. `summaryPublishedAt` is the latest observed publication after a new story or title/summary revision. `contentReadyAt` marks an observed readiness transition; historical values may come from the former threshold, and it can precede a later editorial revision. Therefore backwards pairs are flagged and excluded rather than repaired. A valid nonnegative pair measures the interval between these recorded observations, not necessarily first publication to first full text.

Every coverage field reports valid, missing, and malformed counts against **all input stories**. Null or absent fields are missing; invalid or timezone-free values are malformed. Pair exclusions are mutually exclusive: missing endpoint first, malformed endpoint second, backwards duration third. Per-field coverage still exposes malformed timestamps when the other endpoint is missing. Zero-second observed pairs are valid. Empty samples produce null statistics.

The next useful baseline is after real new stories and enrichment transitions pass through publication, with populated worker pulses. Receipt-to-summary timing additionally needs verified mailbox receipt mapping; queue-to-provider timing needs an explicit acceptance observation; device receipt needs separate client evidence. This report adds none of those missing observations and makes no latency claim without them.


## Additive observations for future traffic

Migration `202609110005_delivery_observations.sql` adds nullable `provider_accepted_at` and `last_finished_at` to push jobs. It stamps only acknowledged outcomes for the current claim under the existing row lock. The acceptance timestamp is the database's observation after the dispatcher receives provider success; it includes acknowledgement transit and is not a device receipt. `last_finished_at` covers the latest attempt outcome including retries, so it is not inherently terminal. Existing rows remain null. Retry exhaustion, invalid-device removal, scheduling, and service-only execution are preserved. These observations participate in the same transaction as the outcome and roll back together.

The publication helper now stamps `firstPublishedAt` for a newly observed story, preserves the remote value on later edits, and rejects generator-supplied substitutes. Existing stories lacking this field remain unmeasured even when edited. It means first observation by this publisher for the current day/story identity; deleting and reintroducing an identity or changing IDs does not reconstruct historical first publication. Other writers that bypass this helper do not acquire this observation automatically.

The report includes `firstPublishedAt` coverage. Its existing summary-to-ready statistic deliberately retains the latest-summary semantics; the new first-publication field supplies future evidence for a separate first-publication or receipt-linked analysis.

After the migration is applied, a safe aggregate export for `--jobs` can be obtained with this read-only query (do not substitute scheduling columns for acceptance):

```sql
select state, count(*)::int as count,
 count(*) filter (where state='sent' and provider_accepted_at >= created_at)::int as valid_latency_count,
 coalesce(sum(extract(epoch from provider_accepted_at-created_at))
   filter (where state='sent' and provider_accepted_at >= created_at),0)::float8 as latency_sum_seconds
from public.audit_push_jobs group by state;
```

Use the returned rows array as the JSON input. Typed database timestamps cannot contain malformed timestamp text; null and backwards pairs do not enter the sample. The report exposes the excluded count against all sent jobs. The baseline above was collected **before this migration** and remains valid evidence of the previous coverage gap. Applying instrumentation does not retroactively fill that gap.

Validation: six report behavior tests, 18 publication tests, and the real migration executed in isolated PGlite covering sent/retry/exhausted/gone outcomes, no backfill, null/invalid outcome rejection, stale/null claims, transaction rollback, device retention/removal, and public-role rejection/service-role execution.


## Verified mailbox and device observations

The report now includes `mailbox_receipt_to_first_published`. One sample per story uses its earliest valid `sourceReceipts` entry with `provider: "gmail"`, a 64-character lowercase SHA-256 `messageHash`, an HTTP(S) `url` matching that story's URL or a coverage URL, and a timezone-qualified `receivedAt`. The end is `firstPublishedAt`. Standalone `receivedAt` is never a substitute. No receipt metadata is emitted in the aggregate report. Missing verified receipts, missing or malformed first-publication timestamps, and backwards pairs have separate exclusion counts. An empty sample remains unknown, not zero latency.

After migration `20260911175645_device_delivery_receipts.sql`, `--jobs` additionally accepts `valid_received_latency_count` with `received_latency_sum_seconds`, and `valid_displayed_latency_count` with `displayed_latency_sum_seconds`. Both values must be present when either is supplied. These sample counts can occur in any job state because a callback can arrive when provider-outcome persistence failed. Device denominators include all input jobs, unlike provider acceptance's sent-only denominator. Omitted device fields produce `unmeasured`.

A read-only aggregate query after both migrations:

```sql
select state, count(*)::int as count,
 count(*) filter (where state='sent' and provider_accepted_at >= created_at)::int as valid_latency_count,
 coalesce(sum(extract(epoch from provider_accepted_at-created_at))
   filter (where state='sent' and provider_accepted_at >= created_at),0)::float8 as latency_sum_seconds,
 count(*) filter (where device_received_at >= created_at)::int as valid_received_latency_count,
 coalesce(sum(extract(epoch from device_received_at-created_at))
   filter (where device_received_at >= created_at),0)::float8 as received_latency_sum_seconds,
 count(*) filter (where device_displayed_at >= created_at)::int as valid_displayed_latency_count,
 coalesce(sum(extract(epoch from device_displayed_at-created_at))
   filter (where device_displayed_at >= created_at),0)::float8 as displayed_latency_sum_seconds
from public.audit_push_jobs group by state;
```

Device times are first server observations of service-worker callbacks and include callback network delay. `device_displayed_at` means `showNotification` resolved successfully; it does not prove human attention or reading. Missing callbacks remain unknown. The report validates aggregate denominators and sums, but cannot independently reconstruct or authenticate their underlying timestamp pairs.
