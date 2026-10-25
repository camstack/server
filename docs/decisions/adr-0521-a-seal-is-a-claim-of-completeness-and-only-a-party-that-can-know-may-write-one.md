---
id: D521
title: A seal is a claim of COMPLETENESS, and only a party that can know may write one
status: accepted
date: 2026-09-17
applies-to:
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/addon/segment-watcher.ts
  - packages/addon-pipeline/src/recorder/addon/recording-controller.ts
  - packages/addon-pipeline/src/recorder/addon/hour-adoption-sweep.ts
  - scripts/check-seal-authority.ts
covers:
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/addon/ledger-walk-reconcile.ts
last-verified: 2026-09-29
---

## Context

[D451](adr-0451-an-hour-says-whether-it-was-sealed-and-a-branch-states-the-coverage-it-delivered.md)
ends like this:

> Nothing catches a future `sealed: true` written by a party that cannot know
> the hour is complete. That is review only, and it is the one way to make this
> record worse than no record at all.

The rollover seal D451 shipped in the same change **is that party**, and six
days later it took two hours of camera 101 off the timeline while every segment
file stayed on the disk (355 and 358 files across both profiles, correct names,
correct mtimes).

The chain, traced end to end:

1. The recorder runner respawned mid-hour (five respawns that day: a server
   update plus memory pressure). The new process's watcher found ffmpeg's
   `-segment_list` truncated and logged `rolledOff=175, processed=0`
   (`segment-watcher.ts`). Those 175 finalizes never reached `recordSegment`.
2. The respawned writer's FIRST finalize into hour H created the row **without
   them** (`segment-hour-ledger.ts`, the write-behind).
3. At the H→H+1 rollover `noteWriter` fired `sealHour(H)`. A process that
   entered H 29 minutes in declared H complete. It could not consult its
   `refused` set: the loss happened in a process that no longer exists.
4. Window hydrate read the sealed row and called `index.hydrateHour(…)`
   (`roots.ts`), marking the hour hydrated.
5. `hourSegmentsFromIndex` returned a short array — non-null means COMPLETE —
   so `segmentsOfChecked` answered `{ segments, complete: true }` and never
   `readdir`'d. Past hours cache indefinitely.
6. The closed-hour skip in `roots.ts` is bypassed only for `unsealed` hours.
   This one is sealed. **Nothing looks again, for the life of the footage.**

The two levers that already exist do not reach it. `reconcileLedgerAgainstDisk`
(D319) iterates only the hours the ledger already CLAIMS — an hour whose row was
never written is invisible to it — it never adopts an orphan, only forgets a
ghost, and it refuses `source-writable` on every ACTIVE location. All three are
correct there: its licence to FORGET rests on a listing being the whole truth,
and a listing of a live location is a lower bound. `adoptWalkedHour` is the
lever that repairs this, and until now the only thing that called it was a
reader walking a window somebody happened to open.

## Decision

**A seal is a CLAIM OF COMPLETENESS about an hour, and only a party that could
have observed the whole hour may write one.** Three parties qualify, and the
list is closed (`scripts/check-seal-authority.ts`):

- **`closed-hour-listing`** — a directory read of an hour that is OVER. The past
  is immutable, so this is the one complete answer there is (D451).
- **`writer-owned-hour`** — the writer that LEAVES the hour, and only if it
  entered within `WRITER_HOUR_ENTRY_GRACE_MS` **and** nothing it produced was
  reported lost. Its entry is the `startMs` of its first finalize into the hour,
  taken from the segment's own name: a delayed finalize is not a late arrival.
- nobody else.

**A loss is reported at the moment it is known, and it reaches the ledger.**
`rolledOff > 0` is the only instant anything knows finalizes were skipped. The
watcher now hands its caller a `MissedSegments` — the count and the MEDIA span
it covers — and the addon turns that into `markHoursRefused`, which holds every
hour the span touches unsealed. A span the playlist cannot supply is reported as
`null` and named in a log line; it is never invented, because an hour guessed
wrong is an hour left sealed.

**The ADD direction never needed the `source-writable` refusal the FORGET
direction does.** A file that is on the array IS on the array; a live writer can
only make a listing SHORT, and a short listing unioned into a row adds fewer
paths than it could have, never a wrong one (D148 in the same direction it has
always run). So `hour-adoption-sweep.ts` is a bounded, add-only pass that runs on
ACTIVE locations, enumerates DIRECTORIES rather than claimed rows — that is what
finds an hour no row ever named — skips the live tail, and calls exactly one
thing: `adoptWalkedHour`. Its ledger surface is a one-method interface, so a
future edit cannot reach a forget from inside it without changing the type.

**`paths` was NOT dropped in this change**, although the aggregate columns can
answer everything the timeline's counts need. The column IS the union's input:
`adoptWalkedHour` diffs what the directory holds against what the row names, and
a row that carried only `segments: 175` could say an hour is short but never
WHICH segments the readers are missing — the repair would degrade from a union
into a replacement, which is exactly the D148 violation the union exists to
avoid. The reason to want it gone is real (D447: `paths` is ~30 KB of table page
per row, and it is what made the accounting read pull table rows); that is paid
for by the covering index, not by deleting the evidence.

