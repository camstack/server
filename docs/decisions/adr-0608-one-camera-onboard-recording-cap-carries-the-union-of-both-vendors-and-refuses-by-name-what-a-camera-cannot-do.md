---
id: D608
title: One camera-onboard recording cap carries the UNION of both vendors, and refuses by name what a camera cannot do
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/types/src/capabilities/recording-onboard.cap.ts
  - packages/types/src/capabilities/recording-onboard-rules.ts
  - packages/system/src/builtins/device-manager/recording-onboard-config-schema.ts
  - packages/addon-provider-hikvision/src/recording-onboard-mapping.ts
  - packages/addon-provider-reolink/src/recording-onboard-mapping.ts
---

## Context

The operator asked for one new section in the camera settings covering the
camera's OWN storage and the camera's OWN recording, on both Reolink and
Hikvision. `recording.cap.ts` does not answer this: that is CamStack's
recorder — our ledger, our locations, our retention — and the authority here is
the firmware.

The first design put on paper was the INTERSECTION: carry only what both
vendors do, and leave a vendor-only field off the device that lacks it. The
operator rejected it, and he was right — *"deve essere comune a entrambe o
altrimenti non ha senso… deve supportare edge cases di entrambi."* [it must be common to both, otherwise it makes no sense… it must support the edge cases of both.] A section
that looks different per vendor is not one interface, and the entire value of
sharing it is that it is one.

So the two models were measured, read-only, on 2026-09-22 against the live
fleet — Reolink 592 and 618 over Baichuan, Hikvision 1436, 3833 and 1441 over
ISAPI — before a line of schema was written:

| fact | Hikvision (ISAPI, V5.7.1 / V5.8.10) | Reolink (Baichuan, v3.1.0.x) |
| --- | --- | --- |
| storage | `ContentMgmt/Storage` `<hdd>` rows: status, capacity, freeSpace in MB | `getHddInfoList` cmd 102: `mount`, `format`, `capacity` GB **plus** `capacityM` MB remainder |
| tracks | several, with independent schedules (1436 AND 3833 both list 101 and 103) | one per channel, no track concept |
| schedule | per track, 7 `ScheduleAction` blocks: DayOfWeek + a TimeOfDay range + **one** `ActionRecordingMode` | per trigger type, a 168-char weekly **hour** mask |
| granularity | arbitrary minutes (1436 track 103 runs 00:05–23:57) | one hour |
| triggers | `CMR`, `MOTION` (`ALARM` in the spec) | `Normal`, `MD`, `people`, `vehicle`, `dog_cat`, `crossline`, `intrude`, `loitering` |
| pre / post record | `PreRecordTimeSeconds` / `PostRecordTimeSeconds` | `preRecordTime` / `recordDelayTime` |
| overwrite | per track `LoopEnable` | `cycle`, with `cycleList` enumerating what it accepts |
| file length | not exposed anywhere in `ContentMgmt` | `packageTime`, minutes |
| write path | `PUT` the track's own resource, read-modify-write | **none** — the library has readers and no writers |

The two schedules are not different models. Both answer *"for this trigger,
during which weekly windows does the camera record"*; they differ only in
coordinates. That is what made a union possible rather than a lowest common
denominator.

Two measurements changed the design rather than decorating it. The track
`Description` declares `framerate=2.260000 fps` on media that measures 12.55 —
so the cap has no framerate field at all, while `codecType` and `resolution`
from the same string are kept. And 1441 and 3831 are both scheduled to record
onto a card that is not there: neither the storage read nor the schedule read
says anything wrong on its own, only the pair does, so the pair is a field.

## Decision

`recording-onboard` is one `deviceConfig` cap whose FIELD SET is identical on
every camera. What varies per device is which VALUES that device accepts, which
`getOptions` states as a `{ readable, writable, reason }` per field plus the
schedule's own limits (`granularityMinutes`, `triggers`,
`supportsOverlappingTriggers`). A field a camera cannot write is still
rendered, DISABLED, with its reason visible — never hidden, because a missing
control is indistinguishable from a feature CamStack never built.

