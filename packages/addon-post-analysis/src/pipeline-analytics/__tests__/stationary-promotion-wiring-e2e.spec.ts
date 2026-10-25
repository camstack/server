/**
 * A registry promotion's effect on TRACKS, through the booted addon (D683
 * round 4, Task 14 fix round 2 — review R1). The pieces are pinned in
 * `pipeline/stationary/__tests__`; this proves the addon wires them: the
 * frame path reaches `birthStationaryFromEvidence` through the ledger, the
 * processor is told the reason, the kept track closes through the addon's own
 * sweep past the TTL, and the addon's own cascades spare the entry's key frame.
 *
 * The ledger's decision is the one thing stubbed: its real bar is minutes of
 * agreement, and the tip is its own spec's subject. The stub calls the real
 * `observe` and only flips `promoted` on the frame the scene chooses, with
 * the row's box, source and key frame named by the scene.
 *
 * The same-chain case (c) maps the source into the live chain through the
 * processor's `rootOf` — the one question the addon asks of L2 there; an
 * L2 fusion committing mid-scene is L2's own spec's subject.
 *
 * Disarms (each alone, restored — all in `index.ts`):
 *  - remove both kept marks (the one at promotion and the executor's
 *    `markKept`): "a walker who sat down …" fails (the sweep discards the row
 *    as a parked re-sighting);
 *  - remove the cascade's sparing wrap (`mediaStore: mediaLeg` →
 *    `mediaStore`): "… survives retention" and "an operator delete names the
 *    key frame it spared" fail;
 *  - force the live plan to never-moved (`planPromotion([])`): "a walker who
 *    sat down …" fails (`'dropped'`, disposed);
 *  - drop the same-chain check in `readPromotionSource`: "a source in the
 *    live chain shares the kept track's fate" fails (the member is disposed);
 *  - (R2) in `readPromotionSource`, judge a persisted source on its trail
 *    (`planPromotion(persisted.positions)`): "an earlier session that walked
 *    in and dwelt is kept as the source" fails.
 */
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrameState } from '../frame/frame-state.js'
import type PipelineAnalyticsAddon from '../index.js'
import type { FrameProcessor } from '../pipeline/frame-processor.js'
import type {
  StationaryEvidenceLedger,
  StationaryEvidenceOutcome,
} from '../pipeline/stationary/stationary-evidence-ledger.js'
import type { StationaryObjectRegistry } from '../pipeline/stationary/stationary-registry.js'
import type { MediaStore } from '../store/media-store.js'
import type { TrackStore } from '../store/track-store.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'

const DEVICE_ID = 103
const HANDLE: FrameHandle = {
  shmId: 'ring-103',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: 'hub',
  slotCount: 8,
}
const T0 = 1_000
const STEP = 130
const SEAT_X = 400

function person(x: number): ObjectDetection {
  return {
    id: 'p',
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 100, width: 60, height: 150 },
  }
}

function emit(bus: IEventBus, timestamp: number, detections: readonly ObjectDetection[]): void {
  const frame: FrameResult = {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections,
  }
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame,
    nodeId: 'hub',
    frameHandle: HANDLE,
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 1))
    await new Promise<void>((r) => setImmediate(r))
  }
}

function field<T>(addon: PipelineAnalyticsAddon, name: string, guard: (v: unknown) => v is T): T {
  const value: unknown = Reflect.get(addon, name)
  if (!guard(value)) throw new Error(`addon.${name} is not built`)
  return value
}
const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null
const trackStoreOf = (a: PipelineAnalyticsAddon): TrackStore =>
  field(a, 'trackStore', (v): v is TrackStore => isObject(v))
const mediaStoreOf = (a: PipelineAnalyticsAddon): MediaStore =>
  field(a, 'mediaStore', (v): v is MediaStore => isObject(v))
const ledgerOf = (a: PipelineAnalyticsAddon): StationaryEvidenceLedger =>
  field(a, 'stationaryEvidence', (v): v is StationaryEvidenceLedger => isObject(v))
const registryOf = (a: PipelineAnalyticsAddon): StationaryObjectRegistry =>
  field(a, 'stationaryRegistry', (v): v is StationaryObjectRegistry => isObject(v))

function processorOf(addon: PipelineAnalyticsAddon): FrameProcessor {
  const frameState = Reflect.get(addon, 'frameState')
  const processors = frameState instanceof FrameState ? frameState.processors : undefined
  if (!(processors instanceof Map)) throw new Error('no processors map')
  const p: FrameProcessor | undefined = processors.get(`${DEVICE_ID}:pipeline`)
  if (p === undefined) throw new Error('no processor for the camera')
  return p
}

