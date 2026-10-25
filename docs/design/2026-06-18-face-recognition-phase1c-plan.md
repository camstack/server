# Face Recognition — Phase 1c (recognizer + wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make face recognition LIVE. Expose each track's inherited embedding, add the per-device `resolveDeviceFaceSettings` cascade, build the `FaceRecognizer` worker (per-frame match → per-track hysteresis → forward-only label propagation + best-face capture → persist at track end), wire it into `pipeline-analytics/index.ts` (processFrame, track-end, retention), and deploy.

**Architecture:** The arcface embedding already rides on first-level person detections (Phase 0, inherited from the face detail). We surface it on the tracker output by mirroring the existing `labelsByBbox` mechanism in `frame-processor.ts`. The `FaceRecognizer` consumes `(trackId, embedding, embeddingModelId, bbox, confidence)` per frame, uses the Phase-1a pure matcher (`assignUniquePerFrame` + `updateTrackAggregate`) against the in-memory gallery loaded from `IdentityStore` (Phase 1b), and on a new assignment propagates the name forward-only via `TrackStore.setLabel` + `EventStore.setLabelForTrack` (Phase 1a). It holds the best face per track (crop extracted from the live `frameHandle`) and persists one `FaceStore` entry per track at track-end. Retention reuses the existing 5-min sweep. Crop extraction is injected (`captureCrop`) so the worker is unit-testable without `sharp`.

**Tech Stack:** TypeScript 5.9 (strict, ESM NodeNext, `.js` imports), vitest. No `@camstack/types` change (Phase 0 already shipped the `ObjectDetection.embedding` field; everything here is internal to `addon-post-analysis`).

## Global Constraints

- **Gating (spec §10):** `settings.enabled === false` → recognizer no-ops entirely (no match, no buffer). `enabled === true` with an EMPTY gallery → collect faces into the buffer only (no matching). Matching runs only when the gallery is non-empty.
- **Forward-only:** on a NEW assignment (`updateTrackAggregate` returns `changed`), call `TrackStore.setLabel(trackId, name)` + `EventStore.setLabelForTrack(trackId, name)`. Never rewrite history beyond the label.
- **Best-face = highest face confidence per track.** The crop is extracted from the live `frameHandle` the moment a new best is seen (frames recycle in ms). One `FaceStore` entry per track (`faceId = \`face-${trackId}\``, upsert), `assigned: false`, `recognizedIdentityId` set iff the track was recognized.
- **Multi-face safeguard:** per-frame identity uniqueness is handled by `assignUniquePerFrame` (Phase 1a). One candidate per track (the tracked person already collapses its face child via Phase-0 inheritance).
- **Defaults (from `FaceSettings`):** τ=0.45, margin=0.05, minFaceConfidence=0.5, confirmFrames=2, bufferRetentionDays=3, bufferMaxPerDevice=50.
- **`addSample` orphan precondition (1b carry-over):** not relevant here (enrollment is Phase 3); the recognizer only READS the gallery + writes the buffer.
- **`FaceStore.insert` must receive the COMPLETE `Face` row** (1b carry-over: `set` only updates present columns).
- **Crop extraction injected:** `FaceRecognizer` takes a `captureCrop(frameHandle, bbox, frameWidth, frameHeight) => Promise<Buffer | null>` dep. Production builds it from `resolveFrame` + `extractCrop` (the same `readers`/`getRemoteFrame` the `EventMediaDispatcher` uses); tests stub it.
- **Best-effort** everywhere (try/catch + `logger.warn`); immutable inputs; ESM `.js`; strict TS. Type gate: `cd packages/addon-post-analysis && npx tsc --noEmit` clean.
- **Commit:** `git commit --no-verify`; conventional commits, no attribution trailers. **Test command:** `npx vitest run --exclude '**/.claude/**' <files>`.
- **Deploy (after all tasks):** `camstack deploy packages/addon-post-analysis --server https://localhost:4443`. No `@camstack/types` rebuild needed.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `…/pipeline/frame-processor.ts` | Tracker output. | Add `embedding?`/`embeddingModelId?` to `TrackedDetectionOut`, populated via an `embeddingByBbox` map mirroring `labelsByBbox`. |
| `…/pipeline-analytics/face-recognizer.ts` | The recognizer worker (gallery, match, aggregate, label propagation, best-face capture, track-end persist). | Create. |
| `…/store/face-store.ts` | Faces buffer. | Add `pruneAll({cutoffMs, maxPerDevice})` (group-by-device retention; no device-list dependency). |
| `…/pipeline-analytics/index.ts` | Addon wiring. | `resolveDeviceFaceSettings` + cache + invalidation; construct stores+recognizer; call `processFrame`; track-end persist; retention prune. |
| `…/__tests__/{frame-processor,face-recognizer,face-store}.spec.ts` | Tests. | Create/append. |

**Interfaces produced:**
- `TrackedDetectionOut.embedding?: readonly number[]`, `.embeddingModelId?: string`.
- `FaceRecognizer` with `refreshGallery()`, `processFrame(input: FaceProcessInput)`, `onTrackEnd(deviceId, trackId)`; types `FaceRecognizerDeps`, `FaceProcessInput`.
- `FaceStore.pruneAll({ cutoffMs, maxPerDevice }): Promise<readonly string[]>`.
- `PipelineAnalyticsAddon.resolveDeviceFaceSettings(deviceId): Promise<FaceSettings>` (private).

