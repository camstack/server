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

describe('applyDeviceSettingsPatch — new prefixes', () => {
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

  it('derivedStreamNames patch creates a derivedStreams entry per name', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { derivedStreamNames: ['web-720p', 'mobile-480p'] },
    })
    const internal = (
      manager as unknown as {
        deviceOverrides: Map<number, { derivedStreams?: Record<string, unknown> }>
      }
    ).deviceOverrides.get(1)
    expect(Object.keys(internal?.derivedStreams ?? {}).toSorted()).toEqual([
      'mobile-480p',
      'web-720p',
    ])
  })

  it('derivedSource:<name> and derivedProfile:<name> update the derivedStreams entry', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { derivedStreamNames: ['web-720p'] },
    })
    const profile = {
      video: { codec: 'h264' as const, width: 1280, height: 720 },
      audio: 'passthrough' as const,
    }
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: {
        'derivedSource:web-720p': 'native:main',
        'derivedProfile:web-720p': profile,
      },
    })
    const internal = (
      manager as unknown as {
        deviceOverrides: Map<
          number,
          {
            derivedStreams?: Record<
              string,
              { source?: { kind: string; camStreamId?: string }; encodeProfile: unknown }
            >
          }
        >
      }
    ).deviceOverrides.get(1)
    expect(internal?.derivedStreams?.['web-720p']?.source).toEqual({
      kind: 'camStream',
      camStreamId: 'native:main',
    })
    expect(internal?.derivedStreams?.['web-720p']?.encodeProfile).toEqual(profile)
  })

  it('removing a name from derivedStreamNames deletes the entry', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { derivedStreamNames: ['a', 'b'] },
    })
    await manager.applyDeviceSettingsPatch({
      deviceId: 1,
      patch: { derivedStreamNames: ['a'] },
    })
    const internal = (
      manager as unknown as {
        deviceOverrides: Map<number, { derivedStreams?: Record<string, unknown> }>
      }
    ).deviceOverrides.get(1)
    expect(Object.keys(internal?.derivedStreams ?? {})).toEqual(['a'])
  })
})
