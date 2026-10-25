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

describe('getDeviceSettingsContribution — General sub-tab', () => {
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

  it('renames the first sub-tab from "Assignment" to "General"', async () => {
    const out = await manager.getDeviceSettingsContribution({ deviceId: 1 })
    const streamsSection = out!.sections.find((s) => s.id === 'stream-broker-streams')
    expect(streamsSection).toBeDefined()
    const subtabsField = streamsSection!.fields[0]
    expect(subtabsField!.type).toBe('sub-tabs')
    if (subtabsField!.type === 'sub-tabs') {
      expect(subtabsField.tabs[0]?.id).toBe('general')
      expect(subtabsField.tabs[0]?.label).toBe('General')
    }
  })

  it('General sub-tab contains the existing 3 profile selectors + derivedStreamNames', async () => {
    const out = await manager.getDeviceSettingsContribution({ deviceId: 1 })
    const sub = out!.sections.find((s) => s.id === 'stream-broker-streams')!.fields[0]
    if (sub!.type !== 'sub-tabs') throw new Error('expected sub-tabs')
    const general = sub.tabs[0]
    expect(general?.fields.some((f) => 'key' in f && f.key === 'streamProfile:high')).toBe(true)
    expect(general?.fields.some((f) => 'key' in f && f.key === 'streamProfile:mid')).toBe(true)
    expect(general?.fields.some((f) => 'key' in f && f.key === 'streamProfile:low')).toBe(true)
    const dn = general?.fields.find((f) => 'key' in f && f.key === 'derivedStreamNames')
    expect(dn).toBeDefined()
    expect(dn?.type).toBe('text')
    expect('multiple' in dn! && dn.multiple).toBeDefined()
    expect('multiple' in dn! && dn.multiple !== undefined && dn.multiple.min).toBe(0)
  })

  it('source-stream sub-tab carries the args-only ffmpeg-params widget (rtsp is ffmpeg-capable)', async () => {
    const out = await manager.getDeviceSettingsContribution({ deviceId: 1 })
    const sub = out!.sections.find((s) => s.id === 'stream-broker-streams')!.fields[0]
    if (sub!.type !== 'sub-tabs') throw new Error('expected sub-tabs')
    const streamTab = sub.tabs.find((t) => t.id === 'stream:native:main')
    expect(streamTab).toBeDefined()
    // The removed per-consumer WebRTC viewer-params widget stays gone; the ONLY
    // widget now present is the args-only ffmpeg-parser normalization editor,
    // offered because an rtsp source is ffmpeg-capable.
    const widgetFields = streamTab!.fields.filter((f) => f.type === 'widget')
    expect(widgetFields).toHaveLength(1)
    const widgetField = widgetFields[0]
    if (!widgetField || widgetField.type !== 'widget') throw new Error('expected widget field')
    expect(widgetField.key).toBe('sourceParserArgsWidget:native:main')
    expect(widgetField.widgetId).toBe('stream-broker/ffmpeg-params')
    expect(widgetField.widgetConfig).toMatchObject({
      argsOnly: true,
      fieldKey: 'sourceParserArgs:native:main',
    })
  })
})
