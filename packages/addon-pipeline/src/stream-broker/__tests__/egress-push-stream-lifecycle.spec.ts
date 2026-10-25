/**
 * A PUBLISHED push stream whose egress entry is alive must stay attachable.
 *
 * Live bug (112 "Camera kitchen", Alexa, 2026-08-07). The Echo's known
 * double-offer acquired ONE shared egress (`refcount=2`, ffmpeg pushing
 * `packetsOut=250,500,750…` throughout) and 13 s later the whole thing fell
 * over:
 *
 *   13:43:55  (webrtc) WebRTC broker unregistered {brokerId=112/egress:08e7…}
 *   13:43:55  (egress:08e7…) Broker stopping
 *   13:43:55  egress push sink: NO broker for the published stream — DROPPED
 *   13:44:05  alexa rtc-session: handleOffer failed
 *             {error='No broker for stream "112/egress:08e7…"'}
 *
 * The teardown is the CATALOG RECONCILE sweep: `reconcileDeviceCatalog`
 * retracts every registered cam-stream absent from the provider's
 * `stream-catalog`, and a provider catalog can never contain a BROKER-OWNED
 * synthetic — the `egress:*` stream the ffmpeg primitive publishes for
 * `publishLocally`. Two teardowns 30 s apart to the second (587 at :55, 101 at
 * :25) are the poll tick, not a consumer edge. It is the exact bug the
 * `kind: 'derived'` skip beside it was added for (the 618 sub-cropped bug),
 * one publisher later.
 *
 * Retraction also DELETES the cam-stream record, so `ensureBroker` no-ops on
 * the next attach (`if (!cam) return`) and every later offer fails with "No
 * broker for stream" while ffmpeg keeps encoding into a dropped sink — the
 * reconnect loop the operator sees as instability.
 *
 * Harness: the manager/RTSP/api stubs of `catalog-reconcile-keeps-derived.spec.ts`
 * plus the egress child seam, so the REAL `publishPushStream` closure runs and
 * the test drives the sink exactly as the ffmpeg push reader does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { pushOnlyUrl } from '../stream-broker/egress-transcode-manager.js'
import type {
  EgressChild,
  EgressChildSpec,
  EgressPushSink,
} from '../stream-broker/egress-transcode-manager.js'
import type {
  AddonApi,
  CamStreamDescriptor,
  EncodedPacket,
  EgressTranscodeRequest,
  IScopedLogger,
} from '@camstack/types'

const DEVICE = 112

/** A logger that records every message, so the announcement PAIR is assertable. */
function makeLogger(lines: string[]): IScopedLogger {
  const record =
    (level: string) =>
    (msg: string): void => {
      lines.push(`${level} ${msg}`)
    }
  const l: IScopedLogger = {
    info: vi.fn(record('info')),
    warn: vi.fn(record('warn')),
    error: vi.fn(record('error')),
    debug: vi.fn(record('debug')),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function stubRtsp(manager: StreamBrokerManager): void {
  ;(manager as unknown as { rtspProvider: unknown }).rtspProvider = {
    getEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: `rtsp://host/${brokerId}?muted`,
      enabled: true,
    })),
    getInternalEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: `rtsp://host/${brokerId}?muted`,
      enabled: true,
    })),
    setEnabled: vi.fn(),
    isEnabled: vi.fn(() => true),
    setTokenPersister: vi.fn(),
    setEnabledPersister: vi.fn(),
    getAllEntries: vi.fn(() => []),
    regenerateToken: vi.fn(),
    getRtspPort: vi.fn(() => 8554),
    persistTokens: vi.fn(),
  }
  ;(manager as unknown as { rtspServer: unknown }).rtspServer = {
    registerRestreamer: vi.fn(),
    unregisterRestreamer: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getPort: vi.fn(() => 8554),
    loadEnabled: vi.fn(),
  }
}

