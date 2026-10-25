import type { IScopedLogger } from '@camstack/types'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

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

type HwAccelOverride = { hwaccel?: Record<string, string> }

describe('applyDeviceSettingsPatch — hwaccel:<camStreamId>', () => {
  let manager: StreamBrokerManager
  let persister: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    manager = new StreamBrokerManager(makeLogger())
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

  function readOverride(): HwAccelOverride | undefined {
    return (
      manager as unknown as { deviceOverrides: Map<number, HwAccelOverride> }
    ).deviceOverrides.get(1)
  }

  it('writes a per-stream hwaccel override readable through getStreamHwAccelOverride (write → read round-trip)', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'hwaccel:native:main': 'videotoolbox' },
    })
    expect(readOverride()?.hwaccel?.['native:main']).toBe('videotoolbox')
    expect(manager.getStreamHwAccelOverride(1, 'native:main')).toBe('videotoolbox')
    expect(persister).toHaveBeenCalled()
  })

  it('clears the per-stream override when set back to the default (copy)', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'hwaccel:native:main': 'videotoolbox' },
    })
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'hwaccel:native:main': 'copy' },
    })
    expect(manager.getStreamHwAccelOverride(1, 'native:main')).toBeNull()
  })

  it('clears the per-stream override when set to the empty sentinel', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'hwaccel:native:main': 'videotoolbox' },
    })
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'hwaccel:native:main': '' },
    })
    expect(manager.getStreamHwAccelOverride(1, 'native:main')).toBeNull()
  })

  it('ignores a value not in FFMPEG_HW_ACCEL_SETTINGS (validation)', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'hwaccel:native:main': 'bogus-backend' },
    })
    expect(manager.getStreamHwAccelOverride(1, 'native:main')).toBeNull()
  })

  it('keeps a device override that ONLY holds an hwaccel entry (hasContent includes hwaccel)', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'hwaccel:native:main': 'auto' },
    })
    // The override map must NOT have been pruned away.
    expect(readOverride()).toBeDefined()
    expect(manager.getStreamHwAccelOverride(1, 'native:main')).toBe('auto')
  })

  it('surfaces a per-stream hwaccel select in getDeviceSettingsContribution with current value + options', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { 'hwaccel:native:main': 'auto' },
    })
    const schema = await manager.getDeviceSettingsContribution({ deviceId: 1 })
    expect(schema).not.toBeNull()
    // Structure: sections[].fields[] → a `sub-tabs` field → tabs[].fields[]
    const subTabFields = (schema?.sections ?? [])
      .flatMap((s) => s.fields)
      .filter((f) => f.type === 'sub-tabs')
      .flatMap((f) => (f.type === 'sub-tabs' ? f.tabs : []))
      .flatMap((t) => t.fields)
    const hwField = subTabFields.find((f) => f.key === 'hwaccel:native:main')
    expect(hwField).toBeDefined()
    expect(hwField?.type).toBe('select')
    if (hwField && hwField.type === 'select') {
      expect(hwField.value).toBe('auto')
      const values = hwField.options.map((o) => o.value)
      expect(values).toContain('copy')
      expect(values).toContain('auto')
    }
  })
})
