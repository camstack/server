# Plan — replaying a real pipeline on a clip

> **For the implementer:** REQUIRED SKILL — use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans`. The steps use checkboxes
> (`- [ ]`) for tracking.

**Goal:** given a FIXED input (an uploaded clip, or a recording window already on
disk), run a camera's REAL pipeline over it, several times, with different
configurations, and show the **delta** between two runs — without writing a single
line into the production collections.

The case that generated it: a package in front of the door on 2026-08-26 at 18:12.
The reference NVR saw it, camstack did not; 101 has only two `person` tracks at 17:59.
The `package-detection` step is not active there, and it is not because **no
`package` zone is drawn** — activation is zone-driven
(`applyPackageZoneActivation`, `packages/addon-pipeline-orchestrator/src/pipeline-resolver.ts:62`).
The operational question is not "which threshold": it is **"if I draw the zone and
turn the step on, is that package seen?"**. Today the only answer is to wait for
another courier.

**It is not an uploader.** The value is REPRODUCIBILITY: same input, N
configurations, comparable results. A plan that delivers an upload and an "analyse"
button without making two runs comparable has missed the target, and this document
is written so as not to miss it.

**Architecture:** four tracks.
**0** adds no functions: it places the guard that makes it *impossible* for a
replay module to write into production, and makes a run that would run with a
different model from the requested one be rejected. **A** turns an input into N
frames. **B** is the engine: N frames → `FrameResult` → fresh `FrameProcessor` →
in-memory verdict. **C** is the comparison, and it is the reason the rest exists.
A and 0 can start in parallel; B depends on both; C on B.

**Stack:** TypeScript 5.7+, Zod 4, vitest, npm workspaces + nx.

## Global constraints

The rules of `CLAUDE.md` apply. In addition, verbatim:

- **No casts.** No `as any`, `as unknown as X`, `as never`. Exceptions: `as
  const` and a documented type boundary. Discriminated unions and type guards.
- **`z.infer<>` for Zod schemas** — never duplicate a shape by hand.
- **Named types**: no inline types on signatures or return values.
- **Every log line carries `tags: { deviceId }`** with the numeric id. For a
  replay the `deviceId` is **the camera whose pipeline is being replayed**,
  even when the pixels come from an upload: the question is always "why did 101
  not see it", and a line without that tag does not answer it. The run id goes in
  `meta.replayRunId`.
- **A branch that silently throws work away logs it.** A skipped frame, a node
  that refuses, a run interrupted by the budget: one line each.
- **Addons do not import each other.** `ctx.api` is the only layer. Framework
  packages (`@camstack/types`, `@camstack/system`) are not addons and are
  imported freely.
- **`npm run codegen` after every touch to a `*.cap.ts`.**
- **A green test is not proof.** After every fix, DISARM the fix and confirm the
  test turns red. Report that you did.
- **Never `git --no-verify`, never `git add -A`, never `git stash`.** Explicit
  pathspecs.
- **No task here touches the production hub.** Only code and tests.
- **Do not touch `packages/addon-admin-ui/**`.** The replay page lives in the
  addon, served via `addon-pages-source` — the same mechanism as
  `addon-benchmark` (`packages/addon-benchmark/src/benchmark-addon.ts:202`). <!-- drift-ok: names benchmark code removed by D792 -->

---

## What already exists — the map, with file and line

This section is the reason the plan is short. Almost everything is there.

### The post-analysis engine is already a reusable pure function

`packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts`

| Line | What | Why it matters here |
| --- | --- | --- |
| `247` | `export class FrameProcessor` | one per `${deviceId}:${source}`, holds tracker + state machine + zones inside |
| `314` | `constructor(...)` | all config is injected: zones, `TrackerConfig`, `StateAnalyzerConfig`, `EventEmitterConfig`, `StationaryFrameGate` |
| `412` | `process({ timestamp, frame }): FrameProcessorResult` | **synchronous, zero I/O** |
| `189` | `interface FrameProcessorResult` | `tracked`, `objectEvents`, `appearanceEvents`, `rawTrackedDetections`, `stationaryConfirmed/Woken/Armed/Disarmed`, `riderFolds` |

**This is the replay.** Feeding N `FrameResult`s in time order to a freshly built
`FrameProcessor` produces the tracks the pipeline would have produced — and writes
nothing, because **the one who persists is
`pipeline-analytics/index.ts:5355 processFrame`, not the `FrameProcessor`**
(`index.ts:5344` is the only live call, from the bus subscriber). The separation
already exists; the replay uses it, does not create it.

### The right inference primitive is `runPipeline`, NOT `runStatelessStep`

`CLAUDE.md` (D54) says massive work over STORED media runs through
`pipelineRunner.runStatelessStep`. **For this work it is not the right
primitive**, and the three reasons are in the code, not in an opinion:

1. **It carries no `settings`.** `packages/addon-pipeline/src/pipeline-runner/stateless-step.ts:209`
   synthesises the tree as `[{ addonId, modelId, enabled: true }]`. No
   `settings`. And `tree-builder.ts:111-112` hydrates the catalogue defaults
   (`{ ...schemaDefaults, ...step.settings }`), so the threshold in force is
   **always** the catalogue's. Changing `minConfidencePackage` — which is
   literally the lever the operator wants to move,
   `step-definitions.ts:423` — is unreachable from there.
2. **It throws away the trail of discards.** `stateless-step.ts:228` maps only
   `result.detections`. `result.discarded` is lost. It is exactly the answer to the
   question that generated the plan: `docs/architecture/detection-execution.md:340`
   ("The discard stack") lists the stages that discard a box with their
   `reason` (`class-filter`, `below-threshold`, `full-frame-guard`, `zone-gate`),
   and `packages/types/src/types/detection.ts:413` carries it on every `FrameResult`.
   A replay that does not show it explains nothing.
3. **It crops.** `stateless-step.ts` goes through `cutFromFullFrame`
   (`pipeline-runner/detail-subtree.ts:373`) → `deriveDetailCropRect`
   (`packages/types/src/pipeline/detail-crop.ts:207`). With the default convention
   (`square: false`, line `89`) a bbox `{0,0,1,1}` is the identity. With
   `square: true` **it is not on a 16:9 frame**: `squareInPixels` collapses onto
   the short side and produces a central square. See the section on unknowns.

The primitive that does everything is already exposed and already used:

| What | Where |
| --- | --- |
| `pipelineExecutor.runPipeline` | `packages/types/src/capabilities/pipeline-executor.cap.ts:604` |
| accepts the full tree with `settings` per step | `pipeline-executor.cap.ts:265-282` (`PipelineStepInputOutput`) |
| accepts `imageBase64`, `nodeId`… | ibid. `604-660`; `deviceKey` and `plane` included |
| returns the WHOLE `FrameResult`, `discarded` included | `pipeline-executor.cap.ts:412` (`PipelineRunResultBridge = z.custom<FrameResult>()`) |
| pre-flight that names model substitutions | `pipeline-executor.cap.ts:526 validatePipeline` → `substitutions[]` (`:301-323`) |

### For ONE image the tester already exists

`packages/addon-benchmark` — manifest description: *"Detection benchmark,
image tester, and pipeline runner"*.

- `packages/addon-benchmark/src/tabs/ImageTab.tsx` (lines 455-470) — loads an image,
  chooses node and `deviceKey`, calls `runPipelineTest`, draws the boxes.
- `packages/addon-benchmark/src/camera-context.ts:64 resolvedStepsToRunSteps` —
  already knows how to take the **resolved tree of a real camera**
  (`pipelineOrchestrator.resolvePipeline`,
  `packages/types/src/capabilities/pipeline-orchestrator.cap.ts:1070`) instead of
  inventing one.
- `packages/addon-benchmark/src/benchmark-actions.ts:41 runPipelineTest` +
  `benchmark-schemas.ts:265 PipelineRunInputSchema`.

**So: "run a model on an image and show me the result" is already
delivered.** What is missing is TIME (a clip is N frames), POST-ANALYSIS (tracks,
zones, package stillness) and the COMPARISON.

### There is already a precedent for "ask the pipeline what it sees on a stored frame"

- `packages/types/src/capabilities/pipeline-analytics.cap.ts:1921
  proposeRetrainAnnotations` — a proposal, not an answer; `source: 'assist'`.
- `packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-assist.ts:71
  planAssist` — and for the package it asks `rfdetr-package` at 0.35 **on the ZONE**,
  refusing (`null`) if the zone is not there, because *"a package detector at that
  threshold proposes furniture"* over the whole frame. The threshold is applied by
  the caller (`mapAssistDetails`, line `125`) because `runStatelessStep` carries
  none.

The replay is this thing, extended in time and made comparable. The lesson
"package = zone, not whole frame" is inherited, not rediscovered.

### Decoding: a JPEG from a recording already exists

- `packages/addon-post-analysis/src/pipeline-analytics/recorded-still.ts:160
  RecordedStillService` — from `(deviceId, epochMs)` to a native JPEG. Named
  refusals (`no-recording | no-footage | busy | decode-failed`), concurrency bound,
  **build guard** that keeps it off the delivery path
  (`scripts/check-recorded-still-off-delivery-path.ts`).
- `recorded-still.ts:128 buildRecordedStillArgs(atSec, maxWidth)` — the argv.
  Reads from `pipe:0`, one frame, `mjpeg` on `pipe:1`.
- `packages/addon-post-analysis/src/pipeline-analytics/recorded-still-ports.ts`
  — the real wiring (`RecordingReadApi`: `getDeviceConfig`, `locateSegment`,
  `readGopBytes`), `RECORDED_STILL_PROFILE = 'high'`.
- The twin in the recorder, for the stills of the export dialog:
  `packages/addon-pipeline/src/recorder/still/still-frame-service.ts:46`.
- `packages/addon-pipeline/src/stream-broker/recorded/ffmpeg-run-once.ts:48
  runFfmpegOnce` — a one-shot ffmpeg, input on stdin, stdout collected,
  correct SIGTERM→SIGKILL.

⚠️ `scripts/check-ffmpeg-primitive.ts` — Rule 1: outside
`packages/types/src/ffmpeg/` no file may export a function matching
`build*(Ffmpeg|Transcode)*Args`. Rule 2: a `spawn`/`execFile` whose first
argument contains `ffmpeg` goes into `SPAWN_ALLOWLIST` with the reason beside it.
`buildRecordedStillArgs` passes because the name does not match; the replay follows
the same naming convention and **does not** add a second generic builder.

### The upload is already solved

`packages/types/src/capabilities/storage.cap.ts` (lines 97-113) —
`beginUpload({ location, relativePath, sizeBytes }) → { uploadId }`,
`writeChunk({ uploadId, offset, data })`, `finalizeUpload`, `abortUpload`.
`StorageLocationType` is an open string (`packages/types/src/interfaces/storage-location.ts:19`),
so a new type `replayClips` requires no change to the schema.
The location id follows the convention `<type>:<slug>` (ibid. `:35`).

### The machinery of a massive pass exists, with its counters

The precedent to copy for the cost, not for the primitive:

- `packages/addon-post-analysis/src/pipeline-analytics/rebuild-node-rotation.ts`
  — `NodeRotation`: round-robin, a node leaves and **does not come back**, each
  exit carries its reason. The header explains why the balancer is not used.
- `packages/addon-post-analysis/src/pipeline-analytics/rebuild-step-dispatch.ts`
  — the three rules of a reliable pass: one model for the whole pass, a node that
  does not serve it leaves and the work is retried, it cannot get stuck.
- `packages/addon-post-analysis/src/pipeline-analytics/cluster-model-pin.ts` — a
  pass that cannot name its model **does not start**.
- `docs/architecture/post-analysis.md:717` ("Reading a pass") — the table of
  counters and the rule of `pacingMs`.

### The precedent of a dry-run that does not dirty

`packages/types/src/capabilities/notification-rules.cap.ts:2069 testRule` —
*"Dry-run a rule against recently persisted records… Mutation kind only to carry
the full rule object safely; no side effects."* The shape of the replay is the
same, one level lower.

### The zones

`applyZoneRuleGate` (`packages/addon-pipeline/src/detection-pipeline/zone-gate.ts:28`)
sits in another addon and **is not imported**. But the pure part,
`evaluateZoneRules`, is in `@camstack/types` and is what both banks already use.
`FrameProcessor` does the detection-stage zone filter inside itself
(`ZoneEngine`), so for the replay the zones enter as a **constructor parameter**,
not as a second engine.

---

## File structure

| File | Responsibility | Track |
| --- | --- | --- |
| `scripts/check-replay-isolation.ts` | **NEW** — no replay module may import a production store | 0 | <!-- drift-ok: this plan creates it -->
| `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-plan.ts` | **NEW** — pure: from `(camera, override)` to the tree + settings + zones of ONE run | 0/B | <!-- drift-ok: this plan creates it -->
| `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-source.ts` | **NEW** — pure: `ReplaySource` → the instants to decode | A | <!-- drift-ok: this plan creates it -->
| `packages/addon-post-analysis/src/pipeline-analytics/replay/mjpeg-split.ts` | **NEW** — pure: an MJPEG stream → N JPEGs | A | <!-- drift-ok: this plan creates it -->
| `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-decode.ts` | **NEW** — the only ffmpeg spawn of the replay, bounded and allowlisted | A | <!-- drift-ok: this plan creates it -->
| `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-run.ts` | **NEW** — the engine: frame → `runPipeline` → `FrameProcessor` → verdict | B | <!-- drift-ok: this plan creates it -->
| `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-store.ts` | **NEW** — the `pipeline-analytics:replay-runs` collection, separate from everything | B | <!-- drift-ok: this plan creates it -->
| `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-diff.ts` | **NEW** — pure: two verdicts → a delta | C | <!-- drift-ok: this plan creates it -->
| `packages/types/src/capabilities/pipeline-analytics.cap.ts` | the replay cap methods | B/C |
| `packages/addon-post-analysis/src/pipeline-analytics/index.ts` | wiring: construction of the service, `declare()` of the collection | B |

**Where it runs, and on which runner.** `pipeline-analytics` is in the `analytics`
group, its own runner, `any-node`, and goes inert on every node that is not
`postProcessingNodeId` (`pipeline-analytics/settings-schema.ts:183`, default
`hub`). The replay inherits that gate: **the direction sits where post-analysis
sits; inference does not** (Track B, Task B2). No new addon is born, no new runner
is born, the hub's RAM is not touched with one more process.

---

## Track 0 — the replay cannot dirty, and cannot lie about the model

### Task 0.1: a guard, not a paragraph

The constraint *"a replay does not write into the camera's collections"* is the
whole safety argument of the plan. Written in a comment it lasts until the first
person in a hurry. `CLAUDE.md`: *"Prefer a guard to a paragraph."*

**Files:**
- Create: `scripts/check-replay-isolation.ts` <!-- drift-ok: this plan creates it -->
- Create: `scripts/__tests__/check-replay-isolation.spec.ts` <!-- drift-ok: this plan creates it -->
- Modify: `.github/workflows/ci.yml` (next to the other `check-*`)

**Interfaces:**
- Produces: `findReplayIsolationViolations(files: readonly ReplayFile[]): readonly ReplayViolation[]`
- Consumes: the content of the files under `pipeline-analytics/replay/`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import {
  findReplayIsolationViolations,
  type ReplayFile,
} from '../check-replay-isolation.js'

const file = (path: string, source: string): ReplayFile => ({ path, source })

describe('findReplayIsolationViolations', () => {
  it('rejects an import of a production store', () => {
    const v = findReplayIsolationViolations([
      file('replay/replay-run.ts', `import { TrackStore } from '../store/track-store.js'`),
    ])
    expect(v).toHaveLength(1)
    expect(v[0]?.symbol).toBe('TrackStore')
  })

  it('rejects a call to the Notification Center', () => {
    // A replay that fires a notification is not a dry-run: it is a delivery
    // with a fake input. It holds for the bus as much as for the store.
    const v = findReplayIsolationViolations([
      file('replay/replay-run.ts', `await this.api.notificationRules.testRule.mutate({})`),
    ])
    expect(v).toHaveLength(1)
  })

  it('lets its own store through', () => {
    const v = findReplayIsolationViolations([
      file('replay/replay-run.ts', `import { ReplayStore } from './replay-store.js'`),
    ])
    expect(v).toEqual([])
  })

  it('lets FrameProcessor through — it is the engine, not a writer', () => {
    const v = findReplayIsolationViolations([
      file('replay/replay-run.ts', `import { FrameProcessor } from '../pipeline/frame-processor.js'`),
    ])
    expect(v).toEqual([])
  })

  it('does not look at files outside replay/', () => {
    const v = findReplayIsolationViolations([
      file('index.ts', `import { TrackStore } from './store/track-store.js'`),
    ])
    expect(v).toEqual([])
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root . check-replay-isolation`
      Expected: `Cannot find module '../check-replay-isolation.js'`.

- [ ] **Step 3 — implement the minimum.** The forbidden list is explicit and
      **enumerated**, not heuristic: a closed list is verifiable by eye, a regex on
      `*Store` is not.

```ts
/**
 * The replay is a dry-run. Its only guarantee is that it cannot write where
 * production writes — and a guarantee that depends on the attention of whoever
 * edits the file is not a guarantee.
 *
 * CLOSED list, not heuristic: `/.*Store/` would also catch `ReplayStore`, and
 * an exception inside a regex is the point where the rule stops saying what it
 * means. Every entry here is a production writer with its own name.
 */
