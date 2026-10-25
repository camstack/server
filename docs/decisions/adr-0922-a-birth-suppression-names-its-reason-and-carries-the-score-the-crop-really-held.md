---
id: D922
title: A birth suppression names its reason and carries the score the crop really held
status: accepted
date: 2026-10-23
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/confirmation-gate.ts
  - packages/addon-post-analysis/src/pipeline-analytics/confirmation-redetect-result.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/birth-decision-record.ts
  - packages/types/src/interfaces/birth-decision-ledger.ts
---

## Context

Prod, 2026-10-23, garage camera 1439: a person track was born at 16:52:02 UTC
and the confirmation gate retracted it (`birth suppressed (false positive)`,
`cropSource: native`, `minConfidence: 0.4`). Its `birth_decisions` row said
`bestScore: null`, `attempts: 0`, `birthEvidenceAvailable: false`, and so did
every suppression on that camera for three hours (13 vehicle, 1 person). It
read as "the gate suppressed with no evidence".

It was not. Every suppression path in the gate runs through `measure()` on a
NATIVE crop of the birth instant that was fetched and re-detected (D379); a
crop that never arrives, a re-detect error and a timeout are `undecided`, are
deferred, and an exhausted deferral is ADMITTED (`exhausted-fallback`). The
`attempts: 0` is simply "decided on the first look".

The `null` came from one layer down. The gate re-runs the node's root detector
through `pipelineExecutor.runPipeline`, and the executor applies the detector's
OWN per-class floors (person 0.65, vehicle/animal 0.5, D738) before a box
leaves it. The gate's bar is 0.4. So any compatible box that survived the floor
already cleared the bar and confirmed, and a suppression could only ever mean
"nothing compatible above the detector's floor" — recorded as no score at all.
The gate's own `minConfidence` never decided a suppression, and the ledger
could not tell an empty wall from a person the detector saw at 0.55. The
single reason `suppressed` hid which of four different things happened.

Rejected: passing the gate's bar to the executor as the floor
(`minConfidencePerson: 0.4` on the re-detect step). It would make the score
visible AND change which births confirm — the effective person bar would drop
from 0.65 to 0.4 on every camera, a behaviour change this record has no
measurement to justify. The score is recorded first; whether the bar should
move is a question the new column now lets someone answer per class.

## Decision

**A suppression names why, and carries the score the crop held.** The gate's
single `suppressed` reason is replaced by four, decided in this order:

- `scored-below-threshold` — a compatible box the detector kept, under the bar
  this candidate faced (the phantom-cell bar can raise it);
- `below-detector-floor` — the only compatible box was refused by the
  detector's own floor; `bestScore` is its score;
- `incompatible-class` — nothing compatible, something else;
- `no-detection` — the crop was measured and held nothing at all.

The re-detect reads the executor's discard trail (`FrameResult.discarded`,
reason `below-threshold`) beside its kept detections. A floor-refused box is
EVIDENCE for the record and nothing else: it never confirms a birth and never
becomes a secondary subject. Verdicts are unchanged.

The ledger row gains `cropSource` (`native | carried | fallback`, `null` when
no crop was judged and on older rows), and the retraction log line names the
reason, score, bar, crop source and attempts, tagged with `deviceId`.

The semantics D379 set are restated, not changed: only a native crop of the
birth instant may suppress; no measurement is never a suppression.

## Consequences

- `reason` on old rows still says `suppressed`; the column stays a string so
  they read. `cropSource` defaults to `null` on read.
- `bestScore` on a suppression can now exceed `appliedMinConfidence` (a
  `below-detector-floor` box at 0.55 against a 0.4 bar). That is the point:
  it says the detector's floor, not the gate's bar, decided.
- The cap's response schema grew a field: the API carries it once the
  `@camstack/server` closure holding the new `@camstack/types` is applied; the
  row is written by the post-analysis addon as soon as that is deployed.

## Enforcement

`confirmation-gate-suppression-reason.spec.ts` (each reason, the score, the
floor-refused box neither confirming nor promoting, no-evidence never
suppressing), `confirmation-redetect-result.spec.ts` (the discard trail is
read), `birth-decision-record.spec.ts` and
`birth-decision-ledger-crop-source.spec.ts` (the row carries it; an old row
still reads). Removing the gate and record changes fails seven of them.
