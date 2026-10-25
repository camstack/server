---
id: D451
title: An hour says whether it was SEALED, and a branch states the coverage it delivered
status: accepted
date: 2026-09-11
applies-to:
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-post-analysis/src/notification-center/timelapse/timelapse-renderer.ts
last-verified: 2026-10-02
---

## Context

[D445](adr-0445-a-ledger-row-describes-its-hour-or-the-array-decides.md) left
three things open, and closing the smallest one first turned up the fact that
the first one had not actually shipped.

**D445's durable repair never happened.** Its record says a short row "is
repaired durably through `adoptRebuiltHour`", and `roots.ts` carries the
comment "`knowsHour` deliberately does NOT gate this: an hour the ledger knows
incompletely is exactly the hour that needs repairing." Against the real
`SegmentHourLedger` both are false. The method opened with

    if (paths.length === 0 || this.ledger.has(key)) return

so the one row that needed repairing — a row known INCOMPLETELY — was exactly
the row it refused. A test written against the real ledger rather than a spy:

    expected [ …(4) ] to have a length of 40 but got 4

`hydrate-window-ledger-incomplete.spec.ts` was green over this because its
`stubLedger` records every call unconditionally: **the fake supplied the
behaviour production declines**, which is the second time this repo has shipped
that exact trap and the second time a correct-sounding comment next to it read
as verification. The practical effect: the export repaired only the in-memory
index, so the export itself was right, `forgottenSegments=9758` would have
recurred identically the next morning, and the timeline never saw a correction.

**The underlying cause was untouched.** The hour row is written write-behind on
every finalized segment, so a writer torn down mid-hour leaves segments on the
array that no row mentions. Nothing distinguished "this row IS the hour" from
"this row is what had been persisted when the writer was last heard from". On a
continuous camera that is one lost tail per writer death; on a lazy source like
camera 4374 the writer dies at the end of every burst, and thirteen bursts
closed inside hours that later went cold. The independent evidence is still on
the disk: `recordingsLow/.rec-tmp/4374/low/` holds seven abandoned 28-byte
staging stubs dated 09-06 → 09-11, one per writer that went away without
closing.

**And a ten-hour window that delivered forty minutes said nothing.**
`checkTimelapsePacing` compares the PLAN against the FILE; nothing compared the
WINDOW against the ARCHIVE. The robot's night went out with no line naming any
of its three figures.

## Decision

**An hour's row says whether it has been SEALED, and an unsealed hour is a
legitimate answer that any reader may resolve by walking the array once.**

`SegmentHourRow.sealed` is set by a party that could know: the writer that
LEAVES the hour (the next hour's first finalize, or a graceful stop), or a disk
walk of a CLOSED hour, which is the one complete answer there is. A process
that lost a finalize — a saturated lane, a failed detail read — never seals,
because it knows its row is short. Absence is `false`: a row written before the
column reads unsealed, the direction that costs one directory read and never a
missing hour.

**The seal costs one write per HOUR, never one per segment.** It fires on the
hour rollover, with no timer and no clock poll. The write-behind exists for a
reason and is left intact.

**A walk UNIONS, never replaces** (`adoptWalkedHour`, renamed for what it
does). A path the row names and the directory lacks survives: "the reader did
not see it" is not evidence it is gone (D148).

**The timeline is now VERIFIED rather than merely declared.** A closed hour
whose row is unsealed falls through to the walk for ANY reader, not only an
export, and is sealed by it — so the cost is one `readdir` per DAMAGED hour,
once, rather than one per open. At rest nothing is unsealed and the early
return is exactly today's.

**A branch that accepts a window and delivers less states the ratio, always.**
The timelapse renderer re-reads availability AFTER the export and logs
`plannedOfWindow` / `archiveOfWindow` / `plannedOfArchive` — `warn` on a
shortfall, `info` when there is none, because a night measured and found
healthy must not look like a night never measured.

## Consequences

- **The verification is affordable, and this is the measurement that says so.**
  On the live array (`/mnt/mixed`, camera 4374, hour directories holding 13 to
  1,091 files): **3.6 ms per hour cold** (after `drop_caches`), **0.76 ms
  warm**, with 166 hour directories in the whole `low` tree and at most 12 per
  camera. A ten-hour window costs ~36 ms once. D445 declined to verify outside
  the export because "a `readdir` per hour there is exactly the 2026-08-22
  `segment read timeout`"; at these numbers that cannot have been the cause,
  and that fear should not be inherited again without a measurement.
- The timelapse pays one extra `getAvailability` per render. It reads the index
  the export's walk has already repaired, so it costs no disk.
- `pacing-check` is now handed the rows the FILE was cut from, not the
  planner's. The renderer hands `createExport` a WINDOW and the engine walks it
  itself, so since D445 the file can legitimately contain footage the planner
  never saw — frame arithmetic over the planner's figure would cry
  `frame-surplus` at a correct file.
- A failed archive re-read reports `null` for every figure that needed it,
  never the plan's number wearing the archive's name (D393).
- Adding a second writer to a row made the per-hour lane mandatory: the
  rollover fires its seal without awaiting it, and "read, append, write back"
  has awaits in the middle. Unserialised, that is the same lost update as the
  sparse rows this record is about, recreated from the other side.
- **What this does NOT fix.** The writer still dies without closing — the seal
  makes the damage NAMEABLE and self-healing, not impossible. And a separate
  defect is suspected in the boot window (a finalize arriving before `load()`
  can take "unknown to this mirror" for "absent from the database"); it is
  untouched here deliberately, because it needs its own measurement and it adds
  a read to the hot finalize path. A row created by that race is born unsealed,
  so a reader walks and repairs it — which is the seal doing its job.

## Enforcement

`segment-hour-seal.spec.ts` runs against the REAL `SegmentHourLedger`, not a
stub, precisely because a stub is what hid the defect it opens with. It pins
the union repair, the D148 no-delete, the unsealed-is-an-answer reads, the
one-write-per-hour cost, the refusal to seal after a lost finalize, and the
lane. `hydrate-window-ledger-incomplete.spec.ts` pins the reader fall-through
and that an unsealed hour costs the array once.

Six disarms, each red on its own tests: the union refusing a known row (3), the
rollover sealing nothing (3), sealing after a lost finalize (1), the reader
ignoring unsealed rows (3), the early return ignoring them (3), and the lane
removed (1 — `expected [ …(5) ] to have a length of 6 but got 5`). One test
that stayed GREEN under the lane disarm was renamed for what it actually pins
rather than left reading as verification.

Nothing catches a future `sealed: true` written by a party that cannot know the
hour is complete. That is review only, and it is the one way to make this
record worse than no record at all.
