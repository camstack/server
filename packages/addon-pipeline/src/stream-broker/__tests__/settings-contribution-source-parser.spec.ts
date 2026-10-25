import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeScopedLogger } from '../../__tests__/support/scoped-logger.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

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

type SourceParserOverride = { sourceParser?: Record<string, string> }

function subTabFieldsOf(
  schema: Awaited<ReturnType<StreamBrokerManager['getDeviceSettingsContribution']>>,
) {
  return (schema?.sections ?? [])
    .flatMap((s) => s.fields)
    .filter((f) => f.type === 'sub-tabs')
    .flatMap((f) => (f.type === 'sub-tabs' ? f.tabs : []))
    .flatMap((t) => t.fields)
}

describe('getDeviceSettingsContribution — sourceParser:<camStreamId> select', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = new StreamBrokerManager(makeScopedLogger())
    stubRtsp(manager)
  })

  it('surfaces a sourceParser select for an rtsp stream with the 4 rtsp options and a native-tcp default', async () => {
    await manager.publishCameraStream({
      deviceId: 1,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://x/m',
    })
    const schema = await manager.getDeviceSettingsContribution({ deviceId: 1 })
    const field = subTabFieldsOf(schema).find((f) => f.key === 'sourceParser:native:main')
    expect(field).toBeDefined()
    expect(field?.type).toBe('select')
    if (field && field.type === 'select') {
      const values = field.options.map((o) => o.value)
      expect(values).toEqual(['native-tcp', 'native-udp', 'ffmpeg-tcp', 'ffmpeg-udp'])
      // Operator-facing labels (sourceParserOptionLabel).
      const byValue = new Map(field.options.map((o) => [o.value, o.label]))
      expect(byValue.get('native-tcp')).toBe('Native (TCP)')
      expect(byValue.get('native-udp')).toBe('Native (UDP) — coming soon')
      expect(byValue.get('ffmpeg-tcp')).toBe('FFmpeg (TCP)')
      expect(byValue.get('ffmpeg-udp')).toBe('FFmpeg (UDP)')
      // No override persisted → defaults to the first (native-tcp) option.
      expect(field.value).toBe('native-tcp')
    }
  })

  it('reflects a persisted override as the current value', async () => {
    await manager.publishCameraStream({
      deviceId: 1,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://x/m',
    })
    manager.loadPersistedDeviceOverrides(
      new Map([[1, { sourceParser: { 'native:main': 'ffmpeg-tcp' as const } }]]),
    )
    const schema = await manager.getDeviceSettingsContribution({ deviceId: 1 })
    const field = subTabFieldsOf(schema).find((f) => f.key === 'sourceParser:native:main')
    if (field && field.type === 'select') {
      expect(field.value).toBe('ffmpeg-tcp')
    } else {
      throw new Error('expected a sourceParser select')
    }
  })

  it('omits the sourceParser select for a non-pull (rfc4571) stream', async () => {
    await manager.publishCameraStream({
      deviceId: 2,
      camStreamId: 'rfc:main',
      kind: 'pull-rfc4571',
      url: 'tcp://x/m',
    })
    const schema = await manager.getDeviceSettingsContribution({ deviceId: 2 })
    const field = subTabFieldsOf(schema).find((f) => f.key === 'sourceParser:rfc:main')
    expect(field).toBeUndefined()
  })
})

describe('applyDeviceSettingsPatch — sourceParser:<camStreamId>', () => {
  let manager: StreamBrokerManager
  let persister: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    manager = new StreamBrokerManager(makeScopedLogger())
    stubRtsp(manager)
    persister = vi.fn()
    manager.setDeviceOverridePersister(persister)
    await manager.publishCameraStream({
      deviceId: 1,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://x/m',
    })
  })

  function readOverride(): SourceParserOverride | undefined {
    return (
      manager as unknown as { deviceOverrides: Map<number, SourceParserOverride> }
    ).deviceOverrides.get(1)
  }

  it('writes a per-stream sourceParser override (write → read round-trip)', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'sourceParser:native:main': 'ffmpeg-udp' },
    })
    expect(readOverride()?.sourceParser?.['native:main']).toBe('ffmpeg-udp')
    expect(persister).toHaveBeenCalled()
  })

  it('clears the override when set back to the native-tcp default', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'sourceParser:native:main': 'ffmpeg-tcp' },
    })
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'sourceParser:native:main': 'native-tcp' },
    })
    expect(readOverride()?.sourceParser?.['native:main']).toBeUndefined()
  })

  it('ignores a value not valid for the stream source type (validation)', async () => {
    // `native` is an rtmp-only setting — invalid for an rtsp stream.
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'sourceParser:native:main': 'native' },
    })
    expect(readOverride()?.sourceParser?.['native:main']).toBeUndefined()
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'sourceParser:native:main': 'bogus' },
    })
    expect(readOverride()?.sourceParser?.['native:main']).toBeUndefined()
  })
})
