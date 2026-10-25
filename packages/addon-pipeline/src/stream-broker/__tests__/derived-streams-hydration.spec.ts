/**
 * loadPersistedDeviceOverrides → derived-stream hydration — Task 12
 *
 * Verifies boot-time hydration of DeviceOverride.derivedStreams:
 *   1. Derived not materialised when source is not yet published.
 *   2. Derived IS materialised once its source is subsequently published.
 */

import type { IScopedLogger } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

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

/**
 * Stub out the RTSP layer so publish paths don't try to bind a real port.
 * Mirrors the pattern used by derived-stream-spawn.spec.ts.
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

function makeManager(): StreamBrokerManager {
  const manager = new StreamBrokerManager(makeLogger())
  stubRtsp(manager)
  return manager
}

// ── Tests ────────────────────────────────────────────────────────────

describe('loadPersistedDeviceOverrides → derived-stream hydration', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
  })

  it('does not materialise a derived stream when its source is not yet published', async () => {
    const overrides = new Map([
      [
        99,
        {
          derivedStreams: {
            'web-720p': {
              source: { kind: 'camStream' as const, camStreamId: 'native:main' },
              encodeProfile: { video: { codec: 'h264' as const }, audio: 'passthrough' as const },
            },
          },
        },
      ],
    ])
    manager.loadPersistedDeviceOverrides(overrides)
    // Allow any fire-and-forget microtasks to settle
    await Promise.resolve()
    expect(manager.getCameraStreamsForDevice(99).map((s) => s.camStreamId)).not.toContain(
      'derived:web-720p',
    )
  })

  it('materialises the derived stream once its source is published', async () => {
    const overrides = new Map([
      [
        99,
        {
          derivedStreams: {
            'web-720p': {
              source: { kind: 'camStream' as const, camStreamId: 'native:main' },
              encodeProfile: { video: { codec: 'h264' as const }, audio: 'passthrough' as const },
            },
          },
        },
      ],
    ])
    manager.loadPersistedDeviceOverrides(overrides)
    // Publish the source — the drain runs synchronously inside publishCameraStream
    await manager.publishCameraStream({
      deviceId: 99,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://example/main',
    })
    // After the source is published, the manager should automatically materialise the pending derived.
    expect(manager.getCameraStreamsForDevice(99).map((s) => s.camStreamId)).toContain(
      'derived:web-720p',
    )
  })
})
