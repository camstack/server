---
id: D393
title: A measurement that failed is not a measurement of zero
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/placement-service.ts
  - packages/addon-pipeline/src/recorder/addon/placement-planner.ts
  - packages/addon-pipeline/src/recorder/addon/location-capacity.ts
---

## Context

`readLocationCapacity` was written to model its failure rather than swallow it.
Its own header says why: *"a bare `catch {}` here made a dead NAS and a
filesystem with no capacity notion produce byte-identical payloads and not one
log line."* So a `statfs` that throws comes back as `{ availableBytes: null,
totalBytes: null, error }` — nulls AND the reason.

The reason never arrived. `PlacementCapacity`, the placement service's own
narrower structural twin of that type, simply had no `error` field, so it was
erased at the type boundary before anything could decide to log it. And
`candidatesFor` then folded the nulls into `headroomBytes: 0`.

Zero is not "unknown" in that number's own vocabulary. `PlacementCandidate`
documents it as *"at its limit — it is a candidate, but it wins nothing"*, and
`recompute` builds its `evacuate` set from `headroomBytes <= 0`. So one
unreadable `statfs` — a NAS that stops responding, an ESTALE handle, a mount
that hiccups for one 30 s tick — moved every camera off a healthy disk at the
next attach boundary. Each move costs a writer restart and a recording gap, and
none of it produced a line anywhere.

The comment above the method claimed the opposite: *"nothing measurable → zero
headroom everywhere, which the planner reads as 'no signal' and splits evenly
rather than pretending to know."* That is true of the planner's WEIGHTS
(`weightsFor` does split evenly when every headroom is zero) and was never true
of the evacuation set, which is computed one layer up and had no such
all-or-nothing test. A leftover describing the right design, reading as
verification — the shape this repo has been bitten by three times.

Two alternatives were rejected. **Keep zero and special-case `evacuate`** — the
call site would then be correct and every other reader of `headroomBytes` would
still be told a disk is full when it is unmeasured; the conflation stays, it
just moves. **Fail the tick when any location is unmeasurable** — that is D49's
answer for a fallible read that gates a DESTRUCTIVE decision, but here only one
location is unknown and the rest of the fleet still needs planning; a
node-wide skip on one bad mount is a bigger outage than the bug.

## Decision

**A quantity that could not be measured is `null`, never `0`, and the type says
so.** A reader that folds an unreadable measurement into the value that means
"at the limit" is making a decision on a reading nobody took. Where the value
already travels with a reason (`LocationCapacity.error`), every intermediate
type on its way to a decision keeps that field, and the branch that acts on the
absence LOGS it — once per distinct fault where the read is on a tick, plus one
line when it recovers. A location whose capacity is unknown keeps what it holds,
attracts no new work, and is never evacuated.

## Consequences

- `PlacementCandidate.headroomBytes` is `number | null`, which forces every call
  site to face the distinction rather than inheriting it: `evacuate` takes only
  measured zeros, `weightsFor` gives a null location no weight, `withHeadroom`
  leaves `RecordingsLocation.headroomBytes` ABSENT (that type already documents
  absent as "not measured"), and `placementSnapshot` omits the location from the
  rebalance headroom map, where `planRebalance` already refuses a target it has
  no entry for.
- The cost of erring this way: a location that is genuinely full but whose
  `statfs` is also failing keeps its cameras for as long as the read fails. It
  is bounded by the per-location free-space guard the storage pressure manager
  enforces independently, and the log line names it every time the fault changes.
- This does NOT hold for a quantity whose zero is measured. A location that
  answers with less free space than its floor is at its limit and is evacuated,
  exactly as before.
- One instance elsewhere is knowingly unfixed and is the same shape:
  `packages/addon-post-analysis/src/pipeline-analytics/index.ts` builds media
  locations with `headroomBytes: l.capacity?.availableBytes ?? 0`, and
  `media-locations.ts` then picks the largest. An unmeasurable location there is
  merely deprioritised rather than evacuated, so it costs a worse pick and not a
  migration — but it is the same `?? 0`.

## Enforcement

Two tests in `packages/addon-pipeline/src/recorder/__tests__/placement-balancing.spec.ts`
— a location whose capacity read fails produces no `evacuate` change, and the
fault is logged once with the location id and the reason. Both were verified
failing against the fold-to-zero. No guard script: the pattern (`?? 0` on a
value that can be legitimately unknown) is too ordinary to grep for without a
flood of false positives, so beyond those tests this is review only.

Related: [D49](adr-0049.md) (a one-shot event never gates on a fallible read),
[D384](adr-0384-never-ran-must-never-look-like-ran.md) (an attempt stamp is not
a success stamp), and [D315](adr-0315-not-yet-known-never-looks-like-not-installed-and-a-presence-gate-asks-the-registry.md)
(not-yet-known must not look like not-installed) — the same mistake in a UI, a
timestamp and a measurement.
