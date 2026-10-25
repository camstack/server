---
id: D206
title: A position that keeps delivering itself with no real pick-up is background
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-background.ts
---

## Context

D205's gates are per-sighting decisions with no memory. An FP that happens to
be parcel-SIZED and happens to co-occur with a passer-by clears both gates —
every night, forever. Device 101's light wedge demonstrated the shape:
delivered→vanished cycles at ONE bbox (IoU ≈ 0.98 across hours), ~23 a night,
with never a human collecting anything. What identifies such an object is the
RECURRENCE, and recurrence needs state that survives the candidate and the
process — the same lesson D204 already paid for with the phantom cells: the
evidence and the decision must be alive at the same time.

The thing that must NOT be built (D62): a parallel store some other switch or
path also writes. This memory has exactly one writer and one reader.

## Decision

`PackageBackgroundRegistry` (style and durability mirror `phantom-cells.ts`,
D204): a GHOST CYCLE — a delivered package whose box then vanished with
nobody around — increments a durable per-`(device, class, 32px-cell)` counter
keyed on the candidate bbox centroid. Three ghost cycles inside 7 days make
the cell BACKGROUND: promotions there are suppressed, with a log line naming
the cell and the count. Two ways a cell forgets: cycles age out of the 7-day
window, and — the point — one REAL, witnessed pick-up at the cell deletes it
outright: somebody collecting from a spot proves it is a genuine delivery
spot, whatever the memory says.

The window is 7 days where the phantom cells use 24 h, deliberately: a light
artefact fires only under the conditions that create it (night, lamp on), so
its cycles can arrive at 1–2 per dusk and would never reach 3 inside 24 h.

Reads are RAM-only on the promotion path (D49); writes are write-behind — a
lost write costs one under-counted cycle, which is the direction this must
fail in. The registry is the single authority for "this position is package
background"; nothing else stores or mirrors that fact.

## Consequences

- A genuine delivery spot that suffered 3 detector-flicker cycles in a week
  goes quiet until a real pick-up happens there — the first collected parcel
  un-suppresses it. The suppression and the un-suppression both log.
- One more durable collection (`pipeline-analytics:package-background`),
  capped at 128 cells per device, LRU-evicted.
- `wipeAllAnalytics` / camera removal clear the device's cells; a wrapper-off
  or unregister deliberately does not (the scene is still there).

## Enforcement

`package-background.spec.ts`: inert below 3 cycles (with a control), bbox
jitter lands in one cell, cycles age out, a real pick-up clears, restart
survival over a column-enforcing store fake. Verified red with the verdict
neutered. Runs in CI.
