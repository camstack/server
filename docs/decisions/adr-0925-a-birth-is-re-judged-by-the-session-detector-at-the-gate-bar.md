---
id: D925
title: A birth is re-judged by the session's own detector, at the gate's bar
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/confirmation-session-detector.ts
  - packages/addon-post-analysis/src/pipeline-analytics/confirmation-gate.ts
  - packages/addon-post-analysis/src/pipeline-analytics/confirmation-redetect-result.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/birth-decision-record.ts
  - packages/addon-pipeline/src/detection-pipeline/model-pin.ts
  - packages/types/src/interfaces/birth-decision-ledger.ts
---

Extends [D922](adr-0922-a-birth-suppression-names-its-reason-and-carries-the-score-the-crop-really-held.md).

## Context

Prod, 2026-10-23, agent-b: a camera whose session ran on the Coral
(`yolov9s-320-edgetpu`, model floor 0.4) had its births re-judged by the
node's GLOBAL default detector, `yolov9t-320` (floor 0.55), on the node's
default pool. The confirmation gate resolved its re-detect step from
`pipelineExecutor.getGlobalSteps` pinned to the frame's node and cached it
for ten minutes per node — a leftover of the first implementation, from
before detection defaults lived on the inference devices. The fleet ledger
held 2 459 suppressed births and 9 with a score: a different model, with a
different score scale and a different floor, was saying "no" to another
model's claim, and the gate's own 0.4 bar never got to decide because the
executor's per-class floor (person 0.65) had already removed the box (D922).

Rejected:

- **Fall back to the node default when the session's device is unusable.**
  Still another model's opinion about this claim. The operator ruled it out:
  the same model must re-analyse, or nothing does.
- **A per-run floor override sent to the executor.** A new cap input for one
  caller, and it changes the step's settings rather than who decides. The
  discard trail already carries every box the per-class floor refused.
- **`replay: true` to make the executor refuse a substitution.** It applies
  the camera's zone gate in frame coordinates to a crop.

## Decision

The gate re-judges a birth with the detector that claimed it. The executor
stamps every frame result with the root it RAN — `rootStepId`, `rootModelId`
(D646) and `rootDeviceKey` (the one field D924 placement also reads), after re-election and the capability fallback —
and the gate re-detects the crop with exactly that step and model on exactly
that pool (`deviceKey`), pinned to the frame handle's node, the node the crop
is cut on. When that detector cannot answer — the frame names none (an
onboard detector), the executor refuses the device (backoff, failed, an
unknown backend) or its stamps show another model or pool ran — the verdict
is `undecided` / `session-device-unavailable`: no measurement, the birth
defers within the existing bound and is admitted once exhausted. No other
model is ever asked; the per-node default-step cache is gone.

The gate's own bar (`confirmationGateMinConfidence`, per camera, raised by the
phantom-cell hook) decides every compatible box, kept or refused by the
detector's per-class floor (read back from `FrameResult.discarded`,
`below-threshold`). A suppression whose best box the floor had refused is
still named `below-detector-floor`.

Every verdict logs `modelId`, `deviceKey`, `node`, `bestScore`,
`appliedMinConfidence`, `reason`, `attempts` and `cropSource` with
`tags: { deviceId }`; the birth ledger row carries `detectorModelId`,
`detectorDeviceKey` and `detectorNodeId` (null on rows written before).

## Consequences

- A camera whose root is its own firmware (onboard detections) has no session
  detector: with the gate on, each birth defers to the deferral bound and is
  then admitted unmeasured. Before, the node default judged it.
- The gate cannot see below the model's pool floor (D662): those boxes never
  leave the Python worker. With the session's model that is the floor its
  births were claimed at, so the bar below it has nothing to judge.
- More births confirm where the per-class floor sat above the gate's bar: a
  person at 0.45 under a 0.4 bar now confirms instead of being suppressed.
- `pipelineExecutor.getGlobalSteps` has no caller in the gate any more; the
  method itself is being inventoried separately.

## Enforcement

`confirmation-gate-session-detector.spec.ts` (the matrix: Coral model on the
Coral pool on its node, 0.45 confirms at 0.4, 0.38 suppresses, backoff /
substituted model / substituted pool / no identity defer, exhausted admits)
and `confirmation-gate-session-detector-e2e.spec.ts` (the booted addon's real
`runPipeline` call and verdict line) fail when the gate asks a node default or
lets the per-class floor decide; `runpipeline-replay.spec.ts` fails when the
executor stops stamping `rootStepId` / `rootDeviceKey`.
