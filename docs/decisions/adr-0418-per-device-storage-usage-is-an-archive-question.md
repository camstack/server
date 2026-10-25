---
id: D418
title: "Per-device storage usage is an ARCHIVE question — and a residency number is never reported under an archive name"
status: accepted
date: 2026-09-09
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/device-storage-usage.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
---

## Context

`recording.getStorageUsage` answered with two quantities of different KINDS, in
one response, under names that suggested they matched:

| field | source | what it said on the live hub, 2026-09-09 |
| --- | --- | --- |
| `locations[].usedBytes` | `SegmentHourLedger.accountingForLocations` — the ARCHIVE | 679.7 + 955.2 + 261.6 GB ≈ **1.9 TB** |
| `devices[].usedBytes` / `oldestMs` | `RecordingIndex.accounting(deviceId)` — RESIDENCY | **60.5 GB**, oldest **three hours ago** |

`RecordingIndex`'s own header says what it holds (D295): the live tail plus the
hours somebody hydrated on demand. But the field was called `oldestMs`, the UI
rendered it beside the disks, and so both the operator and the assistant
reading the page that day concluded the recorder was holding three hours of
history and evicting recent footage under pressure. It was holding **3.3 days**
— verified independently with `getDaysWithRecordingsBatch` (09/06 → 09/09 for
101, 104, 1441, 3839) and `locateSegment(1441, 'high')` returning real segments
at 09/06 12:00 UTC. Nothing was wrong with the storage. The reading was wrong,
and the response made the wrong reading the natural one.

**This was a known leftover, and being named did not stop it.** D295 licensed
it explicitly ("`getStorageUsage`'s per-camera row … KNOWN UNDER-REPORT"), the
residency guard's allowlist carried the paragraph, and §3a rows 5–6 of
`docs/design/2026-08-29-recorder-index-at-scale.md` had the verdict. All three
were read by nobody in the hours it cost, because the page itself said
something else and said it in numbers.

**What was tried first and was not enough:** a comment. The provider's own
comment above the loop explained that `accounting(deviceId)` "already carries
the oldest indexed start" — accurate, and the word doing the work (*indexed*)
is the one a reader of the rendered page never sees.

## Decision

**A per-camera storage number is an ARCHIVE number: `usedBytes`, `oldestMs` and
`segments` come from the durable hour ledger, the same authority the volume
rows beside them come from, so the two can be compared and totalled.** A
residency number may still be reported — it answers "what can this process
serve without touching the disk" — but only under a name that says residency
(`residentBytes`, `residentOldestMs`), never on a field whose neighbour answers
a different question.

Three rules ride with it:

1. **One fold, not a query per camera.** `SegmentHourLedger.usageByDevice`
   folds the always-resident T1 hour summary once, no I/O, for every camera at
   once — the same tier `devicesWithFootage` and `profilesWithFootage` already
   answer from. `census({ deviceId })` is the wrong shape here: `predicate`
   takes ONE `locationId`, so a per-camera census over a multi-volume node is
   `cameras × volumes` SQL aggregates per operator click, and the device-only
   form would silently count footage stranded on a location id that no longer
   resolves — bytes no volume row on the same page accounts for.
2. **No archive ⇒ REFUSE, and say which.** A node with no hour ledger returns
   no rows and `devicesRead: 'unavailable'`, plus a log line. It never falls
   back to the index (D295 rule 3). Not-yet-known must not render as
   not-recorded, so the admin UI's empty state distinguishes the two.
3. **Compare the two totals and shout.** The per-camera sum and the
   per-volume sum are the same hour rows counted two ways; a gap beyond 2% (and
   1 GB) is logged. A page that shows both without comparing them is what let a
   97% gap read as a fact about the disks.

## Consequences

**What it costs.** One pass over the ledger's T1 mirror per call — integer
arithmetic over hour rows, no I/O and no SQL. The archive on this hub today is
**98 445 segments across a 383-hour retention window**, and the fold does not
touch segments: it is O(writers × profiles × hours), the ~19 k hour rows the
ledger's own `REPAIR_MAX_ROWS` note sizes the live archive at. It REPLACES a
walk of every resident row of every camera (29 218 row slots in the D295
measurement). The mirror is capped at `SEGMENT_HOUR_SUMMARY_LIMIT` (250 000
rows, the ~28 TB projection), which bounds this read at any archive size.

*Not measured on the live hub:* the exact hour-row count and the wall time of
the fold. What is certain from the code is the shape — one linear pass over the
mirror, per call, with no query.

**What it forbids.** `RecordingIndex` may not decide a per-camera storage total
or an oldest again. `deviceIdsOnLocations` had no caller left once the census
moved to the ledger and was DELETED with its allowlist entry and its test — a
leftover that describes the right design reads as verification.

**What must now be true elsewhere.** `RecordingStatus.storageBytes`
(`statusFor`) is the last archive-shaped residency read that is REPORTED as
storage. It is synchronous and on a per-device poll, so it wants a
device-scoped fold rather than the whole-mirror one, and it remains licensed in
the guard until then. Consumers: the admin UI Storage table (now renders
"Oldest footage" from the archive) and the Home Assistant export's
`footage_used_bytes` / `oldest_footage` sensors, which change value — they
begin reporting the archive, which is what their names always claimed.

## Enforcement

`packages/addon-pipeline/src/recorder/addon/__tests__/storage-usage-residency-licence.spec.ts`
— the residency licence test. Its fixture is deliberately LOPSIDED (an index
holding three hours over a ledger holding days), never one where the two agree,
which is the fixture shape that let the original substitution ship. It pins
that `devices[]` reports the ledger's bytes and oldest, that a camera with NO
resident rows is still listed with its real bytes, that the archive is asked
ONCE for the whole location set, that a node with no ledger refuses, and that
`index.accounting` is called only for the resident columns. Verified by
disarming: pointing `usedBytes`/`oldestMs` back at the resident accounting
turns exactly three of the seven red.

`scripts/check-recorder-index-residency.ts` (D295) is the other half: the
`accounting` licence now says what is left of it, and the guard fails on a
stale entry, so the licence cannot outlive the caller.