A write a camera cannot honour is REFUSED BY NAME, never accepted and dropped.
The refusal vocabulary is one pure function, `describeOnboardRefusal`, in
`@camstack/types`, shared by both providers so the operator gets the same
sentence whoever refuses. A window that is not aligned to the camera's own step
is refused, not rounded: rounding is how an operator's 06:30 becomes 06:00 with
nothing saying so.

The cap stores nothing of its own (D62). Every value is read from the camera
and every write goes back to it.

## Consequences

**Reolink is read-only, by name, and that is the honest state.** The Baichuan
library exposes `getRecordCfg` / `getRecordSchedule` / `getHddInfoList` and no
matching setter; the SET command ids exist but nothing in this repo has ever
sent them, and the only route is hand-built XML through the generic passthrough.
Every Reolink field therefore reports `writable: false` carrying
`REOLINK_NO_WRITE_REASON`, and the UI shows that sentence under a disabled
control. Lifting it means verifying one Baichuan write against one mains camera,
and nothing else.

**Hikvision's write path is implemented and has never been executed.** The
transformation is pure and proved against the camera's own document
(`applyOnboardPatchToTrackXml`, tested on 1436's verbatim track 101), and it
splices rather than synthesises, exactly as the other ~14 setters in that ISAPI
client do. What is NOT proved is that the camera accepts a `PUT` to
`ContentMgmt/record/tracks/<id>` at all — the sibling resources `Storage/mountList`
and `search/profile` already answer 403 on this firmware. The failure mode is
loud: `putXml` throws on a non-2xx, and a patch whose tag the camera never sent
is refused by name instead of PUT as an unchanged document that would answer 200
for a write that never happened. **The first real write is a supervised one.**

**One Reolink assumption is recorded rather than proved.** The weekly mask is
read as day-major, Monday first (`day * 24 + hour`). Every `valueTable` on the
fleet is uniform, and a uniform mask reads identically under either layout, so
the reads shipped here are exact and the assumption is unfalsifiable from the
current data. `weeklyMaskIsUniform` exists to name the case. To settle it: set a
single hour on one day from the Reolink app and re-read `getRecordSchedule`.

**The schedule is one form field, not many.** `updateDeviceField` is a
single-field save path, so a schedule spread over many keys could not be
reassembled from a legitimate one-key patch — and reassembling it from a mirror
is the second-authority failure D62 forbids. It is an `editable-array`, so the
value that arrives is always the complete set.

**A window we could not read blocks the schedule write.** `unreadableWindows`
is non-zero when the camera described something the reader did not understand;
the provider then reports the schedule unwritable, because replacing a set we
could only partly read would delete the part the operator was never shown
(D391).

**`freeMb` is not "space left for recording".** 1436 and 1439 both sit at
exactly 11776 MB, the fixed reserve a looping card converges on; 592 sits at
598 MB. At loop steady state the number is identical whether the camera recorded
yesterday or stopped a month ago, and the form says so rather than implying a
fill gauge.

## Enforcement

- `packages/types/src/capabilities/__tests__/recording-onboard-rules.spec.ts` —
  25 tests over the refusal vocabulary and both coordinate systems, driven by
  the live masks and the live `TimeOfDay` spellings.
- `packages/addon-provider-hikvision/src/__tests__/recording-onboard-mapping.spec.ts`
  — 33 tests against verbatim camera bytes in `__tests__/fixtures/`, including
  the produced PUT body.
- `packages/addon-provider-reolink/src/__tests__/recording-onboard-mapping.spec.ts`
  — 23 tests against the verbatim Baichuan replies.
- `packages/system/src/builtins/device-manager/__tests__/recording-onboard-config-schema.spec.ts`
  — 17 tests, the load-bearing one being that an unwritable field is still
  rendered and still says why.
- `server/backend/src/__tests__/cap-routers/recording-onboard.router.spec.ts` —
  the device-native mount, the `admin` floor on `setSettings`, and a refusal
  reaching the caller with its sentence intact.
- Every gate above was verified by removing it, confirming RED, restoring
  byte-identically (`cmp`) and confirming GREEN.
- Not enforced by a guard: that a provider calls `describeOnboardRefusal`
  before writing. Review only. A third vendor that skips it would silently drop
  writes, which is the exact failure this record exists to prevent.
