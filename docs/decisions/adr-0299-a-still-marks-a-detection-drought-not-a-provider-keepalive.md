---
id: D299
title: A motion still marks a detection DROUGHT, not an edge — and a bulk media delete confirms the blob before forgetting the row
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/services/motion-marker-policy.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/motion-event-snapshot.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/media-reclaim.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/periodic-media-plan.ts
---

## Context

`pipeline-analytics:media` reached 1 257 140 rows / 152.59 GB on the live hub,
of which **1 136 601 rows / 111.08 GB (73 %)** were one ~95 KiB JPEG per motion
off→on transition — written unconditionally, with no per-camera gate, and
reached by its only consumer as an unnamed `files[0]`.

The obvious reading was "a busy scene". It is not. Measured 2026-08-30 over
bounded windows, the median inter-transition gap is **1 010 ms** with p25 1 007
and p75 1 014 — the same 7 ms band on a camera with 62 tracks in the hour and
on one with zero, at 09:20 and at 21:20. Camera 3829 produced 22 827 stills
against **5** detected tracks in a day.

1 010 ms is a clock, and it is the provider's. Reolink emits
`MotionOnMotionChanged { detected: true }` on every firmware push and never
emits `false`; Hikvision documents the same shape as deliberate — *"Emit the
motion heartbeat on EVERY VMD tick, not just the rising edge … mirroring
Reolink's per-push emit."* Meanwhile the analyzer emits `MotionAnalysis` on
every pass at `motionFps` carrying a raw `regions.length > 0`. Both handlers
write ONE `lastMotionInsertByDevice`, whose docblock asserts the two paths are
mutually exclusive — false, because `onboardMotionDrivesAnalyzer` defaults to
true and an onboard push is what *starts* the analyzer. Every analyzer frame
with no pixel change stamps `detected: false`, and the next keepalive reads it
as a rising edge. 94–98 % of all motion rows are "rising edges".

The first fix considered was a boolean `debugMediaEnabled` gate, default false.
The operator rejected the premise: *"Dovremmo avere delle tracce sintetiche di
motion semplice, se non avviene alcuna detection per molto tempo."* [We should have synthetic simple-motion tracks, if no detection happens for a long time.] The
fallback has a purpose — a quiet camera whose timeline is blank reads as broken
— so a boolean that removes it is the D62 failure in the other direction. The
condition he states is a DROUGHT, and the code was testing an edge.

Separately, reclaiming the standing 111 GB could not use any existing delete
path: every one of them (`deleteByKeyUnchecked`, `deleteForOwnerUnchecked`)
swallows the unlink error and drops the row anyway, and the underlying
`fs.rm(…, { force: true })` cannot distinguish "removed it" from "there was
nothing there". Over 1.14 M rows that manufactures the orphan class this repo
has swept three times this week.

## Decision

**A motion still is produced when nothing has been DETECTED on that camera for
`motionMarkerQuietMs`, at most once per such window — never per motion edge.**
The decision is pure, reads only in-RAM mirrors refreshed off the event path
(D49), and sits **in front of the snapshot fetch**, so a suppressed marker
costs no camera wake and no encode. Per-edge stills survive only under
`MediaSettings.debugMediaEnabled` (default **false**), which absorbs and retires
`saveThumbnails` rather than sitting beside it; the rolling `lastFrame` moves
out from under that switch because it is in the keep-set, and the drought
marker is never gated because it is the fallback.

**A bulk media reclaim deletes through `MediaStore.deleteConfirmed` and nothing
else**: unlink, re-probe that the blob is gone, and only then forget the row. A
blob that survives, or a volume that cannot answer, is a **refusal** — the row
is kept, the cursor does not pass it, and that camera's scope ends. A selected
row is deleted only when a per-page indexed probe confirms its owner is the
artifact the scope names, and never when the owning track is pinned
(`staging` / `favourited` / in-RAM active).

## Consequences

- Motion-still production falls from ~92 400/day (9.0 GB/day) to **688/day
  (64 MB/day)** fleet-wide at the default N, with the fallback intact. N = 900 s
  was chosen from the observed fleet distribution of detection-free stretches
  (median 42 s, p75 201 s, **p90 770 s**), not from a round number.
- A drought longer than N yields one marker per N. Camera 3829's median drought
  is 3.4 h; one marker for it would blank the timeline just as thoroughly as
  none.
- The track filmstrip is now off by default. Trajectory replay degrades to
  first/last frame on a camera in the default state — the "debug" the operator
  described. `lastFrame` is unaffected.
- **The edge itself is still wrong.** This record does not fix
  `lastMotionInsertByDevice`; it makes the media path independent of it. The
  1.29 M motion ROWS are the same defect and still cost what they cost. The
  correct edge is written down in
  `docs/design/2026-08-30-motion-marker-and-media-reclaim.md` §1 — key the map
  by `(deviceId, source)`, synthesise the falling edge from a keepalive TTL
  rather than another source's sample, and make the unit a VISIT
  (`motionCooldownMs`) — and it needs its own change on its own evidence,
  because it changes what a motion row means.
- A reclaim that refuses stops early rather than making progress. That is the
  intended trade: a pass that steps over an unfinished row makes the same
  mistake 1.14 M times.
- `saveThumbnails` values persist in the store with no reader until a
  `RETIRED_SETTINGS_KEYS` entry is added in `packages/system` (not touched
  here — another agent holds that file). Until then the retirement is
  behavioural only.

## Enforcement

- `services/__tests__/motion-marker-policy.spec.ts` and
  `services/__tests__/motion-event-snapshot.spec.ts` — the second asserts
  `getSnapshot` is never CALLED for a suppressed edge, which a
  fetch-then-discard gate fails; and replays the measured hour of 1.010 s edges,
  pinning 3 565 edges → 4 stills → 4 camera fetches.
- `retention/__tests__/media-reclaim.spec.ts` — the pin, the owner probe, the
  refusal-halts-and-keeps-the-cursor, and the throwing-probe cases, each on a
  fixture whose armed and disarmed outcomes differ by a count.
- `store/__tests__/media-delete-confirmed.spec.ts` — a storage whose `delete`
  silently does nothing, and one that throws: both keep the row AND the blob.
- `scripts/check-settings-key-has-reader.ts` already enforces that
  `debugMediaEnabled` / `motionMarkerQuietMs` have readers.
- Nothing yet enforces that a media KIND has a named reader. That guard is the
  proposal in §4 of the design page and is the thing that would have caught
  this population on the day it shipped.
