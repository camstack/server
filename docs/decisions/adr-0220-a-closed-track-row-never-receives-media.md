---
id: D220
title: A CLOSED track row never receives media — the capture path asks the store whether the row is closed, and no answer means WRITE
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/closed-row-media-gate.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts
---

## Context

Track `b50e09f7` (dev102, 2026-08-21) was a PERSON track. Its row closed at
15:22; its `thumbnail`, `keyFrame` and `lastFrame` were overwritten at 15:26
with photos of a DOG. The operator saw a person event whose every preview was an
animal.

The mechanism: on a detection-per-session camera the tracker does not run
between sessions, so its in-memory track survived the gap with a **frozen bbox**
while the TTL sweep closed the row. The animal that walked back in matched that
frozen box, inherited the dead track's id, and the frame path wrote its media
onto the closed row. Scope, measured over 72 h: **21 of 7019 tracks received
best media up to 4.5 minutes after their last sighting.**

The association root was fixed first, in the tracker (pre-association purge past
the real bound, `sort-tracker.ts`, v1.2.105). That fix is necessary and not
sufficient: it makes the tracker stop HANDING BACK a phantom, but every capture
site still trusts whatever it is handed. The 4.4-minute write was possible
because nothing on the capture path ever asked whether the destination row was
still open.

The obvious alternative — refuse a capture whose track has not been seen for
N seconds — was rejected. It re-derives the tracker's coast bound in a second
place, with a second default, and the two would eventually disagree; and it
answers a question ("how old?") that is not the one that went wrong ("is this
row still open?").

Reading `TrackStore.active` was rejected for a sharper reason: it **cannot**
answer. A sighting for an already-closed id re-creates a fresh active entry
through `upsert` — which is exactly what the incident did — so at gate time the
phantom looked perfectly alive. (As of D683 review M3 below, `upsert` itself
refuses this re-creation — see the amendment at the end of this record. The
reasoning above is kept as the HISTORY that justified reading `rowClosedAt`
instead of `active` in the first place; it no longer describes what `upsert`
does today, and the capture-path gate this ADR decides stands on its own
regardless — a closed row must never receive media whether or not the store
can also answer the question some other way.)

## Decision

A row the track store has already CLOSED is never a media destination. The store
keeps a bounded in-RAM record of every close it PERFORMED (`rowClosedAt` — TTL
expiry, `closeActive`, cascade delete), and the per-frame media decision
(`buildSnapshotTargets`) skips any track that record names, which covers all
four kinds in one place: `thumbnail`, `lastFrame`, the appended `snapshot`, and
the native `keyFrame` seeded from the same targets.

The record is POSITIVE knowledge only, and its absence — unknown id, evicted
entry, a fresh process — means WRITE ([D49](adr-0049.md)): losing a live track's
media is worse than tolerating one late write, so the bound may only ever cost
an extra log line. The gate asks whether the row is closed, never how old the
track is; the age bound stays the tracker's, and `closedAgeMs` is reported for
the log line and gates nothing.

## Consequences

- Media written by the CLOSE path itself — last-frame promotion, the raster
  fallback, the keyFrame-derived thumbnail — is unaffected: none of it comes
  through `buildSnapshotTargets`. Enrichment writes that legitimately land after
  close (face/plate crops, embeddings) are likewise untouched; this rule is
  about the per-frame best-media ladder.
- A refusal is never silent. It logs `track media refused: row already closed`
  with `tags.deviceId` and the trackId, class, `closedAgeMs` and how many
  refusals the line stands for — sampled at one line per track per 60 s, because
  a phantom that keeps matching would otherwise produce ~10 lines a second.
- The closed-row memory is bounded (4096 ids, oldest evicted first). An eviction
  fails OPEN by construction.
- A track id that legitimately reappears after its row closed now gets no
  further media on that row. That is the intended outcome: the row is over, and
  a genuine new subject deserves a new row from the tracker.

## Enforcement

`__tests__/closed-row-best-media.spec.ts` boots the real addon, closes a row
under a live tracker and asserts the persisted media rows do not move — the
wiring, not the decision (removing the gate turns it red). The decision and its
sampling have their own unit spec, and `store/__tests__/track-store-closed-rows.spec.ts`
pins the store's memory. (Since D683 review M3, below, that spec instead pins
that a re-sighting of a closed id does NOT re-create an active entry at all —
`upsert` refuses it — which is a STRONGER guarantee than this ADR ever relied
on; see the amendment.)

**Note (2026-10-01, D683 Task 16 review S3).** The sentence above — that
removing the gate turns `closed-row-best-media` red — is no longer true, and
this note replaces it. D220's gate is now a SECOND layer behind D683's
frame-level closed-id filter (review R1): right after `processor.process()`
the frame path removes every id the store already closed from the frame's
result, so on an ordinary drop frame a closed id never reaches
`buildSnapshotTargets` at all, and disabling the gate there stays green. The
booted test that pins the FIRST layer is `closed-row-best-media.spec.ts`'s
"stays green with D220's OWN media gate disabled" case (the gate spied to
never refuse; removing the upstream filter turns it red). The D220 call site
still guards one window the filter cannot: a TTL close landing between the
filter and snapshot capture, across the awaits in between on the same frame
(an in-frame race). That window is **review-only** — no booted spec reaches
it; the gate's DECISION (and its sampling) stays pinned by
`pipeline/__tests__/closed-row-media-gate.spec.ts`, its call site is not.

## Amendment (2026-10-01, D683 review M3)

The scenario this ADR's "Decision" rationale assumed — `upsert` quietly
re-creating a fresh active entry for an already-closed id, so reading
`TrackStore.active` could never tell a phantom from a live track — is no
longer how the store behaves. D683 Task 16 (review M3) made `TrackStore.upsert`
check `rowClosedAt` itself: a sighting for a closed id is now REFUSED outright
(sampled WARN, review N1) and never reaches `active`, and the frame path
(review N2) is told to drop the chain so the real subject respawns under a
brand-new id on its next sighting, instead of the tracker going on handing back
the dead one forever.

This does not retire the gate this ADR decided. The two are independent layers
over the SAME underlying hazard — a row that closed, still receiving writes —
caught at different points (the store's own write path vs. the capture path's
pre-check). (This paragraph originally added that D220's own enforcement
test still goes red if the capture-path gate is removed; since review R1's
frame-level filter that is no longer so — see the dated note under
Enforcement.) What changed is narrower: the specific HISTORICAL justification above
("reading `active` cannot answer") no longer describes current behavior, and
the enforcement note above no longer claims the store-memory spec pins
re-creation surviving — it pins re-creation not happening at all.
