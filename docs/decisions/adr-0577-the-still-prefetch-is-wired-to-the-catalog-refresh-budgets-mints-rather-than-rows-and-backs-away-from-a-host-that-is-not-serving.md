---
id: D577
title: The still prefetch is wired to the catalog refresh, budgets MINTS rather than rows, and backs away from a host that is not serving
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-prefetch.ts
  - packages/addon-provider-reolink/src/clips/clip-refresh.ts
  - packages/addon-provider-reolink/src/clips/clip-service.ts
---

## Context

D549 decision 16 designed a thumbnail prefetch in full: a bound of twenty, a
second queue lane in `ClipThumbQueue` that drains `interactive` before
`prefetch`, a sulking-host rule that keeps a prefetch off a host whose 400
backoff is open, and a `PREFETCH_HEADROOM_FRACTION` that stops it evicting what
the operator is about to open. D574 found, from the viewer side, that **nothing
outside a test ever called it**. Verified again on 2026-09-21 before acting:
`prefetchThumbnails`, `PREFETCH_BATCH` and `PREFETCH_HEADROOM_FRACTION` appear
in exactly four places across the whole workspace — the definition, the two
constants, and one assertion in `clip-uid-is-topological.spec.ts`. The lane and
the headroom do behave as the record describes; the caller was the missing
piece.

The consequence, measured live on the same day, per camera:

| camera | shape | rows in cache | vouched stills | share |
| --- | --- | --- | --- | --- |
| 592 | mains standalone | 1 188 (3 days) | 301 | **25.3 %** |
| 592 | — | 396 (today, browsed) | 284 | 71.7 % |
| 618 | mains standalone | 13 | 0 | **0 %** |
| 3628 | hub child | 5 | 0 | **0 %** |
| 3629 | hub child | 14 | 14 | 100 % |

Every one of those cameras has been refreshing its catalog on a 30-minute
timer for a day. The only stills on the hub's disk are the ones an operator
minted by opening a tile: the day 592 was browsed is at 71.7 % and the two
days behind it drag it to 25.3 %, and the two cameras nobody opened are at
zero. A first paint of sixty tiles therefore meets a cold queue every time —
D574 measured 43 of 60 told to come back.

And the timer is the one that produced none of them. Sampled read-only every
5 minutes from 22:49 to 23:25 UTC — 35 minutes, one whole 30-minute refresh
cycle — 592 went `288/396 → 288/421` vouched/rows (**+25 rows, +0 stills**,
72.7 % → 68.4 %) and 618 went `0/13 → 0/15`. The catalog grows, the still cache
does not. That is the runtime half of the finding, and it is not a grep result.

Wiring it as written would not have fixed it, and two measurements say why.

**The bound could not backfill.** `slice(0, limit)` bounded the rows
EXAMINED, not the mints. 592 recorded 396 clips in 24 h; a pass looked at its
newest twenty, found them warm because the live edge is what an operator opens,
and minted nothing. Rows 21 and older were unreachable by any number of passes,
for ever — which is precisely the 25.3 %.

**A camera that does not answer earns no backoff.** 108 is a mains standalone
whose `CoverPreview` never returns: three cold mints on 2026-09-21 took
30 041 / 30 017 / 30 020 ms and each answered `camera-refused` / `final`. That
is a TIMEOUT, not a `400 rejected`, and `ClipThumbQueue.isCameraRefusal`
requires `rejected` **and** `responseCode = 400` — correctly, because a decode
failure is ours and must not stop minting for a whole hub. So the queue's
sulking-host rule does not cover 618 at all: the lane is free after each
timeout and the next row walks into the same wall. A budget of sixty there is
half an hour of the host's lane per pass, minting nothing, on every tick, for
ever. That is the shape a backoff exists to prevent and the existing one does
not see it.

For contrast, one cold still costs 194–212 ms on 592 and 212–522 ms on hub
child 3628, through the parent's session.

## Decision

**The still prefetch runs from the catalog refresh, immediately after a listing
that LANDED, bounded by the number of stills it may MINT, and it stops — and
stays stopped on a doubling ladder — at the first refusal.**

The refresh (D562) is the home because it is the only thing that already knows,
per camera and per tick, which topology this is, that the catalog was really
re-read, and whether an operator holds the host's lane. Four rules follow, and
each is a change to what D549-16 shipped:

1. **After, never before.** The stills are for the rows that listing just
   confirmed; a pass in front of the refresh mints the catalog as it WAS and
   misses exactly the newest clips an operator opens first. A refresh that
   failed, and a `mark-stale` that read nothing, never reach the prefetch —
   `ClipPrefetchMode` excludes `mark-stale` by type, so no clause pretends to
   handle a mode that cannot arrive.

