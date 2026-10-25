---
id: D646
title: A benchmark names a pool and never swaps an engine; a replay runs the camera's own root step, pinned, over a stored motion session and is compared with what the camera stored
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/addon-benchmark/src/**
  - packages/addon-pipeline/src/detection-pipeline/model-pin.ts
  - packages/addon-pipeline/src/pipeline-runner/bench-actions.ts
  - packages/types/src/utils/background-run-registry.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-provenance.ts
---

## Context

The benchmark addon grew around an ENGINE TRIPLE (`runtime/backend/format/device`)
that the pipeline stopped speaking when multi-device routing made a run's
coordinate `(camera → node → deviceKey)`. Its `engine` override on
`pipelineExecutor.runPipeline` / `runPipelineBatch` was honoured by ASSIGNING
the detection provider's shared `currentEngine`, `engineFactory` and
`executor` for the duration of the call — across `await`s, on a node that also
serves live cameras — and by spawning a second Python pool behind a warm
cache. Any live `runPipeline` that resolved to the node default in that window
ran on the override engine. The Sustained Throughput tab sent it whenever no
deviceKey was ticked.

The rest of the addon had drifted the same way (analysis
(planning repo: superpowers/specs/2026-09-26-benchmark-addon-analysis.md)): <!-- drift-ok: the analysis lives in the main checkout's working tree -->
Decoder Performance timed a decode path live detection no longer uses and
sampled the wrong process's memory; Sustained timed cached-preprocess pure
predict over raw-RGB batches shipped across processes; long runs were single
custom actions on a plane whose request timeout is 60 s, so the page was
abandoned while the node kept working; history rows could not say which node
or accelerator produced them; the agent copies were unreachable (custom actions
are served by the hub); and the replay compared a replay with a replay, on a
tracker with default config, validated the model against the HUB's format for
an agent's run, decoded with the host ffmpeg, and read one segment only.

## Decision

**A benchmark names its pool by `(nodeId, deviceKey)` and cannot reach the
executor's engine state.** `runPipeline` / `runPipelineBatch` carry no `engine`
field (a smuggled one is stripped), the provider has no swap, no override pool
and no `warm-override` inventory kind, and the runner's bench and capacity
schemas carry no engine either. `getEffectiveTuning` and `validatePipeline`
take a `deviceKey` so a bench records, and a replay checks, THE pool it used.

**A replay over stored media runs the camera's own root step PINNED, or
refuses.** `runPipeline({ replay: true })` applies the camera's detection-stage
zone gate and per-device overrides to a recorded image, emits nothing on the
live trace stream, and refuses (`model-not-servable` / `device-not-servable`)
before any pool is touched when the executing steps would not run exactly the
named model on exactly the named pool (D56). The session replay reads one
stored MOTION SESSION (`getMotionEvents`), resolves the camera's tree
(`resolvePipeline`) keeping only the `object-detection` root with its settings,
asks `validatePipeline {deviceKey}` on the pinned node first, reads the
recording through `recordingArchive` (multi-segment, keyframe-anchored), decodes
with the pinned ffmpeg (`ctx.deps.ensureFfmpeg()`) at the LIVE cadence (measured
from the stored positions) and the stored detection-frame width, and compares
each frame with the stored tracks ALIVE at that instant (same class, then
class-agnostic for class changes; `recovery` positions excluded and counted).
The track store thins a long trail, so a missing position inside a track's
life is not an absence: the reference is the stored position within half a
period (`exact`, IoU ≥ 0.5), else the box interpolated between the stored
positions around it (`interpolated`, IoU ≥ 0.3, gap ≤ 5 s), else the fact that
the track was alive (`uncertain`, class only, never a class change). A replay
box with no stored track alive at its instant is `unreferenced`, never
`added`; per class, the report counts the non-exact comparisons. The window is
the camera's own (`motionCooldownMs` tail; pre-roll off when the camera turns
pre-roll inference off), else the fleet default, and the report names which; a
session with no stored duration is refused (`session-length-unknown`). The run
is paced at the live cadence and refuses `pool-failing` after 10 consecutive
failed calls; a stored-track read that hits its limit is reported
`truncated`. A replayed frame logs `occasion: 'replay'` and samples its drops
apart from the live camera's. The live confirmation gate's outcomes come from
the stored birth decisions: an unmatched detection near a live SUPPRESSED
birth of its class is flagged. Root detection only; a child step is added by widening
`selectRootReplayStep`.

**Long benchmark work is start-then-poll** (`BackgroundRunRegistry`): the
synthetic bench (runner) and the session replay (benchmark) answer at once and
are polled.

**Tracks record the root model and the detection-frame size of the frame they
were born on** (`FrameResult.rootModelId`, `Track.modelId/frameWidth/frameHeight`),
so a later replay can name the original model instead of assuming it.

The addon is hub-only, and Sustained Throughput is a one-step Capacity Ramp.

## Consequences

- A benchmark on a node default and one on `openvino:npu` are different
  measurements, and the history row says which (node, deviceKey, plane, mode,
  the pool's `numWorkers`/`concurrency`). Pre-D646 rows keep their engine label;
  Decoder Performance rows are dropped on read (logged).
- Removing a cap field and adding the `replay` flag, `deviceKey` inputs and the
  Track fields is a framework change: live only with a `@camstack/server`
  release. An executor older than that strips `replay` and `validatePipeline`'s
  `deviceKey`, and stamps no `rootModelId` — nothing there is pinned or
  zone-gated — so the replay REFUSES (`model-not-servable`) on the first frame
  that names no root model, rather than reporting an unverifiable run.
- What the Sustained tab could do that the ramp cannot — several agents and
  several device pools in one run — is dropped: custom actions reached the hub
  only anyway, and one ramp per device on the hub answers the device question.
- The replay reads the `high` recording scaled to the stored detection width,
  not the camera's detection stream; the small-subject recovery pass and the
  tracker are not replayed.
- `spinEngine` (an explicit admin action on the Engines tab) still assigns the
  node's engine; it is an operator action, not a benchmark path.
- `PipelineEngineChoice.runtime` is `'python'` only, platform-wide: the node
  runtime and its node-backend format map are gone. An orchestrator template
  stored with `'node'` loads as `'python'`.
- `pipelineAnalytics.runReplayFrameProcessor` (the clip replay's in-memory
  FrameProcessor pass) had no caller and is deleted; the replay isolation
  guard now watches `session-replay/` too (its `replay` segment filter had
  skipped it).

## Enforcement

- `detection-pipeline/__tests__/engine-override-removed.spec.ts`: the cap
  strips `engine`, the provider has no override members, and a smuggled engine
  neither builds a pool nor re-points the engine on either run path.
- `runpipeline-replay.spec.ts` + `model-pin.spec.ts`: the pinned refusal before
  any pool, the zone gate on a replayed JPEG, no live trace, the root stamp.
- `session-replay/__tests__/*.spec.ts`: session selection, cheap question
  first, frame alignment on the keyframe, matching, metrics, no-footage refusal.
- `pipeline-runner/__tests__/synthetic-bench-start-poll.spec.ts`,
  `track-store-provenance.spec.ts`, `background-run-registry.spec.ts`.
- Fix round 1: `session-replay/__tests__/compare.spec.ts` (interpolated /
  uncertain / unreferenced), `run-session-replay.spec.ts` (a thinned 90 s
  parked car is never `added`, `pool-failing`, pacing, camera window,
  `truncated`), `session-plan.spec.ts`, `camera-settings.spec.ts`,
  `pipeline/__tests__/executor-replay-log-channel.spec.ts`,
  `orchestrator-store-schemas.spec.ts` (legacy `'node'` template),
  `scripts/__tests__/check-replay-isolation.spec.ts`.
- Each gate was disarmed once and seen to fail (report, 2026-09-26).
