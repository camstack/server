---
id: D283
title: A re-attached track id does not carry evidence nobody re-confirmed
status: accepted
date: 2026-08-29
supersedes:
---

> **Superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** There is no re-attachment: a provisional id never silently
> carries evidence captured under another id. A piece only gains another
> piece's evidence through L2's deferred, evidence-gated fusion, which is
> final and reported (`tracker: a fused track now carries two identities`),
> never silent.

## Context

Bedroom camera 108, 2026-08-25, 07:27–07:34. A father and two boys — three
people — produced **13 distinct `person` trackIds and ~20 lost/resumed
transitions in 6.5 minutes**.

Track `0b6a4656` was born (resurrected) on the older boy at 07:31:56 at centre
645,681 — his seat, verified against the keyFrame. It ended on the *toddler* at
07:33:30 at 993,363, at the headboard, visible in the 07:32:09 and 07:32:31
keyFrames. It shipped the **older boy's** faceCrop, captured 07:31:48 — eight
seconds BEFORE the track's own `firstSeen`, under the id's previous incarnation.
The log reads `track lost 07:31:53` → `track resumed, resurrected: true
07:31:56`.

Two hypotheses were killed first and must not be re-opened without new evidence.
`MAX_TILE_SUBJECTS_PER_FRAME = 4`: containment is strict, a contained rect yields
pixel-identical output and a non-contained one is a *miss*, never a wrong-person
cut. The gallery: no model-space mismatch in 24 h, and `assignUniquePerFrame`
already forbids two faces in one frame mapping to one identity.

The per-frame face→person binding is **not wrong**. What is wrong is the
track→subject binding underneath it:

- `sort-tracker.ts:1011` step 4a re-attaches a graveyarded id to any same-group
  detection that clears `rescueIouThreshold` (0.1) — the *rescue* pass's loosest
  number — even though a corpse has already burned its entire coast budget and
  been declared dead. A LIVE, present track needs `iouThreshold` (0.3) to claim
  the same detection. The dead were being trusted more than the living.
- The held best face (`face-recognizer.ts:808`) is per-trackId, monotonic on
  score, and was never invalidated on re-attach. Embeddings are deliberately
  inherited onto the person track on face-less frames
  (`face-recognizer.ts:601`), so the face simply rode the id across the hop.

The resurrection pass's stated rationale — "a flickering stationary object keeps
its identity" — is sound, and it is about a scene with **one** subject in it. It
was never scoped to one.

## Decision

Two rules, at the two seams.

**The tracker.** A graveyard re-attach must clear
`resurrectionCrowdedIouThreshold` (0.3, deliberately the same number as
`iouThreshold`) whenever another same-association-group subject shares the scene.
"Shares the scene" means: any same-group track LIVE on the frame, or any other
resurrectable corpse whose **lifetime overlapped** the candidate's. The overlap
clause is load-bearing — a lone flickering subject leaves a trail of corpses
behind it, and counting those would make the subject look like a crowd to itself
and re-fragment the exact case the pass exists to serve. Two fragments of one
subject never coexist; two people do. A lone subject keeps the old loose gate
unchanged. Every re-attach reports the scene it happened in
(`TrackerEmission.resurrectionScene`), whether or not the guard is armed.

**The face.** A held best face on an id re-attached in a `multi-subject` scene is
**quarantined, not dropped**: crop and embedding are kept, `recognizedIdentityId`
and the peak match/suggestion scores are stripped, and the face is not promotable
to the gallery. It is released only by a FRESH face on the same id — one carrying
`faceBbox`, i.e. a face detail that actually fired on that frame — scoring at or
above `similarityThreshold` against the held vector. Below it, the held face is
discarded and that frame's face becomes the new baseline. If no fresh face ever
arrives, the face **is dropped at close and the drop is logged**.

## Consequences

