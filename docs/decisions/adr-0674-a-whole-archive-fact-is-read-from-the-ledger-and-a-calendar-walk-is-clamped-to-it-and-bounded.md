---
id: D674
title: A whole-archive fact is read from the hour ledger, never walked; a calendar walk is clamped to the ledger floor, refused above a cap, and cached under a bound
status: accepted
date: 2026-09-29
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/calendar-index.ts
  - packages/addon-pipeline/src/recorder/addon/calendar-window.ts
  - packages/addon-pipeline/src/recorder/addon/calendar-hour-cache.ts
  - packages/addon-pipeline/src/recorder/addon/device-storage-usage.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/archive-footage-floor.ts
---

## Context

The recorder died of heap exhaustion on 2026-09-28 at 10:21. Every recorder
lifetime had built ~2.3 GB in one silent phase 3–5 min after boot, and nothing
named it. The 5-minute census (heap-delta and census instrumentation, 2026-09-28)
eventually did. The calendar's exact rung held
`hourKeys = 11,937,796` with `devices: 0, days: 0`.

The count explains itself. 11,937,796 = **24 × 497,408**: 24 (camera, served
profile) pairs × every hour from 1970-01-01 to now. `pipeline-analytics`
computed the follow-recordings retention floor as
`recording.getAvailability({ fromMs: 0, toMs: now })` per camera. It did this
every ten minutes, from both of its runners (hub and agent-a), and it
wanted only `min(startMs)`. `CalendarIndex.rangesIn` walked every hour of that
window. A missing hour directory reads as `[]`, and it cached each complete
answer, empty ones included:

- under a composite string key `"${deviceId}:${profile}:${hourMs}"`;
- in `hourSegs`, and in a twin `segsReadAt` map;
- with no bound, and with nothing that ever cleared `segsReadAt`.

The cost, estimated without pointer compression:
- ~166 B per key, ~2.2 GB in total;
- the two Maps at 2^24 capacity are 2 × 470 MB = **~940 MB of large-object
  space**, which matches the live 913–968 MB.

Two things fit this picture:
- The LOS doubling at the 2026-09-03 boot (458 → 914 MB, +456 MB) is both Maps
  crossing 2^23 = 8,388,608 entries and rehashing to 2^24.
- The boot build phase stepped LOS by +232, +336 and +448 MB. Those are the
  rehashes to 4 M, 8 M and 16 M.

