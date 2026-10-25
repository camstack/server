/**
 * Pipeline-analytics E2E — boots the full addon against a fake
 * AddonContext and asserts the subscriber loop:
 *
 *  1. Firing `PipelineInferenceResult` on the bus for an active device
 *     produces TrackStore state + ObjectEvent rows once the tracker
 *     reaches minHits=3.
 *  2. The addon emits `pipeline-analytics.frame-tracked` +
 *     `pipeline-analytics.track-started` +
 *     `pipeline-analytics.detection-event` on the bus.
 *  3. Inactive bindings are skipped — no state mutations, no bus emits.
 *  4. `PipelineAudioInferenceResult` lands in the audio-events
 *     collection with the right schema.
 *  5. DeviceBindingsChanged(wrapper-deactivated) clears state + drops
 *     the processor so subsequent frames for that device are ignored.
 *  6. DeviceUnregistered drops state for the device.
 *  7. Cap query methods (getActiveTracks / getObjectEvents / getAudioEvents)
 *     expose the same state the subscribers wrote.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type {
  AddonContext,
  FrameResult,
  ObjectDetection,
  AudioResult,
  PipelineInferenceResultPayload,
  PipelineAudioInferenceResultPayload,
  IScopedLogger,
  SystemEvent,
  Track,
  ObjectEvent,
  IEventBus,
  MediaFile,
  MotionTriggeredBy,
} from '@camstack/types'
import { EventCategory, createEvent } from '@camstack/types'
import { makeTestSystemEvent } from '../../__tests__/support/events.js'
import { FrameState } from '../frame/frame-state.js'
import PipelineAnalyticsAddon from '../index.js'
import type { FrameProcessor, FrameProcessorResult } from '../pipeline/frame-processor.js'
import { TrackResidentState } from '../pipeline/track-resident-state.js'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeEventBus,
  makeFakeDeviceManager,
  makeFakeAddonApi,
  makePipelineBootRecords,
  makeSilentLogger,
  type FakeSettingsStore,
  type FakeStorageProvider,
  type FakeDeviceManager,
  type FakeEventBus,
} from './test-helpers.js'

const DEVICE_ID = 4

function detection(
  id: string,
  bbox: { x: number; y: number; width: number; height: number },
): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox,
  }
}

function buildFrame(timestamp: number, detections: readonly ObjectDetection[] = []): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections,
  }
}

function buildAudio(timestamp: number, rms = 0.1, dbfs = -20): AudioResult {
  return {
    kind: 'audio-window',
    windowId: `w-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    startMs: timestamp,
    endMs: timestamp + 1000,
    level: { rms, dbfs },
    detections: [],
  }
}

function emitInference(bus: IEventBus, frame: FrameResult): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: frame.deviceId,
    frame,
    nodeId: 'hub',
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

function emitAudio(bus: IEventBus, frame: AudioResult): void {
  const payload: PipelineAudioInferenceResultPayload = {
    deviceId: frame.deviceId,
    frame,
    nodeId: 'hub',
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineAudioInferenceResult,
      { type: 'addon', id: 'pipeline-orchestrator' },
      payload,
    ),
  )
}

/**
 * A frame whose ROOT detector was the camera.
 *
 * It arrives on the ordinary inference-result event, because that is the only
 * door: the runner pairs the camera's boxes with a decoded frame and hands
 * them to the same callback its own root step feeds. The discriminator is
 * `source`, and everything here asserts what post-analysis does with it —
 * whether a flag-only push ever becomes a box is the runner's question, and
 * `detection-source-plan.spec.ts` owns it.
 */