---

### Task 1: Expose the embedding on tracked detections

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts`
- Test: `packages/addon-post-analysis/src/pipeline-analytics/__tests__/frame-processor.spec.ts` (append; create if absent — read the dir first)

**Interfaces:**
- Consumes: `ObjectDetection.embedding`/`.embeddingModelId` (Phase 0).
- Produces: `TrackedDetectionOut.embedding?: readonly number[]`, `.embeddingModelId?: string`.

- [ ] **Step 1: Write the failing test**

Read the existing `frame-processor.spec.ts` (or a nearby processor test) for how a `FrameProcessor` is constructed + a `FrameResult` is fed. Append a test that builds a frame with one first-level person detection carrying `embedding` + `embeddingModelId`, runs `process`, and asserts the resulting `tracked[0]` carries them:

```typescript
it('surfaces a first-level detection embedding on its tracked item', () => {
  // (construct the processor as the other tests in this file do)
  const frame = makeFrame([
    { id: 'd1', kind: 'first-level', macroClass: 'person', score: 0.9,
      bbox: { x: 10, y: 10, width: 50, height: 100 }, labels: [],
      embedding: [0.1, 0.2, 0.3, 0.4], embeddingModelId: 'arcface-r100' },
  ])
  const result = processor.process({ timestamp: 1000, frame })
  const t = result.tracked[0]
  expect(t?.embedding).toEqual([0.1, 0.2, 0.3, 0.4])
  expect(t?.embeddingModelId).toBe('arcface-r100')
})
```

> Match the file's real frame/detection construction helpers. If no `frame-processor.spec.ts` exists, create it modelling another spec in the dir; the detection must be `kind:'first-level'` with a bbox so it survives flatten + tracking.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/frame-processor.spec.ts`
Expected: FAIL — `tracked[0].embedding` is `undefined` (not surfaced yet).

- [ ] **Step 3: Add the fields + the `embeddingByBbox` map**

In `frame-processor.ts`, extend `TrackedDetectionOut`:

```typescript
export interface TrackedDetectionOut {
  readonly trackId: string
  readonly className: string
  readonly confidence: number
  readonly bbox: { x: number; y: number; w: number; h: number }
  readonly zones: readonly string[]
  readonly state: TrackState
  readonly label?: string
  /** Inherited arcface face embedding (Phase 0) for this tracked person, when
   *  present. Surfaced for the FaceRecognizer; mirrors `label` via the bbox map. */
  readonly embedding?: readonly number[]
  readonly embeddingModelId?: string
}
```

In `process`, alongside the `labelsByBbox` map declaration, add:

```typescript
const embeddingByBbox = new Map<BoundingBox, { embedding: readonly number[]; embeddingModelId?: string }>()
```

In the flatten `.map(det => { ... })`, after the `labelsByBbox.set(...)` line, add:

```typescript
if (det.embedding !== undefined) {
  embeddingByBbox.set(bbox, {
    embedding: det.embedding,
    ...(det.embeddingModelId !== undefined ? { embeddingModelId: det.embeddingModelId } : {}),
  })
}
```

In the `tracked` build (`trackedDetections.map(td => { ... return {...} })`), spread the embedding fields onto the returned object:

```typescript
      const emb = embeddingByBbox.get(td.bbox)
      return {
        trackId: td.trackId,
        className: td.class,
        confidence: td.score,
        bbox: { ...td.bbox },
        zones: zonesByTrack.get(td.trackId) ?? [],
        state,
        ...(label !== undefined ? { label } : {}),
        ...(emb !== undefined ? { embedding: emb.embedding, ...(emb.embeddingModelId !== undefined ? { embeddingModelId: emb.embeddingModelId } : {}) } : {}),
      }
```