export const FORBIDDEN_SYMBOLS: readonly string[] = [
  'TrackStore',
  'EventStore',
  'MediaStore',
  'FaceStore',
  'PlateStore',
  'SensorEventStore',
  'captureScheduler',
  'notificationRules',
  'persistSyntheticTrack',
]
```

- [ ] **Step 4 — run, green.** Then **disarm** (empty `FORBIDDEN_SYMBOLS`) and
      confirm that the first two tests turn red again. Report that you did.
- [ ] **Step 5 — wire into `ci.yml`** next to `check-recorded-still-off-delivery-path`.

> **Why the guard comes BEFORE the code it watches.** So that it arrives red on
> the first wrong import instead of in a review. The repo has already paid for the
> opposite order.

### Task 0.2: a run that would run with another model is refused

`pipelineExecutor.runPipeline` **does not refuse**: `resolveModelForFormat`
replaces a model without a build for the node's format with that format's default,
silently, with an info line (it is the whole reason `runStatelessStep` exists —
`stateless-step.ts:96-107`). For a comparison between two runs it is fatal: the
delta would tell a model difference while the operator believes they moved a
threshold.

The pre-flight already exists and is node-pinned: `pipelineExecutor.validatePipeline`
(`pipeline-executor.cap.ts:526`) returns `substitutions[]` and `issues[]`.

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-plan.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/__tests__/replay-plan.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `readPreflight(result: PipelineValidationResult): ReplayPreflightVerdict`
- Consumes: `PipelineValidationResult` from `@camstack/types`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import type { PipelineValidationResult } from '@camstack/types'
import { readPreflight } from '../replay-plan.js'

const base: PipelineValidationResult = {
  ok: true,
  issues: [],
  substitutions: [],
  format: 'onnx',
}

describe('readPreflight', () => {
  it('accepts a tree the node knows how to execute as it is', () => {
    expect(readPreflight(base)).toEqual({ kind: 'runnable', format: 'onnx' })
  })

  it('REFUSES a model substitution — it is not a detail, it is another experiment', () => {
    const verdict = readPreflight({
      ...base,
      substitutions: [
        { addonId: 'package-detection', chosen: 'rfdetr-package', running: 'yolov9m-320', format: 'onnx' },
      ],
    })
    expect(verdict.kind).toBe('refused')
    if (verdict.kind !== 'refused') throw new Error('expected refused')
    expect(verdict.reason).toBe('model-substituted')
    // The message names BOTH models: "the node substituted" without saying with
    // what sends the operator off to look in the catalogue by hand.
    expect(verdict.detail).toContain('rfdetr-package')
    expect(verdict.detail).toContain('yolov9m-320')
  })

  it('REFUSES a hard problem, and distinguishes it from the substitution', () => {
    const verdict = readPreflight({
      ...base,
      ok: false,
      issues: [{ addonId: 'package-detection', kind: 'no-format-build', detail: 'no onnx build' }],
    })
    expect(verdict.kind).toBe('refused')
    if (verdict.kind !== 'refused') throw new Error('expected refused')
    expect(verdict.reason).toBe('step-unrunnable')
  })

  it('a hard problem AND a substitution: the hard problem wins', () => {
    // Deliberate order. `ok: false` means the step does not run at all;
    // reporting "model substituted" would send them to tune a model that would
    // not be loaded anyway.
    const verdict = readPreflight({
      ...base,
      ok: false,
      issues: [{ addonId: 'x', kind: 'unknown-addon', detail: 'unknown' }],
      substitutions: [{ addonId: 'y', chosen: 'a', running: 'b', format: 'onnx' }],
    })
    if (verdict.kind !== 'refused') throw new Error('expected refused')
    expect(verdict.reason).toBe('step-unrunnable')
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/addon-post-analysis replay-plan`

