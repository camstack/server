/**
 * Review follow-up of #609.
 *
 *  - the REAL probe read (broker stats + published resolution, codec spellings
 *    normalised) feeds `previewDerivedEncode`, with nothing stubbed;
 *  - `source` ("keep the source codec") never leaves the derived path unresolved:
 *    not into a stream record, not into the egress (encoder, copy decision);
 *  - the start-path argv of profiles that were storable BEFORE the change is
 *    byte-identical to what the old code produced.
 */
import type {
  AddonApi,
  BrokerStats,
  CamStreamDescriptor,
  EncodeProfile,
  IScopedLogger,
} from '@dominevo/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const feederArgs: { args: readonly string[] | null } = { args: null }

vi.mock('../derived/derived-stream-feeder.js', () => ({
  DerivedStreamFeeder: class {
    constructor(options: { args: readonly string[] }) {
      feederArgs.args = options.args
    }
    connect(): void {}
  },
}))
vi.mock('../stream-broker/ffmpeg-invocation.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireBrokerFfmpeg: () => '/usr/bin/ffmpeg',
}))
import { computeDerivedEncode, normalizeVideoCodec } from '../derived/derived-transcode-args.js'
import type { EgressChildSpec } from '../stream-broker/egress-transcode-manager.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { GOLDEN_ARGS } from './derived-golden-args.fixture.js'

const DEVICE = 112

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function catalog(codec: string): readonly CamStreamDescriptor[] {
  return [
    {
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://x/main',
      codec,
      resolution: { width: 2560, height: 1440 },
    },
  ]
}

/** Type boundary: the manager reads two procedures of the much wider `AddonApi`. */
function makeApi(streams: readonly CamStreamDescriptor[]): AddonApi {
  const api = {
    deviceManager: {
      listAll: {
        query: vi.fn(async () => [{ id: DEVICE, type: 'camera', isCamera: true, disabled: false }]),
      },
    },
    streamCatalog: { getCatalog: { query: vi.fn(async () => streams) } },
  }
  return api as unknown as AddonApi
}

function stubRtsp(manager: StreamBrokerManager): void {
  const entry = (brokerId: string) => ({
    brokerId,
    url: `rtsp://host/${brokerId}`,
    mutedUrl: `rtsp://host/${brokerId}?muted`,
    enabled: true,
  })
  Object.assign(manager, {
    rtspProvider: {
      getEntry: vi.fn(entry),
      getInternalEntry: vi.fn(entry),
      setEnabled: vi.fn(),
      isEnabled: vi.fn(() => true),
      setTokenPersister: vi.fn(),
      setEnabledPersister: vi.fn(),
      getAllEntries: vi.fn(() => []),
      regenerateToken: vi.fn(),
      getRtspPort: vi.fn(() => 8554),
      persistTokens: vi.fn(),
    },
    rtspServer: {
      registerRestreamer: vi.fn(),
      unregisterRestreamer: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      getPort: vi.fn(() => 8554),
      loadEnabled: vi.fn(),
    },
  })
}

function statsWith(codec: string, audio: string): BrokerStats {
  return {
    status: 'streaming',
    inputFps: 20,
    encodedSubscribers: 0,
    uptimeMs: 1000,
    bitrateKbps: 4000,
    idrIntervalMs: 2000,
    codec,
    totalBytes: 0,
    packetCount: 0,
    rtspClients: 0,
    pipeClients: 0,
    preBufferSec: 0,
    preBufferMs: 0,
    preBufferPackets: 0,
    audio: { codec: audio, sampleRate: 8000, channels: 1, supported: true },
  }
}

async function makeManager(codec: string): Promise<StreamBrokerManager> {
  const manager = new StreamBrokerManager(makeLogger())
  stubRtsp(manager)
  manager.setApiAccess(makeApi(catalog(codec)))
  manager.setEgressChildFactory((spec: EgressChildSpec) => {
    seen.push(spec)
    return {
      start: async () => spec.consumerUrl,
      stop: async () => {},
      decodeHwAccel: () => null,
    }
  })
  await manager.reconcileDeviceCatalog(DEVICE)
  return manager
}