> Read the real `tracked` return literal first and merge these spreads into it without dropping existing fields (the snippet above shows the expected shape — match the file's actual field set).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/frame-processor.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/frame-processor.spec.ts
git commit --no-verify -m "feat(post-analysis): surface inherited embedding on tracked detections"
```

---

### Task 2: `resolveDeviceFaceSettings` cascade + cache + invalidation

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/index.ts`
- Test: none new (mirrors the audio/tracking resolvers, already tested at the `resolveFaceSettings` unit level in Phase 1a; the per-device cache wrapper is the same proven pattern). Verify via tsc + existing suite.

**Interfaces:**
- Consumes: `resolveFaceSettings`, `FaceSettings` (Phase 1a); `SETTINGS_CACHE_TTL_MS`, `this.ctx.settings.readDeviceStore`.
- Produces: `private resolveDeviceFaceSettings(deviceId): Promise<FaceSettings>`; `faceCacheByDevice`.

- [ ] **Step 1: Add the cache field + resolver (mirror `resolveDeviceAudioSettings`)**

Add the import near the other settings imports: `import { resolveFaceSettings, type FaceSettings } from './face-settings.js'`.

Add the field beside `trackingCacheByDevice`:

```typescript
private readonly faceCacheByDevice = new Map<number, { settings: FaceSettings; expiresAt: number }>()
```

Add the method beside `resolveDeviceTrackingSettings`:

```typescript
private async resolveDeviceFaceSettings(deviceId: number): Promise<FaceSettings> {
  const now = Date.now()
  const cached = this.faceCacheByDevice.get(deviceId)
  if (cached && now < cached.expiresAt) return cached.settings
  const raw = (await this.ctx?.settings?.readDeviceStore(deviceId)) ?? {}
  const settings = resolveFaceSettings(raw)
  this.faceCacheByDevice.set(deviceId, { settings, expiresAt: now + SETTINGS_CACHE_TTL_MS })
  return settings
}
```

- [ ] **Step 2: Add cache invalidation at the two existing sites**

In the `DeviceBindingsChanged` handler (where `trackingCacheByDevice.delete` is called) and the `DeviceUnregistered` handler, add:

```typescript
this.faceCacheByDevice.delete(deviceId) // (or data.deviceId, matching the surrounding lines)
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/addon-post-analysis && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/index.ts
git commit --no-verify -m "feat(post-analysis): per-device face-settings resolver + cache invalidation"
```

---

### Task 3: FaceRecognizer — gallery + match + forward-only label propagation

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts`
- Test: `packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-recognizer.spec.ts`

**Interfaces:**
- Consumes: `assignUniquePerFrame`, `updateTrackAggregate`, `EMPTY_AGGREGATE`, `GallerySample`, `TrackAggregate` (Phase 1a `face-matcher`); `FaceSettings` (Phase 1a); `IdentityStore`, `FaceStore` (1b); `MediaStore` (1a); `TrackStore`, `EventStore` (1a label methods); `TrackedDetectionOut` (Task 1).
- Produces: `FaceRecognizer`, `FaceRecognizerDeps`, `FaceProcessInput`, `refreshGallery`, `processFrame`. (Best-face capture + `onTrackEnd` are Task 4.)

- [ ] **Step 1: Write the failing test**

Create `face-recognizer.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FaceRecognizer } from '../face-recognizer.js'
import { FACE_DEFAULTS } from '../face-settings.js'
import type { GallerySample } from '../pipeline/face-matcher.js'

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    identityStore: {
      loadGallery: vi.fn(async (): Promise<readonly GallerySample[]> => []),
      listIdentities: vi.fn(async () => [] as readonly { id: string; name: string }[]),
    },
    faceStore: { insert: vi.fn(async () => {}) },
    mediaStore: { put: vi.fn(async () => 'k') },
    trackStore: { setLabel: vi.fn(async () => {}) },
    eventStore: { setLabelForTrack: vi.fn(async () => 0) },
    captureCrop: vi.fn(async () => Buffer.from('jpg')),
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
    ...overrides,
  }
}

const ENABLED = { ...FACE_DEFAULTS, enabled: true, confirmFrames: 2 }

function tracked(trackId: string, embedding: number[], confidence = 0.9) {
  return { trackId, className: 'person', confidence, bbox: { x: 0, y: 0, w: 10, h: 10 },
    zones: [], state: 'active' as const, embedding, embeddingModelId: 'arcface-r100' }
}

