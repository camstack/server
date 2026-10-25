---
id: D741
title: A root-supplied fine label has a floor per root model, the enrichment defaults are measured, and the face embedding keeps its own gate
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/addon-pipeline/src/pipeline-runner/root-supply.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-knob-applicability.ts
  - packages/ui-library/src/composites/agent-step-editor.tsx
---

Extends [D738](adr-0738-a-class-confidence-floor-defaults-to-the-running-model-and-an-override-is-bound-to-the-model-it-was-set-for.md),
[D739](adr-0739-the-floor-defaults-are-measured-per-model-every-model-scaled-threshold-binds-and-an-import-brings-its-sources-defaults.md)
and [D736](adr-0736-the-animal-and-vehicle-classifiers-are-on-by-default-sourced-from-the-root-and-the-supply-follows-the-camera-gate.md).
Amends [D662](adr-0662-a-detector-confidence-floor-belongs-to-the-model-and-a-face-lies-inside-its-person.md)'s
YuNet floor.

## Context

A measurement of the enrichment steps on 2026-10-07 tested each step on the
crops it really receives. The sources were native crops of recent animal,
vehicle and person tracks from 28 cameras. The reference was the agreement of
two large zero-shot models, or of two strong face detectors for faces, and
results were spot-checked by eye. The method and caveats are in
[`classifier-floors.json`](../benchmarks/classifier-floors.json). The animal data is dominated by one
household dog, and the floors carry about ±0.05–0.10.

- **`vehicle-type-v1`:** precision crosses 0.90 at 0.60 (0.912, recall
  0.846), against 0.877 at the 0.50 it ran at.
- **`animal-classifier`:** no floor makes it usable. Precision is 0.54 at
  0.50 and at most about 0.71 at any floor. It has no reject class, so it
  names a species for anything it is given, and it calls a light curly dog
  "sheep" or "cat" at high confidence. 0.80 is the least-bad floor.
- **YuNet:**
  - At 0.85, the D662 floor, it dropped about 40% of clear frontal faces
    (recall 0.53). At 0.70 it keeps precision 1.0 with recall 0.83.
  - Below 0.65 false faces return.
  - D662's junk bands were measured before the face-inside-its-person guard
    existed. 0.85 also did a second job: every auto-recognition scored ≥ 0.85,
    so it was in effect the gate on what reaches the face gallery and the
    matcher.
- **`yolox-tiny-plate`:** not measured (no independent reference), so it
  stays at 0.50.

**The run found an ungated label.** With every catalog detector, species and
vehicle types come from the ROOT detector's own class (`dog`, `bus`; the D736
root supply). They come at the detection's score, and the only gate on them
was the macro floor. Species accuracy at the macro floor was about 0.89–0.90
for 640 roots and about 0.74 for 320 roots, and 0.25 for the Coral SSD. Vehicle
types were right 0.99–1.00 of the time from every root.

## Decision

**A root-supplied fine label has a floor on the detection score, per root
model.**

- A root entry may declare `suppliedLabelFloors` (supplied step → minimum
  detection score). One table in `model-catalogs.ts`
  (`ROOT_SUPPLIED_LABEL_FLOORS`) holds the measured animal floors:

  | Root | Animal floor |
  | --- | --- |
  | `yolov9m-320-int8` | 0.75 |
  | `yolov9m-640-int8` | 0.70 |
  | `yolov9c-640-int8` | 0.75 |
  | `yolo26s` | 0.45 |
  | `yolo26m` | 0.70 |
  | `yolo26s-int8` | 0.55 |
  | Coral SSD | **1, which means never** |

- Vehicle types have no floor. A root or step without a row keeps today's
  behaviour: the macro floor alone.
- Below the floor the runner drops the fine label, and the detection keeps
  its macro class. It is the same path as a species switched off in the
  step's class list (`root-supply.ts`), and the detection is never dropped.

**One knob per step.** The step's own `minConfidence` slider governs the
supplied label, model-bound (D738) to the ROOT model:

- an operator value made for the root applies;
- a value made for the step's own classifier does not, because it is on
  another scale;
- the default is the root's floor.

The editor shows and writes the slider under the root's id while the root
supplies the step. `getSchema` lists each supplying root's default in
`defaultByModel`. When the step runs its own model, the slider is that
model's again.

**The enrichment defaults are the measurement** (model-level, D662):

- `vehicle-type-v1` 0.60;
- `animal-classifier` 0.80, with its catalog description saying it is
  unreliable;
- `yolox-tiny-plate` stays 0.50.

**YuNet detects at 0.70, and the face embedding keeps 0.85 as its own
gate.** `face-embedding` declares `defaultMinParentScore: 0.85`. A face
between the two is a detection with no embedding: it counts as a face for
the overlay and the best shot, but never reaches the gallery or the matcher.
The executor logs that skip, throttled per camera. The two numbers are kept
separate, so a later change to either does not move the other.

## Consequences

- **On the live root (`yolov9m-320-int8`, hub and agent-a):** a dog or
  cat detected between the animal floor (0.45, D739) and 0.75 is now just
  "animal". Above 0.75 it keeps its species. The measured accuracy rose from
  0.74 to about 0.89 for half the labelled animals.
- A Coral-elected camera never shows a species from its SSD.
- **Faces:** the hub now detects faces between 0.70 and 0.85 that it dropped
  before, which means more face boxes and more face-visible best shots. The
  gallery and the matcher see exactly the faces they saw before.
- **A camera running the animal classifier itself** (a root that does not
  name animals) now needs 0.80, not 0.50, and names far fewer species. That
  is intended: below 0.80 most of its names were wrong.
- An unbound legacy `minConfidence` stored on a classifier would now also
  gate the root's label (D738: an unbound value applies to whatever runs).
  This hub stores none.
- A dropped root label is not logged per detection. It is the same silent
  path as the class-list switch-off: the detection survives, only its fine
  name goes.

## Enforcement

- `pipeline-runner/__tests__/root-supplied-label-floor.spec.ts` checks:
  - above the floor the species is kept;
  - below it the label is dropped and the detection stays `animal`;
  - a root with no row keeps the macro floor only;
  - the SSD never supplies a species;
  - a slider value bound to the root overrides the floor, and one bound to
    the classifier does not.
- `model-bound-class-floors.spec.ts` checks the enrichment defaults, the
  embedding gate, the root label rows, and `defaultByModel` for supplying
  roots.
- `agent-step-editor-root-label-floor.test.tsx` checks that the slider shows
  and binds to the root while the root supplies the step, and to the
  classifier otherwise.
- The runner gate, the schema defaults and the editor binding were each
  disarmed and seen to fail.