- [ ] **Step 3 — implement the minimum.**

```ts
/**
 * The pre-flight of a run.
 *
 * `runPipeline` does not refuse a model substitution: it makes it and logs it at
 * info. For live traffic it is the right choice (better a degraded detector than
 * no detector). For a COMPARISON it is the worst thing that can happen: two runs
 * identical except for a threshold would show a delta produced by two different
 * encoders, and nothing in the result would say so. Hence the refusal — the same
 * discipline `runStatelessStep` applies to a fleet pass
 * (`stateless-step.ts:96-107`), here applied to an experiment.
 */
export type ReplayPreflightVerdict =
  | { readonly kind: 'runnable'; readonly format: string }
  | {
      readonly kind: 'refused'
      readonly reason: 'model-substituted' | 'step-unrunnable'
      readonly detail: string
    }
```

- [ ] **Step 4 — green, then DISARM** (make `runnable` return on a non-empty
      `substitutions`) and confirm red.

---

## Track A — a fixed input becomes N frames

### Task A1: two sources, one single type

**The most important thing of this track.** The case that generated the plan
**does not need an upload**: 101 was recording at 18:12 on 2026-08-26, and
`-c:v copy` means *the recorded frame IS the native frame*
(`recorded-still.ts:11-16`). The high-value source is the recording; the uploaded
clip serves for an input camstack does not own (an export of the reference NVR, a
test video, the clip from another installation).