describe('FaceRecognizer — match + label propagation', () => {
  let d: ReturnType<typeof deps>
  let rec: FaceRecognizer

  beforeEach(() => { d = deps(); rec = new FaceRecognizer(d as never) })

  it('does nothing when disabled', async () => {
    await rec.processFrame({ deviceId: 7, timestamp: 1, frameWidth: 100, frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0])], settings: { ...ENABLED, enabled: false } })
    expect(d.trackStore.setLabel).not.toHaveBeenCalled()
  })

  it('assigns + propagates the name forward-only after confirmFrames', async () => {
    d.identityStore.loadGallery.mockResolvedValue([{ identityId: 'id-alice', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }])
    d.identityStore.listIdentities.mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()

    const t = tracked('t1', [1, 0, 0, 0])
    await rec.processFrame({ deviceId: 7, timestamp: 1, frameWidth: 100, frameHeight: 100, tracked: [t], settings: ENABLED })
    expect(d.trackStore.setLabel).not.toHaveBeenCalled() // 1 confirmation < 2

    await rec.processFrame({ deviceId: 7, timestamp: 2, frameWidth: 100, frameHeight: 100, tracked: [t], settings: ENABLED })
    expect(d.trackStore.setLabel).toHaveBeenCalledWith('t1', 'Alice')
    expect(d.eventStore.setLabelForTrack).toHaveBeenCalledWith('t1', 'Alice')
  })

  it('with an empty gallery, never assigns (collect-only)', async () => {
    await rec.refreshGallery() // empty
    const t = tracked('t1', [1, 0, 0, 0])
    await rec.processFrame({ deviceId: 7, timestamp: 1, frameWidth: 100, frameHeight: 100, tracked: [t], settings: ENABLED })
    await rec.processFrame({ deviceId: 7, timestamp: 2, frameWidth: 100, frameHeight: 100, tracked: [t], settings: ENABLED })
    expect(d.trackStore.setLabel).not.toHaveBeenCalled()
  })

  it('skips tracks below minFaceConfidence', async () => {
    d.identityStore.loadGallery.mockResolvedValue([{ identityId: 'id-alice', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }])
    d.identityStore.listIdentities.mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()
    const low = tracked('t1', [1, 0, 0, 0], 0.2) // < 0.5 default
    await rec.processFrame({ deviceId: 7, timestamp: 1, frameWidth: 100, frameHeight: 100, tracked: [low], settings: ENABLED })
    await rec.processFrame({ deviceId: 7, timestamp: 2, frameWidth: 100, frameHeight: 100, tracked: [low], settings: ENABLED })
    expect(d.trackStore.setLabel).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-recognizer.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `face-recognizer.ts` (Task-3 scope)**

```typescript
import type { FrameHandle, IScopedLogger } from '@camstack/types'
import {
  assignUniquePerFrame,
  updateTrackAggregate,
  EMPTY_AGGREGATE,
  type GallerySample,
  type TrackAggregate,
} from './pipeline/face-matcher.js'
import type { FaceSettings } from './face-settings.js'
import type { TrackedDetectionOut } from './pipeline/frame-processor.js'

/** Held best face for a track (crop captured lazily in Task 4). */
interface HeldFace {
  score: number
  embedding: readonly number[]
  embeddingModelId: string
  bbox: { x: number; y: number; w: number; h: number }
  timestamp: number
  recognizedIdentityId?: string
  crop?: Buffer
}

export interface FaceRecognizerDeps {
  readonly identityStore: { loadGallery(): Promise<readonly GallerySample[]>; listIdentities(): Promise<readonly { id: string; name: string }[]> }
  readonly faceStore: { insert(face: { id: string; deviceId: number; trackId: string; timestamp: number; embedding: readonly number[]; mediaKey?: string; recognizedIdentityId?: string; assigned: boolean }): Promise<void> }
  readonly mediaStore: { put(input: { deviceId: number; ownerKind: 'face'; ownerId: string; kind: 'crop'; timestamp: number; data: Buffer }): Promise<string> }
  readonly trackStore: { setLabel(trackId: string, label: string): Promise<void> }
  readonly eventStore: { setLabelForTrack(trackId: string, label: string): Promise<number> }
  /** Extract a JPEG crop of `bbox` (pixel-space) from the live frame; null on failure. */
  readonly captureCrop: (frameHandle: FrameHandle, bbox: { x: number; y: number; w: number; h: number }, frameWidth: number, frameHeight: number) => Promise<Buffer | null>
  readonly logger: IScopedLogger
}

export interface FaceProcessInput {
  readonly deviceId: number
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  readonly tracked: readonly TrackedDetectionOut[]
  readonly settings: FaceSettings
  readonly frameHandle?: FrameHandle
}

export class FaceRecognizer {
  private gallery: readonly GallerySample[] = []
  private names = new Map<string, string>()
  private readonly aggregates = new Map<string, TrackAggregate>()
  private readonly bestFace = new Map<string, HeldFace>()

  constructor(private readonly deps: FaceRecognizerDeps) {}

  /** (Re)load the in-memory gallery + identity-name map. Call at init and on enroll/delete. */
  async refreshGallery(): Promise<void> {
    try {
      this.gallery = await this.deps.identityStore.loadGallery()
      const ids = await this.deps.identityStore.listIdentities()
      this.names = new Map(ids.map((i) => [i.id, i.name]))
    } catch (err) {
      this.deps.logger.warn('FaceRecognizer.refreshGallery failed', { meta: { error: String(err) } })
    }
  }

  async processFrame(input: FaceProcessInput): Promise<void> {
    if (!input.settings.enabled) return
    const { settings } = input
    const candidates = input.tracked
      .filter((t): t is TrackedDetectionOut & { embedding: readonly number[]; embeddingModelId: string } =>
        Array.isArray(t.embedding) && typeof t.embeddingModelId === 'string' && t.confidence >= settings.minFaceConfidence)
    if (candidates.length === 0) return

    // Match (only when the gallery has entries — empty gallery ⇒ collect-only).
    const matches = this.gallery.length > 0
      ? assignUniquePerFrame(
          candidates.map((c) => ({ trackId: c.trackId, embedding: c.embedding, modelId: c.embeddingModelId })),
          this.gallery,
          { threshold: settings.similarityThreshold, margin: settings.margin },
        )
      : new Map<string, { identityId: string; score: number }>()

    for (const c of candidates) {
      const match = matches.get(c.trackId) ?? null
      const prev = this.aggregates.get(c.trackId) ?? EMPTY_AGGREGATE
      const { state, changed } = updateTrackAggregate(prev, match, { confirmFrames: settings.confirmFrames })
      this.aggregates.set(c.trackId, state)

      if (changed && state.assignedIdentityId !== null) {
        const name = this.names.get(state.assignedIdentityId)
        if (name !== undefined) {
          try { await this.deps.trackStore.setLabel(c.trackId, name) } catch (err) { this.deps.logger.warn('setLabel failed', { meta: { trackId: c.trackId, error: String(err) } }) }
          try { await this.deps.eventStore.setLabelForTrack(c.trackId, name) } catch (err) { this.deps.logger.warn('setLabelForTrack failed', { meta: { trackId: c.trackId, error: String(err) } }) }
        }
      }

      // Best-face HOLD (crop capture is Task 4). Track the highest-confidence
      // face per track + the currently-assigned identity for the buffer entry.
      const recognizedIdentityId = state.assignedIdentityId ?? match?.identityId ?? undefined
      const held = this.bestFace.get(c.trackId)
      if (held === undefined || c.confidence > held.score) {
        this.bestFace.set(c.trackId, {
          score: c.confidence, embedding: c.embedding, embeddingModelId: c.embeddingModelId,
          bbox: c.bbox, timestamp: input.timestamp,
          ...(recognizedIdentityId !== undefined ? { recognizedIdentityId } : {}),
        })
      } else if (recognizedIdentityId !== undefined && held.recognizedIdentityId === undefined) {
        held.recognizedIdentityId = recognizedIdentityId
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-recognizer.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-recognizer.spec.ts
git commit --no-verify -m "feat(post-analysis): FaceRecognizer — gallery match + forward-only label propagation"
```

---

### Task 4: FaceRecognizer — best-face crop capture + track-end persist

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts`
- Test: `…/__tests__/face-recognizer.spec.ts` (append)

**Interfaces:**
- Consumes: Task-3 `FaceRecognizer` (the `bestFace`/`aggregates` maps, `captureCrop` dep).
- Produces: crop capture inside `processFrame` (on a new best, via `captureCrop`), and `onTrackEnd(deviceId, trackId): Promise<void>` (persist + state cleanup).

- [ ] **Step 1: Write the failing tests**

Append to `face-recognizer.spec.ts`:

```typescript
describe('FaceRecognizer — best-face capture + track-end persist', () => {
  let d: ReturnType<typeof deps>
  let rec: FaceRecognizer

  beforeEach(() => { d = deps(); rec = new FaceRecognizer(d as never) })

  it('captures the crop of the highest-confidence face and persists one buffer entry at track end', async () => {
    await rec.refreshGallery() // empty gallery ⇒ collect-only
    await rec.processFrame({ deviceId: 7, timestamp: 100, frameWidth: 100, frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.7)], settings: ENABLED })
    await rec.processFrame({ deviceId: 7, timestamp: 200, frameWidth: 100, frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0], 0.95)], settings: ENABLED }) // new best
    expect(d.captureCrop).toHaveBeenCalledTimes(2)

    await rec.onTrackEnd(7, 't1')
    expect(d.mediaStore.put).toHaveBeenCalledWith(expect.objectContaining({ ownerKind: 'face', ownerId: 'face-t1', kind: 'crop' }))
    expect(d.faceStore.insert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'face-t1', deviceId: 7, trackId: 't1', assigned: false,
    }))
    const inserted = d.faceStore.insert.mock.calls[0]![0] as { timestamp: number; embedding: readonly number[] }
    expect(inserted.timestamp).toBe(200) // the best frame's timestamp
  })

  it('records recognizedIdentityId on the buffered face when the track was recognized', async () => {
    d.identityStore.loadGallery.mockResolvedValue([{ identityId: 'id-alice', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }])
    d.identityStore.listIdentities.mockResolvedValue([{ id: 'id-alice', name: 'Alice' }])
    await rec.refreshGallery()
    const t = tracked('t1', [1, 0, 0, 0])
    await rec.processFrame({ deviceId: 7, timestamp: 1, frameWidth: 100, frameHeight: 100, tracked: [t], settings: ENABLED })
    await rec.processFrame({ deviceId: 7, timestamp: 2, frameWidth: 100, frameHeight: 100, tracked: [t], settings: ENABLED })
    await rec.onTrackEnd(7, 't1')
    expect(d.faceStore.insert).toHaveBeenCalledWith(expect.objectContaining({ recognizedIdentityId: 'id-alice' }))
  })

  it('onTrackEnd is a no-op for an unknown track', async () => {
    await rec.onTrackEnd(7, 'never-seen')
    expect(d.faceStore.insert).not.toHaveBeenCalled()
  })

  it('does not capture a crop when no frameHandle is available', async () => {
    await rec.refreshGallery()
    await rec.processFrame({ deviceId: 7, timestamp: 1, frameWidth: 100, frameHeight: 100,
      tracked: [tracked('t1', [1, 0, 0, 0])], settings: ENABLED, frameHandle: undefined })
    expect(d.captureCrop).not.toHaveBeenCalled()
  })
})
```

> NOTE: the Task-3 tests construct `processFrame` input WITHOUT `frameHandle`. For the capture tests above, the helper must pass a `frameHandle`. Add a fake handle to those calls — e.g. `frameHandle: { shmId: 1, nodeId: 'n', /* minimal cast */ } as never`. Keep the Task-3 tests unchanged (they assert no-capture / label-only behavior and pass no handle).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-recognizer.spec.ts`
Expected: FAIL — `onTrackEnd` not a function; `captureCrop` never called.

