---
id: D490
title: A group that walks apart becomes two, and nothing may address a summary by its camera any more
status: superseded
superseded-by:
  - D680
date: 2026-09-13
supersedes:
applies-to:
---

## Context

D489 made membership a proximity decision taken ONCE, at birth. That answers
"who arrived together" and says nothing about what happens next: two people who
meet at the gate and then go separate ways stayed one group until the camera
fell quiet, and the summary then claimed they were together for the whole
session. The operator named this case alongside the concurrent ones.

Wiring it up found two places that still assumed one summary per camera, and
both were found by tests rather than by reading:

* **The id.** `summaryId(deviceId, openedAt)` made an open idempotent — a retry
  writes the same row — but two subjects detected in the SAME frame are born in
  the same millisecond, which is the ordinary case on a gate camera, not a
  race. They collided on the key and the second silently joined the first.
* **The seal key.** `seal` addressed a row by `(openDeviceId, openedAt)`.
  Sealing one of two groups that shared that pair sealed BOTH; the sibling then
  answered "already sealed" and sat in the RAM mirror for the life of the
  process. The same pair keyed the member-count write.

A third was found the same way: the sealer's RAM mirror — what the frame path
scores a group shot against — held ONE entry per camera, so every group but the
last to open got no picture at all.

## Decision

A summary is addressed by its own identity, never by its camera. The id is
`f(deviceId, openedAt, founding track)`, which keeps a retried open idempotent
and makes two births two groups; every write that targets one summary carries
its `id` in the filter, with `openDeviceId` alongside it so sealing stays a
conditional transition. The RAM mirror is keyed by summary id inside the camera.

A group **divides** when its placed members fall into two or more single-linkage
clusters — the same "any, not all" reach the birth rule uses — and stay divided
for {@link SPLIT_CONFIRM_MS} (10 s, two housekeeping sweeps). The primary's
cluster keeps the row; the others are moved into new open groups that open at
the moment their earliest member joined. A member the tracker cannot place is
not evidence of anything and never leaves; an unknown frame yields one cluster,
never a split.

The proximity threshold is now a per-camera setting (`summaryTogetherFraction`),
read synchronously from the cache the frame path warms, defaulting to the
measured constant.

## Consequences

- Splitting is deliberately LATE. The window costs nothing — a summary is not
  read until it seals — and taking a split on the first sweep that saw a gap
  would mint a group per pass out of two people passing each other.
- A split writes the new member rows before deleting the old ones. A failure
  between them leaves a member in two groups, which is visible and repairable;
  the other order loses the membership, which is the wrong this store exists to
  prevent.
- The group born from a split starts with no group shot and earns one from the
  next frames. The half that kept the row keeps its picture, which may show the
  members that left.
- `apartSince` is RAM only: after a restart a still-divided group waits the
  window again.
- A live database whose rows predate this carries the old id shape. Nothing
  parses a summary id, so the two shapes coexist; we are pre-release and no
  migration was written.

## Enforcement

`summary-split.spec.ts` pins the clustering and the keeper rule (both survive a
mutation check). `summary-split-sweep.spec.ts` pins that one sweep never splits,
that the window is honoured whole, and that a separation which heals disarms it.
`summary-split-store.spec.ts` pins that each side ends with exactly one primary
and that moving EVERY member is refused. `summary-mirror.spec.ts` pins that two
groups on one camera are both mirrored and that a seal drops only its own.
`summary-store.spec.ts` pins that two births in the same millisecond are two
rows — it fails against the old id.