Modelling them as ONE union from the start is what prevents building an uploader
and calling it a replay.

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-source.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/__tests__/replay-source.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `planReplayFrames(source: ReplaySource, fps: number, maxFrames: number): ReplayFramePlan`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { planReplayFrames, type ReplaySource } from '../replay-source.js'

const recording: ReplaySource = {
  kind: 'recording',
  deviceId: 101,
  fromMs: 1_756_224_720_000, // 2026-08-26 18:12:00
  toMs: 1_756_224_730_000, // +10 s
}

describe('planReplayFrames', () => {
  it('at 2 fps over 10 s produces 20 instants, the first on fromMs', () => {
    const plan = planReplayFrames(recording, 2, 100)
    expect(plan.kind).toBe('planned')
    if (plan.kind !== 'planned') throw new Error('expected planned')
    expect(plan.instants).toHaveLength(20)
    expect(plan.instants[0]).toBe(recording.fromMs)
    expect(plan.instants[1]).toBe(recording.fromMs + 500)
  })

  it('truncates at maxFrames and SAYS SO — a plan cut silently is a lie', () => {
    const plan = planReplayFrames(recording, 10, 12)
    if (plan.kind !== 'planned') throw new Error('expected planned')
    expect(plan.instants).toHaveLength(12)
    expect(plan.truncated).toBe(true)
  })

  it('an empty or inverted window is refused instead of producing zero frames', () => {
    // Zero frames and "no detection" are the same screen. The refusal is the
    // only thing that tells them apart before the operator draws the wrong
    // conclusion about the model.
    const plan = planReplayFrames({ ...recording, toMs: recording.fromMs }, 2, 100)
    expect(plan).toEqual({ kind: 'refused', reason: 'empty-window' })
  })

  it('for an upload the instants are OFFSETS from the start of the clip, not wall-clock', () => {
    const plan = planReplayFrames(
      { kind: 'upload', clipId: 'clip:abc', deviceId: 101, durationMs: 4_000 },
      1,
      100,
    )
    if (plan.kind !== 'planned') throw new Error('expected planned')
    expect(plan.instants).toEqual([0, 1000, 2000, 3000])
    // The deviceId stays even for an upload: it is the camera whose pipeline is
    // replayed, and it is the key by which every log line is grouped.
    expect(plan.deviceId).toBe(101)
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement the minimum.**

```ts
/**
 * Where the pixels of a replay come from.
 *
 * `recording` first, and not by alphabetical order: in the case that generated
 * the plan the clip ALREADY EXISTS on disk, the recorder writes `-c:v copy` and so
 * the recorded frame is the native frame the detector would have seen live. An
 * upload that shoots the same scene from another installation is DIFFERENT
 * pixels, and a replay on different pixels answers a different question.
 *
 * `deviceId` is present in BOTH branches. For `recording` it is the camera read
 * from; for `upload` it is the camera whose configuration is replayed — the clip
 * is not a camera, but the pipeline is, and every log line must be grouped by
 * that (`CLAUDE.md`, the tags rule).
 */
export type ReplaySource =
  | {
      readonly kind: 'recording'
      readonly deviceId: number
      readonly fromMs: number
      readonly toMs: number
    }
  | {
      readonly kind: 'upload'
      readonly clipId: string
      readonly deviceId: number
      readonly durationMs: number
    }
```

- [ ] **Step 4 — green, disarm the refusal on an empty window, confirm red.**

### Task A2: an MJPEG stream becomes N JPEGs

A `-vf fps=N` in **a single** ffmpeg invocation, not N invocations. On a 10 s clip
at 4 fps that is 40 frames: forty spawns would be forty seeks, and on a hub already
at 35% CPU it is the difference between "a run costs a second" and "a run costs a
minute". `RecordedStillService` spawns once per still because it needs ONE still;
here a sequence is needed, and the shape changes with the purpose.

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/mjpeg-split.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/__tests__/mjpeg-split.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `splitMjpegStream(bytes: Uint8Array): readonly Buffer[]`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { splitMjpegStream } from '../mjpeg-split.js'

/** Minimal synthetic JPEG: SOI, one distinctive payload byte, EOI. */
const jpeg = (marker: number): Buffer => Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9])

describe('splitMjpegStream', () => {
  it('separates three concatenated frames and keeps their order', () => {
    const out = splitMjpegStream(Buffer.concat([jpeg(0x01), jpeg(0x02), jpeg(0x03)]))
    expect(out).toHaveLength(3)
    expect(out[0]?.[2]).toBe(0x01)
    expect(out[2]?.[2]).toBe(0x03)
  })

  it('every extracted frame starts with SOI and ends with EOI', () => {
    const out = splitMjpegStream(Buffer.concat([jpeg(0x01), jpeg(0x02)]))
    for (const f of out) {
      expect(f.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
      expect(f.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
    }
  })

  it('DISCARDS a truncated tail instead of delivering half a frame', () => {
    // An ffmpeg killed by the timeout leaves a tail without EOI. Delivering it
    // means a failed decode much farther from the cause; the frame count is the
    // only thing that makes it visible here.
    const out = splitMjpegStream(Buffer.concat([jpeg(0x01), Buffer.from([0xff, 0xd8, 0x02])]))
    expect(out).toHaveLength(1)
  })

  it('on bytes that do not even contain a SOI it answers empty, it does not throw', () => {
    expect(splitMjpegStream(Buffer.from([0x00, 0x01, 0x02]))).toEqual([])
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement the minimum.** Scan on `0xFFD8` / `0xFFD9`. The
      repo already has a JPEG marker scan in
      `packages/addon-pipeline/src/detection-pipeline/provider.ts:3354` (it probes
      the dimensions, `// skip SOI`) — do **not** reuse it: it is in another addon
      and reads something else. Here it is enough to find the pairs.
- [ ] **Step 4 — green, disarm the EOI check, confirm red on the
      third test.**

### Task A3: the replay's only spawn

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-decode.ts` <!-- drift-ok: this plan creates it -->
- Create: `.../replay/__tests__/replay-decode.spec.ts` <!-- drift-ok: this plan creates it -->
- Modify: `scripts/check-ffmpeg-primitive.ts` (`SPAWN_ALLOWLIST`, with the reason)

- [ ] **Step 1 — test on the ARGV, which is the part that goes wrong silently.**

```ts
import { describe, it, expect } from 'vitest'
import { buildReplaySequenceArgs } from '../replay-decode.js'

describe('buildReplaySequenceArgs', () => {
  it('puts -ss BEFORE -i: it is an input seek, not a decode of the whole file', () => {
    // `still-frame-service.ts:5-10` documents exactly this: `-ss` before
    // `-i` lands on the nearest keyframe and is cheap. After `-i` it decodes
    // everything up to the instant and then throws it away.
    const args = buildReplaySequenceArgs({ startSec: 12, durationSec: 10, fps: 4, maxWidth: 1920 })
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
  })

  it('asks for mjpeg on stdout and bounds the duration', () => {
    const args = buildReplaySequenceArgs({ startSec: 0, durationSec: 10, fps: 4, maxWidth: 1920 })
    expect(args).toContain('mjpeg')
    expect(args).toContain('pipe:1')
    expect(args[args.indexOf('-t') + 1]).toBe('10')
  })

  it('the sampling fps is in the filter, not in -r', () => {
    // `-r` re-times the output by duplicating or dropping frames; `fps=` samples.
    // A replay must see the frames that ARE there, not a paced version.
    const args = buildReplaySequenceArgs({ startSec: 0, durationSec: 4, fps: 2, maxWidth: 1920 })
    expect(args[args.indexOf('-vf') + 1]).toContain('fps=2')
    expect(args).not.toContain('-r')
  })

  it('never upscales: min(maxWidth, iw)', () => {
    const args = buildReplaySequenceArgs({ startSec: 0, durationSec: 1, fps: 1, maxWidth: 1920 })
    expect(args[args.indexOf('-vf') + 1]).toContain(`min(1920,iw)`)
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement the minimum**, tracing `buildRecordedStillArgs`
      (`recorded-still.ts:128`). Name deliberately **not** `build*FfmpegArgs`:
      `scripts/check-ffmpeg-primitive.ts` Rule 1 would reject it, and the rule is
      right — this is not a generic builder, it is the replay's sequence.
- [ ] **Step 4 — the bound.** Copy the shape of `RecordedStillService`: at most 2
      concurrent decodes, a queue that REFUSES instead of queueing without limit,
      hard deadline (15 s is the value already chosen twice in this repo:
      `still-frame-service.ts:37` and `recorded-still-ports.ts:23`). A run that does
      not get the slot answers `busy`, it **does not wait**.
- [ ] **Step 5 — allowlist**, with the reason beside it, in the shape of the
      existing entries: *"replay decode — decodes into frames for a dry-run, not an
      egress; owns its own bound and its own deadline"*.
- [ ] **Step 6 — disarm the bound** (raise to 100 concurrent) and confirm the
      saturation test turns red.

### Task A4: the upload, which is already written

No new machinery: `storage.beginUpload/writeChunk/finalizeUpload`
(`storage.cap.ts:97-113`) on a location of type `replayClips`.

- [ ] The `clipId` is **the content hash**, not a uuid. Two runs must be able to
      prove they saw the same bytes; a random id makes the comparison an act of
      faith. Test: two uploads of the same file produce the same
      `clipId` and a single copy on disk.
- [ ] An interrupted upload calls `abortUpload`. Test: no half clip remains
      listable.
- [ ] The `replayClips` location is declared with `cardinality: 'single'` and has a
      retention window of its own. **A replay clip is not production material and
      must never end up under the tracks sweep.**

> **Do A4 LAST in the track.** The `recording` source covers the case that
> generated the plan and does not need a single byte of upload. Building the
> uploader first is precisely the way to deliver an uploader and call it a
> replay.

---

## Track B — a run, and where its results end up

### Task B1: the plan of a run is pure

A run is: which tree, with which `settings`, with which zones, on which node, at
which fps. All derived from the camera's RESOLVED tree plus an explicit overlay —
never invented.

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-plan.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `buildReplayPlan(base: CameraPipelineConfig, overlay: ReplayOverlay): ReplayPlan`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import type { CameraPipelineConfig } from '@camstack/types'
import { buildReplayPlan } from '../replay-plan.js'

const base: CameraPipelineConfig = {
  steps: [{ addonId: 'object-detection', modelId: 'yolov9m-320', enabled: true, children: [] }],
}

describe('buildReplayPlan', () => {
  it('without an overlay reproduces the resolved tree UNCHANGED', () => {
    // The reference run must be what the camera REALLY does. If the plan
    // normalises it, the comparison measures the normalisation.
    expect(buildReplayPlan(base, {}).steps).toEqual(base.steps)
  })

  // NOTE (2026-09-07): `packageZone` was NEVER implemented as a
  // rectangle. Only its presence was read; the geometry did not
  // reach `plan.steps` and had nowhere to go — a `crop-zone` root derives the crop
  // from the device's STORED zones
  // (`crop-zone.ts:resolvePackageCropBbox`), not from the step's settings. The
  // field is now `packageDetection?: boolean` and its ABSENCE leaves the
  // resolved tree intact (before, it stripped it, and the "baseline" was not the
  // baseline).
  it('turns on package-detection when the overlay declares a package zone', () => {
    // The same authority as production: drawing the zone IS the activation
    // (`pipeline-resolver.ts:62`). The replay does not introduce a second
    // switch — there are already two that wrote a store nobody
    // read (CLAUDE.md, D62).
    const plan = buildReplayPlan(base, {
      packageZone: { x: 0.1, y: 0.55, w: 0.3, h: 0.25 },
    })
    const pkg = plan.steps.find((s) => s.addonId === 'package-detection')
    expect(pkg?.enabled).toBe(true)
  })

  it('without a package zone the step does NOT appear, even if the overlay moves its threshold', () => {
    const plan = buildReplayPlan(base, {
      stepSettings: { 'package-detection': { minConfidencePackage: 0.3 } },
    })
    expect(plan.steps.find((s) => s.addonId === 'package-detection')).toBeUndefined()
    // And the attempt is not silent: the ignored overlay is reported.
    expect(plan.ignoredOverlays).toContain('package-detection')
  })

  it('the threshold goes in settings on the step, where runPipeline reads it', () => {
    const plan = buildReplayPlan(base, {
      stepSettings: { 'object-detection': { minConfidencePerson: 0.4 } },
    })
    const od = plan.steps.find((s) => s.addonId === 'object-detection')
    expect(od?.settings?.['minConfidencePerson']).toBe(0.4)
    // The key is `minConfidence<Macro>` and not `minConfidence`: it is the one
    // that `executor.macroFilterVerdict` composes (`executor.ts:1556`). A bare
    // `minConfidence` on a root detector filters NOTHING.
    expect(od?.settings?.['minConfidence']).toBeUndefined()
  })

  it('a model chosen by the operator replaces the resolved one, explicitly', () => {
    const plan = buildReplayPlan(base, { stepModels: { 'object-detection': 'yolov9m-640' } })
    expect(plan.steps[0]?.modelId).toBe('yolov9m-640')
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement the minimum.** For the activation of the package step
      **replicate the rule, do not copy the function**: `applyPackageZoneActivation`
      lives in `addon-pipeline-orchestrator` and addons do not import each other.
      The test above pins the rule; if production changes one day,
      `packages/addon-pipeline-orchestrator/src/__tests__/package-zone-activation.spec.ts`
      and this test diverge, and that is exactly the signal that is needed.
- [ ] **Step 4 — green, disarm the line that copies `settings`, confirm red.**

### Task B2: the engine — and where everything it produces ends up

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-run.ts` <!-- drift-ok: this plan creates it -->
- Create: `.../replay/__tests__/replay-run.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `runReplay(deps: ReplayRunDeps, plan: ReplayPlan, frames: readonly ReplayFrame[]): Promise<ReplayVerdict>`
- Consumes: `runPipeline` injected (node-pinned), a `FrameProcessor` built
  from the deps

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runReplay } from '../replay-run.js'
import { fakeReplayDeps, oneFrame, frameResultWith } from './replay-fixtures.js'

describe('runReplay', () => {
  it('calls runPipeline ONCE per frame, in time order', async () => {
    const deps = fakeReplayDeps()
    await runReplay(deps, plan, [oneFrame(0), oneFrame(500), oneFrame(1000)])
    expect(deps.runPipeline).toHaveBeenCalledTimes(3)
    const timestamps = deps.runPipeline.mock.calls.map((c) => c[0].timestamp)
    expect(timestamps).toEqual([0, 500, 1000])
  })

  it('PINS the node on every call — the replay does not run wherever it happens', async () => {
    const deps = fakeReplayDeps()
    await runReplay({ ...deps, nodeId: 'agent-128' }, plan, [oneFrame(0), oneFrame(500)])
    for (const call of deps.runPipeline.mock.calls) {
      expect(call[0].nodeId).toBe('agent-128')
    }
  })

  it('carries discarded[] into the verdict — it is the answer to "why did it not see it"', async () => {
    const deps = fakeReplayDeps()
    deps.runPipeline.mockResolvedValue(
      frameResultWith({
        detections: [],
        discarded: [{ bbox: [10, 10, 60, 60], macroClass: 'package', score: 0.41, reason: 'below-threshold' }],
      }),
    )
    const verdict = await runReplay(deps, plan, [oneFrame(0)])
    expect(verdict.discarded).toHaveLength(1)
    expect(verdict.discarded[0]?.reason).toBe('below-threshold')
  })

  it('does NOT touch any production store', async () => {
    // The guard of Task 0.1 prevents the import. This test covers the case the
    // guard does not see: a write passed through an injected dependency. The
    // two defences are deliberately different.
    const deps = fakeReplayDeps()
    await runReplay(deps, plan, [oneFrame(0)])
    expect(deps.trackStore.upsert).not.toHaveBeenCalled()
    expect(deps.mediaStore.put).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('a frame the node refuses is COUNTED and logged, and the run continues', async () => {
    const deps = fakeReplayDeps()
    deps.runPipeline.mockRejectedValueOnce(new Error('node busy'))
    const verdict = await runReplay(deps, plan, [oneFrame(0), oneFrame(500)])
    expect(verdict.counters.framesFailed).toBe(1)
    expect(verdict.counters.framesRan).toBe(1)
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('replay: frame'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('stops on the budget and declares it — complete: false, never a mute truncation', async () => {
    const deps = fakeReplayDeps({ budgetMs: 0 })
    const verdict = await runReplay(deps, plan, [oneFrame(0), oneFrame(500), oneFrame(1000)])
    expect(verdict.complete).toBe(false)
    expect(verdict.counters.framesRan).toBeLessThan(3)
  })

  it('a run that did not execute EVEN ONE frame is not "zero detections"', async () => {
    // The confusion that makes the tool useless: an empty screen because the
    // model saw nothing and an empty screen because nothing ran are the same
    // image. The verdict tells them apart in the type.
    const deps = fakeReplayDeps()
    deps.runPipeline.mockRejectedValue(new Error('node offline'))
    const verdict = await runReplay(deps, plan, [oneFrame(0)])
    expect(verdict.kind).toBe('no-frame-ran')
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement the minimum.**

```ts
/**
 * A replay run: N frames, in order, against ONE freshly built `FrameProcessor`.
 *
 * ## Where the results end up
 *
 * In memory, and then in `pipeline-analytics:replay-runs`. **Never** in `tracks`,
 * `object-events`, `media`. It is not discipline: it is a property of the shape.
 * The one who persists in production is `pipeline-analytics/index.ts:5355 processFrame`, and
 * this module does not call it — it directly builds a `FrameProcessor`
 * (`pipeline/frame-processor.ts:247`), which is synchronous and does no I/O. The
 * tracks coming out of here never had a path to the timeline.
 *
 * ## Where it runs
 *
 * The DIRECTION sits on the post-analysis node (`postProcessingNodeId`, default
 * `hub`) because that is where the `FrameProcessor` exists. INFERENCE does not:
 * every call carries `nodeId`, and the default is an agent. A run that ran on the
 * hub would compete with the recording of thirty cameras on a machine already
 * at 85% memory — and `runPipeline` has always accepted `nodeId`
 * (`pipeline-executor.cap.ts:604`), so there is nothing to build, only something
 * not to forget. The node is chosen before the run and **does not rotate**: a run
 * that changed node halfway would compare two engines.
 *
 * ## Why a failure does not stop the run
 *
 * One lost frame out of forty is a hole; the run stays readable. A run
 * interrupted at the first hiccup is not. Every loss is counted and logged with
 * `tags: { deviceId }`, and `complete` says whether the census is intact — the same
 * reading that `docs/architecture/post-analysis.md:717` documents for the rebuild.
 */
```

- [ ] **Step 4 — the pacing.** Between one frame and the next, `pacingMs` (default 50,
      like the rebuild). The value in force must be **logged at the start and at
      the end**, so that a deliberately slow run reads differently from a stuck run.
- [ ] **Step 5 — green, then disarm**: remove the `nodeId` from the call and
      confirm the pin test turns red; put a write on
      `trackStore` back and confirm the isolation test turns red.

### Task B3: the replay collection, separate from everything

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-store.ts` <!-- drift-ok: this plan creates it -->
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/index.ts` (`declare()` in `onInitialize`)

- [ ] Collection `pipeline-analytics:replay-runs`, with the `@durable` annotation
      in the shape of `store/ops-log-store.ts:25-34`. **Declare it in
      `onInitialize` before the first insert** — an undeclared collection
      sends the runner into a crash loop (ibid. line `6`).
- [ ] `retention`: its own, independent. A run is diagnostic material and
      must never enter the tracks sweep
      (`docs/reference/storage.md:175`: `pipeline-analytics:tracks` is the cascading
      ROOT — deleting a track takes away its events, media, faces,
      plates and the CLIP vector). A run that ended up there would become, by
      construction, capable of dragging production data away.
- [ ] One row per run: `replayRunId`, `deviceId`, the source, the plan
      (`steps` + `settings` + zones) **serialised in full**, the counters, the
      verdict. The whole plan and not a summary: without it a comparison
      between two runs of yesterday is not reconstructible, and that is the whole point.
- [ ] Test: a written run reads back identical. Test: the tracks retention sweep
      does not touch `replay-runs` (call it and count the rows before
      and after).
- [ ] Update `docs/reference/storage.md` — **no**: it is generated at commit. Run
      the generation and verify the row appears.

---

## Track C — the comparison, which is the reason for everything else

### Task C1: two verdicts, one delta

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/replay/replay-diff.ts` <!-- drift-ok: this plan creates it -->
- Create: `.../replay/__tests__/replay-diff.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `diffReplayRuns(a: ReplayVerdict, b: ReplayVerdict): ReplayDiff`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { diffReplayRuns } from '../replay-diff.js'
import { verdict, track, discarded } from './replay-fixtures.js'

describe('diffReplayRuns', () => {
  it('REFUSES to compare two runs on different clips', () => {
    // The comparison makes sense only with a fixed input. Two different clips
    // produce a beautiful and meaningless delta, and it is the easiest way to
    // draw the wrong conclusion with this tool in hand.
    const d = diffReplayRuns(
      verdict({ clipId: 'clip:aaa' }),
      verdict({ clipId: 'clip:bbb' }),
    )
    expect(d).toEqual({ kind: 'incomparable', reason: 'different-input' })
  })

  it('REFUSES to compare two runs on different nodes', () => {
    // Two nodes = two engines, potentially two model formats. The delta would
    // measure the hardware, not the configuration.
    const d = diffReplayRuns(
      verdict({ clipId: 'c', nodeId: 'hub' }),
      verdict({ clipId: 'c', nodeId: 'agent-128' }),
    )
    expect(d).toEqual({ kind: 'incomparable', reason: 'different-node' })
  })

  it('names the knobs that changed, and ONLY those', () => {
    const d = diffReplayRuns(
      verdict({ clipId: 'c', settings: { 'package-detection': { minConfidencePackage: 0.5 } } }),
      verdict({ clipId: 'c', settings: { 'package-detection': { minConfidencePackage: 0.3 } } }),
    )
    if (d.kind !== 'compared') throw new Error('expected compared')
    expect(d.changedKnobs).toEqual([
      { stepId: 'package-detection', key: 'minConfidencePackage', from: 0.5, to: 0.3 },
    ])
  })

  it('a track that appears only in B is "gained"', () => {
    const d = diffReplayRuns(
      verdict({ clipId: 'c', tracks: [] }),
      verdict({ clipId: 'c', tracks: [track({ className: 'package', firstSeenMs: 1000 })] }),
    )
    if (d.kind !== 'compared') throw new Error('expected compared')
    expect(d.tracks.gained).toHaveLength(1)
    expect(d.tracks.lost).toHaveLength(0)
  })

  it('a box that was discarded in A and passes in B names the reason for the discard', () => {
    // It is the sentence the operator wants to read: "this box was already there,
    // `below-threshold` was throwing it away, now it passes". Without it the delta
    // says that something appeared and not from where.
    const d = diffReplayRuns(
      verdict({ clipId: 'c', discarded: [discarded({ macroClass: 'package', score: 0.41, reason: 'below-threshold' })] }),
      verdict({ clipId: 'c', detections: [{ macroClass: 'package', score: 0.41 }] }),
    )
    if (d.kind !== 'compared') throw new Error('expected compared')
    expect(d.promoted).toEqual([{ macroClass: 'package', score: 0.41, wasDiscardedBy: 'below-threshold' }])
  })

  it('two identical runs produce an EMPTY delta, not a delta of noise', () => {
    // The test that protects the tool from itself. If identical runs show
    // differences (random ids, timestamps, order), every true delta drowns.
    const v = verdict({ clipId: 'c', tracks: [track({ className: 'person' })] })
    const d = diffReplayRuns(v, v)
    if (d.kind !== 'compared') throw new Error('expected compared')
    expect(d.tracks.gained).toEqual([])
    expect(d.tracks.lost).toEqual([])
    expect(d.changedKnobs).toEqual([])
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement the minimum.** The pairing between tracks of two runs is
      by `(className, time window, IoU)`, **not by `trackId`**: the
      tracker assigns new ids on every run and pairing by id would always give
      "everything lost, everything gained".
- [ ] **Step 4 — green, then DISARM the `different-input` refusal** and confirm
      the first test turns red. It is the refusal that makes the tool
      honest; if it goes, the rest is of no use.

### Task C2: the page

In the addon, via `addon-pages-source` — **never** in `packages/addon-admin-ui/**`.

- [ ] A run is launched from an existing track ("replay the 30 s around this
      event") **and** from a hand-chosen window. The first is the true gesture: you
      arrive here from an absence, and the absence is looked at on the timeline.
- [ ] The `package` zone is drawn on the first frame of the clip, with the editor
      that already exists for retrain annotation — not a second canvas.
- [ ] Every discarded box is drawn as a ghost with its `reason`. It is the same
      thing the viewer already does with `FrameResult.discarded`
      (`docs/architecture/detection-execution.md:340`), here on a still input.
- [ ] The comparison is the **primary** view, not a secondary tab: two runs
      side by side, and the changed knobs at the top. A page that shows one run at
      a time produces an uploader with an "analyse" button.
- [ ] Every screen that can be empty says WHY: `no-frame-ran`, `busy`,
      `refused: model-substituted`, `complete: false`. Never a bare empty screen.

---

## Out of scope, on purpose

- **It is not a second detection engine.** Every inference goes through
  `pipelineExecutor.runPipeline`; every track comes out of `FrameProcessor`. If in
  a task you need a copy of either, the plan has grown too much:
  stop and report it.
- **It is not a generic uploader.** The upload is one of the two sources and comes
  last (Task A4). If `replayClips` starts to look like a media library, it has
  grown too much.
- **It is not a new storage format.** A clip is a file on a `storage` location;
  a run is a row in a declared collection.
- **Do not touch `runStatelessStep`.** It has two real defects for THIS use
  (no `settings`, `discarded` thrown away) and a potential one (the crop under
  `square: true`), but it is the path of the embedding rebuild and the face
  re-embed, where it works and is tested. The replay goes around it; fixing it is
  a job of its own. See the unknowns.
- **Do not add a switch for `package-detection`.** The activation is the zone
  (`pipeline-resolver.ts:43-58`). A second switch is exactly the mistake
  `packageDropEnabled` already was (`step-definitions.ts:441`).
- **Do not run a replay from the hub by default.** `nodeId` is mandatory in the
  plan, not optional.
- **Do not touch `packages/addon-admin-ui/**`.**

---

## What remains unknown and must be MEASURED, not assumed

- **Whether the package of 2026-08-26 is visible in that frame.** Nothing in this
  plan proves it. The plan builds the tool that makes the question decidable in a
  minute instead of at the next courier. The answer may be "the model does not
  even see it on the zone at 0.30", and it would be a useful answer — today we do
  not have it.
- **Whether 101's recording covers 18:12.** `RecordedStillService`
  distinguishes `no-recording` from `no-footage` precisely because they are
  different things, but which of the two holds for that instant **has not been
  verified** (no task of this plan touches the hub). Verify it with a
  `locateSegment` before building track A: if the footage is not there, `recording`
  does not cover the case and A4 (upload) becomes the first task, not the last.
- **How much a run costs.** Not estimated, and estimates here are worth little: the
  cost is `frames × (decode + one runPipeline)` and the second depends on the
  model, the `deviceKey` and the node. **Measure**: a 10 s run at 4 fps on an
  agent, with `getLocalLoad` read before and after. The number to know before
  exposing the button is that one, not an extrapolation from the benchmark — which
  measures hot throughput on a repeated frame (`runPipelineBatch.frameId`,
  `pipeline-executor.cap.ts:696`), that is the opposite thing.
- **What a run does when the chosen node is busy.** The plan says "refuse and say
  so", but the threshold (`getAgentLoad` above what?) is not chosen because there
  is no measurement. Do it after the first real run, not before.
- **The whole-frame crop under `square: true`.** `deriveDetailCropRect`
  (`packages/types/src/pipeline/detail-crop.ts:207`) with `square: true` calls
  `squareInPixels`, which collapses onto the short side of the frame: on a 16:9 a
  bbox `{0,0,1,1}` becomes a **central square**, not the frame. The header of
  `FULL_IMAGE_BBOX` (line `162`) declares the identity and argues it *"for a
  SQUARE image"* — which is true and does not cover the 16:9 case. The default is
  `square: false` (line `89`), so **today it does not bite**. But
  `proposeRetrainAnnotations({ kind: 'objects' })` goes exactly through there with
  `WHOLE_FRAME` (`retrain-assist.ts:48`), on camera frames that are not square.
  **It must be measured**: set `square: true` on the test cluster, ask for a
  whole-frame proposal on a 16:9, and see whether the delivered crop is the
  frame. If it is not, it is a live bug that this plan found and does not fix —
  open it separately, not inside the replay.
- **Whether `FrameProcessor` is constructible outside `index.ts`.** The constructor is
  at `frame-processor.ts:314` and takes injected config, but `index.ts` is 13,008
  lines and that construction was not read line by line. If the real construction
  turns out to be entangled with addon state, Task B2 must be renegotiated
  **before** writing code, not worked around with a second copy of the tracker.
- **The right retention for a clip and for a run.** Not chosen. A number invented
  here would be the third retention window of this repo chosen without a
  measurement. Start generous and with a hard ceiling on the count, then look at
  how much space it takes in a week.
