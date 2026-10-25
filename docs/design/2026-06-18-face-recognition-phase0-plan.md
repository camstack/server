# Face Recognition — Phase 0 (runner: expose the face embedding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The detection pipeline stops discarding the arcface face embedding and instead exposes the normalized 512-d vector on the detection (on the `face` detail and inherited to its parent person), so `addon-post-analysis` can match faces in a later phase.

**Architecture:** Approach B (see `docs/design/2026-06-18-face-recognition-design.md` §3 — that document was never committed to this repo) <!-- drift-ok -->: the runner change is minimal. The arcface postprocessor already L2-normalizes the vector (`dispatch.ts` `postprocessArcface` → `embeddingNorm`). Today `result-assembler.applyChildOutput` collapses that output to an opaque `embedding:<dim>d` marker label and throws the vector away. We add two optional fields to `ObjectDetection` (`embedding`, `embeddingModelId`), store the normalized vector on the `face` detail in the `embedding` case, and inherit it onto the parent person in `buildFrameResult` (mirroring the existing label inheritance). The back-compat marker label is kept (it is already filtered downstream by `label-utils`).

**Tech Stack:** TypeScript 5.9 (strict, ESM, NodeNext), vitest, nx monorepo, `@camstack/types` (vite + tsc `--emitDeclarationOnly`). Python postprocessors are unchanged.

## Global Constraints

- **Immutability:** `ObjectDetection` and all its fields are `readonly`. New fields are `readonly embedding?: readonly number[]` / `readonly embeddingModelId?: string`. Never mutate an emitted detection; the only mutation site is the per-frame `MutableObjectDetection` accumulator.
- **Backward compatibility:** the field is OPTIONAL — older runners / disabled face-embedding steps emit detections with no `embedding`, and every consumer must tolerate its absence. Keep the existing `embedding:<dim>d` marker label (do not remove it in Phase 0).
- **Expose the NORMALIZED vector** (`output.embeddingNorm`), not the raw `output.embedding`. Dimension is derivable from `embedding.length` — do NOT add a separate `dim` field.
- **Strip-undefined discipline:** follow the assembler's existing `...(cond ? { field } : {})` spread style so absent fields never serialize as `undefined`.
- **Type gate:** `cd packages/addon-pipeline && npx tsc --noEmit` must pass. Project-wide gate is `npm run ts-check`.
- **Commit hygiene:** commit with `git commit --no-verify` (the lint-staged/eslint pre-commit hook hangs on the monorepo type graph). The real gates are `tsc --noEmit` + vitest.
- **Conventional commits**, no attribution trailers (match repo history).
- **Deploy (after all tasks):** rebuild `@camstack/types` BEFORE deploying because a shared type changed: `npm run build -w packages/types`, then `camstack deploy packages/addon-pipeline --server https://localhost:4443`.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/types/src/types/detection.ts` | The shared `ObjectDetection` contract carried over the bus. | Add `embedding?` + `embeddingModelId?` optional fields. |
| `packages/addon-pipeline/src/detection-pipeline/pipeline/result-assembler.ts` | Per-frame assembly: accumulate enrichments on `MutableObjectDetection`, inherit child→parent, emit immutable `ObjectDetection[]`. | Add the same fields to `MutableObjectDetection`; store the vector in the `embedding` case; emit own + inherited embedding in `toImmutableObject`. |
| `packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts` | New unit spec — locks the embedding contract in isolation (no engine). | Create. Mirrors `result-assembler-debug.spec.ts`. |

No zod schema change is needed: the bus payload (`PipelineInferenceResultPayload` in `packages/types/src/interfaces/event-bus.ts`) carries `frame: FrameResult` as a plain interface with a `[key: string]: unknown` forward-compat index, so an added optional field on `ObjectDetection` flows through automatically.

**Interfaces produced by this plan (consumed by Phase 1):**
- `ObjectDetection.embedding?: readonly number[]` — the L2-normalized arcface vector (length 512 for arcface-r100), present on a `face` detail and on its parent person detection; absent otherwise.
- `ObjectDetection.embeddingModelId?: string` — the arcface step's `modelId` (e.g. `arcface-r100`), present iff `embedding` is present.

---

### Task 1: Add the optional embedding fields and emit a detection's OWN embedding

A detection that carries an embedding on its `MutableObjectDetection` accumulator must surface it on the emitted immutable `ObjectDetection`. This covers the `face` detail (which is where arcface runs). The type fields are scaffolding this task's test needs, so they live here.

**Files:**
- Modify: `packages/types/src/types/detection.ts` (`ObjectDetection`, ~231-241)
- Modify: `packages/addon-pipeline/src/detection-pipeline/pipeline/result-assembler.ts` (`MutableObjectDetection` ~55-85; `toImmutableObject` base object ~342-352)
- Test: `packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts` (create)

**Interfaces:**
- Consumes: `buildFrameResult(input: BuildFrameResultInput): FrameResult`, `MutableObjectDetection` (both exported from `../pipeline/result-assembler.js`).
- Produces: `ObjectDetection.embedding?: readonly number[]`, `ObjectDetection.embeddingModelId?: string`; `MutableObjectDetection.embedding?: readonly number[]`, `MutableObjectDetection.embeddingModelId?: string`.

- [ ] **Step 1: Write the failing test**

Create `packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  buildFrameResult,
  type MutableObjectDetection,
} from '../pipeline/result-assembler.js'

