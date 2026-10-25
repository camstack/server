---
title: Summary — one event per camera session, one group shot (DELETED 2026-09-29)
status: historical
date: 2026-09-05
---

# Summary — one event per camera session, one group shot

> **Status: DELETED 2026-09-29
> ([D680](../decisions/adr-0680-nearby-track-grouping-is-deleted-with-its-tables-and-its-cap-surface.md)).
> Nothing described below is in the codebase.** The summary's production path
> was switched off on 2026-09-16 and the entity was removed with its tables,
> its group shot and its three cap methods. Kept as the record of what was
> built — read it before proposing a grouping of tracks again, not as a
> description of the system.

The successor of the `group` entity retired by D330, built on the invariants
of D359 (which came out of diagnosing why its predecessor wrote eleven
sealed rows in 1.7 s on 2026-08-24).

## What it is

A per-camera **session envelope** that REFERENCES tracks instead of
duplicating them. It opens when a track opens on a camera with no open
summary, absorbs every track that opens while it is open, and closes itself
when its last member closes (and the stationary registry's `ttl`/`departed`
says nothing is still standing) — no wall-clock cap: an open summary stays
readable, it just has no group keyframe yet.

Its **best shot** is the summary's own running argmax, independent of any
member's best shot, because the group's best moment coincides with no
member's. Scored on METADATA only (frames never cross a process boundary at
frame-rate, D9/D18); pixels are materialised solely when the maximum
improves. Ordering is lexicographic by operator decision: most members
visible and NOT OCCLUDED first — occlusion measured as the fraction of one's
OWN box covered by others, never IoU — then quality (confidence .30 /
capped area .25 / recognition AT THAT INSTANT .25 / placement .20).

## Phases

1. **Durable core** (this commit): `summary-store.ts` (collections
   `pipeline-analytics:summaries` + `:summary-members`, deterministic id,
   unique `openDeviceId`, seal in place, `insertMany`), `summary-sealer.ts`
   (single-flight sweep, open/absorb/seal driven by track open/close
   events, D49 gate discipline). Pure scoring in `summary-score.ts` with the
   lexicographic rule. Tests with a RECORDING store fake and a concurrent
   double sweep.
2. **Wiring**: track open/close hooks in `pipeline-analytics/index.ts`,
   boot recovery (seal what the row says is open and whose members are all
   closed), retention (age-keyed, declared per D-retention guard).
3. **Group shot** (built 2026-09-05, late night): `summary-score.ts` scores
   each processed frame on metadata (`scoreSummaryFrame`, lexicographic:
   visible-and-unoccluded members, then the quality blend);
   `group-shot.ts` keeps the running argmax per open summary in RAM and says
   when a frame beats the best so far; the pixels are then fetched as a
   NATIVE key frame by handle at the owning node (`group-shot-materialiser.ts`,
   the same path and tier rule as a track key frame, `ownerKind: 'summary'`)
   through the capture scheduler, coalesced per summary. The sealer mirrors
   each camera's open summary and its members for the frame path (`openFor`)
   and drops the argmax on seal. Two deliberate approximations, written down
   so nobody reads them as verification: the recognition term is "recognised
   SO FAR" (a gallery match lands on the detail plane after its frame; the
   frames that follow carry it), not "at that instant"; and the argmax is
   RAM-only, so a summary open across a restart is scored on the members that
   open after it — a weaker shot for one session, never a wrong one. Media
   lifetime: freed with the summary by the age sweep (`SummaryStore.onEvict`)
   and probed by the orphan audit (`liveSummaryIds`).
4. **Surface**: `pipelineAnalytics.listSummaries` / `getSummary` (cap change
   → codegen → framework release), viewer Events list showing one card per
   summary with its group shot, admin list.

D330 applies in full: if it is built, it ships ON.