## Consequences

- **The seal is no longer free at rest for a respawning writer.** Every hour a
  writer entered late is now walked once by its first reader (~3.6 ms cold per
  hour directory, D451's own measurement) and sealed by that walk. On a
  continuous camera that is one hour per writer death; on a lazy source it is
  one per burst, which is the population D451 was already paying for.
- **`WRITER_HOUR_ENTRY_GRACE_MS = 90 s` is a guess, and this is the shape of it
  being wrong.** Tighter: a normal rollover stops sealing and every hour of the
  archive gets a directory read it did not need. Looser: a runner respawn inside
  the window seals an hour it entered late — the defect above, whose observed
  hole was ~29 minutes. 90 s is one segment length at the longest anyone
  configures here (60 s) plus 30 s for a keyframe-cut segment overrunning its
  nominal `-segment_time`, and it is the smallest number that never fires on a
  legitimate rollover.
- **A reopened process inherits a row it cannot vouch for, and the grace does
  not catch that case.** A ledger that boots and appends to an existing hour
  passes the ownership gate on its own entry while the part of the row written
  before the restart may still be short. The watcher refusal covers it when the
  loss was observed; the adoption sweep covers it when it was not. Nothing
  covers an hour where BOTH failed — that hour is sealed and short until the
  sweep's cursor reaches it, which is why the sweep exists and why it starts
  over when it finishes.
- **The adoption sweep spends `readdir` on the array every live read competes
  for.** Daily, never at boot, bounded at 512 hour listings per pass, paced
  every `WALK_HOUR_BATCH` listings through `LEDGER_WALK_PAUSE_MS`, nothing
  recursive. A `find` over this array hung an SSH session on 2026-08-29 and the
  brakes are inherited from the pass that learned it.
- The sweep's cursor lives in RAM. A restart re-walks from the top: listings,
  never footage.
- Two log lines about a camera gained the tag they should always have had
  (`rolledOff`, and the pending give-up). The adjacent comment claiming "the
  logger is already deviceId-scoped by the controller" was deleted: a logger
  binding is not the tag being on the line, and this is the primary signal for
  the whole failure mode.

## Enforcement

`scripts/check-seal-authority.ts`, wired into `.github/workflows/ci.yml`. It
enumerates every `sealed: true` under `recorder/`, attributes each to its
enclosing method, and requires (a) an `@seal-authority <id>` tag on that
method's doc comment, (b) an allowlist entry here naming what that party KNOWS,
(c) no stale entries, and (d) that `sealHour` still consults both
`WRITER_HOUR_ENTRY_GRACE_MS` and both refusal sets. Adding `sealed: true` to
`recordSegment` — the exact shape of this defect — fails it by name.

`segment-hour-seal-ownership.spec.ts` runs against the REAL `SegmentHourLedger`
(D451's reason: a stub is what hid the previous one). `segment-watcher-loss-
reported.spec.ts` pins the span arithmetic, the callback and the tag;
`hour-adoption-sweep.spec.ts` pins add-only, closed-hours-only, the bound, the
cursor and that a failed listing decides nothing.

Five disarms, each red on its own tests: the ownership gate removed (3 ownership
tests + the guard), the reported-loss refusal removed (2 + the guard), the
watcher's report and tag removed (2), the sweep's live-tail skip and bound
removed (5), and a `sealed: true` added to `recordSegment` (the guard, by name).
D451's own suite stays green under all of them, which is the point: this record
adds a gate, it does not move one.

What is still review-only: whether the sentence written next to an
`@seal-authority` is TRUE. The guard can tell that a party declared what it
knows; it cannot tell that the party knows it.

## Amendment, 2026-09-28 — a predecessor THIS process drained is not a loss

The report above fired on every writer spawn on every camera (1149 lines in 90
minutes on 2026-09-28), not only after a runner respawn: a fresh watcher's first
read is the previous run's bounded `live.m3u8`, and with its mark at 0 every
entry before that body's front counted as rolled off — holding those hours
unsealed. When the previous writer's watcher ran in this same process from spawn
through a final pass that successfully READ the playlist, those entries were
already handled, or reported by that watcher when they rolled. The
controller-owned drain ledger therefore records the exact last segment start
and global media sequence of that body. The next watcher suppresses a roll-off
only when the body it sees is no newer than that record and its front predates
its own writer (`rolledOffIsDrainedPredecessor`, logged at debug with the
`deviceId` tag). An unreadable final pass records nothing; a foreign or later
playlist is newer and still reports. "Ignore everything older than the spawn"
was rejected: it is exactly the 101 case above, where the predecessor died with
the process and the new watcher's report is the only record. A new process
starts with an empty ledger, so that case still reports — pinned in
`segment-watcher-loss-reported.spec.ts`, along with a predecessor stopped
without its flush, an unreadable final read, a newer foreign body and a body
whose front belongs to the new writer.