- [ ] **Step 3: Add crop capture to `processFrame` + implement `onTrackEnd`**

In `processFrame`, replace the best-face HOLD block with one that captures the crop when a new best is seen AND a `frameHandle` is present:

```typescript
      const recognizedIdentityId = state.assignedIdentityId ?? match?.identityId ?? undefined
      const held = this.bestFace.get(c.trackId)
      if (held === undefined || c.confidence > held.score) {
        let crop: Buffer | undefined
        if (input.frameHandle !== undefined) {
          try {
            const captured = await this.deps.captureCrop(input.frameHandle, c.bbox, input.frameWidth, input.frameHeight)
            crop = captured ?? undefined
          } catch (err) {
            this.deps.logger.debug('FaceRecognizer crop capture failed', { meta: { trackId: c.trackId, error: String(err) } })
          }
        }
        this.bestFace.set(c.trackId, {
          score: c.confidence, embedding: c.embedding, embeddingModelId: c.embeddingModelId,
          bbox: c.bbox, timestamp: input.timestamp,
          ...(crop !== undefined ? { crop } : {}),
          ...(recognizedIdentityId !== undefined ? { recognizedIdentityId } : {}),
        })
      } else if (recognizedIdentityId !== undefined && held.recognizedIdentityId === undefined) {
        held.recognizedIdentityId = recognizedIdentityId
      }
```