function emitOnboardInference(
  bus: IEventBus,
  timestamp: number,
  bbox: { x: number; y: number; width: number; height: number },
  cls = 'person',
): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    nodeId: 'hub',
    source: 'onboard',
    frame: {
      kind: 'frame',
      frameId: `onboard-${String(DEVICE_ID)}-${String(timestamp)}`,
      deviceId: DEVICE_ID,
      timestamp,
      width: 1000,
      height: 1000,
      detections: [
        {
          id: `onboard-${String(timestamp)}-0`,
          kind: 'first-level',
          macroClass: cls,
          score: 0.8,
          labels: [],
          bbox,
        },
      ],
    },
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

function categoriesOf(events: readonly SystemEvent[]): readonly string[] {
  return events.map((e) => e.category)
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

/** The motion still is captured AFTER the row insert, and sharp's downscale
 *  is a libuv tick — two `setImmediate`s are not enough. Poll until the
 *  event owns a snapshot or the budget is spent.
 *
 *  Each attempt yields through a TIMER as well as `setImmediate`. Spinning on
 *  `setImmediate` alone re-enters the check phase without ever giving libuv's
 *  poll phase a turn, so a threadpool completion can be starved for the whole
 *  budget: this spec passed alone and failed inside the full suite, on a
 *  different test each run. The loop still exits the instant the snapshot
 *  lands, so the wider budget costs nothing when nothing is wrong. */
async function waitForEventSnapshot(
  addon: PipelineAnalyticsAddon,
  /** The event's own id — a number (D474). Every caller here is a motion
   *  episode, so the owner type is fixed at `'motion'` (D482 — the owner
   *  TYPE is now part of the question, since a bare id names up to three
   *  rows across the motion/object/audio tables). */
  eventId: number,
): Promise<readonly MediaFile[]> {
  let last: readonly MediaFile[] = []
  for (let i = 0; i < 200; i++) {
    last = await addon.getEventMedia({ ownerType: 'motion', eventId, deviceId: DEVICE_ID })
    if (last.some((m) => m.kind === 'snapshot')) return last
    await new Promise<void>((r) => setTimeout(r, 1))
    await new Promise<void>((r) => setImmediate(r))
  }
  return last
}

interface BootResult {
  readonly addon: PipelineAnalyticsAddon
  readonly ctx: AddonContext
  readonly fakes: {
    readonly settings: FakeSettingsStore
    readonly storage: FakeStorageProvider
    readonly bus: FakeEventBus
    readonly deviceManager: FakeDeviceManager
    readonly snapshotCalls: Array<{ deviceId: number; force?: boolean }>
  }
}

async function boot(
  initialActive = true,
  postProcessingNodeId?: string,
  logger: IScopedLogger = makeSilentLogger(),
): Promise<BootResult> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  const snapshotCalls: Array<{ deviceId: number; force?: boolean }> = []
  if (initialActive) {
    deviceManager.setActive(DEVICE_ID, 'pipeline-analytics', true)
  }

  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
    snapshot: {
      getSnapshot: {
        query: async (input) => {
          snapshotCalls.push({
            deviceId: input.deviceId,
            ...(input.force !== undefined ? { force: input.force } : {}),
          })
          return {
            base64: Buffer.from('jpeg-bytes').toString('base64'),
            contentType: 'image/jpeg',
          }
        },
      },
    },
  })
  const addonStore: Record<string, unknown> =
    postProcessingNodeId !== undefined ? { postProcessingNodeId } : {}
  const deviceStore = new Map<number, Record<string, unknown>>()

  const records = await makePipelineBootRecords()
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger,
    records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: {
      localNodeId: 'hub',
      storage,
      devices: {
        allocateDeviceId: async () => {
          throw new Error('no')
        },
        create: async () => {
          throw new Error('no')
        },
        createContext: () => {
          throw new Error('no')
        },
        register: async () => {
          throw new Error('no')
        },
        remove: async () => {
          /* no-op */
        },
        decommission: async () => {
          /* no-op */
        },
        getAll: async () => [],
        getChildren: async () => [],
      },
    } as unknown as AddonContext['kernel'],
    api,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {
        /* no-op */
      },
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
        const existing = deviceStore.get(deviceId) ?? {}
        deviceStore.set(deviceId, { ...existing, ...patch })
      },
      async getSection() {
        return {}
      },
      async setSection() {
        /* no-op */
      },
    },
    getNativeProvider: () => {
      throw new Error('no native providers in e2e')
    },
    fetchDevice: async () => {
      throw new Error('no devices in e2e')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)

  return {
    addon,
    ctx,
    fakes: { settings, storage, bus, deviceManager, snapshotCalls },
  }
}