- **The no-fresh-face case is the common one, and it resolves to "drop".** A
  re-attach usually happens on a face-less frame — the face is generally *why*
  the track was lost — and the subject may never show one again. Dropping costs
  one crop of a subject the camera will see again. Keeping writes a face row and
  a track preview asserting a person was somewhere they were not, and once
  enrolled, a gallery sample that mislabels every future probe of *both* people.
  The costs are not comparable, and "unknown" is the truth about a track nobody
  re-identified.
- Quarantine rather than immediate drop is what keeps this from being a
  regression. A genuinely flickering subject in a crowded room that shows its
  face again gets its best face back, unchanged, with one cosine.
- `similarityThreshold` is reused rather than a second continuity knob being
  added. One band, one number (D222). It inherits that threshold's known
  weakness — most crops reaching ArcFace are still misaligned, and a degenerate
  crop scores high against everything — which makes re-verification *lenient*,
  i.e. biased toward keeping. The gate that actually protects the gallery here is
  the close-time refusal, which needs no threshold at all.
- The 0.3 floor refuses the `centroid` and `growth` clauses in a crowded scene by
  construction: both are reached only once the overlap is already under 0.1.
  `rescue-growth.ts` itself is untouched — a prior investigation established that
  the growth gate cannot catch this class, because the jump here is *smaller*
  than what that gate exists for.
- The rescue pass (step 2.5, a still-LIVE coasting track) is untouched. It rests
  on stronger evidence than a corpse and is not implicated.
- A re-attach the guard refuses is reported at the `resurrection-refused` stage
  of the existing sampled bind log, with the IoU it fell short on. A corpse that
  merely loses to a better corpse is ordinary competition and is not reported.
- **Deliberately NOT done.** An identity label already written to the track store
  before a hop is not reverted; only forward-looking evidence is quarantined.
  Reverting a persisted label is a store-level operation with a much wider blast
  radius, and the compounding harm — gallery poisoning — flows through the held
  face, which this does stop.
- `TrackerEmission` is declared in `sort-tracker.ts`, not as a widening of
  `TrackedDetection` in `@camstack/types`. Producer and consumers are all inside
  `addon-post-analysis`, so **no framework publish train is required** — one
  `camstack deploy packages/addon-post-analysis` carries the whole change.

## Enforcement

Tests, in
`packages/addon-post-analysis/src/pipeline-analytics/__tests__/resurrection-subject-hop.spec.ts` <!-- drift-ok: the old tracker's own enforcement, deleted with it (D683 Task 21) -->,
replaying the 618 geometry. Two equal 220×520 boxes offset by 163 px overlap at
IoU 0.149 — above `rescueIouThreshold`, below `iouThreshold` — which is the exact
band the defect lived in:

- the 0.149 re-attach is REFUSED with two other people on screen, the detection
  still gets a track (a new id), and the refusal is reported;
- a crowded re-attach on REAL overlap (0.69) still succeeds, and reports
  `multi-subject`;
- **the identical 0.149 geometry KEEPS its id when nobody else is on screen** —
  the protected direction, and the only difference between it and the first case
  is who else is in the room;
- a subject's own graveyard debris does not read as a crowd;
- a held face is persisted across a `sole-subject` re-attach (asserted positively
  before any absence is asserted);
- it is dropped after a `multi-subject` re-attach with no fresh face, and the
  drop is logged with `tags: { deviceId, trackId }`;
- it is restored by a fresh agreeing face, and replaced by a fresh disagreeing
  one (the row that lands carries the NEW subject's vector);
- an INHERITED embedding — same vector, no `faceBbox` — cannot confirm the face
  it descends from.

Each was disarmed and confirmed RED before being restored: the crowd guard off
(1 red), the corpse lifetime-overlap clause removed (1 red), the close-time
refusal removed (2 red), the `faceBbox` freshness guard removed (1 red), the
cosine verdict forced to `confirmed` (1 red), and the quarantine widened to every
re-attach (1 red — the protected direction). No guard script: these are
predicates, not shapes.