const seen: EgressChildSpec[] = []

describe('previewDerivedEncode reads the real probe', () => {
  let manager: StreamBrokerManager

  afterEach(async () => {
    vi.restoreAllMocks()
    await manager.destroyAll()
  })

  it.each([
    ['H264', 'h264'],
    ['H.265', 'h265'],
    ['hevc', 'h265'],
    ['HEVC', 'h265'],
  ])('broker stats codec %s resolves to %s', async (spelling, expected) => {
    manager = await makeManager(spelling)
    for (const broker of manager.getBrokerInstances()) {
      vi.spyOn(broker, 'getStats').mockReturnValue(statsWith(spelling, 'PCMU'))
    }
    const result = await manager.previewDerivedEncode({
      deviceId: DEVICE,
      profile: { video: { codec: 'source', height: 720 }, audio: 'passthrough' },
      source: { kind: 'camStream', camStreamId: 'native:main' },
    })
    expect(result.kind).toBe('preview')
    if (result.kind !== 'preview') return
    expect(result.preview.videoCodec).toBe(expected)
    // The picture size came from the published resolution, the cadence and the
    // audio codec from the broker's own stats.
    expect(result.preview).toMatchObject({ width: 1280, height: 720, fps: 20, audio: 'aac' })
  })

  it('answers no-source when the source has nothing to read', async () => {
    manager = new StreamBrokerManager(makeLogger())
    const result = await manager.previewDerivedEncode({
      deviceId: 404,
      profile: { video: { codec: 'h264', height: 360 }, audio: 'passthrough' },
    })
    expect(result).toEqual({ kind: 'no-source' })
  })
})

describe('the feeder spawn and the preview run the same computation', () => {
  let manager: StreamBrokerManager

  afterEach(async () => {
    vi.restoreAllMocks()
    await manager.destroyAll()
  })

  it('returns identical args for the same profile and the real probe', async () => {
    manager = await makeManager('hevc')
    for (const broker of manager.getBrokerInstances()) {
      vi.spyOn(broker, 'getStats').mockReturnValue(statsWith('hevc', 'PCMU'))
    }
    const profile: EncodeProfile = {
      video: { codec: 'source', height: 360, fps: 60, bitrateKbps: 50 },
      audio: { codec: 'aac' },
    }
    const source = { kind: 'camStream', camStreamId: 'native:main' } as const
    feederArgs.args = null
    // Bracket access reaches the private start path without a cast.
    await manager['spawnDerivedFeeder'](
      DEVICE,
      'derived:x',
      source,
      profile,
      manager.getBrokerInstances()[0]!,
      () => {},
    )
    const preview = await manager.previewDerivedEncode({ deviceId: DEVICE, profile, source })
    expect(preview.kind).toBe('preview')
    if (preview.kind !== 'preview') return
    const started = feederArgs.args
    expect(started).not.toBeNull()
    // Only the `-i` differs: a preview has no loopback to dial.
    const maskUrl = (args: readonly string[]): string[] =>
      args.map((a) => (a.startsWith('rtsp://') ? '<src>' : a))
    expect(maskUrl(preview.preview.args)).toEqual(maskUrl(started ?? []))
    expect(preview.preview).toMatchObject({
      videoCodec: 'h265',
      fpsClampedToSource: true,
      raisedToFloor: true,
    })
  })
})

describe('normalizeVideoCodec', () => {
  it.each([
    ['h264', 'h264'],
    ['H.264', 'h264'],
    ['avc', 'h264'],
    ['H265', 'h265'],
    ['h.265', 'h265'],
    ['HEVC', 'h265'],
    ['mjpeg', null],
    ['', null],
    [undefined, null],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeVideoCodec(raw)).toBe(expected)
  })
})