async function sweepExpiredTracks(addon: PipelineAnalyticsAddon): Promise<void> {
  const sweep: unknown = Reflect.get(addon, 'sweepExpiredTracks')
  if (typeof sweep !== 'function') throw new Error('no sweepExpiredTracks')
  await sweep.call(addon)
}

interface BirthLine {
  readonly keptTrackIds: readonly string[]
  readonly disposedTrackIds: readonly string[]
  readonly dropReason: string
}

function birthLine(booted: Booted): BirthLine {
  const line = booted.logs.find((l) => l.message === 'stationary entry born from repeated evidence')
  const meta: unknown = isObject(line?.extras) ? Reflect.get(line.extras, 'meta') : null
  if (!isObject(meta)) throw new Error('no birth line')
  const kept: unknown = Reflect.get(meta, 'keptTrackIds')
  const disposed: unknown = Reflect.get(meta, 'disposedTrackIds')
  const reason: unknown = Reflect.get(meta, 'dropReason')
  const strings = (v: unknown): readonly string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    keptTrackIds: strings(kept),
    disposedTrackIds: strings(disposed),
    dropReason: typeof reason === 'string' ? reason : '',
  }
}

interface SceneOptions {
  /** Boxes walked before sitting (0 = sitting from the first box). */
  readonly walkBoxes: number
  /** The row's source: `live` (the live track itself) or a named member id. */
  readonly source: 'live' | string
  /** Map the named source into the live chain (processor `rootOf`). */
  readonly sourceInLiveChain?: boolean
  /** Runs on the booted addon before the first frame. */
  readonly before?: (addon: PipelineAnalyticsAddon) => Promise<void>
}

interface Scene {
  readonly booted: Booted
  readonly trackId: string
  readonly keyFrame: number
  readonly dropReasons: readonly string[]
  readonly lastFrameAt: number
}

/**
 * A person walks in (or is there from the start), sits, and the ledger tips
 * on the last seated frame. The entry is born from the seat box with a key
 * frame the LIVE track owns — the D547 shape.
 */
async function promoteScene(opts: SceneOptions): Promise<Scene> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  const booted = await bootAnalytics(DEVICE_ID, async () => null)
  await opts.before?.(booted.addon)
  let t = T0
  const frame = async (x: number): Promise<void> => {
    vi.setSystemTime(t)
    emit(booted.bus.bus, t, [person(x)])
    await flush()
    t += STEP
  }
  for (let i = 0; i < opts.walkBoxes; i += 1) await frame(100 + i * 30)
  // Seated long enough to be a real track, short of anything the TTL decides.
  for (let i = 0; i < 12; i += 1) await frame(SEAT_X)
  const trackId = trackStoreOf(booted.addon).getActive(DEVICE_ID)[0]?.trackId
  if (trackId === undefined) throw new Error('no live track')
  const keyFrame = await mediaStoreOf(booted.addon).put({
    deviceId: DEVICE_ID,
    ownerKind: 'track',
    ownerId: trackId,
    kind: 'keyFrame',
    timestamp: t,
    data: Buffer.alloc(2_048, 7),
  })
  const processor = processorOf(booted.addon)
  const dropReasons: string[] = []
  const realDrop = processor.dropTrack.bind(processor)
  vi.spyOn(processor, 'dropTrack').mockImplementation((id, reason) => {
    dropReasons.push(reason ?? 'dropped')
    realDrop(id, reason)
  })
  const sourceTrackId = opts.source === 'live' ? trackId : opts.source
  if (opts.sourceInLiveChain === true) {
    const realRoot = processor.rootOf.bind(processor)
    vi.spyOn(processor, 'rootOf').mockImplementation((id) =>
      id === sourceTrackId ? trackId : realRoot(id),
    )
  }
  const ledger = ledgerOf(booted.addon)
  const realObserve = ledger.observe.bind(ledger)
  vi.spyOn(ledger, 'observe').mockImplementation((obs): StationaryEvidenceOutcome | undefined => {
    const real = realObserve(obs)
    if (real === undefined || obs.trackId !== trackId) return real
    return {
      ...real,
      promoted: true,
      row: { ...real.row, bestBbox: { ...obs.bbox }, sourceTrackId, keyFrameMediaId: keyFrame },
    }
  })
  await frame(SEAT_X)
  vi.restoreAllMocks()
  await flush()
  return { booted, trackId, keyFrame, dropReasons, lastFrameAt: t - STEP }
}

