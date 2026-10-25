/**
 * assignProfile cycle-guard — Task 7
 *
 * Drives the REAL profile-assignment mutation (`StreamBrokerManager.assignProfile`)
 * and asserts that assigning a `derived:*` stream to a profile it (transitively)
 * sources from is rejected with a clear loop error, while an acyclic assignment
 * succeeds. The pure detector (`wouldCycle`) is unit-tested separately in
 * `derived-cycle-check.spec.ts`; this spec proves it is WIRED into the mutation.
 */

import type { IScopedLogger } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

/** Stub the RTSP layer so publish paths don't bind real ports. */
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

/**
 * Seed a derived stream (`derived:d`) that sources from profile `mid`, plus the
 * physical `native:mid` source stream. Returns once both are published so the
 * derived is assignable and the override graph is populated.
 */
async function seedDerivedFromMid(manager: StreamBrokerManager): Promise<void> {
  manager.loadPersistedDeviceOverrides(
    new Map([
      [
        99,
        {
          derivedStreams: {
            d: {
              source: { kind: 'profile' as const, profile: 'mid' as const },
              encodeProfile: {
                video: { codec: 'h264' as const, width: 640, height: 360 },
                audio: 'passthrough' as const,
              },
            },
          },
        },
      ],
    ]),
  )
  // Boot-hydration publishes the profile-source derived (fire-and-forget IIFE).
  await new Promise((resolve) => setTimeout(resolve, 0))
  // Publish the physical source so `mid` can point at it.
  await manager.publishCameraStream({
    deviceId: 99,
    camStreamId: 'native:mid',
    kind: 'pull-rtsp',
    url: 'rtsp://example/mid',
  })
  await manager.assignProfile({ deviceId: 99, profile: 'mid', camStreamId: 'native:mid' })
}

describe('assignProfile cycle-guard', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
  })

  it('sanity: the derived stream is published and assignable', async () => {
    await seedDerivedFromMid(manager)
    expect(manager.getCameraStreamsForDevice(99).map((s) => s.camStreamId)).toContain('derived:d')
  })

  it('rejects assigning a derived to the profile it sources from (would loop)', async () => {
    await seedDerivedFromMid(manager)
    // derived:d sources from profile mid → assigning it to mid closes mid→d→mid.
    await expect(
      manager.assignProfile({ deviceId: 99, profile: 'mid', camStreamId: 'derived:d' }),
    ).rejects.toThrow(/loop/i)
  })

  it('allows assigning that derived to a DIFFERENT profile (low)', async () => {
    await seedDerivedFromMid(manager)
    await expect(
      manager.assignProfile({ deviceId: 99, profile: 'low', camStreamId: 'derived:d' }),
    ).resolves.toEqual({ success: true })
  })
})