/** A face detail accumulator carrying a stored, normalized embedding. */
function makeFaceDetail(id: string, parentId: string): MutableObjectDetection {
  return {
    id,
    kind: 'detail',
    macroClass: 'face',
    score: 0.9,
    bbox: [10, 10, 50, 60],
    parentId,
    ownLabels: [],
    alternateLabels: {},
    stepLatencyMs: {},
    modelIds: {},
    embedding: [0.5, 0.5, 0.5, 0.5],
    embeddingModelId: 'arcface-r100',
  }
}

function buildArgs(dets: MutableObjectDetection[]) {
  const firstLevel = dets.filter((d) => d.kind === 'first-level')
  const details = dets.filter((d) => d.kind === 'detail')
  return {
    deviceId: 99,
    width: 1920,
    height: 1080,
    firstLevel,
    details,
    stepTimings: [],
    totalMs: 1,
    engine: 'test',
    debug: false,
    timestamp: 1000,
  }
}

describe('result-assembler — embedding exposure', () => {
  it("emits a face detail's own normalized embedding + model id", () => {
    const face = makeFaceDetail('d2', 'd1')
    const frame = buildFrameResult(buildArgs([face]))

    const emitted = frame.detections.find((d) => d.id === 'd2')
    expect(emitted?.embedding).toEqual([0.5, 0.5, 0.5, 0.5])
    expect(emitted?.embeddingModelId).toBe('arcface-r100')
  })

  it('omits embedding fields on a detection that has none', () => {
    const face = makeFaceDetail('d2', 'd1')
    delete (face as { embedding?: unknown }).embedding
    delete (face as { embeddingModelId?: unknown }).embeddingModelId
    const frame = buildFrameResult(buildArgs([face]))

    const emitted = frame.detections.find((d) => d.id === 'd2')
    expect('embedding' in (emitted ?? {})).toBe(false)
    expect('embeddingModelId' in (emitted ?? {})).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts`
Expected: FAIL — TypeScript error that `embedding` / `embeddingModelId` do not exist on `MutableObjectDetection`, and the first assertion fails because the emitted detection has no `embedding`.

- [ ] **Step 3: Add the optional fields to `ObjectDetection`**

In `packages/types/src/types/detection.ts`, inside `interface ObjectDetection` (after the `parentId?` field, ~line 240):

```typescript
  /**
   * Normalized (L2, ||v||=1) face/biometric embedding produced by an
   * in-pipeline embedding step (arcface, `inputClasses:['face']`). Present on
   * the `face` detail that arcface ran on, and inherited onto its parent
   * person detection (same per-`parentId` inheritance as labels). Absent when
   * no embedding step ran or the runner predates this field. Length is the
   * model's dimension (512 for arcface-r100) — derive `dim` from `.length`.
   */
  readonly embedding?: readonly number[]
  /** Model id that produced `embedding` (e.g. `arcface-r100`). Present iff
   *  `embedding` is present — lets consumers skip samples from a stale model. */
  readonly embeddingModelId?: string
```

- [ ] **Step 4: Add the same fields to `MutableObjectDetection`**

In `packages/addon-pipeline/src/detection-pipeline/pipeline/result-assembler.ts`, inside `interface MutableObjectDetection` (after `embeddingId?` ~line 85):

```typescript
  /** Normalized face embedding stored by an arcface embedding step (the
   *  vector itself, not the opaque marker). Inherited to the parent in
   *  `buildFrameResult`. */
  embedding?: readonly number[]
  /** Model id of the embedding step that produced `embedding`. */
  embeddingModelId?: string
```

- [ ] **Step 5: Emit the detection's own embedding in `toImmutableObject`**

In `result-assembler.ts`, in `toImmutableObject`, extend the `base` object literal (currently ~lines 344-352). Replace:

```typescript
    const base: ObjectDetection = {
      id: m.id,
      kind: m.kind,
      macroClass: m.macroClass,
      score: m.score,
      bbox,
      labels,
      ...(m.parentId !== undefined ? { parentId: m.parentId } : {}),
    }
```

with:

```typescript
    const base: ObjectDetection = {
      id: m.id,
      kind: m.kind,
      macroClass: m.macroClass,
      score: m.score,
      bbox,
      labels,
      ...(m.parentId !== undefined ? { parentId: m.parentId } : {}),
      ...(m.embedding !== undefined
        ? {
            embedding: m.embedding,
            ...(m.embeddingModelId !== undefined ? { embeddingModelId: m.embeddingModelId } : {}),
          }
        : {}),
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/types/detection.ts \
        packages/addon-pipeline/src/detection-pipeline/pipeline/result-assembler.ts \
        packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts
git commit --no-verify -m "feat(pipeline): carry an optional normalized embedding on ObjectDetection"
```

---

### Task 2: Store the normalized arcface vector in the `embedding` case of `applyChildOutput`

When the arcface step's output reaches `applyChildOutput`, store the normalized vector + the step's model id on the `face` detail (`parent`). Keep pushing the existing `embedding:<dim>d` marker label for back-compat.

**Files:**
- Modify: `packages/addon-pipeline/src/detection-pipeline/pipeline/result-assembler.ts` (`case 'embedding'` ~250-256)
- Test: `packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts` (add a test)

**Interfaces:**
- Consumes: `applyChildOutput(parent, childStep, output, stepLatencyMs, ctx)` (exported); `AssemblyContext`, `FrameIdGenerator` (exported); the embedding `StepOutput` variant `{ kind: 'embedding'; embedding: readonly number[]; embeddingNorm: readonly number[] }` (from `dispatch.ts` `postprocessArcface`).
- Produces: after this task, `parent.embedding === output.embeddingNorm` and `parent.embeddingModelId === childStep.modelId` for an embedding output.

- [ ] **Step 1: Write the failing test**

Append to `result-assembler-embedding.spec.ts`. Add `applyChildOutput`, `FrameIdGenerator`, and `type AssemblyContext` to the import from `../pipeline/result-assembler.js`, then add:

```typescript
import {
  applyChildOutput,
  FrameIdGenerator,
  type AssemblyContext,
} from '../pipeline/result-assembler.js'
import type { ExecutableStep } from '../pipeline/tree-builder.js'

/** Minimal arcface step — applyChildOutput only reads stepId + modelId here.
 *  The heavy `definition`/`engine` fields are unused on the embedding path. */
function fakeArcfaceStep(): ExecutableStep {
  return { stepId: 'face-embedding', modelId: 'arcface-r100' } as unknown as ExecutableStep
}

describe('result-assembler — applyChildOutput embedding case', () => {
  it('stores the normalized vector + model id on the parent face detail', () => {
    const face = makeFaceDetail('d2', 'd1')
    delete (face as { embedding?: unknown }).embedding
    delete (face as { embeddingModelId?: unknown }).embeddingModelId

    const ctx: AssemblyContext = { idGen: new FrameIdGenerator(), details: [] }
    applyChildOutput(
      face,
      fakeArcfaceStep(),
      { kind: 'embedding', embedding: [3, 4], embeddingNorm: [0.6, 0.8] },
      12,
      ctx,
    )

    expect(face.embedding).toEqual([0.6, 0.8]) // normalized, not raw [3,4]
    expect(face.embeddingModelId).toBe('arcface-r100')
    // back-compat marker is still emitted
    expect(face.ownLabels.some((l) => l.label === 'embedding:2d')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts`
Expected: FAIL — `face.embedding` is `undefined` (the case only pushes the marker today).

- [ ] **Step 3: Store the vector in the `embedding` case**

In `result-assembler.ts`, replace the `case 'embedding'` block (~250-256):

```typescript
    case 'embedding': {
      parent.ownLabels.push({
        label: `embedding:${output.embedding.length}d`,
        score: 1.0,
      })
      break
    }
```

with:

```typescript
    case 'embedding': {
      // Expose the normalized vector for downstream face recognition
      // (addon-post-analysis). Stored on the face detail; inherited to the
      // parent person in buildFrameResult.
      parent.embedding = output.embeddingNorm
      parent.embeddingModelId = childStep.modelId
      // Keep the opaque marker for back-compat — downstream label-utils
      // already filters `embedding:*` out of user-visible labels.
      parent.ownLabels.push({
        label: `embedding:${output.embedding.length}d`,
        score: 1.0,
      })
      break
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-pipeline/src/detection-pipeline/pipeline/result-assembler.ts \
        packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts
git commit --no-verify -m "feat(pipeline): store the arcface normalized embedding on the face detail"
```

---

### Task 3: Inherit the best face child's embedding onto the parent person

A person first-level detection has no embedding of its own; it must inherit the embedding from its best (highest-score) `face` detail child, mirroring the existing label inheritance. The face detail keeps its own embedding too.

**Files:**
- Modify: `packages/addon-pipeline/src/detection-pipeline/pipeline/result-assembler.ts` (`toImmutableObject` ~328-352)
- Test: `packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts` (add a test)

**Interfaces:**
- Consumes: `buildFrameResult`; the `detailsByParent` map + `children` list already computed inside `toImmutableObject`.
- Produces: a parent person `ObjectDetection` whose `embedding` / `embeddingModelId` equal those of its highest-score face child that carries an embedding.

- [ ] **Step 1: Write the failing test**

Append to `result-assembler-embedding.spec.ts` (reuses `makeFaceDetail` / `buildArgs`):

```typescript
function makePerson(id: string): MutableObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.8,
    bbox: [0, 0, 200, 400],
    ownLabels: [],
    alternateLabels: {},
    stepLatencyMs: {},
    modelIds: {},
  }
}

describe('result-assembler — parent inherits best face embedding', () => {
  it('person inherits the higher-score face child embedding; faces keep their own', () => {
    const person = makePerson('d1')
    const faceA = makeFaceDetail('d2', 'd1') // score 0.9, [0.5,0.5,0.5,0.5]
    const faceB = makeFaceDetail('d3', 'd1')
    ;(faceB as { score: number }).score = 0.4
    ;(faceB as { embedding: readonly number[] }).embedding = [0.1, 0.2, 0.3, 0.4]

    const frame = buildFrameResult(buildArgs([person, faceA, faceB]))

    const emittedPerson = frame.detections.find((d) => d.id === 'd1')
    expect(emittedPerson?.embedding).toEqual([0.5, 0.5, 0.5, 0.5]) // from faceA (0.9 > 0.4)
    expect(emittedPerson?.embeddingModelId).toBe('arcface-r100')

    // each face still carries its own embedding
    expect(frame.detections.find((d) => d.id === 'd2')?.embedding).toEqual([0.5, 0.5, 0.5, 0.5])
    expect(frame.detections.find((d) => d.id === 'd3')?.embedding).toEqual([0.1, 0.2, 0.3, 0.4])
  })

  it('a person with no embedding-bearing children emits no embedding', () => {
    const person = makePerson('d1')
    const face = makeFaceDetail('d2', 'd1')
    delete (face as { embedding?: unknown }).embedding
    delete (face as { embeddingModelId?: unknown }).embeddingModelId

    const frame = buildFrameResult(buildArgs([person, face]))
    expect('embedding' in (frame.detections.find((d) => d.id === 'd1') ?? {})).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts`
Expected: FAIL — the person's `embedding` is `undefined` (no inheritance yet).

- [ ] **Step 3: Inherit the best child embedding in `toImmutableObject`**

In `result-assembler.ts`, in `toImmutableObject`, the `children` array is already computed (~line 331). Just before the `const bbox = bboxTupleToRect(m.bbox)` line, insert the effective-embedding resolution:

```typescript
    // Effective embedding: a detection's own (the face detail arcface ran on),
    // else inherited from its best (highest-score) embedding-bearing child
    // (the parent person inherits its face's vector — same child→parent flow
    // as labels). One face per parent in practice; ties resolve to the first.
    let embedding = m.embedding
    let embeddingModelId = m.embeddingModelId
    if (embedding === undefined) {
      let best: MutableObjectDetection | undefined
      for (const child of children) {
        if (child.embedding === undefined) continue
        if (best === undefined || child.score > best.score) best = child
      }
      if (best !== undefined) {
        embedding = best.embedding
        embeddingModelId = best.embeddingModelId
      }
    }
```

Then change the `base` object's embedding spread (added in Task 1, Step 5) to use the resolved locals instead of `m.embedding`:

```typescript
      ...(embedding !== undefined
        ? {
            embedding,
            ...(embeddingModelId !== undefined ? { embeddingModelId } : {}),
          }
        : {}),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-pipeline/src/detection-pipeline/pipeline/result-assembler.ts \
        packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts
git commit --no-verify -m "feat(pipeline): inherit the best face embedding onto the parent person"
```

---

### Task 4: Verify, rebuild `@camstack/types`, and deploy

Lock the whole package green, regenerate the shared types build (a shared type changed → required before deploy), and ship to the hub.

**Files:** none (build + verify + deploy only).

- [ ] **Step 1: Typecheck the pipeline package**

Run: `cd packages/addon-pipeline && npx tsc --noEmit`
Expected: no output (clean). Return to repo root afterwards.

- [ ] **Step 2: Run the full result-assembler suite (no regressions)**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-embedding.spec.ts packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-debug.spec.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 3: Project-wide type gate**

Run (repo root): `npm run ts-check`
Expected: clean (this is the CI gate). If `ts-check` is too broad/slow, the per-package `tsc --noEmit` from Step 1 plus `npm run build -w packages/types` (Step 4) covers the changed surface.

- [ ] **Step 4: Rebuild `@camstack/types`**

Run (repo root): `npm run build -w packages/types`
Expected: `vite build` + `tsc --emitDeclarationOnly` succeed; `packages/types/dist` regenerated with the new optional fields in the `.d.ts`. <!-- drift-ok: dist/ is a gitignored build output, absent until `npm run build` runs -->

- [ ] **Step 5: Deploy the runner**

Run (repo root): `camstack deploy packages/addon-pipeline --server https://localhost:4443`
Expected: `✓ Deployed` + `✓ Hub healthy`.

- [ ] **Step 6: Empirically verify the vector ships (cam99)**

cam99 (deviceId 99) runs the full pipeline (object-detection → face-detection/scrfd → face-embedding/arcface-r100). After redeploy, confirm a recent person/face detection on the `pipeline-analytics` inference feed carries a non-empty `embedding` (length 512) and `embeddingModelId: 'arcface-r100'`. Use the same inspection path used last session for `pipeline-analytics:object-events` (better-sqlite3 from inside `packages/addon-post-analysis`, or the REPL `device.state` inspector). Absence on motion/audio-only detections is expected.

---

## Self-Review

**Spec coverage (spec §12 Phase 0):** "expose the normalized face embedding on the detection (result-assembler + optional field in `packages/types`; rebuild `@camstack/types` for deploy)." → Task 1 (optional fields + own emit), Task 2 (store normalized vector in the assembler), Task 3 (parent inheritance, the "inherited from the face detail to its parent" requirement of §4.1), Task 4 (rebuild types + deploy). ✅

**Open question #1 (spec §13 — field shape):** resolved — two first-class optional fields on `ObjectDetection` (`embedding`, `embeddingModelId`), NOT a debug-gated side-channel (debug is stripped when `traceVerbosity !== verbose`, and Phase 1's model-version check needs the model id in production). `dim` is derived from `.length`. Lowest-churn (no zod/schema edits; bus auto-forwards). ✅

**Placeholder scan:** every code step shows complete code; every run step shows the exact command + expected result. No TBD/TODO. ✅

**Type consistency:** `embedding: readonly number[]` and `embeddingModelId: string` are named identically across `ObjectDetection`, `MutableObjectDetection`, the `case 'embedding'` write (`output.embeddingNorm` / `childStep.modelId`), and all assertions. `applyChildOutput` / `buildFrameResult` / `FrameIdGenerator` / `AssemblyContext` / `MutableObjectDetection` are all real exports of `result-assembler.ts`; `ExecutableStep` is a real export of `tree-builder.ts`. ✅

**Deliberately deferred to Phase 1 (not Phase 0 gaps):** "one face per parent (best by score/area/frontality)" is only roughly approximated here (best-by-score for inheritance); per-track aggregation, gallery matching, and `dim`/`modelId` sample-stamping are Phase 1. Removing the back-compat marker is out of scope.