Add the `onTrackEnd` method:

```typescript
/**
 * Persist the held best face for a finished track as ONE FaceStore buffer
 * entry (crop → MediaStore under ownerKind 'face'), then drop the track's
 * in-memory state. Best-effort; a track with no held face is a no-op.
 */
async onTrackEnd(deviceId: number, trackId: string): Promise<void> {
  const held = this.bestFace.get(trackId)
  this.aggregates.delete(trackId)
  this.bestFace.delete(trackId)
  if (held === undefined) return
  const faceId = `face-${trackId}`
  let mediaKey: string | undefined
  if (held.crop !== undefined) {
    try {
      mediaKey = await this.deps.mediaStore.put({ deviceId, ownerKind: 'face', ownerId: faceId, kind: 'crop', timestamp: held.timestamp, data: held.crop })
    } catch (err) {
      this.deps.logger.warn('FaceRecognizer face crop put failed', { meta: { faceId, error: String(err) } })
    }
  }
  try {
    await this.deps.faceStore.insert({
      id: faceId, deviceId, trackId, timestamp: held.timestamp,
      embedding: held.embedding,
      ...(mediaKey !== undefined ? { mediaKey } : {}),
      ...(held.recognizedIdentityId !== undefined ? { recognizedIdentityId: held.recognizedIdentityId } : {}),
      assigned: false,
    })
  } catch (err) {
    this.deps.logger.warn('FaceRecognizer faceStore insert failed', { meta: { faceId, error: String(err) } })
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-recognizer.spec.ts`
Expected: PASS (8 tests). (Update the Task-3 capture-less tests only if they now need a handle — they should NOT; keep them handle-free.)

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-recognizer.spec.ts
git commit --no-verify -m "feat(post-analysis): FaceRecognizer — best-face crop capture + track-end persist"
```

---

### Task 5: `FaceStore.pruneAll` (group-by-device retention)

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts`
- Test: `…/__tests__/face-store.spec.ts` (append)

**Interfaces:**
- Consumes: existing `FaceStore.prune` logic.
- Produces: `pruneAll({ cutoffMs, maxPerDevice }): Promise<readonly string[]>` — applies the age + per-device-cap rule across ALL devices (no device-list dependency), returns all deleted ids.

- [ ] **Step 1: Write the failing test**

Append to `face-store.spec.ts`:

```typescript
describe('FaceStore — pruneAll', () => {
  let fake: ReturnType<typeof makeFakeSettingsStore>
  let store: FaceStore
  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new FaceStore({ store: fake.client, logger: makeSilentLogger() })
    await FaceStore.declare(fake.client)
  })

  it('applies age + per-device cap across every device', async () => {
    await store.insert(face('a-old', 7, 'a-old', 1000))
    await store.insert(face('a-new', 7, 'a-new', 9000))
    await store.insert(face('b1', 99, 'b1', 1000))
    await store.insert(face('b2', 99, 'b2', 2000))
    await store.insert(face('b3', 99, 'b3', 3000))
    // cutoff 5000 drops a-old; cap 2 on device 99 drops the oldest (b1)
    const deleted = await store.pruneAll({ cutoffMs: 5000, maxPerDevice: 2 })
    expect(new Set(deleted)).toEqual(new Set(['a-old', 'b1']))
    expect((await store.listRecentFaces({ deviceId: 7 })).map((f) => f.id)).toEqual(['a-new'])
    expect((await store.listRecentFaces({ deviceId: 99 })).map((f) => f.id)).toEqual(['b3', 'b2'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts`
Expected: FAIL — `pruneAll` not defined.

- [ ] **Step 3: Implement `pruneAll`**

Add to `FaceStore`:

