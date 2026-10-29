/**
 * `hasLiveTrack` — the presence signal the orchestrator's on-motion session
 * hold runs on, and the reason a parked car cannot pin a session open forever.
 *
 * The orchestrator holds a detection session while a subject is PRESENT. The
 * predecessor flag (`hasMovingTrack`) was true only for `moving`/`entered`/
 * `left` states, so it flapped on every detector jitter (D261).
 *
 * The flag is read from `result.tracked` — the POST-suppression tracked set —
 * MINUS anything the stillness predicate says has stopped:
 *
 *   - a subject still being tracked and still doing something ⇒ present;
 *   - a subject that has held still for `sessionStillnessWindowMs` ⇒ NOT
 *     present, so a parked car cannot pin a session to the 120 s cap forever.
 *     This is the ONLY job that predicate has left: it no longer creates a
 *     stationary entry, because "one track survived N seconds" rewards objects
 *     seen well and often and the parked cars that matter are seen badly;
 *   - a subject with a stationary ENTRY has its detections suppressed by the
 *     registry before the tracker sees them, so it never reaches
 *     `result.tracked` at all.
 *
 * Those halves are what this file pins. The controller-side consequences
 * live in
 * `addon-pipeline-orchestrator/src/__tests__/session-holds-until-stationary-promotion.spec.ts`,
 * and the arithmetic between the two packages in
 * `scripts/check-stationary-promotion-reachable.ts`.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type {
  AddonContext,
  FrameResult,
  IEventBus,
  IScopedLogger,
  ObjectDetection,
  PipelineInferenceResultPayload,
  Zone,
} from '@camstack/types'
import { EventCategory, createEvent } from '@camstack/types'
import PipelineAnalyticsAddon from '../index.js'
import { FrameProcessor } from '../pipeline/frame-processor.js'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeEventBus,
  makeFakeDeviceManager,
  makeFakeVectorStore,
  makePipelineBootRecords,
  makeSilentLogger,
  type FakeEventBus,
} from './test-helpers.js'

const DEVICE_ID = 102
const NODE_ID = 'hub'

function detection(id: string): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x: 100, y: 100, width: 60, height: 180 },
  }
}

/** A parked car: `vehicle` promotes by default, `person` does not. */
function vehicle(id: string): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'vehicle',
    score: 0.9,
    labels: [],
    bbox: { x: 100, y: 100, width: 120, height: 90 },
  }
}

/** Every stationary entry the addon has announced so far. */
function stationaryBirths(bus: FakeEventBus): readonly string[] {
  return bus.captured
    .filter((e) => e.category === EventCategory.PipelineAnalyticsStationaryChanged)
    .filter((e) => (e.data as { phase?: string }).phase === 'appeared')
    .map((e) => String((e.data as { entryId?: string }).entryId))
}

function buildFrame(timestamp: number, detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: [...detections],
  }
}

function emit(bus: IEventBus, timestamp: number, detections: readonly ObjectDetection[]): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame: buildFrame(timestamp, detections),
    nodeId: NODE_ID,
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
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

/** Every `hasLiveTrack` value emitted so far, oldest first. */
function presenceFlags(bus: FakeEventBus): readonly (boolean | undefined)[] {
  return bus.captured
    .filter((e) => e.category === EventCategory.PipelineAnalyticsFrameTracked)
    .map((e) => (e.data as { hasLiveTrack?: boolean }).hasLiveTrack)
}

interface BootResult {
  readonly addon: PipelineAnalyticsAddon
  readonly bus: FakeEventBus
}

