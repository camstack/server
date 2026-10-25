/**
 * D692 (fresh review H-3): the grouped notification window's three in-process inputs,
 * WIRED through the booted addon. Every NC spec uses a fake outlook and calls the hooks
 * directly, so a dropped wiring line in `index.ts` would leave every identity-scoped
 * grouped rule silent (promotions never arrive) or every window waiting its deadline (the
 * outlook absent) — with the suite green. This proves each line.
 *
 * Disarms (each alone, restored):
 *  - drop TrackStore's `onLabelChanged` dep: "a label change reaches the NC" fails;
 *  - drop the fusion lifecycle port's `fused` line: "a fusion reaches the NC" fails;
 *  - drop the `detailStepsByDevice.set(...)` in `processFrame`: "the outlook answers…" fails;
 *  - drop the NC's `recognitionOutlook` dep: "the outlook answers…" fails;
 *  - pass `firstFaceAt: undefined` in that dep: "…past the settle cap a person is final" fails;
 *  - drop the NC's `resolveTrackAliasSync` dep: "the NC's sync alias read…" fails.
 */
import type {
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationCenter } from '../../notification-center/index.js'
import type PipelineAnalyticsAddon from '../index.js'
import { FaceRecognizer } from '../face-recognizer.js'
import { FACE_DEFAULTS } from '../face-settings.js'
import { TrackFusionService } from '../pipeline/track-fusion-service.js'
import { FACE_SETTLE_HOLD_MS } from '../pipeline/tracker-v2/constants.js'
import { TrackAliasStore } from '../store/track-alias-store.js'
import { TrackStore } from '../store/track-store.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'
import { sighting } from './track-store-test-helpers.js'

const DEVICE_ID = 101

function centerOf(addon: PipelineAnalyticsAddon): NotificationCenter {
  const center: unknown = Reflect.get(addon, 'notificationCenter')
  if (!(center instanceof NotificationCenter)) throw new Error('no notification center')
  return center
}
function trackStoreOf(addon: PipelineAnalyticsAddon): TrackStore {
  const store: unknown = Reflect.get(addon, 'trackStore')
  if (!(store instanceof TrackStore)) throw new Error('no track store')
  return store
}
function recognizerOf(addon: PipelineAnalyticsAddon): FaceRecognizer {
  const rec: unknown = Reflect.get(addon, 'faceRecognizer')
  if (!(rec instanceof FaceRecognizer)) throw new Error('no face recognizer')
  return rec
}
function fusionOf(addon: PipelineAnalyticsAddon): TrackFusionService {
  const svc: unknown = Reflect.get(addon, 'trackFusion')
  if (!(svc instanceof TrackFusionService)) throw new Error('no fusion service')
  return svc
}

function person(id: string, x: number): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 100, width: 60, height: 150 },
  }
}

function emitAnnounce(bus: IEventBus, timestamp: number): void {
  const frame: FrameResult = {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: [person('a', 100)],
  }
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame,
    nodeId: 'hub',
    detailSteps: [
      { stepId: 'face-detection', inputClasses: ['person'], cadence: { trigger: 'once' } },
    ],
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

const booted: Booted[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(booted.splice(0).map((b) => b.addon.shutdown()))
})

