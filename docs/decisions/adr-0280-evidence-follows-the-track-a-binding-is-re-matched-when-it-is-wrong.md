---
id: D280
title: A track's evidence binding is re-matched when the bound candidate is wrong
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence-ledger.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence.ts
---

## Context

[D264](adr-0264-an-object-becomes-stationary-by-repetition-not-by-one-track-surviving.md)
promotes a parked object on a RATIO: N agreeing observations over M offered by
tracks bound to the candidate. The dilution is deliberate — a car that merely
drove through a spot binds for a few frames and then contributes dozens of
disagreeing ones — and it is why the binding map exists at all.

A track bound at its **first emitted frame and never re-matched**
(`stationary-evidence-ledger.ts:221`). A track's first emitted frame is by
construction its worst: the box is still settling, and on device 102 the ledger
was holding ~497 accumulated candidates for the camera, so there was always
something for a bad box to land on.

The arithmetic from the 2026-08-28 audit: a promotion carried
`agreed: 240 / seen: 240` — exactly one track's 239 observations plus the
candidate's own birth — while a second track's **267 observations of the same
spot** were absent from it entirely. Had they folded into the same row, the span
criterion would have been satisfied **3.3 minutes earlier**. The two tracks were
watching the same parked car; only one of them was allowed to say so.

The audit could not confirm this by asking. Nothing exposed which candidate a
track was bound to, so the mis-binding had to be reconstructed from the
arithmetic of a promotion that had already happened.

## Decision

A track re-binds when its bound candidate is demonstrably not about the box it
is reporting: the bound row's overlap with the observation has fallen to at most
`EVIDENCE_REBIND_MAX_BOUND_OVERLAP` (0.05) **and** another same-class candidate
matches at or above the policy's `agreeIou`. The observation is then folded into
the new row.

A re-bind moves the TRACK and nothing else. No tally is copied, credited twice
or transferred, so every observation is folded exactly once and the total M
across a device's candidates always equals the number of observations the device
offered.

`StationaryEvidenceLedger.bindingsFor` makes the binding readable, and
`debug.stationary` serves it (see Consequences).

## Consequences

- The threshold is deliberately far below `agreeIou` and is not the same
  question. `agreeIou` asks "is this box in this place?"; the re-bind floor asks
  "is this row about this box AT ALL?". A merely poor fit must keep diluting the
  row it bound to — that is the whole discriminator against a car driving
  through — so only an essentially zero overlap qualifies.
- The two bands cannot flap: to bounce back, the new row would have to fall
  under 0.05 while the old one reaches 0.5, which means the box genuinely
  travelled the distance between them.
- A track on a NOVEL spot does not re-bind, because no other candidate reaches
  `agreeIou`. It keeps diluting its row, exactly as before.
- Re-binding is logged at debug with `tags.deviceId`, the two rows' tallies and
  both overlaps. It is expected to be rare; if a camera produces it constantly,
  the anchors are wrong and that is a different defect.
- **A read-only diagnostic now exists**, `debug.stationary`, on the
  `addons.custom` surface of `pipeline-analytics` — the registry's entries and
  pending departure strikes, the evidence candidates with their ratio and span,
  and the live track→candidate bindings. A custom action rather than a cap
  method for the reason the rest of `debug.*` is one: no codegen, no publish
  train, one `camstack deploy`. It performs pure reads off two RAM mirrors, so
  it is safe to ask while a camera is flooding.

## Enforcement

Tests, in
`packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/__tests__/stationary-evidence.spec.ts`:

- a track bound to one spot and then reporting another re-binds, and the row it
  moves to receives the agreement;
- **the total M across the device's candidates equals the observations offered**
  — the double-counting assertion, stated positively;
- a merely poor fit (above the floor, below `agreeIou`) does NOT re-bind and
  keeps diluting its row;
- a novel spot with no matching candidate does NOT re-bind;
- the case it was written for: a second track born on a settling box completes
  the SPAN that the first track could never reach alone, and the candidate
  promotes. With the re-bind reverted, it promotes nothing.

Each was verified by reverting the implementing branch and confirming the
assertions fail. No guard script: this is a predicate, not a shape.