describe('a registry promotion through the booted addon (D683 Task 14, review R1)', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await flush()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  /** Past the TTL, the addon's own sweep, as the timer runs it. */
  async function sweepPastTtl(scene: Scene): Promise<void> {
    vi.setSystemTime(scene.lastFrameAt + 60_000)
    await sweepExpiredTracks(scene.booted.addon)
    await flush()
  }

  it('a walker who sat down closes normally: stationary drop, row persisted, no marker', async () => {
    const scene = await promoteScene({ walkBoxes: 10, source: 'live' })
    booted = scene.booted
    expect(registryOf(booted.addon).list(DEVICE_ID)).toHaveLength(1)
    expect(scene.dropReasons).toEqual(['stationary'])
    expect(birthLine(booted).keptTrackIds).toEqual([scene.trackId])

    await sweepPastTtl(scene)

    const row = await trackStoreOf(booted.addon).getPersistedByTrackId(scene.trackId)
    expect(row, 'the kept track was persisted, not discarded as parked').not.toBeNull()
    expect(row?.closedReason).toBeUndefined()
    expect(row?.moved).toBe(true)
  })

  it('… and the entry’s key frame survives retention of that track', async () => {
    const scene = await promoteScene({ walkBoxes: 10, source: 'live' })
    booted = scene.booted
    await sweepPastTtl(scene)
    expect(await trackStoreOf(booted.addon).getPersistedByTrackId(scene.trackId)).not.toBeNull()

    await booted.addon.pruneTracksBefore({ deviceId: DEVICE_ID, cutoffMs: Date.now() + 1 })

    expect(await trackStoreOf(booted.addon).getPersistedByTrackId(scene.trackId)).toBeNull()
    expect(await mediaStoreOf(booted.addon).getById(scene.keyFrame)).not.toBeNull()
  })

  it('an operator delete names the key frame it spared (R6)', async () => {
    const scene = await promoteScene({ walkBoxes: 10, source: 'live' })
    booted = scene.booted
    await sweepPastTtl(scene)

    const result = await booted.addon.deleteTracks({
      deviceId: DEVICE_ID,
      trackIds: [scene.trackId],
    })

    expect(result.deleted).toBe(1)
    expect(result.sparedMediaIds).toEqual([scene.keyFrame])
    expect(await mediaStoreOf(booted.addon).getById(scene.keyFrame)).not.toBeNull()
  })

  it('a subject sitting there from its first box is disposed as D547 — dropped, no row', async () => {
    const scene = await promoteScene({ walkBoxes: 0, source: 'live' })
    booted = scene.booted
    expect(scene.dropReasons).toEqual(['dropped'])
    expect(birthLine(booted).disposedTrackIds).toEqual([scene.trackId])
    expect(trackStoreOf(booted.addon).getActiveByTrack(scene.trackId)).toBeNull()

    await sweepPastTtl(scene)

    expect(await trackStoreOf(booted.addon).getPersistedByTrackId(scene.trackId)).toBeNull()
    // The entry keeps its key frame (D547).
    expect(await mediaStoreOf(booted.addon).getById(scene.keyFrame)).not.toBeNull()
  })

  it('a source in the live chain shares the kept track’s fate (M4)', async () => {
    const scene = await promoteScene({
      walkBoxes: 10,
      source: 'absorbed-member',
      sourceInLiveChain: true,
    })
    booted = scene.booted
    const birth = birthLine(booted)
    expect(birth.dropReason).toBe('stationary')
    expect(birth.keptTrackIds).toEqual([scene.trackId, 'absorbed-member'])
    expect(birth.disposedTrackIds).toEqual([])
  })

  it('an earlier session that walked in and dwelt is kept as the source (R2)', async () => {
    // Session 1 walked in and sat for 3,000 boxes, then was lost and persisted
    // on its TTL — its stored trail has forgotten the walk-in by then.
    const persistEarlier = async (addon: PipelineAnalyticsAddon): Promise<void> => {
      const store = trackStoreOf(addon)
      const sight = (i: number, x: number): void => {
        const timestamp = -1_000_000 + i * STEP
        store.upsert({
          trackId: 'earlier',
          deviceId: DEVICE_ID,
          className: 'person',
          timestamp,
          position: { x, y: 175, timestamp, bbox: { x, y: 100, w: 60, h: 150 } },
          zones: [],
          state: 'moving',
        })
      }
      for (let i = 0; i < 10; i += 1) sight(i, 100 + i * 30)
      for (let i = 10; i < 3_010; i += 1) sight(i, SEAT_X)
      await store.expireStale(T0)
      const row = await store.getPersistedByTrackId('earlier')
      expect(row?.moved).toBe(true)
    }
    const scene = await promoteScene({ walkBoxes: 0, source: 'earlier', before: persistEarlier })
    booted = scene.booted
    const birth = birthLine(booted)
    // The live session never moved and goes (D547); the source moved and stays.
    expect(birth.disposedTrackIds).toEqual([scene.trackId])
    expect(birth.keptTrackIds).toEqual(['earlier'])
    expect(await trackStoreOf(booted.addon).getPersistedByTrackId('earlier')).not.toBeNull()
  })
})