describe('pipeline-analytics E2E', () => {
  let booted: BootResult

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
  })

  it('produces tracks, events and bus emits when a device is active', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })

    // Warm up to minHits = 3.
    emitInference(fakes.bus.bus, buildFrame(1000, [det]))
    await flushMicrotasks()
    emitInference(fakes.bus.bus, buildFrame(1100, [det]))
    await flushMicrotasks()
    emitInference(fakes.bus.bus, buildFrame(1200, [det]))
    await flushMicrotasks()

    const tracks: readonly Track[] = await addon.getActiveTracks({
      deviceId: DEVICE_ID,
    })
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.className).toBe('person')

    // Bus should carry frame-tracked + track-started on the third frame.
    const cats = categoriesOf(fakes.bus.captured)
    expect(cats).toContain('pipeline-analytics.frame-tracked')
    expect(cats).toContain('pipeline-analytics.track-started')

    // Object event persisted + queryable through the cap.
    const events = await addon.getObjectEvents({ deviceId: DEVICE_ID })
    if (events.length > 0) {
      const ev: ObjectEvent = events[0]!
      expect(ev.kind).toBe('object')
      expect(ev.trackId).toBe(tracks[0]!.trackId)
      expect(ev.deviceId).toBe(DEVICE_ID)
    }
  })

  it('skips inactive bindings — no tracks, no bus emits', async () => {
    booted = await boot(false)
    const { addon, fakes } = booted
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })

    for (const t of [1000, 1100, 1200]) {
      emitInference(fakes.bus.bus, buildFrame(t, [det]))
      await flushMicrotasks()
    }

    expect(await addon.getActiveTracks({ deviceId: DEVICE_ID })).toHaveLength(0)
    expect(categoriesOf(fakes.bus.captured)).not.toContain('pipeline-analytics.frame-tracked')
    expect(categoriesOf(fakes.bus.captured)).not.toContain('pipeline-analytics.track-started')
  })

  it('is fully INERT when this node is not the designated post-processing node', async () => {
    // Designated node is 'dev-agent-0' but this node is 'hub' → no subscriptions.
    booted = await boot(true, 'dev-agent-0')
    const { addon, fakes } = booted
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })

    for (const t of [1000, 1100, 1200]) {
      emitInference(fakes.bus.bus, buildFrame(t, [det]))
      await flushMicrotasks()
    }

    // No processing at all: no tracks, no bus emits, no persisted events.
    expect(await addon.getActiveTracks({ deviceId: DEVICE_ID })).toHaveLength(0)
    expect(categoriesOf(fakes.bus.captured)).not.toContain('pipeline-analytics.frame-tracked')
    expect(categoriesOf(fakes.bus.captured)).not.toContain('pipeline-analytics.track-started')
    expect(await addon.getObjectEvents({ deviceId: DEVICE_ID })).toHaveLength(0)
  })

  it('re-seeds the rolling-lastFrame clock when a FUSED survivor id reappears (D683)', async () => {
    // Tracker v2 never re-attaches an id across a gap on its own, but a fusion
    // does: after L2 commits B → A, every emission of B carries A's root id,
    // and `processFrame` classifies that reappearance as a RESURRECTION
    // (store positionsCount > 1). The re-seed must run for it exactly as it did
    // for the old tracker's graveyard re-attach.
    //
    // Disarm: in `processFrame`'s resurrection branch, skip the lastFrame
    // re-seed — this test fails (the clock keeps A's near-birth value).
    booted = await boot(true)
    const { addon, fakes } = booted
    const a = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
    for (const t of [1000, 1100, 1200, 1300]) {
      emitInference(fakes.bus.bus, buildFrame(t, [a]))
      await flushMicrotasks()
    }
    const tracks = await addon.getActiveTracks({ deviceId: DEVICE_ID })
    expect(tracks).toHaveLength(1)
    const survivorId = tracks[0]!.trackId
    const residents = Reflect.get(addon, 'residents')
    if (!(residents instanceof TrackResidentState)) throw new Error('no residents')
    expect(residents.lastFrameAt(survivorId)).toBeDefined()
    expect(residents.lastFrameAt(survivorId)!).toBeLessThanOrEqual(1300)

    // Watch the processor's own results to learn the frame the fusion landed on.
    const frameState = Reflect.get(addon, 'frameState')
    const processors = frameState instanceof FrameState ? frameState.processors : undefined
    if (!(processors instanceof Map)) throw new Error('no processors')
    const processor: FrameProcessor | undefined = processors.get(`${DEVICE_ID}:pipeline`)
    if (processor === undefined) throw new Error('no processor')
    const original = processor.process.bind(processor)
    let fusedAt: number | null = null
    processor.process = (input): FrameProcessorResult => {
      const out = original(input)
      if (fusedAt === null && out.fusions.some((f) => f.survivorId === survivorId)) {
        fusedAt = input.timestamp
      }
      return out
    }

    // 8 s of silence (A's 4 s coast runs out), then B beside A's last box —
    // no overlap, well inside the link reach — kept running past the commit
    // (A.lastSeen + 10 s, plus B's 3 s of evidence).
    const b = detection('d2', { x: 160, y: 100, width: 50, height: 50 })
    for (let t = 9300; t <= 14_500; t += 100) {
      emitInference(fakes.bus.bus, buildFrame(t, [b]))
      await flushMicrotasks()
    }
    expect(fusedAt, 'L2 fused the return into the survivor').not.toBeNull()
    const back = await addon.getActiveTracks({ deviceId: DEVICE_ID })
    expect(back.map((t) => t.trackId)).toContain(survivorId)
    // The clock is re-seeded to the frame the survivor id REAPPEARED on — not
    // A's stale near-birth value, which would make lastFrameElapsed true at once.
    expect(residents.lastFrameAt(survivorId)).toBe(fusedAt)
  })

  it('level-path audio writes device-history, not audio-events rows (D850)', async () => {
    const record = vi.fn(async () => ({ accepted: 1, refused: [] }))
    booted = await boot(true)
    booted.ctx.api.deviceHistory.record = { mutate: record }
    const { addon, fakes } = booted

    // One point per 10 s window carrying its PEAK: -12 is the loudest of the
    // window's samples; the third frame (past the window) closes it.
    emitAudio(fakes.bus.bus, buildAudio(1000, 0.42, -12))
    emitAudio(fakes.bus.bus, buildAudio(4000, 0.1, -40))
    emitAudio(fakes.bus.bus, buildAudio(12_000, 0.1, -40))
    await flushMicrotasks()

    const events = await addon.getAudioEvents({ deviceId: DEVICE_ID })
    expect(events).toHaveLength(0)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        points: [
          expect.objectContaining({
            key: 'addon:pipeline-analytics/audio-level',
            value: -12,
            ts: 1000,
          }),
        ],
      }),
    )
    const detectionEvent = fakes.bus.captured.find(
      (e) => e.category === 'pipeline-analytics.detection-event',
    )
    expect(detectionEvent).toBeUndefined()
  })

  it('persists onboard MotionEvent rows from MotionOnMotionChanged', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted

    // Reolink-style firmware push: source='onboard', no regions/frame
    // dims. Mirrors what `provider-reolink/handleSimpleEvent` emits.
    fakes.bus.bus.emit(
      createEvent(
        EventCategory.MotionOnMotionChanged,
        {
          type: 'device',
          id: DEVICE_ID,
          addonId: 'provider-reolink',
          deviceId: DEVICE_ID,
        },
        {
          deviceId: DEVICE_ID,
          detected: true,
          timestamp: 1000,
          source: 'onboard',
        },
      ),
    )
    await flushMicrotasks()

    const events = await addon.getMotionEvents({ deviceId: DEVICE_ID })
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('motion')
    expect(events[0]!.deviceId).toBe(DEVICE_ID)
    expect(events[0]!.timestamp).toBe(1000)
    expect(events[0]!.regionCount).toBe(0)
    expect(events[0]!.regions).toHaveLength(0)

    const detectionEvent = fakes.bus.captured.find(
      (e) =>
        e.category === 'pipeline-analytics.detection-event' &&
        (e.data as { kind?: string }).kind === 'motion',
    )
    expect(detectionEvent).toBeDefined()

    // Videoclip thumbnail contract: the motion row owns a still so
    // `getEventMedia kind:snapshot` (and the stamped mediaUrl) 200s.
    const eventId = events[0]!.id
    const media = await waitForEventSnapshot(addon, eventId)
    expect(media.some((m) => m.kind === 'snapshot')).toBe(true)
    expect(fakes.snapshotCalls).toEqual([{ deviceId: DEVICE_ID }])
  })

  it('an onboard episode opened by an attached sensor records it, and a later camera edge does not move it (D672)', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted
    const emit = (timestamp: number, triggeredBy?: MotionTriggeredBy): void => {
      fakes.bus.bus.emit(
        createEvent(
          EventCategory.MotionOnMotionChanged,
          { type: 'device', id: DEVICE_ID, deviceId: DEVICE_ID },
          {
            deviceId: DEVICE_ID,
            detected: true,
            timestamp,
            source: 'onboard',
            ...(triggeredBy ? { triggeredBy } : {}),
          },
        ),
      )
    }
    emit(1_000, { kind: 'sensor', deviceId: 3299 })
    await flushMicrotasks()
    emit(2_000) // the camera's own VMD, same episode
    await flushMicrotasks()

    const full = await addon.getMotionEvents({ deviceId: DEVICE_ID })
    expect(full).toHaveLength(1)
    expect(full[0]!.triggeredBy).toEqual({ kind: 'sensor', deviceId: 3299 })
    const slim = await addon.getMotionEvents({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim).toHaveLength(1)
    expect(slim[0]!.triggeredBy).toEqual({ kind: 'sensor', deviceId: 3299 })
  })

  it('a camera-opened onboard episode records the camera; a device-activity one records nothing (D672)', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted
    const OTHER = DEVICE_ID + 1
    fakes.deviceManager.setActive(OTHER, 'pipeline-analytics', true)
    const emit = (deviceId: number, source: 'onboard' | 'device-activity'): void => {
      fakes.bus.bus.emit(
        createEvent(
          EventCategory.MotionOnMotionChanged,
          { type: 'device', id: deviceId, deviceId },
          { deviceId, detected: true, timestamp: 1_000, source },
        ),
      )
    }
    emit(DEVICE_ID, 'onboard')
    emit(OTHER, 'device-activity')
    await flushMicrotasks()

    const camera = await addon.getMotionEvents({ deviceId: DEVICE_ID })
    expect(camera).toHaveLength(1)
    expect(camera[0]!.triggeredBy).toEqual({ kind: 'camera' })
    const activity = await addon.getMotionEvents({ deviceId: OTHER })
    expect(activity).toHaveLength(1)
    // Absent means NOT RECORDED — never a guessed camera (D393).
    expect('triggeredBy' in activity[0]!).toBe(false)
    const activitySlim = await addon.getMotionEvents({ deviceId: OTHER, projection: 'slim' })
    expect('triggeredBy' in activitySlim[0]!).toBe(false)
  })

  it('the bridge`s onboard event naming the camera records triggeredBy { kind: camera } on the row (D673 C14)', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted
    fakes.bus.bus.emit(
      createEvent(
        EventCategory.MotionOnMotionChanged,
        { type: 'device', id: DEVICE_ID, deviceId: DEVICE_ID },
        {
          deviceId: DEVICE_ID,
          detected: true,
          timestamp: 1_000,
          source: 'onboard',
          triggeredBy: { kind: 'camera' },
        },
      ),
    )
    await flushMicrotasks()

    const rows = await addon.getMotionEvents({ deviceId: DEVICE_ID })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.triggeredBy).toEqual({ kind: 'camera' })
    const slim = await addon.getMotionEvents({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim[0]!.triggeredBy).toEqual({ kind: 'camera' })
  })

  it('a malformed onboard trigger is recorded as the camera and said ONCE, on the rising edge (D672)', async () => {
    const warns: Array<{ message: string; deviceId: unknown }> = []
    const silent = makeSilentLogger()
    const logger: IScopedLogger = {
      ...silent,
      warn: (message, opts) => {
        warns.push({ message, deviceId: opts?.tags?.['deviceId'] })
      },
      child: () => logger,
      withTags: () => logger,
    }
    booted = await boot(true, undefined, logger)
    const { addon, fakes } = booted
    const emit = (detected: boolean, timestamp: number): void => {
      fakes.bus.bus.emit(
        makeTestSystemEvent(
          EventCategory.MotionOnMotionChanged,
          { type: 'device', id: DEVICE_ID, deviceId: DEVICE_ID },
          {
            deviceId: DEVICE_ID,
            detected,
            timestamp,
            source: 'onboard',
            triggeredBy: { kind: 'doorbell' },
          },
        ),
      )
    }
    emit(true, 1_000)
    await flushMicrotasks()
    emit(false, 2_000)
    await flushMicrotasks()

    const rows = await addon.getMotionEvents({ deviceId: DEVICE_ID })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.triggeredBy).toEqual({ kind: 'camera' })
    const malformed = warns.filter((w) => w.message.includes('triggeredBy malformed'))
    expect(malformed).toEqual([
      {
        message: 'onboard motion: triggeredBy malformed — read as the camera',
        deviceId: DEVICE_ID,
      },
    ])
  })

  it('marks a DROUGHT once per window, not once per off→on edge', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted

    const emitOnboard = (detected: boolean, timestamp: number): void => {
      fakes.bus.bus.emit(
        createEvent(
          EventCategory.MotionOnMotionChanged,
          {
            type: 'device',
            id: DEVICE_ID,
            addonId: 'provider-hikvision',
            deviceId: DEVICE_ID,
          },
          { deviceId: DEVICE_ID, detected, timestamp, source: 'onboard' },
        ),
      )
    }

    // The measured shape: a provider that emits a LEVEL keepalive at ~1 Hz
    // for the whole burst — on the live hub this ran at one per 1.010 s for
    // hours. D475: these all land in ONE open episode row, keyed per
    // (deviceId, source) — a further push inside the still-open episode
    // extends it rather than inserting a new row, and `false` observes the
    // falling edge without touching the episode (it closes on its own timer,
    // never on an explicit off). So this whole sequence — including the
    // t=8000 push, a genuine transition since t=3000 observed an explicit
    // false — stays ONE row, still open (`durationMs: null`) at the end,
    // because none of it is 15 s (`MOTION_CLOSE_AFTER_MS`) past the last push.
    emitOnboard(true, 1000)
    await flushMicrotasks()
    emitOnboard(true, 2000) // still in the same burst — a continuation, not a new edge
    await flushMicrotasks()
    emitOnboard(false, 3000) // firmware inactivity — the episode stays open, closes on its OWN timer
    await flushMicrotasks()
    emitOnboard(true, 8000) // a genuine second edge (transition), extends the SAME row
    await flushMicrotasks()
    emitOnboard(true, 13_000) // a continuation of the second edge, not a third
    await flushMicrotasks()

    const events = await addon.getMotionEvents({ deviceId: DEVICE_ID })
    // ONE row for the whole burst — replaces the pre-D475 heartbeat scheme
    // (which produced 3 rows for this exact sequence: one per genuine edge,
    // plus one heartbeat). The row is still open: none of this sequence sits
    // 15 s past its last push.
    expect(events).toHaveLength(1)
    const episode = events[0]!
    expect(episode.timestamp).toBe(1000)
    expect(episode.durationMs).toBeNull()

    // Exactly ONE still, across BOTH genuine edges (t=1000 and t=8000) — they
    // fall inside the same 15-minute drought window, so the second is a
    // duplicate of a marker that already exists on the SAME row, and the
    // camera is asked for a frame exactly once, not twice.
    for (let i = 0; i < 50 && fakes.snapshotCalls.length < 1; i++) {
      await new Promise<void>((r) => setImmediate(r))
    }
    expect(fakes.snapshotCalls).toHaveLength(1)

    const media = await waitForEventSnapshot(addon, episode.id)
    expect(media.filter((m) => m.kind === 'snapshot')).toHaveLength(1)
  })

  it('analyzes a camera-rooted frame through the same layers, tagged source=onboard', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted

    // The camera was this frame's root detector. Warm up to minHits=3 at a
    // stable position so a track emerges — the SAME layers as the ML source,
    // through the SAME door, distinguished only by `source`.
    const box = { x: 100, y: 100, width: 100, height: 100 }
    emitOnboardInference(fakes.bus.bus, 1000, box)
    await flushMicrotasks()
    emitOnboardInference(fakes.bus.bus, 1100, box)
    await flushMicrotasks()
    emitOnboardInference(fakes.bus.bus, 1200, box)
    await flushMicrotasks()

    // Native detections produced a track via the same analysis layers.
    const tracks: readonly Track[] = await addon.getActiveTracks({
      deviceId: DEVICE_ID,
    })
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.className).toBe('person')
    expect(categoriesOf(fakes.bus.captured)).toContain('pipeline-analytics.frame-tracked')

    // Every persisted object event + every object detection-event carries
    // the onboard source — the discriminator consumers will select on.
    const events = await addon.getObjectEvents({ deviceId: DEVICE_ID })
    expect(events.every((e) => e.source === 'onboard')).toBe(true)
    const objectDetectionEvents = fakes.bus.captured.filter(
      (e) =>
        e.category === 'pipeline-analytics.detection-event' &&
        (e.data as { kind?: string }).kind === 'object',
    )
    expect(
      objectDetectionEvents.every((e) => (e.data as { source?: string }).source === 'onboard'),
    ).toBe(true)
  })

  // A flag-only push producing no track USED to be asserted here, against this
  // addon's own subscription to `DetectionCameraNative`. That subscription is
  // gone, so the case now passes because nothing listens — a test that is green
  // about a door that does not exist, which is worse than no test. The rule it
  // guarded (no geometry ⇒ no root detection) moved with the code, to the
  // runner: `detection-source-plan.spec.ts`, "drops a flag-only push".
  it('ignores a raw camera-native push — this addon no longer has a door for it', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted

    fakes.bus.bus.emit(
      createEvent(
        EventCategory.DetectionCameraNative,
        { type: 'device', id: DEVICE_ID, addonId: 'provider-reolink', deviceId: DEVICE_ID },
        {
          cameraId: DEVICE_ID,
          source: 'onboard',
          detections: [{ class: 'person', timestamp: 1000, bbox: [0.1, 0.1, 0.1, 0.1] }],
        },
      ),
    )
    await flushMicrotasks()

    // Even WITH geometry: the runner decides whether this camera's detector is
    // a root step, and a push that bypassed it is not admitted here.
    expect(await addon.getActiveTracks({ deviceId: DEVICE_ID })).toHaveLength(0)
    expect(categoriesOf(fakes.bus.captured)).not.toContain('pipeline-analytics.frame-tracked')
  })

  it('skips analyzer-source MotionOnMotionChanged (analyzer drives MotionAnalysis path)', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted

    fakes.bus.bus.emit(
      createEvent(
        EventCategory.MotionOnMotionChanged,
        {
          type: 'device',
          id: DEVICE_ID,
          addonId: 'pipeline-runner',
          deviceId: DEVICE_ID,
        },
        {
          deviceId: DEVICE_ID,
          detected: true,
          timestamp: 1000,
          source: 'analyzer',
        },
      ),
    )
    await flushMicrotasks()

    expect(await addon.getMotionEvents({ deviceId: DEVICE_ID })).toHaveLength(0)
  })

  it('drops state for a device when its wrapper is deactivated', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })

    for (const t of [1000, 1100, 1200]) {
      emitInference(fakes.bus.bus, buildFrame(t, [det]))
      await flushMicrotasks()
    }
    expect((await addon.getActiveTracks({ deviceId: DEVICE_ID })).length).toBeGreaterThan(0)

    // Flip off via DeviceBindingsChanged.
    fakes.bus.bus.emit(
      createEvent(
        EventCategory.DeviceBindingsChanged,
        { type: 'addon', id: 'device-manager' },
        {
          deviceId: DEVICE_ID,
          capName: 'pipeline-analytics',
          reason: 'wrapper-deactivated',
          addonId: 'pipeline-analytics',
          nodeId: 'hub',
        },
      ),
    )
    await flushMicrotasks()

    expect(await addon.getActiveTracks({ deviceId: DEVICE_ID })).toHaveLength(0)
  })

  it('drops state when the device is unregistered', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
    for (const t of [1000, 1100, 1200]) {
      emitInference(fakes.bus.bus, buildFrame(t, [det]))
      await flushMicrotasks()
    }
    expect((await addon.getActiveTracks({ deviceId: DEVICE_ID })).length).toBeGreaterThan(0)

    fakes.bus.bus.emit(
      createEvent(
        EventCategory.DeviceUnregistered,
        { type: 'addon', id: 'device-manager' },
        { deviceId: DEVICE_ID, providerId: 'test' },
      ),
    )
    await flushMicrotasks()

    expect(await addon.getActiveTracks({ deviceId: DEVICE_ID })).toHaveLength(0)
  })

  it('declares object-events + tracks + media at init (trackless events are records on hub)', async () => {
    booted = await boot(true)
    const { fakes } = booted
    expect(fakes.settings.declared.has('pipeline-analytics:tracks')).toBe(true)
    expect(fakes.settings.declared.has('pipeline-analytics:object-events')).toBe(true)
    expect(fakes.settings.declared.has('pipeline-analytics:media')).toBe(true)
    expect(fakes.settings.declared.has('pipeline-analytics:motion-events')).toBe(false)
    expect(fakes.settings.declared.has('pipeline-analytics:audio-events')).toBe(false)
  })

  it('clearTracks drops active state for a device through the cap method', async () => {
    booted = await boot(true)
    const { addon, fakes } = booted
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
    for (const t of [1000, 1100, 1200]) {
      emitInference(fakes.bus.bus, buildFrame(t, [det]))
      await flushMicrotasks()
    }
    expect((await addon.getActiveTracks({ deviceId: DEVICE_ID })).length).toBeGreaterThan(0)
    await addon.clearTracks({ deviceId: DEVICE_ID })
    expect(await addon.getActiveTracks({ deviceId: DEVICE_ID })).toHaveLength(0)
  })
})