async function boot(): Promise<BootResult> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  deviceManager.setActive(DEVICE_ID, 'pipeline-analytics', true)

  const api = {
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
    // Present in production wherever `settingsStore` is — same builtin addon.
    vectorStore: makeFakeVectorStore().client,
  } as unknown as AddonContext['api']

  const logger: IScopedLogger = makeSilentLogger()
  const addonStore: Record<string, unknown> = {}
  const deviceStore = new Map<number, Record<string, unknown>>()

  const records = await makePipelineBootRecords()
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger,
    records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: {
      localNodeId: NODE_ID,
      storage,
    } as unknown as AddonContext['kernel'],
    api,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {},
      getDepsDir: () => '/tmp/fake/deps',
    },
    settings: {
      async readAddonStore() {
        return { ...addonStore }
      },
      async writeAddonStore(patch: Record<string, unknown>) {
        Object.assign(addonStore, patch)
      },
      async readDeviceStore(deviceId: number) {
        return { ...deviceStore.get(deviceId) }
      },
      async writeDeviceStore(deviceId: number, patch: Record<string, unknown>) {
        deviceStore.set(deviceId, { ...deviceStore.get(deviceId), ...patch })
      },
      async getSection() {
        return {}
      },
      async setSection() {},
    },
    getNativeProvider: () => {
      throw new Error('no native providers')
    },
    fetchDevice: async () => {
      throw new Error('no devices')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)
  return { addon, bus }
}

describe('pipeline-analytics — hasLiveTrack is PRESENCE, not motion', () => {
  let booted: BootResult

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    })
    vi.setSystemTime(1000)
  })

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    vi.useRealTimers()
  })

  it('reports a subject that is still tracked, and stops the instant it leaves the tracked set', async () => {
    booted = await boot()
    const { bus } = booted

    // Warm the tracker past its confirmation gate on a subject that does not
    // move at all — the very case `hasMovingTrack` could not report.
    for (const t of [1000, 1100, 1200, 1300]) {
      emit(bus.bus, t, [detection('p1')])
      await flush()
    }
    expect(presenceFlags(bus).at(-1)).toBe(true)

    // The subject is gone from the tracked set — which is ALSO what a
    // stationary promotion looks like from here: `processor.dropTrack` plus
    // registry suppression means the object never reaches `result.tracked`
    // again, whether or not it is still physically in frame.
    // The tracker coasts a track for a few frames before giving up, which is
    // its own tolerance and is exactly right here — a one-frame detector miss
    // must not read as "the subject left".
    for (let t = 1400; t <= 20_000; t += 100) {
      vi.setSystemTime(t)
      emit(bus.bus, t, [])
      await flush()
    }
    expect(presenceFlags(bus).at(-1)).toBe(false)
  })
})

describe('pipeline-analytics — the overlay event skips replayed (stale) frames', () => {
  let booted: BootResult

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    })
    vi.setSystemTime(100_000)
  })

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    vi.useRealTimers()
  })

  it('emits for a fresh frame and not for a pre-roll frame older than OVERLAY_MAX_FRAME_AGE_MS', async () => {
    booted = await boot()
    const { bus } = booted
    const emitted = (): number =>
      bus.captured.filter((e) => e.category === EventCategory.PipelineAnalyticsFrameTracked).length

    // A GOP pre-roll replay: frames 5 s old reach the tracker on session start.
    for (const t of [95_000, 95_100, 95_200]) {
      emit(bus.bus, t, [detection('p1')])
      await flush()
    }
    expect(emitted()).toBe(0)

    // A live frame (age 0) is overlaid.
    emit(bus.bus, 100_000, [detection('p1')])
    await flush()
    expect(emitted()).toBe(1)
  })
})

describe('FrameProcessor — the two mechanisms that end presence after a promotion', () => {
  const zones: readonly Zone[] = []

  function frame(detections: readonly ObjectDetection[], timestamp: number): FrameResult {
    return buildFrame(timestamp, detections)
  }

  it('dropTrack (what a stationary BIRTH calls) empties the tracked set for that object', () => {
    const processor = new FrameProcessor(DEVICE_ID)
    processor.setZones(zones)
    const det = detection('d1')
    processor.process({ timestamp: 1000, frame: frame([det], 1000) })
    processor.process({ timestamp: 1100, frame: frame([det], 1100) })
    const settled = processor.process({
      timestamp: 1200,
      frame: frame([det], 1200),
    })
    const trackId = settled.tracked[0]?.trackId
    expect(trackId).toBeDefined()

    processor.dropTrack(trackId!)

    const after = processor.process({
      timestamp: 1300,
      frame: frame([det], 1300),
    })
    expect(after.tracked.find((t) => t.trackId === trackId)).toBeUndefined()
  })

  it('a suppressed detection never reaches the tracked set, so a promoted object stays absent', () => {
    const processor = new FrameProcessor(DEVICE_ID)
    processor.setZones(zones)
    // What the stationary registry does to every later sighting of a promoted
    // object: the detection is filtered out BEFORE the tracker.
    processor.setStationaryGate({
      filter: () => ({
        suppressedIndices: new Set([0]),
        continuableIndices: new Set<number>(),
        confirmed: [],
        woken: [],
      }),
    })
    const det = detection('d1')
    for (const t of [1000, 1100, 1200, 1300]) {
      const out = processor.process({ timestamp: t, frame: frame([det], t) })
      expect(out.tracked).toHaveLength(0)
    }
  })
})