```typescript
/**
 * Retention across ALL devices: query every face once, group by deviceId, and
 * apply the same age (`timestamp < cutoffMs`) + per-device-cap rule as `prune`.
 * Returns all deleted ids (caller removes their crops). The buffer is small +
 * capped, so a full scan is cheap.
 */
async pruneAll(input: { cutoffMs: number; maxPerDevice: number }): Promise<readonly string[]> {
  const rows = await this.store.query.query({
    collection: FACES_COLLECTION,
    filter: { orderBy: { field: 'timestamp', direction: 'desc' } },
  })
  const byDevice = new Map<number, { id: string; timestamp: number }[]>()
  for (const r of rows) {
    const data = r.data as { deviceId?: unknown; timestamp?: unknown }
    const deviceId = Number(data.deviceId ?? -1)
    const list = byDevice.get(deviceId) ?? []
    list.push({ id: r.id, timestamp: Number(data.timestamp ?? 0) }) // rows already newest-first
    byDevice.set(deviceId, list)
  }
  const toDelete = new Set<string>()
  for (const list of byDevice.values()) {
    list.forEach((row, idx) => {
      if (row.timestamp < input.cutoffMs) toDelete.add(row.id)
      if (idx >= input.maxPerDevice) toDelete.add(row.id)
    })
  }
  const deleted: string[] = []
  for (const id of toDelete) {
    try {
      await this.store.delete.mutate({ collection: FACES_COLLECTION, key: id })
      deleted.push(id)
    } catch (err) {
      this.logger.warn('FaceStore.pruneAll delete failed', { meta: { faceId: id, error: String(err) } })
    }
  }
  return deleted
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts`
Expected: PASS (8 tests — 7 prior + pruneAll).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts
git commit --no-verify -m "feat(post-analysis): FaceStore.pruneAll — group-by-device retention"
```

---

### Task 6: Wire FaceRecognizer into the addon

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/index.ts`
- Test: none new (integration; covered by the recognizer/store unit tests + tsc + the full suite + deploy verification in Task 7).

**Interfaces:**
- Consumes: everything above + the existing `frameReaders`/`getRemoteFrame`/`resolveFrame`/`extractCrop`, `sweepExpiredTracks`, `sweepRetention`.

- [ ] **Step 1: Add fields + imports**

Imports: `IdentityStore` from `./store/identity-store.js`, `FaceStore` from `./store/face-store.js`, `FaceRecognizer` from `./face-recognizer.js`, `resolveFrame` from `../shared/frame/resolve-frame.js`, `extractCrop` from `../shared/frame/crop-extractor.js` (check if already imported).

Add class fields beside the existing stores:

```typescript
private identityStore: IdentityStore | null = null
private faceStore: FaceStore | null = null
private faceRecognizer: FaceRecognizer | null = null
```

- [ ] **Step 2: Declare + construct in `onInitialize`**

After `EventStore.declare(api.settingsStore)`:

```typescript
await IdentityStore.declare(api.settingsStore)
await FaceStore.declare(api.settingsStore)
```

After `this.eventStore = new EventStore(...)`:

```typescript
this.identityStore = new IdentityStore({ store: api.settingsStore, logger: logger.child('IdentityStore') })
this.faceStore = new FaceStore({ store: api.settingsStore, logger: logger.child('FaceStore') })
```

After the `this.eventMediaDispatcher = new EventMediaDispatcher({...})` block (so `frameReaders`/`getRemoteFrame` exist), construct the recognizer with a real `captureCrop`:

```typescript
const ownNodeIdForFaces = ownNodeId
const frameReadersForFaces = this.frameReaders
const captureCrop = async (
  frameHandle: FrameHandle,
  bbox: { x: number; y: number; w: number; h: number },
  frameWidth: number,
  frameHeight: number,
): Promise<Buffer | null> => {
  const decoded = await resolveFrame(frameHandle, { ownNodeId: ownNodeIdForFaces, readers: frameReadersForFaces, getRemoteFrame })
  if (!decoded || decoded.format !== 'rgb') return null
  const data = Buffer.isBuffer(decoded.data) ? decoded.data : Buffer.from(decoded.data)
  const norm = { x: bbox.x / frameWidth, y: bbox.y / frameHeight, w: bbox.w / frameWidth, h: bbox.h / frameHeight }
  const { crop } = await extractCrop(data, decoded.width, decoded.height, norm)
  return crop
}
this.faceRecognizer = new FaceRecognizer({
  identityStore: this.identityStore,
  faceStore: this.faceStore,
  mediaStore: this.mediaStore,
  trackStore: this.trackStore,
  eventStore: this.eventStore,
  captureCrop,
  logger: logger.child('FaceRecognizer'),
})
void this.faceRecognizer.refreshGallery()
```

> `getRemoteFrame`/`ownNodeId`/`this.frameReaders` are built just above for the EventMediaDispatcher — reuse them. Match the real variable names in scope (the dispatcher block names them `ownNodeId`, `getRemoteFrame`).

- [ ] **Step 3: Call the recognizer per frame**

In `processFrame`, right after the `eventMediaDispatcher.captureForFrame({...})` block (the `frameHandle` is still live), add:

```typescript
if (this.faceRecognizer) {
  const faceSettings = await this.resolveDeviceFaceSettings(deviceId)
  if (faceSettings.enabled) {
    void this.faceRecognizer.processFrame({
      deviceId,
      timestamp: frame.timestamp,
      frameWidth: result.frameWidth,
      frameHeight: result.frameHeight,
      tracked: result.tracked,
      settings: faceSettings,
      ...(frameHandle !== undefined ? { frameHandle } : {}),
    })
  }
}
```

> Use `await`/`void` consistent with the surrounding code (the dispatcher call uses `void` fire-and-forget — match it; the settings resolve must be `await`ed). If `result.frameWidth`/`frameHeight` aren't on the result, use `frame.width`/`frame.height`.

