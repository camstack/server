/**
 * The key frame, END TO END through the booted addon — since D422, as a PARK.
 *
 * The pure decision (`key-frame-retry.ts`) and the pure orders
 * (`track-park.ts`) have their own specs, but the defect this guards was
 * never in a decision — it was in the WIRING: `keyFrame` was `isNewBest &&
 * plausibleBox` at one call site, and `isNewBest` is a peak signal. A unit
 * test of a correct decision function proves nothing about whether the frame
 * loop consults it. So this boots the real addon, feeds it frames with a real
 * `frameHandle`, and counts the PARK orders that actually reach the node and
 * the parcel reads the write actually makes.
 *
 * Measured baseline, live hub 2026-08-06: of 102 tracks that logged a native
 * key-frame miss, 494 (80%) got exactly ONE attempt in their whole life;
 * 388/542 survivors (71.6%) ended with no key frame. And 2026-09-09 (D420): a
 * 10 s lease bound took keyFrame presence from 99.5% to 76.6% because the
 * write asked for pixels by handle, late. Here nothing asks by handle: the
 * park happens the instant the best is decided, and the write reads by track.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type {
  FrameHandle,
  FrameResult,
  ObjectDetection,
  PipelineInferenceResultPayload,
  IEventBus,
} from '@camstack/types'
import { EventCategory, createEvent } from '@camstack/types'
import { encodeRgbCropToJpeg } from '../../shared/frame/encode-crop.js'
import { bootAnalytics, type Booted } from './boot-analytics.js'
import {
  isFullFrameRequest,
  isKeyFramePark,
  isKeyFrameRequest,
  type FakeEventBus,
  type FakeNativeCropReply,
  type FakeNativeCropRequest,
  type FakeParkRequest,
  makeTestTopologyNode,
} from './test-helpers.js'

const DEVICE_ID = 4
const OWNER_NODE = 'alice-laptop'

const HANDLE: FrameHandle = {
  shmId: 'ring-4',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: OWNER_NODE,
  slotCount: 8,
}

function detection(id: string): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    // Centred and well inside the frame so the plausibility + edge-clear
    // guards pass and the best-frame policy accepts it.
    bbox: { x: 220, y: 160, width: 200, height: 160 },
  }
}

function buildFrame(timestamp: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: [detection('d1')],
  }
}

function emitInference(bus: IEventBus, timestamp: number): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame: buildFrame(timestamp),
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

function emitTopology(bus: IEventBus, nodes: readonly { id: string; isOnline: boolean }[]): void {
  bus.emit(
    createEvent(
      EventCategory.ClusterTopologySnapshot,
      { type: 'core', id: 'topology-emitter' },
      {
        nodes: nodes.map((n) => makeTestTopologyNode(n)),
        timestamp: Date.now(),
      },
    ),
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 1))
    await new Promise<void>((r) => setImmediate(r))
  }
}

/** The key-frame PARK orders — the whole frame at the native cap. */
function keyFrameParks(parks: readonly FakeParkRequest[]): number {
  return parks.filter(isKeyFramePark).length
}

/** The key-frame WRITES that ran — each one reads the parcel by track. */
function keyFrameReads(booted: Booted): number {
  return booted.parcelReads.filter((read) => read.kind === 'keyFrame').length
}

/** The frame instant of the FIRST accepted best-shot promotion — the decision
 *  the park must ride on. Read off the D400 promotion log line. */
function firstAcceptedPromotionAt(booted: Booted): number | undefined {
  for (const line of booted.logs) {
    if (line.message !== 'best shot promotion') continue
    const meta = (line.extras as { meta?: { accepted?: boolean; timestamp?: number } }).meta
    if (meta?.accepted === true && typeof meta.timestamp === 'number') return meta.timestamp
  }
  return undefined
}

/** No native crop by handle answers anything here: every pixel a key frame
 *  needs is parked, and this proves the write never reaches back for one. */
const NO_NATIVE = async (): Promise<null> => null

/** A decodable JPEG for the ≤640 frame RESOLVE (bbox {0,0,1,1} at the handle's
 *  own width) the per-frame media batch pins in its live window, and for the
 *  960 boxed timeline tiles — both inside the enrichment horizon and still by
 *  handle. Nothing at the KEY-FRAME cap is ever answered: that is the ask
 *  D422 retired, and the write must not make it. */
