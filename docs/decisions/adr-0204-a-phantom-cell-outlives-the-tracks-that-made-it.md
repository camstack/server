---
id: D204
title: A phantom cell outlives the tracks that made it, and one moving subject revokes it
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/phantom-cells.ts
---

## Context

There is a class of false positive the stationary registry structurally cannot
see. Promotion into the registry needs a track that has EXISTED for
`promotionWindowMs` — 30 seconds — and these die long before it: the dead
ornamental grass on device 101 produced tracks of 3.8 s, 4.1 s, 6.5 s and
19.0 s, with 0–2.5 px of total displacement, roughly fifteen a day, all at the
same spot.

Each of those tracks is individually innocent. Nothing about a single 4-second
motionless "person" is wrong enough to suppress. **The recurrence is the
signal** — and nothing survived a track's death to notice it. That is the whole
defect: the evidence and the decision were never alive at the same time.

The obvious fix is wrong and has to be named so it stays refused: **lowering
`promotionWindowMs` is not the answer.** Those 30 seconds exist so that somebody
standing still at a door is not declared scenery, and buying a cheap win on
plants by paying for it with people is the trade this system exists to refuse.

A first pass (`noteShortMotionlessTrack`) shipped the MEASUREMENT half
deliberately: an in-RAM counter per `(device, class, cell)` that logged
`repeatsInWindow` and suppressed absolutely nothing, so that "N closes in what
window" would come from data rather than intuition. It has been read. Over 24
hours the fleet showed **32 cells with ≥3 short-motionless closes, the worst at
31**.

## Decision

A **phantom cell** — a coarse quantisation of a track's BIRTH point, per
`(device, class)` — is remembered durably, outliving every track that
contributed to it, and repeated short-motionless closes in one cell **raise the
confirmation gate's `minConfidence` for a birth born inside it**. Nothing else.

Three properties are load-bearing:

1. **It raises a bar; it never closes a cell.** The ceiling is 0.9, explicitly
   below 1.0. A real subject re-detects strongly in a native crop — the person
   score floor alone is 0.65 — while a dead shrub read as a person does not. A
   cell that could become impossible to be born in would be a scene the system
   had permanently blinded itself to.
2. **`person` is included** (operator decision). A person motionless for 30 s+
   is furniture until they move. Excluding the class would have exempted exactly
   the phantoms that cost the most: a coat on a chair read as a person is the
   single most expensive false positive this system produces.
3. **One moving subject revokes the cell, immediately.** A track born in a
   suspect cell that actually goes somewhere deletes it. This is what makes (2)
   safe to hold, and it is not optional: without it, a doorway a delivery driver
   pauses in every morning would stay suppressed on the strength of a plant that
   was removed a month ago.

The cell is a property of the SCENE, not of a track, so it is classified
`never-orphaned` and is bounded by its own mechanics — a 24-hour close window
(matching the window the measurement was reported over) and 512 cells per
device, both enforced on write. It gets no age sweep: that would be a second
retention clock, which D61 collapsed ten of.

## Consequences

- The confirmation gate gains a per-candidate bar
  (`ConfirmationGateDeps.minConfidenceFor`) and every decision carries the bar
  it actually faced (`appliedMinConfidence`). Without that field, "was 0.62 a
  pass?" stopped being answerable from the config — which is the shape of every
  diagnostic hole this repo has paid for.
- The hook can only ever RAISE the bar. `phantomSpawnBar` is monotonic in its
  base and the gate clamps at the point of use as well. A hook that could lower
  it would be a way to smuggle a birth past a gate the operator switched on.
- The bar is read SYNCHRONOUSLY from the in-RAM mirror (D49). A birth decision
  is never gated on a fallible read, and a registry that failed to construct
  returns the configured bar — the mechanism disappears rather than failing
  closed.
- Both arming and clearing are logged at `info` with `tags: { deviceId }`. A
  suppression that lifts silently is exactly as hard to explain as one that
  starts silently.
- Expected effect on the measured fleet: the 32 armed cells cover ~7% of daily
  track births. Those births are not deleted, they are *measured harder*.

## Enforcement

`phantom-cells.spec.ts` pins the constants against the measured distribution
(inert below 3 closes, one step per close above it, saturating exactly at the
worst measured cell's count) and every state property: the cell survives a
restart, a failed load never clears the mirror (D130), the arming is per-cell
AND per-class (D12), and the movement clear works. Each negative is proved
against a control that must hold.

`confirmation-gate.spec.ts` pins the seam: a 0.55 that confirms at the ordinary
bar is suppressed at a raised one, a 0.93 still gets through, and the hook
cannot lower the configured bar.

The collection's `@durable` annotation and its `ANALYTICS_COLLECTIONS` entry are
both enforced by guards (`check-durable-state-declared.ts`,
`check-age-keyed-retention.ts`) — a new store cannot ship without someone
deciding, in writing, what happens to its rows.