describe('`source` never reaches a record or the egress unresolved', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    seen.length = 0
  })
  afterEach(async () => {
    await manager.destroyAll()
  })

  it('a derived stream record carries the source codec, never `source`', async () => {
    manager = await makeManager('h265')
    await manager.publishCameraStream({
      deviceId: DEVICE,
      camStreamId: 'derived:small',
      kind: 'derived',
      sourceCamStreamId: 'native:main',
      encodeProfile: { video: { codec: 'source', height: 360 }, audio: 'passthrough' },
    })
    const record = manager
      .getCameraStreamsForDevice(DEVICE)
      .find((s) => s.camStreamId === 'derived:small')
    expect(record?.codec).toBe('h265')
  })

  it('a derived stream record of an undeclared source carries no codec at all', async () => {
    manager = await makeManager('')
    await manager.publishCameraStream({
      deviceId: DEVICE,
      camStreamId: 'derived:small',
      kind: 'derived',
      sourceCamStreamId: 'native:main',
      encodeProfile: { video: { codec: 'source', height: 360 }, audio: 'passthrough' },
    })
    const record = manager
      .getCameraStreamsForDevice(DEVICE)
      .find((s) => s.camStreamId === 'derived:small')
    expect(record?.codec).toBeUndefined()
  })

  it('egress with `source` on an H.265 camera stays H.265', async () => {
    manager = await makeManager('h265')
    const handle = await manager.acquireEgressTranscode({
      deviceId: DEVICE,
      source: { kind: 'cam-stream', camStreamId: 'native:main' },
      encode: { video: { codec: 'source', width: 1280, height: 720 }, audio: 'passthrough' },
      rateControl: 'relaxed',
      publishLocally: true,
      tag: 'spec/source-codec',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.targetCodec).toBe('H265')
    const record = manager
      .getCameraStreamsForDevice(DEVICE)
      .find((s) => s.camStreamId === handle.camStreamId)
    expect(record?.codec).toBe('h265')
  })

  it('egress with `source` equal to the camera codec and no other change copies', async () => {
    manager = await makeManager('h265')
    await manager.acquireEgressTranscode({
      deviceId: DEVICE,
      source: { kind: 'cam-stream', camStreamId: 'native:main' },
      encode: { video: { codec: 'source' }, audio: 'passthrough' },
      rateControl: 'relaxed',
      publishLocally: true,
      tag: 'spec/source-copy',
    })
    expect(seen[0]?.invocation.video.kind).toBe('copy')
  })
})

describe('the start-path argv of previously storable profiles is unchanged', () => {
  const SOURCE = {
    width: 1920,
    height: 1080,
    fps: 20,
    idrIntervalMs: 2000,
    videoCodec: null,
    audioCodec: 'PCMU',
  } as const
  const PROFILES: Readonly<Record<string, EncodeProfile>> = {
    bothSides: {
      video: { codec: 'h264', width: 640, height: 360, bitrateKbps: 800 },
      audio: 'passthrough',
    },
    neitherSide: { video: { codec: 'h264', fps: 15 }, audio: { codec: 'aac' } },
    h264BitrateFps: {
      video: { codec: 'h264', width: 1280, height: 720, bitrateKbps: 2000, fps: 25 },
      audio: 'passthrough',
    },
    h265Both: { video: { codec: 'h265', width: 640, height: 360 }, audio: 'passthrough' },
    copy: { video: { codec: 'copy' }, audio: 'passthrough' },
  }

  it.each(Object.keys(PROFILES))('%s', (name) => {
    const profile = PROFILES[name]
    const golden = GOLDEN_ARGS[name]
    if (profile === undefined || golden === undefined) throw new Error(`no fixture ${name}`)
    const { built } = computeDerivedEncode(profile, SOURCE, { loopbackUrl: 'rtsp://loop/back' })
    expect(built.args).toEqual(golden)
  })
})