let resolveJpegBase64 = ''
async function resolveOnly(request: FakeNativeCropRequest): Promise<FakeNativeCropReply | null> {
  if (!isFullFrameRequest(request) || isKeyFrameRequest(request)) return null
  if (resolveJpegBase64 === '') {
    const rgb = Buffer.allocUnsafe(64 * 48 * 3)
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 37) & 0xff
    resolveJpegBase64 = (await encodeRgbCropToJpeg(rgb, 64, 48)).toString('base64')
  }
  return { jpeg: resolveJpegBase64, width: 64, height: 48, tier: 'ram-fullframe' }
}

/**
 * Drive the track well past the best-frame peak. Frame timestamps are spaced
 * 1 s apart so the retry's 2 s min gap is crossed several times over — the
 * point being that `isNewBest` is NOT raised on most of these frames.
 */
async function driveFrames(bus: FakeEventBus, count: number, stepMs = 1_000): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    emitInference(bus.bus, 1_000 + i * stepMs)
    await flush()
  }
}

describe('key-frame park + write, end to end', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    // DRAIN before shutting the addon down. The bus handler dispatches
    // `handleInferenceResult` fire-and-forget, so the last frame of a test can
    // still be inside `processFrame` when `shutdown()` clears `_ctx`.
    await flush()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('PARKS the key frame the instant the best is decided, and writes it from the parcel — by track, never by handle', async () => {
    booted = await bootAnalytics(DEVICE_ID, resolveOnly)
    await driveFrames(booted.bus, 12)

    // One decision, one park, one write — and nothing after it, because it
    // landed. The park names the owning node and the whole frame.
    expect(keyFrameParks(booted.parks)).toBe(1)
    const park = booted.parks.find(isKeyFramePark)
    // ON THE DECISION FRAME: the instant the best-frame policy ACCEPTED the
    // frame (the `best shot promotion` line it logs), not a later one. A park
    // stamped later came from the retry path, not from the decision — the
    // by-handle lateness one design later — and that was exactly what this
    // spec failed to catch the first time the fix was removed under it.
    const decidedAt = firstAcceptedPromotionAt(booted)
    expect(decidedAt).toBeDefined()
    expect(park).toMatchObject({
      deviceId: DEVICE_ID,
      handle: { nodeId: OWNER_NODE },
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      timestamp: decidedAt,
    })
    expect(booted.parks.find((p) => p.kind === 'thumbnail')?.timestamp).toBe(decidedAt)
    expect(keyFrameReads(booted)).toBe(1)
    // The write never asked for pixels by handle: not one full-frame fetch at
    // the key-frame cap (the 960 boxed timeline tiles still fetch by handle
    // inside the live batch — a different consumer, inside the horizon).
    expect(booted.requests.filter(isKeyFrameRequest)).toEqual([])
    // A thumbnail was parked from the SAME decision — the subject window, not
    // the whole frame, and it too is read by track.
    expect(booted.parks.filter((p) => p.kind === 'thumbnail')).toHaveLength(1)
    expect(booted.parcelReads.filter((r) => r.kind === 'thumbnail').length).toBeGreaterThan(0)
  })

  it('RETRIES a track whose park is REFUSED — bounded, on LATER frames, not once', async () => {
    // The handle is gone by the time every order lands (the D419 shape).
    booted = await bootAnalytics(DEVICE_ID, NO_NATIVE, {
      parking: {
        park: async () => ({ kind: 'refused', reason: 'handle-gone', handleAgeMs: 4_310 }),
      },
    })
    await driveFrames(booted.bus, 12)

    const parks = keyFrameParks(booted.parks)
    // The defect: exactly one attempt for 80% of missing tracks. The retry
    // must park a LATER frame, more than once…
    expect(parks).toBeGreaterThan(1)
    // …and must NOT park one per frame on a saturated hub. 1 new-best peak
    // + 3 bounded retries is the ceiling for a track with a single peak.
    expect(parks).toBeLessThanOrEqual(4)
    // Every retry park is a DIFFERENT instant — a later frame, not the same
    // dead handle asked again.
    const instants = new Set(booted.parks.filter(isKeyFramePark).map((p) => p.timestamp))
    expect(instants.size).toBe(parks)
    // The refusal reached the log, per camera, with the age the node measured.
    const refused = booted.logs.filter(
      (l) => l.level === 'warn' && l.message === 'track frame park refused by the owning node',
    )
    expect(refused.length).toBeGreaterThan(0)
    expect(refused[0]!.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { nodeId: OWNER_NODE, reason: 'handle-gone', handleAgeMs: 4_310 },
    })
  })

  it('a parcel the node let go keeps the write retrying (bounded) without re-parking over a ranked one', async () => {
    booted = await bootAnalytics(DEVICE_ID, NO_NATIVE, {
      parking: { parcelRead: async () => 'gone' },
    })
    await driveFrames(booted.bus, 12)

    // The park succeeded at the peak, so the retry does NOT replace it with a
    // frame the ranking did not prefer …
    expect(keyFrameParks(booted.parks)).toBe(1)
    // … it re-reads, bounded: 1 peak write + ≤3 retries.
    const reads = keyFrameReads(booted)
    expect(reads).toBeGreaterThan(1)
    expect(reads).toBeLessThanOrEqual(4)
    const gone = booted.logs.filter(
      (l) =>
        l.level === 'warn' &&
        l.message === 'parked frame gone at retrieval — the node no longer holds it',
    )
    expect(gone.length).toBeGreaterThan(0)
    expect(gone[0]!.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { nodeId: OWNER_NODE, kind: 'keyFrame' },
    })
  })

  it('a THROWING runner is retried too, and the failure names the camera AND the node', async () => {
    booted = await bootAnalytics(DEVICE_ID, NO_NATIVE, {
      parking: {
        park: async () => {
          throw new Error(
            `pipelineRunner.parkTrackFrame not routable to node ${OWNER_NODE}: node-offline`,
          )
        },
      },
    })
    await driveFrames(booted.bus, 12)

    expect(keyFrameParks(booted.parks)).toBeGreaterThan(1)

    // Fix 1a, still true one design later: the routing failure reaches the log
    // at WARN, naming the camera AND the unreachable node.
    const warned = booted.logs.filter(
      (l) =>
        l.level === 'warn' &&
        l.message === 'track frame park failed — the order did not reach the node',
    )
    expect(warned.length).toBeGreaterThan(0)
    expect(warned[0]!.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { nodeId: OWNER_NODE },
    })
    // And the write that had no parcel to read says so — never at debug.
    expect(
      booted.logs.some(
        (l) =>
          l.level === 'error' &&
          l.message === 'key-frame parcel missing — nothing to write, retry parks a later frame',
      ),
    ).toBe(true)
  })

  it('dispatches NOTHING once the registry says the handle owner is offline', async () => {
    booted = await bootAnalytics(DEVICE_ID, NO_NATIVE)
    // Two agreeing snapshots — one is deliberately not enough (D49).
    emitTopology(booted.bus.bus, [
      { id: 'hub', isOnline: true },
      { id: OWNER_NODE, isOnline: false },
    ])
    emitTopology(booted.bus.bus, [
      { id: 'hub', isOnline: true },
      { id: OWNER_NODE, isOnline: false },
    ])
    await flush()

    await driveFrames(booted.bus, 12)

    // Not one park and not one read: every one of them would have burned a
    // cross-node timeout to learn what the registry already said (D58).
    expect(booted.parks).toHaveLength(0)
    expect(booted.parcelReads).toHaveLength(0)
    expect(booted.requests).toHaveLength(0)

    // …and the drop is LOGGED, once, naming the camera and the dead node.
    const gated = booted.logs.filter(
      (l) =>
        l.level === 'warn' &&
        l.message ===
          'media capture SKIPPED — the node owning this frame handle is offline in the cluster registry',
    )
    expect(gated).toHaveLength(1)
    expect(gated[0]!.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { nodeId: OWNER_NODE },
    })
  })

  it('a SINGLE offline snapshot does not gate — one read never destroys work', async () => {
    booted = await bootAnalytics(DEVICE_ID, NO_NATIVE)
    emitTopology(booted.bus.bus, [{ id: OWNER_NODE, isOnline: false }])
    await flush()

    await driveFrames(booted.bus, 6)
    expect(booted.parks.length).toBeGreaterThan(0)
  })

  it('resumes parking when the node comes back', async () => {
    booted = await bootAnalytics(DEVICE_ID, NO_NATIVE)
    for (let i = 0; i < 2; i += 1) {
      emitTopology(booted.bus.bus, [{ id: OWNER_NODE, isOnline: false }])
    }
    await flush()
    await driveFrames(booted.bus, 4)
    expect(booted.parks).toHaveLength(0)

    emitTopology(booted.bus.bus, [{ id: OWNER_NODE, isOnline: true }])
    await flush()
    await driveFrames(booted.bus, 6)
    expect(booted.parks.length).toBeGreaterThan(0)
  })
})