11.9 M keys is **71 % of V8's hard Map limit** (2^24 = 16,777,216, measured in
the hub's node v24.21.0). About ten more pairs would have thrown `RangeError:
Map maximum size exceeded` inside the calendar, and every availability read
would then have been `unreadable`.

The first fix considered was a smaller cache (an LRU on the flat map). It
bounds the heap, but the walk would still run: ~497 k iterations per call
(~65 MB of garbage and 0.5–1.9 s warm), and on a cold boot two ENOENT syscalls
per hour per root (~2 M), at 12–56 s per call. The window itself was the defect,
and the number it computed already existed. `recordingArchive.getStorageUsage()`
reports `devices[].oldestMs` from the hour ledger's mirror, in one call for every
camera (D418).

## Decision

1. **A fact about the whole archive is read from the durable hour ledger, never
   derived from an availability walk.**
   - The follow-recordings floor is `getStorageUsage().devices[].oldestMs`, one
     call per 10 min for the whole fleet (`archive-footage-floor.ts`).
   - That floor is the oldest segment across EVERY profile and location. The
     walk answered for the served profile only. Across-all is `<=`
     served-only, so the cutoff can only move earlier and tracks are kept at
     least as long as before.
   - **The answer is the archive only when it says so.** The recorder
     registers its providers before `onHubReachable` loads the ledger, and a
     failed load used to last the runner's life. In both windows the mirror
     holds only the rows written since boot, and they were labelled
     `devicesRead: 'archive'`. Now:
     - `getStorageUsage` refuses (`devicesRead: 'unavailable'`) until the ledger
       has LOADED — every returned row staged, not only the query answered — and
       at least one location has resolved;
     - an unanswered load is retried from its readers, at most one attempt a
       minute for the first ten, then one every ten minutes for as long as it
       takes (never abandoned), and the slowdown is logged once;
     - the answer carries `complete: boolean`: loaded, a location resolved, and
       the load not cut at its row cap. The cap query is ordered newest-first,
       so a cut drops the OLDEST hours.
   - **Unreadable** means: the call failed, `devicesRead !== 'archive'`,
     `complete !== true` (absent included, i.e. a recorder predating this
     field), or the camera's row has no `oldestMs`. An incomplete answer is
     unreadable for EVERY camera: an absent one may hold footage past the cap,
     and a present one's `oldestMs` is the oldest of the newest rows, too young.
   - An answer that cannot be read is not "no footage" (D393). This covers a
     failed call, `devicesRead !== 'archive'`, or a row without `oldestMs`. In
     each case that camera gets **no cutoff for the pass**, and it is logged:
     once per failed read, and once per camera per skip episode with
     `tags: { deviceId }`.
   - This replaces the old fallback to the custom day window, which deleted more
     than follow would have whenever the archive reached back further.
   - An unreadable floor is its own cause (`DeviceRetentionCutoffs.floorUnreadable`).
     The sweep skips the camera but never reports it as the operator's
     `trackRetentionDays = 0`, whose line is latched for the process's life.
     The read-failure line is said once per episode, and its end once.
   - A camera ABSENT from a COMPLETE answer, or whose row's `oldestMs` is
     `null`, holds no footage: it keeps today's fallback, the custom window.
2. **Every calendar walk is clamped, then bounded** (`calendar-window.ts`).
   - `rangesIn` and `localDays` never visit an hour below the camera's oldest
     ledger hour (`SegmentHourLedger.oldestHourByDevice`, folded at most once a
     minute). That hour is a known "no" from the archive, not an inference from
     an empty directory. They never visit an hour after the current one either.
   - The floor is read only from a COMPLETE ledger. A camera ABSENT from it is
     UNKNOWN, not a known "no": an hour not adopted yet is on disk and absent
     from the ledger. It is bounded by the cap alone, so its from-0 ask is
     refused rather than answered as a confident empty `read`.
   - The clamp keeps the writer's current and previous hour, because the ledger
     is write-behind.
   - A ledger that has not completed a load clamps nothing (D393), and asks
     for the load to be retried.
   - A walk still wider than `CALENDAR_MAX_WALK_HOURS` after the clamp is
     **refused** with `CalendarWindowRefusedError`, never truncated. The
     provider surfaces it as `read: 'unreadable'` and logs it.
   - The cap is 366 × 24 = 8,784 hours. The widest caller is the viewer's month
     calendar (~33 days); the rest ask a day or a clip window. The 28 TB
     projection is ~47 k hour rows, ~2,000 hours per pair at ~24 pairs, and the
     live hub held 3.3 days. The ledger's load CAP (`SEGMENT_HOUR_SUMMARY_LIMIT`
     = 250,000 rows, ~10 k hours per pair) is a memory bound, not a retention
     claim; the clamp only narrows further. At the cap a warm walk costs
     ~1.1 MB of garbage.
3. **The exact rung is a bounded, numeric, read-through cache**
   (`calendar-hour-cache.ts`).
   - Keys are nested device → profile → hour index. The index is hours since
     the epoch, a Smi, so no composite string is built.
   - Entries are evicted LRU under the RAM index's own budget: 20,000 hours and
     250,000 segments, evicting to 80 %.
   - An empty hour is a bounded negative-cache marker (one shared frozen array,
     counted as `emptyHours`), never a fresh `[]` and never an `hourKeys` entry.
   - The current-hour read stamp lives on the cached hour itself. It dies with
     its hour (eviction, `invalidate`, `invalidateAll`), and an hour read while
     current is re-read once after it closes, whichever other hour of the pair
     was read in between.
   - `invalidate` is `profiles × 24` deletes instead of a scan of every key. It
     was a 12–37 s `storage-evictable.evict` at 11.9 M keys.
   - A future hour is never cached.
   - The census reports `hourKeys`, `emptyHours`, `hourSegments`,
     `segsReadAtKeys`, `evictedHours` and `approxBytes`.

## Consequences

- **The recorder's heap after deploy.** The calendar should hold what the
  theater, liveness and clips ask for: tens of hours per camera, a few MB at
  most, and never above the 20 k-hour / 250 k-segment bound. `approxBytes`
  stays under ~20 MB at the full bound. LOS should drop by ~940 MB, and heapUsed
  should settle near index + mfra + ledger, roughly 0.3–0.5 GB. This is an
  estimate, not a measurement.
- **The clamp trusts the ledger.** An hour on disk that the ledger has never
  heard of, older than its oldest row, is not shown by availability until
  adoption records it. That is the archive authority D295/D418 already set for
  retention and the storage page; the calendar now agrees with them.
- **The scheduled read is covered.** Two runners now call `getStorageUsage`
  every 10 min. Its per-camera half is a RAM fold. Its per-volume half is the
  `accountingForLocations` aggregate, which D447 requires to be served from a
  covering index; it is (`idx_recorder_segment_hours_loc_accounting`, pinned by
  the existing plan spec). HA-export already calls it on a schedule.
- **Retention waits for the recorder.** After a recorder restart,
  follow-recordings cameras are not swept until its ledger has loaded, which
  is seconds on the live hub.
- **Deploy order matters: `@camstack/addon-post-analysis` FIRST** (hub, then
  agent-a), **then `@camstack/addon-pipeline`** (the recorder).
  - The reverse order reopens the delete window this record closes. An OLD
    pipeline-analytics still asks `getAvailability(0 → now)`. A NEW recorder
    refuses that walk (a camera absent from the ledger, or any camera before
    the ledger has loaded) and answers `unreadable`. The old caller maps a
    failed read to `null`, i.e. the custom window, which deletes more than
    follow would have.
  - The safe order costs only this: a NEW analytics addon reads an OLD
    recorder's answer (no `complete`) as unreadable and does not sweep follow
    cameras until the recorder is updated. That is logged once per episode.
  - No `@camstack/server` or `@camstack/types` publish is needed. `complete` is
    additive and optional, it travels with each addon, and the hub's cap
    routers pass output through unvalidated (`cap-router-builder.ts`).
- **Wide windows fail.** A caller that genuinely needs more than a year of exact
  ranges gets `unreadable`. It should ask the ledger for aggregates instead.
- **A read-only window must be accepted.** `pipeline-analytics` sweeps nothing
  for a follow-recordings camera while the archive cannot answer, which could be
  a recorder outage of any length. That is the D393 trade: a floor that is late
  keeps tracks for longer, and a floor that is guessed deletes them.

## Enforcement

- `packages/addon-pipeline/src/recorder/addon/__tests__/calendar-epoch-walk.spec.ts`
  covers:
  - a from-0 ask scans only the archive span;
  - a from-0 ask over 24 pairs keeps `hourKeys` O(real hours);
  - an unknown floor or an over-cap window is refused, and scans nothing;
  - the day rung clamps;
  - empty hours are not `hourKeys`;
  - the LRU bound holds;
  - `invalidate` and `invalidateAll` clear the stamps;
  - a closed hour is re-read once;
  - census bytes;
  - `ArchiveFloorReader` gives no floor until the ledger has loaded.
- `segment-hour-ledger.spec.ts` covers `hasLoaded`, `oldestHourByDevice`,
  loaded-only-after-staging, the row cap and its order, and the bounded, spaced
  retry that never overwrites a row this process wrote.
- `storage-usage-ledger-not-loaded.spec.ts` drives a REAL ledger through the
  provider: before the load, during it, after a failed load (then retried),
  with no location, at the row cap, and whole.
- `packages/addon-post-analysis/src/pipeline-analytics/retention/__tests__/archive-footage-floor.spec.ts`
  uses a fake api whose `getAvailability` throws on any window over a day. It
  pins that the floor comes from `getStorageUsage` in one call, that
  unreadable (incomplete included) means skip plus log, never the custom
  window, and that the trackless sweep never reports it as retention OFF.
- Every one of those tests was disarmed by hand and went red.
- `addon-post-analysis` had no `test` target, so CI never ran its specs. It has
  one now (`vitest.config.ts`); the whole suite (679 files) was green when it
  was added.