2. **The budget is MINTS, and it is sixty.** The scan walks the whole cached
   catalog newest-first and the budget counts only stills that were minted, so
   one pass both keeps up with the live edge and fills in behind it. Sixty
   because sixty is the operator's first screen (D574); twenty could not reach
   its second row. The cost is bounded by the same measurement: 60 × ~200 ms is
   12 s of a mains camera's own socket per pass, 0.7 % of a 30-minute interval,
   and the lane drains `interactive` first between every one of them.

3. **What it may never do, per topology.** A **mains standalone** pays its own
   socket. A **hub child** pays the PARENT's one shared session — that is a
   real cost and it is why the scheduler stayed sequential — and the child
   itself never hears it. A **standalone battery camera pays a wake, so it is
   never prefetched, in either mode.** `mark-stale` read nothing. `forced-wake`
   did read something, but the operator's own switch text says *"one interval
   buys exactly one wake"* and it bought that wake for the CATALOG; sixty
   CoverPreviews on top of it is a second meaning for a knob that already names
   what it buys (D62). A standalone battery camera's stills stay what they have
   always been: minted when somebody is waiting for the answer.

4. **When it stops.** A pass stops at the FIRST refusal of any kind and names
   it (`code`, `disposition`, `clipKey`) rather than meeting the same wall once
   per remaining row. The scheduler turns a stopped pass — refused or thrown,
   which are the same fact about the host — into a quiet period measured in
   INTERVALS: one refusal skips the next two passes, two skips four, capped at
   12 h, and the first pass that lands clears it. This does not change the
   queue's own backoff; it covers the case the queue's cannot see.

The prefetch is an enhancement to a refresh that already landed, so it never
throws into the refresh's own catch: a prefetch failure must not mark a catalog
stale that is not.

## Consequences

- **Cost, per topology, per pass.** Mains standalone: up to 12 s of its own
  socket. Hub child: up to ~30 s of the parent's shared session — in practice
  never reached, because a hub child holds single-digit rows and the pass ends
  `rows-exhausted`. Standalone battery: nothing, ever.
- A pass is O(rows) `stat` calls on the device's thumbnail directory.
  `hasHeadroomForPrefetch` is a `readdir` plus a `stat` per file, so it is read
  once before the pass and then every `PREFETCH_HEADROOM_RECHECK` (16) mints —
  16 stills at the 32–35 KiB measured on 592 is 0.5 MiB against a 6.4 MiB
  headroom, so the bound cannot be crossed between two reads.
- A camera at the live edge takes time to fill from cold: 107 records ~400
  clips a day and a 60-mint budget on a 30-minute interval backfills 120/hour,
  so a day is warm in about 3–4 hours and the newest 60 within one interval.
- `prefetchThumbnails` now returns a `ClipPrefetchOutcome` rather than a count.
  A count cannot tell "nothing to do" from "stopped on the first row", and
  those want opposite reactions.
- The quiet ladder is per device and per process: a runner respawn forgets it
  and pays one pass's first refusal again. That is deliberate — persisting it
  would be a second authority on a fact the next pass can re-measure in one
  mint.
- **Rejected: riding the wake-side refresher.** `onWakeTransition` already
  re-reads a standalone battery camera's catalog when it is up for its own
  reasons, and a prefetch there would spend no wake. It would still extend the
  awake window by sixty CoverPreviews on the one device class where awake time
  IS the budget, and it would do it through a hook the operator never armed.
  If it is ever wanted it needs its own switch and its own bound, not this one.

## Enforcement

- `packages/addon-provider-reolink/src/__tests__/clip-prefetch-is-wired.spec.ts`
  drives the REAL scheduler from COLD and asserts over a SEQUENCE of ticks, not
  a value. Confirmed red on revert:
  - removing the call: the trace is `refresh, refresh, refresh` with no
    `prefetch` between them (7 tests red);
  - removing the quiet ladder: a permanently refusing host is attempted at
    ticks `0,1,2,…,15` instead of `0, 2, 6, 14`;
  - removing the topology clause: `forced-wake` grows a `prefetch:640` in its
    trace.
- `packages/addon-provider-reolink/src/__tests__/clip-prefetch-pass.heavy.spec.ts`
  runs the real `ClipService` over a real temp directory. Confirmed red on
  revert:
  - restoring `slice(0, limit)`: three passes mint `[100, 0, 0]` instead of
    `[100, 60, 40]` — the measured defect, exactly;
  - removing the stop-on-refusal: a camera that throws on its third still is
    asked 200 times and the pass reports `rows-exhausted`;
  - removing the headroom gate: 16 stills are minted into a device that had
    none to spare, instead of 0.
- Nothing mechanically forbids a future caller invoking `prefetchThumbnails`
  from outside the scheduler and skipping `decideClipPrefetch`. The type keeps
  `mark-stale` out; the battery rule is review only.
