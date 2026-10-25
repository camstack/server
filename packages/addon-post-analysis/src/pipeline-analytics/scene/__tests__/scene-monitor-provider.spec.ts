import type {
  IScopedLogger,
  RecordsAccess,
  SceneMonitor,
  SceneMonitorStatus,
} from '@camstack/types'
import { SCENE_DIVERGED } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import type { SceneEngineResult } from '../scene-engine.js'
import type { SceneEngineControl } from '../scene-monitor-provider.js'
import { type SceneEdge, SceneMonitorProvider } from '../scene-monitor-provider.js'
import { SceneStore } from '../scene-store.js'

const MODEL = 'clip-vit-b32'

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

interface Harness {
  provider: SceneMonitorProvider
  store: SceneStore
  records: RecordsAccess
  slices: SceneMonitorStatus[]
  edges: SceneEdge[]
  emitted: unknown[]
  engine: SceneEngineControl & { resetMonitor: ReturnType<typeof vi.fn> }
  encodeCalls: number
  snapshotForced: boolean[]
  /** Media ids the provider asked to be deleted, in order. */
  droppedMedia: number[]
  /** Mutable clock — two captures at the same millisecond would be one blob. */
  now: { value: number }
}

async function harness(
  opts: {
    embedding?: number[]
    snapshot?: boolean
    condition?: string
    dropMediaFails?: boolean
  } = {},
): Promise<Harness> {
  const world = await makeAnalyticsRecords()
  const store = new SceneStore({ records: world.records, logger: logger() })
  await store.load()

  const slices: SceneMonitorStatus[] = []
  const edges: SceneEdge[] = []
  const emitted: unknown[] = []
  const snapshotForced: boolean[] = []
  const droppedMedia: number[] = []
  const now = { value: 1_000 }
  const state = { encodeCalls: 0 }
  let nextMediaId = 1
  const mediaIdByOwner = new Map<string, number>()
  const engine = {
    recheck: vi.fn(async () => undefined),
    resetMonitor: vi.fn(),
  }

  const provider = new SceneMonitorProvider({
    store,
    encoder: {
      encode: async () => {
        state.encodeCalls += 1
        return { embedding: opts.embedding ?? [1, 0, 0], inferenceMs: 1 }
      },
      getInfo: async () => ({ modelId: MODEL, embeddingDim: 3, ready: true }),
    },
    getSnapshot: async (_id, force) => {
      snapshotForced.push(force)
      return opts.snapshot === false ? null : { base64: 'AAAA', contentType: 'image/jpeg' }
    },
    // Mirrors the real `MediaStore` upsert shape closely enough that a shared
    // owner id produces a SHARED id — which is exactly the defect the
    // "own picture" test has to be able to see.
    putMedia: async ({ ownerId }) => {
      const existing = mediaIdByOwner.get(ownerId)
      if (existing !== undefined) return existing
      const id = nextMediaId++
      mediaIdByOwner.set(ownerId, id)
      return id
    },
    dropMedia: async (mediaId) => {
      if (opts.dropMediaFails === true) throw new Error('storage unavailable')
      droppedMedia.push(mediaId)
    },
    mirrorSlice: (_deviceId, status) => slices.push(status),
    emitStateChanged: (p) => emitted.push(p),
    onSceneEdge: (e) => edges.push(e),
    currentCondition: async () => opts.condition ?? 'day',
    logger: logger(),
    now: () => now.value,
  })
  provider.attachEngine(engine)

  const h: Harness = {
    provider,
    store,
    records: world.records,
    slices,
    edges,
    emitted,
    engine,
    get encodeCalls() {
      return state.encodeCalls
    },
    snapshotForced,
    droppedMedia,
    now,
  }
  return h
}

function rect(): SceneMonitor['roi'] {
  return { kind: 'rect', x: 0.1, y: 0.1, width: 0.4, height: 0.4 }
}

async function makeScene(h: Harness): Promise<SceneMonitor> {
  return h.provider.createScene({
    deviceId: 104,
    label: 'Immondizia prelevata',
    roi: rect(),
    check: { mode: 'similarity', threshold: 0.8, hysteresisCount: 3 },
  })
}

