---
id: D172
title: A track SAYS why it was closed, and a digest is made of passages
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-selection.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-rule.ts
---

## Context

D161 stopped stationary promotion from FORGETTING a track: `dropActive` (drop the
RAM entry, write nothing) became `closeActive` (persist the row, then drop),
because the row is the only thing retention cascades from and every parked object
was orphaning its whole media set — 18.9 GB on the live hub.

The fix was right and it had a second effect nobody planned for. The persisted
row is not only a retention anchor; it is what every window-shaped consumer
reads. From the night the fix shipped, the car parked in the car park at camera
102 entered every summary window it overlapped, and — with a high `importance`, a
dwell measured in hours, and the per-camera quota guaranteeing it a tile — it won
the tiles the digest exists for. The operator's nightly digest went from 1-2
tiles to 10, most of them the same stationary car. Verbatim: *"le ultime
summaries includono ancora tantissime track stazionarie"*.

The obvious fix is the wrong one. A digest producer can look at
`totalDistance`, or at the trajectory envelope, and decide for itself whether a
track "moved". That is a heuristic re-derived at the far end of the pipeline from
data that has already been slimmed (`projection: 'slim'` empties `positions[]`),
and it is wrong in both directions: a person standing still at a door for four
minutes is a passage, and a car that rolls two metres before parking is not.

The tracker ALREADY made this decision, correctly, at the moment it handed the
subject to the stationary registry. It simply threw the answer away.

The second choice was where the answer lives. `Track` is a Zod shape in
`packages/types`, which is `external` to the addon build and travels inside the
published `@camstack/server` closure: a field added there is not live until a
framework train is installed, and until it lands the cap schema *silently strips*
it. The summary rule schema is in the addon for exactly this reason (see
`summary-rule.ts`), and the marker belongs beside it.

## Decision

**When a track is closed EARLY, the row records WHY.** `TrackStore.closeActive`
takes a `TrackCloseReason` and writes it to the `closedReason` column; a track
that expires on its TTL leaves the field absent. The column, the type
(`PersistedTrack extends Track`) and both readers live in `addon-post-analysis`,
never in `packages/types` — the marker is live on the next `camstack deploy`, and
promoting it later is additive.

**A summary digest is made of PASSAGES.** `filterSummaryCandidates` drops
candidates marked `stationary` unless the rule sets
`filters.includeStationary: true`, and it does so even when the rule declares no
filters at all — "no filters" has never meant "put the car park in the digest".
An absent field reads as off, so no rule is migrated and none is rewritten.

**Nothing else filters on the marker.** The events page, grouping, retention and
every other reader keep seeing every track. A parked car is still an event; it is
simply not a passage, and only the digest cares about the difference.

## Consequences

- The drop is COUNTED and reported: `droppedStationary` rides the digest log
  line beside `droppedByClass`, is returned by `nc.testSummaryRule`, and the Test
  banner says "N parked objects left out". A digest that shrank from 10 tiles to
  2 has to be distinguishable from a quiet night, or the first operator response
  to this change is a bug report.
- The marker is written forward only. Rows persisted before this change carry no
  `closedReason` and read as passages — the fail-OPEN direction, deliberately:
  showing a parked car once more is recoverable, hiding a passage is not. Those
  rows leave the digest's windows within hours.
- Same for a hub-main whose `tracks` table never gained the column (the
  `ensureTable` fingerprint caveat that `hasFace` and `hasRider` already carry):
  the write is dropped, the read is absent, and the digest behaves as it did
  before this record.
- Every new close reason has to be added to `TRACK_CLOSE_REASONS`. An unknown
  value read from a row narrows to `undefined`, which again fails open.

## Enforcement

Tests, in three places, each written to go red when the mechanism is removed
(verified by neutralisation):

- `store/__tests__/track-store-closed-reason.spec.ts` — the reason is stamped and
  readable in both projections, absent on a TTL expiry, survives a later partial
  patch of the row, and does not hide the track from `queryHistorical` or from
  the retention selection.
- `summary/__tests__/summary-selection.spec.ts` — dropped by default, dropped
  when the rule carries OTHER filters, kept when `includeStationary` is set,
  and an absent marker is treated as a passage.
- `summary/__tests__/summary-producer.spec.ts` — the same window, the same mixed
  candidate list, only the toggle moving: 1 tile vs 4.

The UI half is held by the existing `NC_SUMMARY_TABS` guard, which fails when a
form field has no tab claiming it.