const CATALOG: readonly CamStreamDescriptor[] = [
  {
    camStreamId: 'native:main',
    kind: 'pull-rtsp',
    url: 'rtsp://x/main',
    codec: 'h265',
    resolution: { width: 2560, height: 1440 },
  },
  {
    camStreamId: 'native:sub',
    kind: 'pull-rtsp',
    url: 'rtsp://x/sub',
    codec: 'h265',
    resolution: { width: 640, height: 360 },
  },
]

function makeApi(): AddonApi {
  return {
    deviceManager: {
      listAll: {
        query: vi.fn(async () => [{ id: DEVICE, type: 'camera', isCamera: true, disabled: false }]),
      },
    },
    streamCatalog: { getCatalog: { query: vi.fn(async () => CATALOG) } },
  } as unknown as AddonApi
}

const REQUEST: EgressTranscodeRequest = {
  deviceId: DEVICE,
  source: { kind: 'profile', profile: 'high' },
  encode: {
    video: {
      codec: 'h264',
      width: 1280,
      height: 720,
      fps: 25,
      bitrateKbps: 2000,
    },
    audio: 'passthrough',
  },
  rateControl: 'relaxed',
  publishLocally: true,
  tag: 'spec/alexa',
}

/** A fake ffmpeg child that hands the test the sink the manager published. */
function fakeChild(spec: EgressChildSpec, captured: { sink?: EgressPushSink }): EgressChild {
  captured.sink = spec.pushSink
  return {
    start: async () => spec.consumerUrl,
    stop: async () => {},
    decodeHwAccel: () => null,
  }
}

function videoPacket(pts: number, keyframe: boolean): EncodedPacket {
  return {
    type: 'video',
    data: Buffer.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41, pts & 0xff]),
    pts,
    dts: pts,
    keyframe,
    codec: 'h264',
  }
}

/** The manager's live broker registry — the thing an attach resolves through. */
function brokersOf(manager: StreamBrokerManager): Map<string, { onEncodedData: unknown }> {
  return (manager as unknown as { brokers: Map<string, { onEncodedData: unknown }> }).brokers
}

interface AttachableBroker {
  onEncodedData: (cb: (packet: EncodedPacket) => void) => () => void
  getStats: () => { audio: { codec: string } | null }
}

function attach(
  manager: StreamBrokerManager,
  brokerId: string,
): { received: EncodedPacket[]; detach: () => void; broker: AttachableBroker } {
  const broker = brokersOf(manager).get(brokerId) as unknown as AttachableBroker | undefined
  if (!broker) throw new Error(`no broker registered for "${brokerId}"`)
  const received: EncodedPacket[] = []
  const detach = broker.onEncodedData((packet) => received.push(packet))
  return { received, detach, broker }
}

