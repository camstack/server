import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeSourceBrokerId, type BrokerStats } from '@camstack/types'
import { makeScopedLogger } from '../../__tests__/support/scoped-logger.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { ProbedSnapshotMapSchema } from '../stream-broker/probed-summary.js'

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

function streamingStats(over: Partial<BrokerStats>): BrokerStats {
  return {
    status: 'streaming',
    inputFps: 15,
    encodedSubscribers: 0,
    uptimeMs: 1000,
    bitrateKbps: 5,
    idrIntervalMs: 4000,
    codec: 'h264',
    totalBytes: 0,
    packetCount: 0,
    rtspClients: 0,
    pipeClients: 0,
    preBufferSec: 0,
    preBufferMs: 0,
    preBufferPackets: 0,
    audio: {
      codec: 'MPEG4-GENERIC',
      sampleRate: 16000,
      channels: 1,
      supported: true,
    },
    ...over,
  }
}

async function probedFieldValue(
  manager: StreamBrokerManager,
  camStreamId: string,
): Promise<string | undefined> {
  const schema = await manager.getDeviceSettingsContribution({ deviceId: 1 })
  const field = (schema?.sections ?? [])
    .flatMap((s) => s.fields)
    .filter((f) => f.type === 'sub-tabs')
    .flatMap((f) => (f.type === 'sub-tabs' ? f.tabs : []))
    .flatMap((t) => t.fields)
    .find((f) => f.key === `probedInfo:${camStreamId}`)
  if (field === undefined || field.type !== 'text') return undefined
  return typeof field.value === 'string' ? field.value : undefined
}

describe('per-stream "Probed" readonly settings field', () => {
  let manager: StreamBrokerManager

  beforeEach(async () => {
    manager = new StreamBrokerManager(makeScopedLogger())
    stubRtsp(manager)
    await manager.publishCameraStream({
      deviceId: 1,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://x/m',
    })
  })

  it('renders a readonly text field, "not yet probed" before any stream pull', async () => {
    const value = await probedFieldValue(manager, 'native:main')
    expect(value).toBe('not yet probed')
  })

  it('populates video + audio after a streaming probe is recorded', async () => {
    manager.recordProbeSnapshot(makeSourceBrokerId(1, 'native:main'), streamingStats({}), 0)
    const value = await probedFieldValue(manager, 'native:main')
    expect(value).toContain('H.264')
    expect(value).toContain('5 kbps')
    expect(value).toContain('IDR 4.0s')
    expect(value).toContain('Audio: MPEG4-GENERIC 16kHz mono')
    expect(value).toContain('as of ')
  })

  it('does not clobber the last good probe with an idle/suspended snapshot', async () => {
    const brokerId = makeSourceBrokerId(1, 'native:main')
    manager.recordProbeSnapshot(brokerId, streamingStats({ bitrateKbps: 1200 }), 0)
    manager.recordProbeSnapshot(
      brokerId,
      streamingStats({ status: 'idle', bitrateKbps: 0, audio: null }),
      0,
    )
    const value = await probedFieldValue(manager, 'native:main')
    expect(value).toContain('1.2 Mbps')
    expect(value).toContain('Audio: MPEG4-GENERIC 16kHz mono')
  })

  it('exposes a "refresh-probe" action on the probed field', async () => {
    const schema = await manager.getDeviceSettingsContribution({ deviceId: 1 })
    const field = (schema?.sections ?? [])
      .flatMap((s) => s.fields)
      .filter((f) => f.type === 'sub-tabs')
      .flatMap((f) => (f.type === 'sub-tabs' ? f.tabs : []))
      .flatMap((t) => t.fields)
      .find((f) => f.key === 'probedInfo:native:main')
    expect(field?.type).toBe('text')
    if (field && field.type === 'text') {
      expect((field.actions ?? []).some((a) => a.action === 'refresh-probe')).toBe(true)
    }
  })

  it('probeStream dials transiently, captures a snapshot, and releases the warmup consumer', async () => {
    const brokerId = makeSourceBrokerId(1, 'native:main')
    let subscribed = false
    let released = false
    // Replace the real (idle) broker with a fake that reports streaming so the
    // probe captures immediately instead of waiting out the 6s timeout.
    const fakeBroker = {
      deviceId: brokerId,
      onEncodedData: () => {
        subscribed = true
        return () => {
          released = true
        }
      },
      getStats: () => streamingStats({ bitrateKbps: 77 }),
      // A re-publish re-applies BOTH pre-roll windows to a broker that already
      // exists (a device's battery feature can be discovered post-creation and
      // it decides the recording window), so a fake standing in for a live
      // broker has to accept them — see D193.
      setDetectionPreRollMs: () => {},
      setRecordingPreRollMs: () => {},
    }
    ;(manager as unknown as { brokers: Map<string, unknown> }).brokers.set(brokerId, fakeBroker)

    const res = await manager.probeStream({ brokerId })
    expect(subscribed).toBe(true)
    expect(released).toBe(true) // warmup consumer always detached
    expect(res.probed).toBe(true)
    expect(res.summary).toContain('77 kbps')
    expect(res.summary).toContain('Audio: MPEG4-GENERIC 16kHz mono')
    // And the captured snapshot now backs the settings field.
    expect(await probedFieldValue(manager, 'native:main')).toContain('77 kbps')
  })

  it('probeStream on an unparseable broker id returns not-probed without throwing', async () => {
    const res = await manager.probeStream({ brokerId: 'not-a-broker' })
    expect(res.probed).toBe(false)
    expect(res.summary).toBe('not yet probed')
  })

  it('round-trips the probe map through get/load (durable persistence) and the schema', async () => {
    const brokerId = makeSourceBrokerId(1, 'native:main')
    manager.recordProbeSnapshot(brokerId, streamingStats({ bitrateKbps: 1200 }), 1_700_000_000_000)

    // Serialize (what the addon persists) and validate against the durable schema.
    const blob = manager.getProbeSnapshots()
    expect(blob[brokerId]).toBeDefined()
    expect(() => ProbedSnapshotMapSchema.parse(blob)).not.toThrow()

    // Simulate a restart: a fresh manager seeded only from the persisted blob
    // must render the populated field (no live recording).
    const revived = new StreamBrokerManager(makeScopedLogger())
    stubRtsp(revived)
    await revived.publishCameraStream({
      deviceId: 1,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://x/m',
    })
    revived.loadProbeSnapshots(blob)
    const value = await probedFieldValue(revived, 'native:main')
    expect(value).toContain('1.2 Mbps')
    expect(value).toContain('Audio: MPEG4-GENERIC 16kHz mono')
  })
})