- [ ] **Step 4: Persist best face at track end**

In `sweepExpiredTracks`, inside the `for (const t of expired)` loop, before/after the `thumbnailer?.captureTrackFrame` call:

```typescript
void this.faceRecognizer?.onTrackEnd(t.deviceId, t.trackId)
```

- [ ] **Step 5: Prune the face buffer in `sweepRetention`**

In `sweepRetention`, after the `mediaStore.evictBefore(...)` backstop, add:

```typescript
if (this.faceStore) {
  try {
    const faceCutoffMs = now - FACE_DEFAULTS.bufferRetentionDays * day
    const deletedFaceIds = await this.faceStore.pruneAll({ cutoffMs: faceCutoffMs, maxPerDevice: FACE_DEFAULTS.bufferMaxPerDevice })
    if (deletedFaceIds.length > 0) {
      await this.mediaStore.deleteForOwner('face', deletedFaceIds)
      this.ctx.logger.info('face buffer retention prune', { meta: { deleted: deletedFaceIds.length } })
    }
  } catch (err) {
    this.ctx.logger.debug('face buffer prune failed', { meta: { error: String(err) } })
  }
}
```

Add the import `import { FACE_DEFAULTS } from './face-settings.js'` (alongside the Task-2 `resolveFaceSettings` import). Retention uses global defaults (per-device retention tuning is a later enhancement).

- [ ] **Step 6: Typecheck + full suite**

Run: `cd packages/addon-post-analysis && npx tsc --noEmit` (expect clean), then
`npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics` (expect all pass).

- [ ] **Step 7: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/index.ts
git commit --no-verify -m "feat(post-analysis): wire FaceRecognizer — per-frame, track-end, retention"
```

---

### Task 7: Verify + deploy + empirical check

**Files:** none.

- [ ] **Step 1: Package typecheck + full suite**

Run: `cd packages/addon-post-analysis && npx tsc --noEmit` (clean), then
`npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics` (all pass).

- [ ] **Step 2: Deploy**

Run (repo root): `camstack deploy packages/addon-post-analysis --server https://localhost:4443`
Expected: `✓ Deployed` + `✓ Hub healthy`. (No `@camstack/types` rebuild — no shared type changed in 1c.)

- [ ] **Step 3: Empirical check on cam99**

cam99 (deviceId 99) runs the full pipeline (… → face-detection/scrfd → face-embedding/arcface-r100). The gallery is empty until Phase-3 enrollment, so face recognition is in **collect-only** mode — verify the buffer fills:
- Enable face recognition for cam99 (set `enabled: true` in the device store, or globally) — note: there is no settings UI yet (Phase 2), so set it via the device settings store / REPL.
- After some person tracks complete, confirm `pipeline-analytics:faces` rows appear for deviceId 99 (one per track, `assigned: false`, `recognizedIdentityId` null), and matching face crops exist on disk at `eventMedia/pipeline-analytics/99/face/face-<trackId>/crop-<ts>.jpg`. Use the same better-sqlite3 / FS inspection path used in prior sessions.
- Confirm NO label is written (empty gallery → no assignment) and existing object-event flows are unchanged.

---

## Self-Review

**Spec coverage (spec §4 components 1-2, 5; §6; §10):**
- Embedding exposed on the tracker output (component 1 finalization) → Task 1.
- `FaceRecognizer` match + per-track aggregation + label update + best-face capture (component 2) → Tasks 3-4.
- `EventStore.setLabelForTrack` + `TrackStore.label` forward-only (§4.5) → invoked in Task 3.
- `resolveDeviceFaceSettings` cascade → Task 2.
- Retention via the existing sweep (§10) → Tasks 5-6.
- Gating: enabled off ⇒ no-op; enabled + empty gallery ⇒ collect-only (§10) → Task 3 + verified in Task 7.

**Placeholder scan:** all code complete. The net-new `FaceRecognizer` is fully specified; index.ts wiring snippets carry "match the real variable names" directives (the file is large and live) — these are integration instructions, not TODOs. Flagged for the reviewer.

**Type consistency:** `FaceRecognizerDeps` store method signatures match the real `TrackStore.setLabel` / `EventStore.setLabelForTrack` / `MediaStore.put` / `FaceStore.insert` / `IdentityStore.loadGallery`+`listIdentities` from Phases 1a/1b. `assignUniquePerFrame`/`updateTrackAggregate`/`EMPTY_AGGREGATE`/`GallerySample`/`TrackAggregate` are the real Phase-1a exports. `TrackedDetectionOut.embedding` (Task 1) is what the recognizer reads.

**1a/1b carry-overs honored:** `FaceStore.insert` receives a COMPLETE row; `prune`/`pruneAll` ids feed `MediaStore.deleteForOwner('face', …)`; crop capture reuses the dispatcher's frame infra. Deferred (named): SQL `assigned=false` filter for `listRecentFaces`; per-device retention tuning (uses global defaults now); gallery auto-refresh on enroll wired in Phase 3 (the `refreshGallery()` hook exists). The 5 viewer/UX points (frame-original, cluster aspect, box toggle, tracks) remain a SEPARATE post-Phase-1 analysis per the user.