describe('egress push stream lifecycle', () => {
  let manager: StreamBrokerManager
  let logLines: string[]
  let captured: { sink?: EgressPushSink }

  beforeEach(async () => {
    logLines = []
    manager = new StreamBrokerManager(makeLogger(logLines))
    stubRtsp(manager)
    manager.setApiAccess(makeApi())
    captured = {}
    manager.setEgressChildFactory((spec) => fakeChild(spec, captured))
    await manager.reconcileDeviceCatalog(DEVICE)
  })

  afterEach(async () => {
    await manager.destroyAll()
  })

  it('the catalog reconcile does NOT sweep the broker-owned egress stream out from under a live egress entry', async () => {
    const handle = await manager.acquireEgressTranscode(REQUEST)
    const camStreamId = handle.camStreamId
    expect(camStreamId).not.toBeNull()
    expect(handle.url).toBe(pushOnlyUrl(camStreamId!))
    const brokerId = `${DEVICE}/${camStreamId!}`
    expect(brokersOf(manager).has(brokerId)).toBe(true)

    // The poll tick. The provider catalog lists only `native:main` — it can
    // never contain a broker-owned synthetic — and the egress entry is still
    // held (refcount 1, ffmpeg alive).
    await manager.reconcileDeviceCatalog(DEVICE)

    expect(manager.getCameraStreamsForDevice(DEVICE).map((s) => s.camStreamId)).toContain(
      camStreamId,
    )
    expect(brokersOf(manager).has(brokerId)).toBe(true)
    // …and a physical stream that left the catalog is still swept.
    expect(manager.getCameraStreamsForDevice(DEVICE).map((s) => s.camStreamId)).toContain(
      'native:main',
    )
  })

  it('a SECOND consumer attaching after the first detached and the broker was torn down still receives packets', async () => {
    const handle = await manager.acquireEgressTranscode(REQUEST)
    const camStreamId = handle.camStreamId!
    const brokerId = `${DEVICE}/${camStreamId}`
    const sink = captured.sink
    expect(sink).toBeDefined()

    // First consumer: attaches, receives, detaches.
    const first = attach(manager, brokerId)
    sink!.push(videoPacket(1, true))
    expect(first.received).toHaveLength(1)
    first.detach()

    // Whatever tears the broker down while the published stream is alive —
    // an idle edge, a sweep, a restart — the stream stays PUBLISHED, so the
    // next attach must bring the broker back rather than fail.
    await (
      manager as unknown as {
        releaseBroker: (deviceId: number, camStreamId: string) => Promise<void>
      }
    ).releaseBroker(DEVICE, camStreamId)
    expect(brokersOf(manager).has(brokerId)).toBe(false)

    await manager.ensureBrokerForWebrtcSession(DEVICE, brokerId, camStreamId)
    expect(brokersOf(manager).has(brokerId)).toBe(true)

    const second = attach(manager, brokerId)
    sink!.push(videoPacket(2, true))
    expect(second.received).toHaveLength(1)
  })

  it('the sink re-announces and re-primes audio on a NEW broker generation', async () => {
    const handle = await manager.acquireEgressTranscode(REQUEST)
    const camStreamId = handle.camStreamId!
    const brokerId = `${DEVICE}/${camStreamId}`
    const sink = captured.sink!

    sink.audioInfo({ codec: 'aac', sampleRate: 48000, channels: 1 })
    sink.push(videoPacket(1, true))
    const resolvedFirst = logLines.filter((l) => l.includes('broker RESOLVED')).length
    expect(resolvedFirst).toBe(1)

    await (
      manager as unknown as {
        releaseBroker: (deviceId: number, camStreamId: string) => Promise<void>
      }
    ).releaseBroker(DEVICE, camStreamId)

    // Dropping while no broker exists is announced ONCE per generation — the
    // pair must re-arm, or the recovery is silent and reads as still-broken.
    sink.push(videoPacket(2, false))
    expect(logLines.filter((l) => l.includes('packets are being DROPPED'))).toHaveLength(1)

    await manager.ensureBrokerForWebrtcSession(DEVICE, brokerId, camStreamId)
    sink.push(videoPacket(3, true))

    expect(logLines.filter((l) => l.includes('broker RESOLVED'))).toHaveLength(2)
    // The audio plane was armed ONCE, at start, by the demuxer. A fresh broker
    // that is never re-primed carries video and no audio, for the rest of the
    // session.
    const broker = brokersOf(manager).get(brokerId) as unknown as AttachableBroker
    expect(broker.getStats().audio?.codec).toBe('AAC')
  })

  it('is SILENT about the packets that trail a release — that is a teardown, not an outage', async () => {
    await manager.acquireEgressTranscode(REQUEST)
    const sink = captured.sink!
    sink.push(videoPacket(1, true))

    // What every teardown looks like: the reader is destroyed, the stream is
    // retracted, and the child's already-buffered stdout is demuxed after both.
    await sink.release()
    sink.push(videoPacket(2, false))

    expect(logLines.filter((l) => l.includes('packets are being DROPPED'))).toHaveLength(0)
  })
})
