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

describe('getDeviceSettingsContribution — derived-stream sub-tabs', () => {
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
    manager.loadPersistedDeviceOverrides(
      new Map([
        [
          1,
          {
            derivedStreams: {
              'web-720p': {
                source: { kind: 'camStream' as const, camStreamId: 'native:main' },
                encodeProfile: {
                  video: { codec: 'h264' as const, width: 1280, height: 720 },
                  audio: 'passthrough' as const,
                },
              },
            },
          },
        ],
      ]),
    )
  })

  it('emits a sub-tab for each derived stream', async () => {
    const out = await manager.getDeviceSettingsContribution({ deviceId: 1 })
    const sub = out!.sections.find((s) => s.id === 'stream-broker-streams')!.fields[0]
    if (sub!.type !== 'sub-tabs') throw new Error('expected sub-tabs')
    const derivedTab = sub.tabs.find((t) => t.id === 'derived:web-720p')
    expect(derivedTab).toBeDefined()
    expect(derivedTab?.label).toBe('web-720p')
  })

  it('derived sub-tab contains source select + encode-params widget + per-stream extras', async () => {
    const out = await manager.getDeviceSettingsContribution({ deviceId: 1 })
    const sub = out!.sections.find((s) => s.id === 'stream-broker-streams')!.fields[0]
    if (sub!.type !== 'sub-tabs') throw new Error('expected sub-tabs')
    const derivedTab = sub.tabs.find((t) => t.id === 'derived:web-720p')!
    expect(
      derivedTab.fields.some((f) => f.key === 'derivedSource:web-720p' && f.type === 'select'),
    ).toBe(true)
    const encodeWidget = derivedTab.fields.find(
      (f) => f.type === 'widget' && f.widgetConfig?.fieldKey === 'derivedProfile:web-720p',
    )
    expect(encodeWidget).toBeDefined()
    expect(derivedTab.fields.some((f) => f.key === 'derivedPrebufferEnabled:web-720p')).toBe(true)
    expect(derivedTab.fields.some((f) => f.key === 'derivedRtspEnabled:web-720p')).toBe(true)
    // The per-consumer WebRTC viewer-params widget was removed — the
    // derived encode-params widget above is the only transform editor.
    const webrtcWidget = derivedTab.fields.find(
      (f) => f.type === 'widget' && f.widgetConfig?.fieldKey === 'derivedWebrtc:web-720p',
    )
    expect(webrtcWidget).toBeUndefined()
  })
})
