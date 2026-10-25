---
id: D445
title: A ledger row describes its hour, or the array decides
status: accepted
date: 2026-09-11
applies-to:
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/addon/recording-provider.ts
last-verified: 2026-10-02
---

## Context

The operator asked for a second look at the timelapse of camera 4374 ("Robot
piano terra"), a camera whose stream is BUILT on demand: *"sembra abbia
considerato solo il primo set di eventi e non l'intera notte."* [it seems to have considered only the first set of events and not the whole night.]

The first hypothesis — that the export takes the FIRST availability window
instead of the union — was wrong: `availabilityFor` returns every range in the
window and the export's playlist spans 21:56 to 04:19. The second — that the
robot simply had not worked all night — was also wrong, and it is the one that
had to be falsified first.

What the ARRAY holds for the night of 2026-09-10→11, inside the rule's
21:00→07:00 window, on `low`:

| | segments | footage |
| --- | --- | --- |
| on disk | 10,246 | 11,986 s (3 h 20 m) across 13 bursts |
| `recording.getAvailability` | — | **2,574 s**, 46 ranges |
| the export's own `src.ffconcat` | **488** | 2,362 s |

Both readers agree with each other and disagree with the disk by 5×, and they
agree because they are the SAME answer: `hourSegmentsFromIndex` serves the
calendar from `RecordingIndex` whenever the hour is `hydrated`, so
`getAvailability` never readdirs an hour the index claims.

The index is seeded by `hydrateWindowFromStorage`, which asks the hour ledger
first (D287) and then skips the array for any CLOSED hour the ledger answered
for — "the past is immutable, so the directory can only return what the index
already holds". **That sentence is true only of a COMPLETE row.** The row is
written write-behind on every FINALIZED segment, so a writer torn down mid-hour
leaves segments on the array no row ever mentioned. Until the hour closes the
live-hour walk recovers them; after it closes:

- the closed-hour skip fires, so the walk never looks;
- `adoptRebuiltHour` is gated on `!ledger.knowsHour(...)` — it can add an hour
  the ledger never knew and can never repair one it knows incompletely;
- `reconcileLedgerAgainstDisk` refuses `source-writable`, so the one tool that
  could measure this cannot run on any ACTIVE location — which is every
  location footage is written to.

`hydrate-window-ledger-first.spec.ts` already named this exact tail ("Nothing
could ever correct it") and fixed it for the LIVE hour only. On a continuous
camera that is one lost tail per writer death, which is why it read as a
rounding error for a year. On a lazy source it is most of the night: the robot's
writer is torn down at the end of **every burst**, and thirteen bursts closed
inside hours that later went cold.

That teardown leaves its own tracks. `recordingsLow/.rec-tmp/4374/low/` holds
seven abandoned 28-byte staging stubs dated 09-06 through 09-11 — one per
writer that went away without closing. The stubs are not the lost footage (the
real segments do reach the final tree, correctly named); they are the
independent evidence that this camera's writer dies abruptly and often, which
is the precondition the whole defect needs. The same walk confirms there is no
second root to blame: `4374` exists under exactly one recordings location
(`/mnt/mixed/camstack/media/recordingsLow/4374`), so the disagreement is not
two roots each seeing half.

The visible damage: the timelapse was rendered from a fifth of its night; 36 of
its 40 dense ranges were dropped as `reason: 'gap'` over footage that exists
(the one honest line in the whole path, `export dense ranges mapped onto the
concatenated stream`, warned `requested=40 mapped=4`); the delivered file was
**6.4 s / 77 frames for a ten-hour window**. A control render with the dense
overlay removed gave 16 frames — the base cadence itself was sampling 2,362 s
instead of 11,986 s.

## Decision

> **Largely superseded on 2026-09-17 by
> [D523](adr-0523-the-directory-says-which-segments-exist-and-the-table-says-how-much.md).**
> This record's answer was an OPT-IN: a reader that could afford the array was
> allowed to ask it. D523 removed the question — `paths` is gone from the row,
> the ledger is no longer read by the hydrate at all, and **every** reader lists
> the directory. Read the two paragraphs marked below for what survives here and
> what does not; the context above is why the class exists and is untouched.

**A hydrated hour is only as good as the row it was hydrated FROM, so a reader
that can afford the array must be able to ask it.**

`hydrateWindowFromStorage` takes `{ verifyClosedHours }`. When set, neither the
post-ledger early return nor the closed-hour skip fires: every hour of the
window is read from the array, the difference against what the ledger claimed
is counted, and a row found SHORT is repaired durably through
`adoptRebuiltHour` — `knowsHour` does not gate that call, because an hour the
ledger knows incompletely is precisely the hour that needs repairing.

**Superseded (D523).** There is no post-ledger early return to suppress any
more, because the walk asks the ledger nothing. The flag survives with a
narrower meaning — it re-reads hours **this process** has already listed, for a
reader inside a long-lived process that must not inherit an earlier reader's
view — and the skip it bypasses now rests on this process having listed the
directory itself, never on a durable row's claim about it. The repair is
`adoptWalkedHour`, which REPLACES the hour's account with the listing and seals
it, rather than `adoptRebuiltHour`, which merged and is gone.

**The EXPORT asks; playback and scrub never do.** `collectRangeSegments` keys
it off `uriMode === 'absolute'`, the same seam that already decides who stats
every file, and for the same reason: an export walks its window once and a
short answer is a whole night missing from a file, while the scrub re-walks per
cursor position and a `readdir` per hour there is exactly the 2026-08-22
`segment read timeout`. `hydrated` must not short-circuit the verified read —
an hour hydrated FROM a short row is the case it exists to catch, and gating on
that flag is what made the defect unreachable.

**Superseded (D523).** The asymmetry is gone: playback and scrub list the array
too. What replaced the cost argument is a measurement — an hour directory of
345–349 files lists in ~1 ms on this hub's SATA SSD, and the `~650 ms per hour`
five docblocks quoted traces to a FUSE mount that has been retired. The scrub is
protected by an in-process skip — an hour this process has listed is not listed
again — rather than by a durable row's claim about it, and CONTENTION, not
latency, is the ceiling that remains.

**And the walk says what it found.** `recorder: verified the hour ledger
against the array` carries `forgottenSegments` / `forgottenHours` with
`tags: { deviceId }`, `warn` when anything was forgotten and `info` when
nothing was — a verified walk that found nothing must be distinguishable from
one that never ran.

## Consequences

- ~~One `readdir` per hour of an EXPORT window, on the export path only. A
  ten-hour export pays ten reads once; the scrub's cost is unchanged.~~
  **Superseded (D523)** — every read path lists, and the bound is the
  once-per-process skip rather than the caller's identity.
- ~~`RecordingIndex.hydrateHour` is additive, so a verified walk can only ever
  ADD rows. It cannot delete footage the ledger claims and the disk no longer
  has — that stays D148's rule: never cancel from the ledger alone.~~
  **Superseded (D523)** — `hydrateHour` is still additive, but D148 gives up its
  one-directional arm here: a closed hour's listing may now SHRINK its row,
  bounded by `HOUR_LISTING_MAX_SHRINK_SHARE = 0.5`, and the two passes holding
  trusted evidence use the named `RecordingIndex.resetHour` instead.
- ~~The repair is durable, so the second export of the same night is cheap and
  the TIMELINE gets the corrected answer too, as a side effect of someone
  having exported.~~ **FALSE — corrected by
  [D451](adr-0451-an-hour-says-whether-it-was-sealed-and-a-branch-states-the-coverage-it-delivered.md)
  on 2026-09-11.** `adoptRebuiltHour` opened with `if (paths.length === 0 ||
  this.ledger.has(key)) return`, so the row this bullet claims it repaired — a
  row known INCOMPLETELY — was exactly the one it refused. The export's
  in-memory index was corrected and nothing durable was. The spec cited below
  was green over it because its `stubLedger` fake recorded every call
  unconditionally.
- **What this does NOT fix**: the timeline still under-reports a camera nobody
  has exported, because availability deliberately does not verify. And the
  underlying cause is untouched — the writer still fails to persist what it
  wrote. The right long-term shape is a row that says whether its hour was
  SEALED, so an unsealed hour falls through to the walk without anyone having
  to opt in.
  **Both closed since.** The seal shipped as
  [D451](adr-0451-an-hour-says-whether-it-was-sealed-and-a-branch-states-the-coverage-it-delivered.md)
  and was gated to a party that can know it by
  [D521](adr-0521-a-seal-is-a-claim-of-completeness-and-only-a-party-that-can-know-may-write-one.md),
  and D523 then went past the shape proposed here: no row names a file at all,
  so no reader can under-report from one, exported or not. The writer's torn-down
  tail still happens — the closed hour's listing simply re-derives the account
  after it.
- **Still unreported**: a timelapse that covers 2,362 s of a 36,000 s window
  ships with no statement of that ratio. `checkTimelapsePacing` computes
  `coveredSec` and would have called this `no-slowdown`, but it measures the
  plan against the file, not the window against the archive. A branch that
  ACCEPTS ten hours and delivers forty minutes must say so.

## Enforcement

`hydrate-window-ledger-incomplete.spec.ts` pins the correction, the
`forgottenSegments` line, the no-op on a complete row, and that the live hour's
row is still never written. **It did NOT pin the durable repair**, though it
claimed to: its ledger is a stub whose `adoptRebuiltHour` records every call,
so the assertion held against the fake while production declined. D451 replaces
that claim with a test against the real `SegmentHourLedger`. `export-verifies-the-ledger.spec.ts`
pins the seam in both directions — the export verifies even when the window
reads `hydrated`, and the playback path makes no call at all. Each was disarmed
and each went red.

Nothing yet catches a NEW caller wiring `verifyClosedHours: true` onto a hot
path; that is review only.
