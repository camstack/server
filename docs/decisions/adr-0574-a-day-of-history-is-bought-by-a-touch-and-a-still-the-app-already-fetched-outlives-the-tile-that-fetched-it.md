---
id: D574
title: A day of history is bought by a TOUCH, never by the surface reacting to itself — and a still the app already fetched outlives the tile that fetched it
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - camstack/src/components/camera/theater/lookback-walk.ts
  - camstack/src/components/camera/theater/use-timeline-scrub.ts
  - camstack/src/data/use-camera-clips.ts
  - camstack/src/clips/clip-still-memory.ts
  - camstack/src/clips/use-clip-still.ts
---

## Context

Two reports from the operator on 1.0.512/1.0.513, one sentence:

> *"se scrollo la lista di Clips va in loading e non ne esce più per qualche
> motivo, inoltre le thumbnail non arrivano nonostante prima dovrebbe già
> averle scaricate."*
>
> [if I scroll the Clips list it goes into loading and never comes out for some reason, moreover the thumbnails do not arrive although it should already have downloaded them before.]

### 1. The walk that asked for thirty days because it had emptied the list

`lookback-walk.ts` lets a near-bottom scroll ask for one more day of history.
Its latch was written to bridge one gap — `lookbackDays` is React state, so the
hook reads the OLD value for a render after the call — and the second-midnight
fix then widened the discharge rule to *"ANY movement of the observed value"*, so a
day-change reset could not wedge the walk.

On the CLIPS body that rule closes a cycle:

1. the near-bottom hit extends, so `lookbackDays` moves;
2. the wider window is a new react-query key, and a new key has no data — so
   the body draws **no cards**;
3. the content collapses, and the ScrollView clamps the parked offset to the
   new, much smaller maximum, emitting a scroll event **nobody caused**;
4. the value moved at (1), so the latch is already discharged;
5. the clamped offset is, of course, at the oldest end. Round again.

The operator's finger left the glass at step 1. Measured in
`clips-back-scroll.spec.ts` against the real pure functions: **29 extensions
from clamp frames alone, with no gesture in front of them** — the walk running
to its 30-day cap on its own, each step a fresh `listClips` / `listTracks` over
an ever-wider window, the body pinned on `loading` for the whole run. On 592,
whose onboard catalog is 357 files in four hours, the thirtieth of those reads
is over a window ~180× the one that answered in the first place.

Two candidates were ruled out with evidence before this one was believed. A
query left `enabled: false` cannot be the cause: react-query v5 reports
`isLoading` as `isPending && isFetching`, so a disabled query is not loading,
and the only `enabled` gates on this surface are in `use-camera-clips.ts`. A
churning list identity cannot be either: `clip-list-identity.ts` and the
module-level `EMPTY_CLIPS` already close that, and `clip-publish-loop.spec.ts`
bounds it.

The 32 px compressed threshold (`COMPRESSED_LOOKBACK_THRESHOLD_PX`) was an
earlier, partial fix to the same seam — it stopped the walk firing at offset
zero, but on a body the operator has actually scrolled to the bottom of, "the
bottom" is exactly where the clamp keeps putting them.

**And the hook was never keeping what its consumer said it kept.**
`clips-status.ts` has documented `clipCount` since the day it was written as
including *"a previous window's rows, which the hook deliberately keeps while a
wider one loads"*. `useCameraClips` did no such thing. That leftover described
the right design and read as verification — the exact hazard CLAUDE.md names —
and it is also the thing that empties the list at step (2).

### 2. The still the app threw away between one scroll and the next

`useClipStill` held its bytes in `useState`. The clips body mounts only a band
around the viewport (`timeline-window.ts`: 320 px of margin, re-selected every
160 px), so an ordinary scroll unmounts tiles constantly — and each of those
unmounts destroyed a still the app had already paid a mint for. Scrolling back,
leaving the screen and returning, and the window-widening above all re-asked
for every one of them.

That re-ask is not a cheap round trip. The provider mints on demand behind a
lane 16 deep, one in flight per camera (`clip-thumb-queue.ts`,
`THUMB_QUEUE_CAPACITY`); past that the route answers 204 `queue-full` and the
tile spends D563's four-attempt budget getting back to where it already was.
The still the operator "already downloaded" is precisely the one most likely
not to arrive the second time.

**A correction to D573 while we are here.** D573 records *"the mint route has no
cache"* from a measurement that re-fired 60 URLs and got the identical 17
served / 43 `queue-full`. The route does have one, and it is vouched by a stat:
`ClipArtifactStore` (2 000 files / 64 MB per device), read BEFORE any mint, and
served `cache-control: immutable`. The captured wire says so — of 592's 357
rows, **115 carry the vouched `thumbnail` field and 242 carry only a
`thumbnailMint`**. What the second measurement actually showed is that the 43
were never minted at all, so there was nothing to cache. That distinction is
what makes a client-side memory worth having and a client-side *probe* still
worthless.

