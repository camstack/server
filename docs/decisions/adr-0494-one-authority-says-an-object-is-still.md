---
id: D494
title: ONE authority says an object is still, and every class earns a registry entry the same way
status: proposed
date: 2026-09-14
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence-ledger.ts
  - packages/addon-post-analysis/src/pipeline-analytics/stationary-settings.ts
---

## Context

Two things decided whether an object was standing still, and they could
disagree.

1. The **tracker** already computes it, once per observation, for every track:
   `StateAnalyzer` produces a `TrackState` (`new | entered | moving | idle |
   left`) and the overlay draws it. That is the state the operator sees.
2. The **evidence ledger** decided it again, from geometry alone —
   `overlap >= policy.agreeIou` against the candidate's anchor box. A person who
   merely paused inside a parked car's anchor agreed with it; a track the
   tracker called `moving` fed the candidate exactly like one it called `idle`.

The operator put it plainly: *"Perché abbiamo due percorsi??? … L'autorità di
stazionario DEVE essere una sola."* [Why do we have two paths??? … The authority on stationary MUST be only one.] Two sources for one fact is the defect,
independently of which number either of them produces.

On top of that sat a per-camera switch, `promotePersons`, off by default
(D264). An opt-in nobody turns on produces nothing — it produced nothing — and
it was the third place the question "is this thing stationary?" got answered.

## Decision

An observation AGREES with a candidate only when **both** hold: it overlaps the
anchor at `agreeIou`, **and** the tracker did not call that track `moving` or
`left`. `observationAgrees()` is the only place that conjunction is written, and
the ledger has no geometry test of its own. The tracker's `TrackState` is the
single authority; the ledger consumes it and never recomputes it.

Every class is promotable. There is no class gate, no `promotesByDefault`, no
`classEnabled` argument, no `promotePersons` setting, and no
`'class-not-promoted'` shortfall. What still separates a person from a car is
`PERSON_EVIDENCE_POLICY` — measured thresholds (N ≥ 40, N/M ≥ 0.95, span ≥
30 min), not a switch.

## Consequences

- A person standing still for half an hour now earns a registry entry. The
  measured cost is 10 promotions per 24 h across four cameras, and roughly the
  half of the old candidate population that was a statue, a poster or an IR
  artifact — which is what the registry is for. The false positives that
  remain are indistinguishable from furniture to any criterion, including the
  one that shipped off.
- The pause case is now cheap to state: a person who stops inside an anchor
  contributes to M and not to N, so they DILUTE the candidate instead of
  confirming it. Before, that was one of the strongest ways to promote wrongly.
- Every producer of a `StationaryObservation` must carry `movementState` from
  the track. A producer that omits it degrades to the old geometry-only rule
  for its own observations — silently. That is the one way this decision can
  rot, and it is why the field is on the observation type rather than looked up.
- `promotePersons` is gone from the settings schema. A stored blob that still
  carries it resolves as if it were absent; nothing reads it.

## Enforcement

`stationary-single-authority.spec.ts` pins `observationAgrees` directly: a
`moving` or `left` track never agrees however perfect the overlap.
`stationary-evidence.spec.ts` pins the class behaviour from both ends — ten
minutes of perfect person evidence does NOT promote (the thresholds still
differ) and forty minutes DOES (no switch is involved). Nothing guards the
`movementState` plumbing at the producers; that is review only.
