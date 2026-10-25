---
id: D222
title: A suggestion floor is DERIVED from the match threshold, never stored beside it
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/face-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-rescore.ts
  - packages/addon-post-analysis/src/pipeline-analytics/settings-schema.ts
---

## Context

Face recognition had **two operator knobs describing one band**.
`similarityThreshold` was the cosine required to auto-assign an identity;
`suggestionMinCosine` was the cosine below which nothing was even offered. The
suggestion band was the half-open interval between them —
`[suggestionMinCosine, similarityThreshold)` — and nothing anywhere checked that
the interval was non-empty.

It went empty. The 2026-08-19 retune lowered `similarityThreshold` to `0.45`
(measured: genuine probes were scoring median 0.38 / p90 0.51, so the old bar
left almost nothing recognisable) and left `suggestionMinCosine` at its `0.50`
default. From that moment `[0.50, 0.45)` was empty and the recognizer could not
produce a single suggestion, for any camera, for any face. No error, no log
line, no test — the settings form went on rendering two plausible numbers side
by side, and the only symptom was an absence, which reads exactly like "nobody
walked past a camera". It was found on 2026-08-21, two days later, by reading
the two numbers next to each other by hand.

The first attempt at a fix was the obvious one and was wrong: set the stored
`suggestionMinCosine` to `0.33` so the band re-opened. That restores the feature
and leaves the defect completely intact — the next threshold retune inverts it
again, silently, and now there is a hand-typed number nobody remembers the
reason for.

This is the shape [D62](adr-0062.md) already named: **a second authority over a
fact that already had one.** The repo has shipped that defect three times
(`zoneMembershipMinOverlap`, `rescueCentroidFactor`, the four retention day
windows). The lesson each time was the same — police the second authority and it
drifts again; delete it and it cannot.

## Decision

**The suggestion band's floor is a pure function of the assignment threshold —
`SUGGESTION_BAND_FACTOR × similarityThreshold`, with `SUGGESTION_BAND_FACTOR =
0.8` — computed by `deriveSuggestionMinCosine` and stored nowhere.**

`suggestionMinCosine` is not a field of `FaceSettingsSchema`, does not appear in
the settings form, and has no per-device override. Every consumer (the live
recognizer's band, the `face.rescoreTrack` report) calls the derivation. What
the form shows in its place is a `readonlyField` readout — *"36% — 80% of the
45% match threshold"* — so the operator sees the consequence of the one knob
they set and has nothing to contradict it with.

`0.8` is the operator's number and matches what the band was for: a near-miss is
a probe that scored within a fifth of the bar. It also *tracks* — the
recalibration plan on `similarityThreshold` expects that value to fall toward
~0.30 once landmark-precision alignment lands, and a fixed floor would have to
be remembered and moved by hand at that moment, which is precisely the step that
was missed in 2026-08.

## Consequences

- **The band cannot invert, for any threshold.** `deriveSuggestionMinCosine` is
  total over `[0, 1]`: the floor is never above the threshold and is strictly
  below it for every threshold > 0. Rounding (to 4 decimals, because
  `0.8 × 0.45` is `0.36000000000000004`) is applied only where it preserves
  that.
- **An operator loses a knob.** Deliberate: a second knob that disagrees with
  the first is worse than no knob. The band's *width* is no longer tunable at
  all; if evidence ever demands a different ratio, the factor is one named
  constant with a rationale attached, changed once for the whole cluster — not a
  per-device store row.
- **A persisted value must not survive as a phantom authority.** Removing the
  field makes a stored value inert, which is necessary and not sufficient: it is
  still what the operator last typed, and still there for the next reader who
  greps the key. `purgeStoredSuggestionThreshold` runs on the retention pass —
  once for the global store, once per device — and WARNs with both numbers
  (`wasSetTo`, `nowInForce`) before unsetting the key. Absence of the key is the
  migration marker; the patch unsets with `undefined`, never `null`, because the
  settings merge preserves a `null` as a stored value.
- **`face.rescoreTrack` reports the rule, not only the result.** Its `params`
  carry `suggestionMinCosine` *and* `suggestionBandFactor`. A number that moves
  whenever another number moves reads as a bug unless the derivation is on
  screen beside it.

## Enforcement

Tests, at three levels — the guard here is behavioural because the failure was
behavioural:

- `__tests__/face-settings.spec.ts` pins the invariant over the **whole domain**
  (`floor < threshold` for 1000+ thresholds including the sub-milli values where
  rounding would otherwise reach the threshold), not at sample points. Removing
  the guard that keeps it total fails the test.
- `__tests__/face-recognizer.spec.ts` asserts that *lowering* the match
  threshold widens what is offered — pinning the floor back to the old `0.5`
  constant fails it. This is the live defect, as a test.
- `__tests__/suggestion-band-derived-wiring.spec.ts` boots the real addon on the
  store the live hub carried (`similarityThreshold: 0.45`,
  `suggestionMinCosine: 0.33`) and asserts the value in force is `0.36`, that
  `face.rescoreTrack` reports it with its factor, and that the retention pass
  announces and removes the stale key — global and per-device — exactly once.

No static guard forbids re-adding the field. One would have to name the key in
source to check for it, which is the same string the migration must keep
mentioning; the schema test that enumerates `FACE_DEFAULTS` keys is what a
re-addition would have to get past.