describe('a track no longer earns a stationary entry by surviving', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    })
    vi.setSystemTime(1000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Feed one perfectly motionless vehicle for `untilMs`, 10 fps. */
  async function parkFor(bus: FakeEventBus, untilMs: number): Promise<void> {
    for (let t = 1000; t <= untilMs; t += 100) {
      vi.setSystemTime(t)
      emit(bus.bus, t, [vehicle('v1')])
      await flush()
    }
  }

  it('60 s of an unmoving track — twice the old 30 s window — creates NOTHING', async () => {
    const booted = await boot()
    await parkFor(booted.bus, 61_000)
    // The old criterion promoted this at 30 s. There is no longer any amount of
    // ONE track's survival that produces an entry.
    expect(stationaryBirths(booted.bus)).toHaveLength(0)
    await booted.addon.shutdown()
  })

  it('but it DOES stop holding the session open, at the stillness window', async () => {
    const booted = await boot()
    await parkFor(booted.bus, 61_000)
    // The car is still detected on every single frame — nothing was dropped and
    // nothing was suppressed. Presence ends because the subject STOPPED.
    expect(presenceFlags(booted.bus).at(-1)).toBe(false)
    // CONTROL: it WAS present before the window elapsed.
    expect(
      presenceFlags(booted.bus)
        .slice(0, 100)
        .some((f) => f === true),
    ).toBe(true)
    await booted.addon.shutdown()
  })

  it('repetition past the evidence span DOES create one — occasion A, end to end', async () => {
    const booted = await boot()
    // Same car, same place, past the evidence span floor (120 s). No burst, no
    // extra dial, no second producer: this is the motion session paying for
    // itself.
    await parkFor(booted.bus, 130_000)
    expect(stationaryBirths(booted.bus).length).toBeGreaterThan(0)
    await booted.addon.shutdown()
  })

  it('the birth event carries the zones the parked box is in (none on a camera without zones)', async () => {
    const booted = await boot()
    await parkFor(booted.bus, 130_000)
    await flush()
    const birth = booted.bus.captured.find(
      (e) =>
        e.category === EventCategory.PipelineAnalyticsStationaryChanged &&
        (e.data as { phase?: string }).phase === 'appeared',
    )
    expect(birth).toBeDefined()
    expect(birth?.data).toHaveProperty('zones', [])
    await booted.addon.shutdown()
  })
})

/**
 * D652 — the tracked frame also says how many objects the TRACKER holds.
 *
 * `hasLiveTrack` is presence as the session HOLD sees it: a still subject is
 * subtracted from it on purpose. So a session that closes on a parked car and
 * one that closes on an empty street both saw `hasLiveTrack: false` last, and
 * the orchestrator's close line could not tell them apart. `liveTrackCount` is
 * the tracker's own count, still subject included — diagnostics, deciding
 * nothing.
 */
describe('pipeline-analytics — liveTrackCount counts the still subject the hold ignores', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    })
    vi.setSystemTime(1000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a parked car: hasLiveTrack goes false, liveTrackCount stays 1', async () => {
    const booted = await boot()
    for (let t = 1000; t <= 61_000; t += 100) {
      vi.setSystemTime(t)
      emit(booted.bus.bus, t, [vehicle('v1')])
      await flush()
    }
    const last = booted.bus.captured
      .filter((e) => e.category === EventCategory.PipelineAnalyticsFrameTracked)
      .at(-1)?.data as { hasLiveTrack?: boolean; liveTrackCount?: number } | undefined
    expect(last?.hasLiveTrack).toBe(false)
    expect(last?.liveTrackCount).toBe(1)
    await booted.addon.shutdown()
  })
})
