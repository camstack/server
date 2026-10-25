---
id: D680
title: Tracks are not grouped by proximity — the session summary is deleted with its tables, its media and its cap surface
status: accepted
date: 2026-09-29
supersedes:
  - D359
  - D489
  - D490
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-audit.ts
  - packages/types/src/media/media-owner-key.ts
---

## Context

The session SUMMARY (`pipeline-analytics/summary/`) was the entity above the <!-- drift-ok: naming the deleted directory IS the record -->
track: a group of subjects that "arrived together" on one camera. D359 made it a
durable row created open and sealed in place; D489 made membership a PROXIMITY
decision taken at birth (`summaryTogetherFraction`, 0.15 of the frame
diagonal); D490 split a group whose members walked apart. It carried a group
shot (a 4096-px native full frame fetched by handle, gated by D470), three cap
methods (`listSummaries`, `listRecentSummaries`, `getSummary`), a cascade leg,
an age-sweep root, an orphan-audit probe, a media owner kind (`summary`) and a
second reading of the notification digest (`rule.subject: 'groups'`).

It never did what the operator wanted. Subjects that merely passed each other
were read as walking together; 94.6 % of summaries had exactly one member
(14 132 of 14 940, measured 2026-09-12), so the entity was a 1:1 copy of the
track almost everywhere and wrong where it was not. On 2026-09-16 the
production path was closed at its one door (`SUMMARY_GROUPS_ENABLED = false`)
and the viewer's group surfaces were hidden. What stayed was the D330 state:
a switched-off feature that every reader of the cascade, the retention roots,
the orphan audit, the media owner kinds, the digest producer and the pipeline
frame path still had to serve — including a per-frame `offerGroupShot` that
could only ever find no open group.

## Decision

**Tracks are not grouped by proximity. The session summary is deleted, whole,
in one change** (operator decision 2026-09-29; D330's rule applied):

- the sealer, store, join/split, group shot and settings are gone, and so is
  every leftover whose only consumer they were (`getNativeKeyFrameRgb` on the
  native-frame transport, `encodeKeyFrameVariants`, the semantic-promotion
  `origin`, `TrackStore.trackIdsMatching`);
- `listSummaries` / `listRecentSummaries` / `getSummary` and their schemas are
  off the `pipeline-analytics` cap, and therefore off the generated routers,
  the SDK surface and the ui-library hooks;
- the digest reads subjects only: `subject` is off the summary-rule schema, and
  a stored rule carrying `subject: 'groups'` parses with the key dropped;
- `pipeline-analytics:summaries` and `:summary-members` are in
  `RETIRED_COLLECTIONS` and are dropped at boot (D183);
- `summary` is off `OWNER_KINDS` and `MEDIA_OWNER_TYPES` and is in
  `RETIRED_OWNER_KINDS`, so the group-shot media rows resolve to
  `retired-owner` and the orphan audit reclaims them under its usual grace
  window and ceilings — the same path the D330 group entity's media took.

The notification center's BURST merge (`groupIdleSec`, `NcGroupBuffer`,
`notification-center:track-groups`, D143) is a different mechanism — one
notification per burst of one rule's matches, by time, not by position — and is
NOT part of this decision.

## Consequences

- The drop is not role-gated and destroys rows: the first boot after the
  upgrade logs `dropped a retired collection — it still held rows` at `warn`
  for each table, with the count. That is the expected line, once.
- The live hub held ~27 000 `summary:`-owned media rows on 2026-09-12. They are
  reclaimed by the orphan audit, bounded per pass, not in one sweep; until then
  they occupy disk and resolve to nothing.
- A per-camera `summaryTogetherFraction` stored before the slider was withdrawn
  (2026-09-16) stays in that camera's `pipeline-analytics` device blob, read by
  nothing. No purge was written: the key never governed anything after
  2026-09-16 and no surface shows it, unlike the D222/D662 values whose purge
  announces a behaviour change.
- A viewer that still calls the three methods gets a tRPC NOT_FOUND. The viewer
  must drop its summary surfaces before (or together with) a server carrying
  this change reaches the hub.
- A new grouping of tracks is a new design and a new record — read
  `docs/design/track-grouping-analysis.md` and this record first.

## Enforcement

`scripts/check-retired-collections-are-dead.ts` refuses the retirement while <!-- drift-ok: deleted 2026-10-22 (D901) -->
anything still declares either table; `scripts/check-orphan-reclaimers.ts` and
`scripts/check-method-tiers.ts` refuse a dead reclaimer or a silently removed
method; `orphan-audit.spec.ts` pins that a `summary`-owned row resolves to
`retired-owner` and is reclaimed; codegen drift (`npm run codegen:check`) keeps
the cap removal and the generated surfaces together.
