---
id: D430
title: A track is born with the zones it crossed before it existed
status: accepted
date: 2026-09-10
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/__tests__/a-track-keeps-the-zones-it-crossed-before-it-was-a-track.spec.ts
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts
last-verified: 2026-10-02
---

## Context

2026-09-10 05:55, camera 101. Another system announced an animal in the
"Aiuola" zone at **05:55:45.164** and the operator's phone stayed silent on
ours. The operator, watching the recording, said the cat had crossed the zone
*before* the track began.

He was right, and the logs say so to the second. Ours had already seen it: the
full-frame pass missed it and the native crop pass recovered it three times
running.

```
05:55:45  small-subject recovery → animal 0.586
05:55:46  small-subject recovery → animal 0.620
05:55:47  small-subject recovery → animal 0.829   ← track cf8adbcd born
05:55:47  occupancy changed → Uscio: 1, Aiuola: 0
```

**The subject was not missed, it was withheld.** A birth needs `minHits`
measurements; on a subject the full frame keeps missing — one the crop pass
recovers about once a second — those three measurements cost **two seconds**.
By the time the track existed the cat was on the doorstep, so its
`zonesVisited` read `["Uscio"]` and the rule was rejected on exactly that:
`rejectedBy=["Animale su Aiuola:zones", "Persona su Uscio:classes"]`. Both
conditions were right about the data they were given. The data was wrong.

This is the same silence [D419](adr-0419-a-refusal-swept-before-the-ask-is-still-a-refusal.md)
named in July — *the 3-measurement confirmation presumes continuity; on a
subject detected intermittently it is not a defence against phantoms, it is a
guarantee of silence* — and it is the defect that
[D426](adr-0426-a-refused-detection-is-observed-never-alerted-on.md) tried to
solve from the wrong end, by emitting refused detections as events. That
produced two phantom alerts, a 19-events/second storm, and 589 failed inserts,
and it would never have reached this cat: the cat was never refused.

## Decision

**The confirmation gate decides WHEN a subject becomes a track. It does not
decide where the subject has been.**

On the frame a track first becomes visible, the zones of its own
pre-confirmation measurements are folded into its zone set. The tracker already
carries the boxes (`InternalTrack.path`, emitted on every tracked detection as
`path`), so this is a history that was being discarded, not one that has to be
built. The fold runs once per track, the birth frame's own box is excluded
because it is already in the set, and a subject that never left the zone it was
born in gains nothing.

The result is a **real track, with real media, in the zone the subject was
actually in** — the opposite of D426's track-less phantom.

Two things are reported that were not:

- `track born carrying zones it crossed before it was a track`, with how many
  measurements preceded the birth and which zones were inherited.
- The small-subject recovery line now carries the **boxes**, not only the
  classes and scores. Zones cannot be resolved in the runner's process, but the
  box is what a zone is tested against — and its absence is why this
  investigation had to be settled from the operator's video rather than from
  the logs.

## Consequences

- A zone-scoped rule now sees a passage the confirmation gate delayed past it.
- The birth is still late. This changes what the track KNOWS, not when it is
  born; a subject that leaves the frame entirely before `minHits` still
  produces nothing. Lowering the bar for a crop-pass-recovered subject is a
  separate question, and it needs its own evidence.
- `path` is capped at `MAX_PATH_LENGTH`, far above a birth's few hits, so the
  fold sees the whole pre-confirmation trail in practice.