describe('the grouped-window inputs are WIRED (D692, H-3)', () => {
  it('a label change on an active track reaches the NC — accepted and cleared', async () => {
    const b = await bootAnalytics(DEVICE_ID, async () => null)
    booted.push(b)
    const center = centerOf(b.addon)
    const spy = vi.spyOn(center, 'onTrackLabelChanged')
    const store = trackStoreOf(b.addon)
    store.upsert(sighting('tA', 1_000, 100, { deviceId: DEVICE_ID }))
    await store.applyLabelCandidate('tA', {
      text: 'Person A',
      tier: 2,
      score: 0.9,
      stepId: 'face-recognizer',
      decidedAt: 1,
      identityId: 'id-a',
    })
    expect(spy).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      trackId: 'tA',
      change: 'accepted',
      label: { label: 'Person A', identityId: 'id-a', labelKind: 'identity' },
    })
    await store.clearLabel('tA', 2)
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ trackId: 'tA', change: 'cleared' }),
    )
  }, 20_000)

  it('a fusion reaches the NC with the survivor and the absorbed id', async () => {
    const b = await bootAnalytics(DEVICE_ID, async () => null)
    booted.push(b)
    const spy = vi.spyOn(centerOf(b.addon), 'onTracksFused')
    const store = trackStoreOf(b.addon)
    store.upsert(sighting('S', 1_000, 100, { deviceId: DEVICE_ID }))
    store.upsert(sighting('A', 1_200, 300, { deviceId: DEVICE_ID }))
    await fusionOf(b.addon).fuse(DEVICE_ID, `${DEVICE_ID}:pipeline`, {
      survivorId: 'S',
      absorbedId: 'A',
      members: ['A'],
      t: 1_500,
      cost: 0.4,
      gapMs: 200,
    })
    expect(spy).toHaveBeenCalledWith({ deviceId: DEVICE_ID, survivorId: 'S', absorbedId: 'A' })
  }, 20_000)

  it("the NC's sync alias read answers a fused id from the alias store's RAM (L-1)", async () => {
    const b = await bootAnalytics(DEVICE_ID, async () => null)
    booted.push(b)
    const aliases: unknown = Reflect.get(b.addon, 'trackAliasStore')
    if (!(aliases instanceof TrackAliasStore)) throw new Error('no track alias store')
    await aliases.record(DEVICE_ID, 'A2', 'S2', 1_500)
    const deps: unknown = Reflect.get(centerOf(b.addon), 'deps')
    const read: unknown =
      deps !== null && typeof deps === 'object' ? Reflect.get(deps, 'resolveTrackAliasSync') : null
    if (typeof read !== 'function') throw new Error('resolveTrackAliasSync is not wired')
    expect(read('A2')).toBe('S2')
    expect(read('S2')).toBeUndefined()
  }, 20_000)

  it('the outlook answers from the camera announce: a dog is final, a person waits for a face', async () => {
    const b = await bootAnalytics(DEVICE_ID, async () => null)
    booted.push(b)
    const center = centerOf(b.addon)
    const ask = (className: string) =>
      center.recognitionOutlookFor({
        deviceId: DEVICE_ID,
        trackId: 'x',
        className,
        now: Date.now(),
      })
    expect(ask('dog')).toMatchObject({ final: false, awaiting: 'unknown' })
    emitAnnounce(b.bus.bus, Date.now())
    await flush()
    expect(ask('dog')).toEqual({ final: true })
    expect(ask('person')).toEqual({ final: false, awaiting: 'face-unseen' })
  }, 20_000)

  it("the outlook reads the face recogniser's first face: past the settle cap a person is final", async () => {
    const b = await bootAnalytics(DEVICE_ID, async () => null)
    booted.push(b)
    const center = centerOf(b.addon)
    emitAnnounce(b.bus.bus, Date.now())
    await flush()
    const recognizer = recognizerOf(b.addon)
    await recognizer.ingestFaceDetail({
      deviceId: DEVICE_ID,
      trackId: 'face-1',
      timestamp: 10_000,
      frameWidth: 640,
      frameHeight: 480,
      score: 0.9,
      embedding: [1, 0, 0, 0],
      parentBbox: { x: 0, y: 0, w: 100, h: 100 },
      faceBbox: { x: 10, y: 10, w: 50, h: 50 },
      settings: { ...FACE_DEFAULTS, enabled: true, minFacePx: 0, recognitionMinFacePx: 0 },
      cropPadding: 0,
    })
    const ask = (now: number) =>
      center.recognitionOutlookFor({
        deviceId: DEVICE_ID,
        trackId: 'face-1',
        className: 'person',
        now,
      })
    expect(ask(10_000 + FACE_SETTLE_HOLD_MS - 1)).toEqual({ final: false, awaiting: 'face' })
    expect(ask(10_000 + FACE_SETTLE_HOLD_MS)).toEqual({ final: true })
  }, 20_000)
})
