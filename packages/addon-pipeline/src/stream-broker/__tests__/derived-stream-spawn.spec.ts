/**
 * publishCameraStream({kind: 'derived'}) — Task 10
 *
 * Verifies the three minimum-viability behaviours:
 *   1. Derived publish without a registered source → rejects SOURCE_NOT_FOUND
 *   2. Derived publish with a registered source → appears in getCameraStreamsForDevice
 *   3. Duplicate derived publish (same camStreamId) → single-flight, only one entry
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import type { IScopedLogger } from '@camstack/types'

// ── Fakes ────────────────────────────────────────────────────────────

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

function makeManager(): StreamBrokerManager {
  return new StreamBrokerManager(makeLogger())
}

/**
 * Stub out the RTSP layer so publish paths don't try to bind a real port.
 * Mirrors the pattern used by profile-broker.spec.ts.
 */
function stubRtsp(manager: StreamBrokerManager): void {
  ;(manager as unknown as { rtspProvider: unknown }).rtspProvider = {
    getEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    getInternalEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
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

// ── Tests ────────────────────────────────────────────────────────────

describe('publishCameraStream kind: "derived"', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
    stubRtsp(manager)
  })

  it('rejects derived publish when the source broker is not registered', async () => {
    await expect(
      manager.publishCameraStream({
        deviceId: 99,
        camStreamId: 'derived:web-720p',
        kind: 'derived',
        sourceCamStreamId: 'native:main',
        encodeProfile: { video: { codec: 'h264' }, audio: 'passthrough' },
      }),
    ).rejects.toThrow(/SOURCE_NOT_FOUND/)
  })

  it('registers a derived broker when the source exists', async () => {
    // Publish the source first
    await manager.publishCameraStream({
      deviceId: 99,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://example/main',
    })

    // Derive from it
    await manager.publishCameraStream({
      deviceId: 99,
      camStreamId: 'derived:web-720p',
      kind: 'derived',
      sourceCamStreamId: 'native:main',
      encodeProfile: { video: { codec: 'h264', width: 1280, height: 720 }, audio: 'passthrough' },
    })

    const streams = manager.getCameraStreamsForDevice(99)
    expect(streams.map((s) => s.camStreamId)).toContain('derived:web-720p')
  })

  it('reuses the existing entry when publishing the same derived name twice', async () => {
    await manager.publishCameraStream({
      deviceId: 99,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://example/main',
    })
    await manager.publishCameraStream({
      deviceId: 99,
      camStreamId: 'derived:web-720p',
      kind: 'derived',
      sourceCamStreamId: 'native:main',
      encodeProfile: { video: { codec: 'h264' }, audio: 'passthrough' },
    })
    // Second publish of the same derived camStreamId → single-flight
    await manager.publishCameraStream({
      deviceId: 99,
      camStreamId: 'derived:web-720p',
      kind: 'derived',
      sourceCamStreamId: 'native:main',
      encodeProfile: { video: { codec: 'h264', width: 640 }, audio: 'passthrough' },
    })
    const derived = manager
      .getCameraStreamsForDevice(99)
      .filter((s) => s.camStreamId === 'derived:web-720p')
    expect(derived.length).toBe(1)
  })
})

type ManagerPrivates = {
  derivedFeeders: Map<string, unknown>
  brokers: Map<string, unknown>
  releaseBroker: (deviceId: number, camStreamId: string) => Promise<void>
}

function privates(manager: StreamBrokerManager): ManagerPrivates {
  return manager as unknown as ManagerPrivates
}

async function publishNativeAndDerived(manager: StreamBrokerManager): Promise<void> {
  await manager.publishCameraStream({
    deviceId: 99,
    camStreamId: 'native:main',
    kind: 'pull-rtsp',
    url: 'rtsp://example/main',
  })
  await manager.publishCameraStream({
    deviceId: 99,
    camStreamId: 'derived:web-720p',
    kind: 'derived',
    sourceCamStreamId: 'native:main',
    encodeProfile: { video: { codec: 'h264', width: 1280, height: 720 }, audio: 'passthrough' },
  })
  await manager.assignProfile({
    deviceId: 99,
    profile: 'low',
    camStreamId: 'derived:web-720p',
  })
}

describe('derived consumer paths re-attach the transcode feeder', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
    stubRtsp(manager)
  })

  it('getStreamWithCodec for a derived profile returns the restream URL', async () => {
    await publishNativeAndDerived(manager)
    const src = await manager.getStreamWithCodec({
      deviceId: 99,
      video: 'copy',
      audio: 'copy',
      profile: 'low',
    })
    expect(src.url).toContain('99/derived:web-720p')
    expect(src.transcoded).toBe(false)
  })

  it('ensureBrokerForWebrtcSession recreates a released derived broker WITH its feeder', async () => {
    // Live 618: catalog/session recreate minted a push broker with no feeder
    // ("push source stalled"). WebRTC attach must not skip derived.
    await publishNativeAndDerived(manager)
    const p = privates(manager)
    expect(p.derivedFeeders.size).toBe(1)

    await p.releaseBroker(99, 'derived:web-720p')
    expect(p.brokers.has('99/derived:web-720p')).toBe(false)
    expect(p.derivedFeeders.size).toBe(0)

    await manager.ensureBrokerForWebrtcSession(99, '99/derived:web-720p', 'derived:web-720p')
    expect(p.brokers.has('99/derived:web-720p')).toBe(true)
    expect(p.derivedFeeders.size).toBe(1)
  })

  it('getStreamWithCodec re-attaches the feeder when the derived broker is an empty shell', async () => {
    await publishNativeAndDerived(manager)
    const p = privates(manager)
    await p.releaseBroker(99, 'derived:web-720p')
    expect(p.derivedFeeders.size).toBe(0)

    await manager.getStreamWithCodec({
      deviceId: 99,
      video: 'copy',
      audio: 'copy',
      profile: 'low',
    })
    expect(p.derivedFeeders.size).toBe(1)
    expect(p.brokers.has('99/derived:web-720p')).toBe(true)
  })
})
