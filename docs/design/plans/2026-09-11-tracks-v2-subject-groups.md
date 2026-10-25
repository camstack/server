---
title: tracks-v2 — a track that can hold a GROUP
status: superata da `2026-09-12-groups-on-the-existing-summary.md`
covers:
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/**
---

> **2026-09-29 — superato da
> [D680](../../decisions/adr-0680-nearby-track-grouping-is-deleted-with-its-tables-and-its-cap-surface.md):**
> the session summary and the proximity grouping have been
> deleted. This plan will not be implemented.

# tracks-v2 — a track that can hold a group

**This is a plan, not a change.** Nothing here has been implemented. It exists
to be argued with.

> **SUPERSEDED on 2026-09-12** by
> `2026-09-12-groups-on-the-existing-summary.md`. The measurements in this
> document remain valid and are cited there — in particular the probe of §9
> (7 % overall, zero on six cameras out of eight) and the finding of §3, that
> the D359 summary is already the temporal envelope.
>
> What changed: `TrackGroup` **is not built**. 94.6 % of the summaries
> have a single member, so a third level would be 1:1:1 almost always; the
> existing summary is reused as the group, and the difference reduces to
> `role` + `className` on the member plus a table for the sub-crops. The open
> question of §4 is closed: the `groupId` does not exist, it was an idea.

## 1. What the operator asked for

> «un modo per raggruppare le tracce senza dover stravolgere troppo la
> struttura» [a way to group tracks without having to overhaul the structure
> too much] — remove the `groupId` we fill today (keeping it first as a probe
> of the current state), support several sub-crops inside one track (more than
> one face, more than one plate), support sibling and sub classes (a dog
> *with* a person), and the key frame belongs to the GROUP. Possibly a parallel
> `tracks-v2` we switch to when stable.

## 2. What the measurement says, before any design

Asked to look at a "messy 4-person track" on `parking` (102), I first
diagnosed identity swapping. **The 24 h measurement over persisted outdoor
tracks contradicted that**, and the numbers should steer this design:

| signal | result |
| --- | --- |
| mutual identity swaps | **1** in 658 comparable samples (0.2 %) |
| plausible continuations (a track split in two) | **7 of 483** (1 %) |
| **tracks living under one second** | **92 of 483 — 19 %** |

The four tracks in the reported scene were four REAL people walking in
parallel (x ≈ 3371 / 3298 / 3146 / 2983, all receding, boxes shrinking
together), entering frame a second apart. Nothing was split and nothing was
swapped. What is wrong is that four coherent subjects produce four independent
rows, four notifications' worth of material and four key frames, when a human
would say "four people walked across the car park".

**So grouping is not a repair for fragmentation.** It is a representation
change, and it must be sold as one. The fragmentation number worth chasing is
the 19 % of sub-second tracks, which is a different task (§8).

## 3. What already exists — and this is the part that changes the plan

Two grouping primitives are already in the tree, and a third is client-side:

1. **`Summary` (D359)** — `SummarySchema { id, deviceId, openedAt,
   lastActiveAt, sealedAt, memberCount, groupShotKey }`, with
   `getSummary` returning member track ids. A track birth *"opens the camera's
   summary or joins the open one"*. It is a **per-camera temporal session**,
   and it already has the group shot the operator asks for
   (`groupShotKey`, `ownerKind: 'summary'`, plus a running-argmax
   materialiser).
2. **The crowd guard / `fragment-relink`** — already reasons about "how
   crowded the scene was" and REFUSES to merge on overlap alone in a crowd,
   deliberately (`spawn-beside-coasting.ts`, `crowd-guard`).
3. **`dedupeFragmentItems` (viewer)** — collapses tracker fragments so a
   subject split across rows shows one card.

**The consequence for this plan: `tracks-v2` should NOT invent a second
envelope.** A summary is already "the things that happened on this camera in
this session". What it lacks is the ability to say *which members are one
subject-group and which are separate*, and to carry per-member sub-crops.

## 4. The open question to settle FIRST (tomorrow, before any code)

The brief says "rimuovere il `groupId` che attualmente riempiamo" [remove the `groupId` we currently fill]. **I could
not find a track-level `groupId`.** Searched: `packages/types/src` (only
`nodes.cap.ts` process groups and `notification-rules.groupIdleSec`),
`pipeline-analytics/**`, `addon-pipeline/**`, and the viewer. The candidates
for what was meant:

- `Summary.id` — the de-facto group id today;
- `notification-rules.groupIdleSec` — the per-rule notification grouping;
- `dedupeFragmentItems` — the client-side collapse;
- something in the plugin catalog-side component, outside this repo.

**Which one it is changes step 1 materially**, so it is the first question,
not an implementation detail. The "probe the current state" instruction is
cheap either way and is step 0 below.

## 5. Shape

A group is a **first-class row that references tracks**, never a mutation of
`Track`. `Track` keeps its meaning — one tracker identity — because every
existing consumer (zone rules, notifications, retrain export, the timeline)
reads it that way, and re-pointing them is the "stravolgimento" to avoid.

```
TrackGroup {
  id            string
  deviceId      number
  summaryId     string | null     // the session it belongs to (D359)
  openedAt      number
  lastActiveAt  number
  sealedAt      number | null

  members       TrackGroupMember[]
  keyFrameKey   string | null     // THE GROUP'S key frame (§7)

  // The taxonomy question (§6), resolved, not raw:
  primaryClass  string            // what the group IS ("person")
  classes       string[]          // every class present ("person","animal")
}

TrackGroupMember {
  trackId    string
  role       'primary' | 'sibling' | 'child'
  className  string
  // Sub-crops belong to the MEMBER, and there can be several of each kind:
  crops      SubCrop[]
}

SubCrop {
  kind       'face' | 'plate' | 'detail'
  mediaKey   string
  score      number
  atMs       number
  // For a face: which identity, when known. For a plate: the read.
  labelRef   string | null
}
```

Three things this buys, each mapped to the brief:

- **several sub-crops per track** — `crops` is a list on the MEMBER, not one
  `faceCrop` field on the track. Two faces in one track stop fighting for one
  slot, which is what they do today.
- **sibling and sub classes** — `role`. A dog walked by a person is one group:
  the person is `primary`, the dog is `sibling`. A face inside a person is
  `child`. The relation is on the EDGE, not baked into a class name — the
  alternative (a `person+animal` compound class) would multiply the taxonomy
  and break every class filter in the viewer and the rules.
- **the key frame is the group's** — `keyFrameKey`, chosen across members
  (§7).

## 6. What decides membership

Deliberately conservative, because §2 says the tracker is not misbehaving and
an aggressive rule would create the very merging the crowd guard exists to
prevent.

A candidate pair joins when ALL hold, over a window:
1. same camera, same summary (so the temporal envelope is already agreed);
2. co-motion — their trajectories stay within a bounded relative distance AND
   their velocity directions agree within a tolerance;
3. co-existence — they overlap in time for a minimum fraction of the shorter
   track's life;
4. and the pair is NOT already separated by the crowd guard's own verdict.

The four parking people would pass 1–3. **That is the point of contention for
tomorrow**: four people walking abreast ARE a group in the everyday sense the
operator used, but the count is information and the group must not destroy it —
hence `memberCount` stays, and per-member rows stay.

Rule 2 is the one that needs a threshold, and thresholds belong to whoever
generates the event, per-device — never a classifier default
([[soglie-appartengono-a-chi-genera]]).

## 7. The group's key frame

`compareBestFrame` (D400) already ranks a best shot for ONE subject: square →
semantic → edge → effective score → canvas-fill → centeredness. The group shot
is a different question — a frame where the MOST members are simultaneously
visible and unclipped — and D359's `group-shot.ts` already keeps a running
argmax for exactly this.

So: **reuse `group-shot`, do not write a second ranker.** The work is wiring
`TrackGroup.keyFrameKey` to it and deciding the tie-break when two frames show
the same number of members (proposal: fall back to `compareBestFrame` on the
primary member).

## 8. Not in scope, and why

- **The 19 % of sub-second tracks.** Grouping does not fix them; they do not
  continue into anything. **Measured since this plan was written**: the other
  half of that population is now known — of 414 sampled track deaths, 43 % are
  spawns that died under `minHits` and never emitted, and among them
  `framesSinceLastSeen` is ZERO in not one case (median 72). Frames kept
  arriving; the subject simply stopped being DETECTED. So this is detector
  behaviour, not tracker association — and neither grouping nor an appearance
  term would touch it. It is the bigger prize and it belongs to a different
  piece of work.
- **Appearance / ReID.** The tracker is geometry-only (0 occurrences of
  embedding/ReID/histogram in 2 924 lines). An appearance term would address
  swapping — which §2 says is 0.2 %. Not worth it on this evidence.

## 9. Sequencing

0. **Probe — DONE, 2026-09-11.** Run over 24 h of persisted outdoor positions
   with §6's rule (same camera, ≥50 % temporal overlap, ≤600 px relative
   distance and ≤60° direction agreement on ≥60 % of aligned samples):

   | camera | tracks | pairs | would group | % |
   | --- | --- | --- | --- | --- |
   | front door | 132 | 10 | 19 | **14 %** |
   | parking | 137 | 9 | 12 | **9 %** |
   | porch | 86 | 0 | 0 | 0 % |
   | cortile | 34 | 0 | 0 | 0 % |
   | esterno garage | 28 | 0 | 0 | 0 % |
   | capanno | 14 | 0 | 0 | 0 % |
   | **total** | **443** | **19** | **31** | **7 %** |

   **Read it honestly.** Seven per cent overall, and ZERO on six of eight
   cameras — the effect is entirely `front door` and `parking`, the two places
   where people arrive together. That is above the 3 % this step nominated as
   "not worth the table" and well below anything that would justify rebuilding
   the track path.

   It also means the design's value is NOT volume. It is that the 14 % on
   `front door` is precisely the case the operator complained about — a family
   arriving becomes four notifications — so the win is per-EVENT quality on
   two cameras, not a fleet-wide reduction. Tomorrow's decision should be made
   on that framing, and the thresholds in §6 are the lever: they were picked to
   be conservative, and a looser `MAX_DIST` would raise the 7 % while merging
   people who merely passed each other.
1. **Types + store, parallel** (`tracks-v2`). New rows, new store, nothing
   reads them. The existing `Track` path is untouched and un-risked.
2. **Populate, shadow.** The grouper runs and writes, and a log line reports
   what it would have grouped. Compare against §0's projection.
3. **One reader.** The viewer timeline behind a flag — the cheapest place to
   see whether a group reads better than N cards.
4. **Switch** only after the shadow numbers hold for a week, and remove the
   old field §4 identifies.

Steps 1–2 are the ones that can start without further decisions. **Step 0 is
the one that can start tonight**, and it needs no code review.