## Decision

**A day of history is bought by a TOUCH.** `armLookbackWalk` is called from
`onScrollBeginDrag` and from nothing else; one finger-down buys at most one
extension, and a scroll event the surface generated for itself — a clamp, a
programmatic scroll, a re-layout — buys none. The movement of `lookbackDays`
was never evidence that the operator wanted another day; it is evidence that
WE changed it. A movement DOWN still re-arms, because that is the day-change
reset and the request it would guard no longer exists.

**The rows the operator is reading STAND while a wider window loads.** The clip
query keeps the previous window's rows, scoped: same camera, same provider, a
different window only (`sameClipScope`). A provider change must blank, or one
source's files paint under another source's name for a frame — the
two-derivations defect D569 exists to forbid. `clips-status.ts` now describes
what the hook does.

**A still the app has fetched outlives the tile that fetched it.**
`clip-still-memory.ts` holds minted stills across mounts, bounded by BOTH
entries (120) and bytes (8 MB) because a still is not a fixed size, LRU with a
recall counting as a use. A tile that finds one there is `ready` on its FIRST
render and asks nobody. Only `served` bytes are remembered — a deferral is not
an answer. And a request in the air is JOINED, not duplicated: a remount racing
its own unmount must not put a second ask into a 16-deep queue for bytes
already on their way.

## Consequences

- One flick now buys one day. Reaching the 30-day cap takes 29 separate drags,
  which is what the cap was always for; an operator who wants a week of history
  flicks a week of times. `lookback-walk.spec.ts`'s cap scenario was rewritten
  to say so rather than deleted.
- `LookbackWalkOutcome`'s `'pending'` is now `'spent'`, and it is also what an
  UN-ARMED surface answers. The log line at the call site distinguishes it from
  `'capped'` exactly as before; the three outcomes stay apart.
- The kept rows are the PREVIOUS window's until the wider read lands. A row
  deleted at the source is therefore on screen for that read's duration. That
  is the trade `clips-status.ts` already described and the alternative is the
  blank the whole clips-status line of work exists to remove.
- ~8 MB of JPEG held in the app for as long as the process lives. Deliberately
  not persisted: the expensive thing to avoid is the MINT, not the transfer,
  and the bytes are on the hub's disk once minted. If a page of stills grows a
  lot, `CLIP_STILL_MEMORY_MAX_BYTES` is what to re-measure.
- Module-level state outlives a test file's mounts. Every spec driving
  `useClipStill` must `forgetClipStills()` in `beforeEach` — two existing specs
  counted zero requests until they did, which is how this was found.
- **Server-side, and NOT fixed here: `prefetchThumbnails` is dead code.**
  `clip-service.ts` defines it, `PREFETCH_BATCH` bounds it to 20 rows,
  `PREFETCH_HEADROOM_FRACTION` keeps it from evicting, `ClipThumbQueue` gives
  it a whole second lane and a rule about sulking hosts — and nothing outside
  a test calls it. The entire D549-16 design exists and is not wired, which is
  why the disk cache holds 115 of 592's 357 rows instead of most of them and
  why a first paint meets a cold queue every time. Wiring it into
  `clip-refresh` (which already asks `hostBusy` and already yields) is the
  server-side half of this operator report and belongs to the provider.

## Enforcement

- `camstack/src/components/camera/theater/__tests__/clips-back-scroll.spec.ts`
  drives the REAL `nearOldestEnd` + latch through the reported gesture and
  asserts a COUNT: one flick, 61 scroll frames, **one** extension; an untouched
  surface, 60 clamp frames, **zero**. Confirmed red on revert — 29 and 29.
  A loop is the same right value for ever, so nothing here asserts a value.
- `camstack/src/data/__tests__/camera-clips-window.spec.ts` mounts the real
  hook over the REAL captured wire (592's 357 rows), widens the window with the
  answer held open, and asserts the rows stand and the body says `hidden`.
  Confirmed red on revert: 357 → 0. Its second case pins that a cold first
  window still says `loading`.
- `camstack/src/clips/__tests__/clip-still-memory.spec.ts` asserts over the
  sequence mount → serve → unmount → remount that the remount is `ready` on its
  first render with NO second request, that two tiles on one URL make one
  request, that a deferral is remembered as nothing, and that both bounds bite.
  Confirmed red on revert twice: `loading` instead of `ready`, and 2 requests
  instead of 1.
- Nothing mechanically forbids a future caller arming the walk from somewhere
  other than a gesture, or a second still cache appearing elsewhere. Review
  only.