function divergence(overrides: Partial<SceneEngineResult> = {}): SceneEngineResult {
  return {
    currentStateId: SCENE_DIVERGED,
    previousStateId: 'baseline',
    lastConfidence: 0.2,
    currentCondition: 'day',
    verdict: 'diverged',
    unavailable: null,
    availability: 'ok',
    unavailableReason: null,
    coveredConditions: ['day'],
    suspendedCondition: null,
    transitioned: true,
    checkedAt: 2_000,
    ...overrides,
  }
}

// Real `sharp` decoding is exercised by the engine spec; here the crop helpers
// are stubbed so the provider's OWN logic (latch, reset, hydration) is what the
// assertions bind to.
vi.mock('../scene-crop.js', () => ({
  cropSnapshotRoi: async () => ({ crop: Buffer.from([1, 2, 3]), width: 10, height: 10 }),
  anchorFrame: async () => ({ crop: Buffer.from([4, 5, 6]), width: 8, height: 8 }),
  chromaSpread: async () => 30,
  SCENE_ANCHOR_PX: 224,
}))

describe('SceneMonitorProvider', () => {
  let h: Harness
  beforeEach(async () => {
    h = await harness()
  })

  it('a new scene is unknown, not matched — it has nothing to compare against yet', async () => {
    const scene = await makeScene(h)
    expect(scene.verdict).toBe('unknown')
    expect(scene.latched).toBe(false)
    expect(scene.baselineStateId).toBeNull()
    expect(scene.unavailable).toBe('no-reference-for-condition')
  })

  it('the first capture becomes the baseline, forces the snapshot, and stores an anchor', async () => {
    const scene = await makeScene(h)
    const res = await h.provider.captureReference({ deviceId: 104, monitorId: scene.id })

    expect(res.referenceCount).toBe(1)
    // `force: true` is the OPERATOR signal — the one legitimate use in the repo.
    expect(h.snapshotForced).toEqual([true])
    const stored = h.store.getScene(104, scene.id)!.monitor
    expect(stored.baselineStateId).toBe(res.stateId)
    const ref = stored.states[0]!.references[0]!
    expect(ref.condition).toBe('day')
    expect(ref.modelId).toBe(MODEL)
    expect(ref.anchorEmbedding).toEqual([1, 0, 0]) // the whole-frame view guard
  })

  it('latches on a confirmed divergence and records divergedAt', async () => {
    const scene = await makeScene(h)
    await h.provider.applyEngineResult(104, scene.id, divergence())

    const latch = h.store.getLatch(104, scene.id)!
    expect(latch.latched).toBe(true)
    expect(latch.verdict).toBe('diverged')
    expect(latch.divergedAt).toBe(2_000)
    expect(h.edges).toHaveLength(1)
    expect(h.edges[0]).toMatchObject({ direction: 'diverged', latched: true })
    expect(h.emitted).toHaveLength(1)
  })

  it('holds the latch when the scene matches again, but still emits the restored edge', async () => {
    const scene = await makeScene(h)
    await h.provider.applyEngineResult(104, scene.id, divergence())
    await h.provider.applyEngineResult(
      104,
      scene.id,
      divergence({
        currentStateId: 'baseline',
        previousStateId: SCENE_DIVERGED,
        verdict: 'matched',
        lastConfidence: 0.95,
        checkedAt: 3_000,
      }),
    )

    const latch = h.store.getLatch(104, scene.id)!
    // autoRestore is false: the operator's alarm does NOT clear itself…
    expect(latch.latched).toBe(true)
    expect(latch.verdict).toBe('matched')
    expect(latch.restoredAt).toBe(3_000)
    // …but the EDGE is a different fact and is always emitted.
    expect(h.edges.map((e) => e.direction)).toEqual(['diverged', 'restored'])
  })

  // D49 applied to a fallible OBSERVATION: a read that fails changes nothing,
  // and it must never be able to clear a week of latch state.
  it('an unknown verdict never moves the latch in either direction', async () => {
    const scene = await makeScene(h)
    await h.provider.applyEngineResult(104, scene.id, divergence())
    await h.provider.applyEngineResult(
      104,
      scene.id,
      divergence({
        verdict: 'unknown',
        unavailable: 'no-snapshot',
        currentStateId: SCENE_DIVERGED,
        transitioned: false,
        checkedAt: 4_000,
      }),
    )

    const latch = h.store.getLatch(104, scene.id)!
    expect(latch.latched).toBe(true)
    expect(latch.verdict).toBe('unknown')
    expect(h.edges).toHaveLength(1) // no second edge from a non-observation
  })

  // The night half is OPTIONAL, and "optional" is only true if the latch is
  // genuinely untouched: a scene the operator left flagged at dusk must still
  // be flagged at dawn, and one that was normal must not have been quietly
  // re-armed by hours of checks that were never made.
  //
  // NEUTRALIZATION: drop the `result.suspendedCondition !== null` early return
  // in `applyEngineResult` and this goes red — the generic path would rewrite
  // `lastCheckedAt`, `verdict` and (via `autoRestore`) the latch itself.
  it('a SKIPPED check writes no latch at all — it is not an observation', async () => {
    const scene = await makeScene(h)
    await h.provider.applyEngineResult(104, scene.id, divergence())
    const before = h.store.getLatch(104, scene.id)!

    await h.provider.applyEngineResult(
      104,
      scene.id,
      divergence({
        verdict: 'matched',
        currentStateId: 'baseline',
        suspendedCondition: 'ir',
        currentCondition: 'ir',
        lastConfidence: null,
        transitioned: false,
        checkedAt: 9_000,
      }),
    )

    expect(h.store.getLatch(104, scene.id)).toEqual(before)
    expect(h.edges).toHaveLength(1)
    // The one thing that DOES move: the advisory line the card renders.
    expect(h.store.getScene(104, scene.id)!.monitor.suspendedCondition).toBe('ir')
  })

  it('a real check clears the suspension marker again', async () => {
    const scene = await makeScene(h)
    await h.provider.applyEngineResult(104, scene.id, divergence({ suspendedCondition: 'ir' }))
    await h.provider.applyEngineResult(104, scene.id, divergence({ checkedAt: 9_000 }))
    expect(h.store.getScene(104, scene.id)!.monitor.suspendedCondition).toBeNull()
  })

  // The gallery's whole purpose is letting the operator pick the ONE blurry
  // capture out of six. That is impossible if they share a blob — and they did:
  // the owner id was `scene-<id>-<condition>` and `thumbnailSmall` is a
  // single-instance kind, so every capture overwrote the last.
  it('each reference owns its OWN picture, so two captures do not share one blob', async () => {
    const h = await harness()
    const scene = await makeScene(h)
    await h.provider.captureReference({ deviceId: 104, monitorId: scene.id, condition: 'day' })
    h.now.value = 5_000
    await h.provider.captureReference({ deviceId: 104, monitorId: scene.id, condition: 'day' })

    const refs = h.store.getScene(104, scene.id)!.monitor.states[0]!.references
    expect(refs).toHaveLength(2)
    expect(refs[0]!.thumbnailMediaId).not.toBe(refs[1]!.thumbnailMediaId)
  })

  // Scene media is retention-exempt, so nothing else will ever collect it: if
  // the picture does not leave with the reference it never leaves.
  it('deleting a reference deletes its picture', async () => {
    const h = await harness()
    const scene = await makeScene(h)
    await h.provider.captureReference({ deviceId: 104, monitorId: scene.id, condition: 'day' })
    const ref = h.store.getScene(104, scene.id)!.monitor.states[0]!.references[0]!

    await h.provider.deleteReference({
      deviceId: 104,
      monitorId: scene.id,
      stateId: h.store.getScene(104, scene.id)!.monitor.states[0]!.id,
      index: 0,
    })

    expect(h.store.getScene(104, scene.id)!.monitor.states[0]!.references).toHaveLength(0)
    expect(h.droppedMedia).toContain(ref.thumbnailMediaId)
  })

  it('deleting a scene takes every reference picture with it', async () => {
    const h = await harness()
    const scene = await makeScene(h)
    await h.provider.captureReference({ deviceId: 104, monitorId: scene.id, condition: 'day' })
    const ref = h.store.getScene(104, scene.id)!.monitor.states[0]!.references[0]!

    await h.provider.deleteScene({ deviceId: 104, monitorId: scene.id })

    expect(h.droppedMedia).toContain(ref.thumbnailMediaId)
  })

  // A picture that will not unlink must never cost the operator the delete they
  // actually asked for.
  it('a reference is still deleted when its picture refuses to go', async () => {
    const h = await harness({ dropMediaFails: true })
    const scene = await makeScene(h)
    await h.provider.captureReference({ deviceId: 104, monitorId: scene.id, condition: 'day' })
    const stateId = h.store.getScene(104, scene.id)!.monitor.states[0]!.id

    await expect(
      h.provider.deleteReference({ deviceId: 104, monitorId: scene.id, stateId, index: 0 }),
    ).resolves.toBeUndefined()
    expect(h.store.getScene(104, scene.id)!.monitor.states[0]!.references).toHaveLength(0)
  })

  it('a new scene defaults to skipping the lights it has no reference for', async () => {
    const scene = await makeScene(h)
    expect(scene.onUncoveredCondition).toBe('skip')
    expect(scene.suspendedCondition).toBeNull()
  })

  it('the uncovered-light policy is patchable per scene', async () => {
    const scene = await makeScene(h)
    await h.provider.updateScene({
      deviceId: 104,
      monitorId: scene.id,
      patch: { onUncoveredCondition: 'judge-anyway' },
    })
    expect(h.store.getScene(104, scene.id)!.monitor.onUncoveredCondition).toBe('judge-anyway')
  })

  describe('resetScene', () => {
    it('RE-CAPTURES the baseline for the current condition and re-arms', async () => {
      const scene = await makeScene(h)
      await h.provider.captureReference({ deviceId: 104, monitorId: scene.id })
      await h.provider.applyEngineResult(104, scene.id, divergence())
      expect(h.store.getLatch(104, scene.id)!.latched).toBe(true)

      const before = h.encodeCalls
      await h.provider.resetScene({ deviceId: 104, monitorId: scene.id })

      // A fresh crop AND a fresh anchor were encoded — the reset took a new
      // photograph of the world, it did not merely clear a flag.
      expect(h.encodeCalls).toBe(before + 2)
      const latch = h.store.getLatch(104, scene.id)!
      expect(latch.latched).toBe(false)
      expect(latch.armedAt).toBe(1_000)
      expect(latch.divergedAt).toBeNull()
      expect(latch.verdict).toBe('matched')
      expect(h.engine.resetMonitor).toHaveBeenCalled()
    })

    it('REPLACES that condition’s references rather than appending', async () => {
      const scene = await makeScene(h)
      await h.provider.captureReference({ deviceId: 104, monitorId: scene.id })
      await h.provider.captureReference({ deviceId: 104, monitorId: scene.id })
      expect(h.store.getScene(104, scene.id)!.monitor.states[0]!.references).toHaveLength(2)

      await h.provider.resetScene({ deviceId: 104, monitorId: scene.id })

      // Leaving the old baseline in place would keep matching forever — a reset
      // that quietly disarmed the alarm for good.
      const refs = h.store.getScene(104, scene.id)!.monitor.states[0]!.references
      expect(refs).toHaveLength(1)
      expect(refs[0]!.condition).toBe('day')
    })

    it('re-arms even when the camera cannot be photographed', async () => {
      const noCam = await harness({ snapshot: false })
      const scene = await makeScene(noCam)
      await noCam.provider.applyEngineResult(104, scene.id, divergence())

      await noCam.provider.resetScene({ deviceId: 104, monitorId: scene.id })

      // The operator pressed reset to clear an alarm. Refusing because the
      // camera is asleep leaves the latch stuck exactly when they need it gone.
      expect(noCam.store.getLatch(104, scene.id)!.latched).toBe(false)
    })

    it('honours recapture:false — re-arm only', async () => {
      const scene = await makeScene(h)
      await h.provider.captureReference({ deviceId: 104, monitorId: scene.id })
      const before = h.encodeCalls

      await h.provider.resetScene({ deviceId: 104, monitorId: scene.id, recapture: false })

      expect(h.encodeCalls).toBe(before)
      expect(h.store.getLatch(104, scene.id)!.latched).toBe(false)
    })
  })

  describe('boot hydration', () => {
    it('restores a latched scene from the durable ledger WITHOUT re-firing an edge', async () => {
      const scene = await makeScene(h)
      await h.provider.captureReference({ deviceId: 104, monitorId: scene.id })
      await h.provider.applyEngineResult(104, scene.id, divergence())

      // A second process, same durable store — a restart.
      const store2 = new SceneStore({ records: h.records, logger: logger() })
      await store2.load()
      const edges2: SceneEdge[] = []
      const emitted2: unknown[] = []
      const slices2: SceneMonitorStatus[] = []
      const p2 = new SceneMonitorProvider({
        store: store2,
        encoder: {
          encode: async () => ({ embedding: [1, 0, 0], inferenceMs: 1 }),
          getInfo: async () => ({ modelId: MODEL, embeddingDim: 3, ready: true }),
        },
        getSnapshot: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
        mirrorSlice: (_d, s) => slices2.push(s),
        emitStateChanged: (p) => emitted2.push(p),
        onSceneEdge: (e) => edges2.push(e),
        currentCondition: async () => 'day',
        logger: logger(),
        now: () => 9_000,
      })

      p2.hydrate()

      const restored = (await p2.listScenes({ deviceId: 104 })).monitors[0]!
      expect(restored.latched).toBe(true)
      expect(restored.verdict).toBe('diverged')
      expect(restored.divergedAt).toBe(2_000)
      // The operator was already told. Telling them again on every container
      // restart is how a feature loses its credibility in a week.
      expect(edges2).toHaveLength(0)
      expect(emitted2).toHaveLength(0)
    })

    // NEUTRALIZATION: make `SceneStore.load()` swallow its result (or make
    // `hydrate()` read the config mirror instead of the latch ledger) and this
    // goes red. A green suite has twice passed here because the fake supplied
    // what production forgot to fetch — so the world is deliberately empty
    // until production writes through it.
    it('a latch the store never loaded is NOT invented', async () => {
      const world = await makeAnalyticsRecords()
      const store3 = new SceneStore({ records: world.records, logger: logger() })
      await store3.load()
      const p3 = new SceneMonitorProvider({
        store: store3,
        encoder: {
          encode: async () => ({ embedding: [1, 0, 0], inferenceMs: 1 }),
          getInfo: async () => ({ modelId: MODEL, embeddingDim: 3, ready: true }),
        },
        getSnapshot: async () => null,
        mirrorSlice: () => undefined,
        emitStateChanged: () => undefined,
        currentCondition: async () => 'day',
        logger: logger(),
      })
      p3.hydrate()
      expect((await p3.listScenes({ deviceId: 104 })).monitors).toEqual([])
    })
  })

  it('listAllEnabled hides a disabled scene from the engine', async () => {
    const scene = await makeScene(h)
    expect(h.provider.listAllEnabled()).toHaveLength(1)
    await h.provider.updateScene({
      deviceId: 104,
      monitorId: scene.id,
      patch: { enabled: false },
    })
    expect(h.provider.listAllEnabled()).toHaveLength(0)
  })

  it('a patch never overwrites a field it omitted', async () => {
    const scene = await makeScene(h)
    await h.provider.updateScene({
      deviceId: 104,
      monitorId: scene.id,
      patch: { label: 'renamed' },
    })
    const stored = h.store.getScene(104, scene.id)!.monitor
    expect(stored.label).toBe('renamed')
    expect(stored.quietSeconds).toBe(scene.quietSeconds)
    expect(stored.roi).toEqual(rect())
  })
})
