/**
 * An orphan prebuffer hold on a battery camera (640, 2026-11-23).
 *
 * The stream registers BEFORE the Sleeps / battery fact is known, so the first
 * decision warms it (high profile default) and opens a hold. The fact arrives
 * on a re-publish; nothing re-applied the decision, so the hold lived until
 * the broker restarted and kept the camera awake. And a decision that resolves
 * to `seconds: 0` must never open a hold in the first place.
 */
import { describe, it, expect, vi } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { StreamBroker } from '../stream-broker/stream-broker.js'

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

describe('prebuffer hold converges on the battery fact', () => {
  it('releases the hold when the sleeps fact arrives after registration', async () => {
    const logger = makeLogger()
    const manager = new StreamBrokerManager(logger)
    stubRtsp(manager)
    const base = {
      deviceId: 640,
      camStreamId: 'native:main',
      kind: 'pull-rtsp' as const,
      url: 'rtsp://cam/main',
      resolution: { width: 2560, height: 1440 },
    }
    await manager.publishCameraStream(base)
    await manager.assignProfile({ deviceId: 640, profile: 'high', camStreamId: 'native:main' })
    await manager.restartProfile({ deviceId: 640, profile: 'high' })
    const broker = await manager.getBroker({ brokerId: '640/native:main' })
    expect(broker).not.toBeNull()
    expect(broker!.getPreBufferDuration()).toBeGreaterThan(0)
    expect(logger.info).toHaveBeenCalledWith('prebuffer hold opened', expect.anything())

    await manager.publishCameraStream({ ...base, deviceFeatures: ['battery-operated', 'sleeps'] })

    expect(broker!.getPreBufferDuration()).toBe(0)
    expect(logger.info).toHaveBeenCalledWith(
      'prebuffer hold released',
      expect.objectContaining({ tags: { deviceId: 640 } }),
    )
  })

  it('a publish carrying only battery-operated (no sleeps) opens no default hold', async () => {
    const logger = makeLogger()
    const manager = new StreamBrokerManager(logger)
    stubRtsp(manager)
    const base = {
      deviceId: 641,
      camStreamId: 'native:main',
      kind: 'pull-rtsp' as const,
      url: 'rtsp://cam/main',
      resolution: { width: 2560, height: 1440 },
    }
    await manager.publishCameraStream({ ...base, deviceFeatures: ['battery-operated'] })
    await manager.assignProfile({ deviceId: 641, profile: 'high', camStreamId: 'native:main' })
    await manager.restartProfile({ deviceId: 641, profile: 'high' })
    const broker = await manager.getBroker({ brokerId: '641/native:main' })
    expect(broker).not.toBeNull()
    expect(broker!.getPreBufferDuration()).toBe(0)
    expect(logger.info).not.toHaveBeenCalledWith('prebuffer hold opened', expect.anything())
  })

  it('a wired camera still gets its default hold', async () => {
    const logger = makeLogger()
    const manager = new StreamBrokerManager(logger)
    stubRtsp(manager)
    await manager.publishCameraStream({
      deviceId: 642,
      camStreamId: 'native:main',
      kind: 'pull-rtsp' as const,
      url: 'rtsp://cam/main',
      resolution: { width: 2560, height: 1440 },
      deviceFeatures: [],
    })
    await manager.assignProfile({ deviceId: 642, profile: 'high', camStreamId: 'native:main' })
    await manager.restartProfile({ deviceId: 642, profile: 'high' })
    const broker = await manager.getBroker({ brokerId: '642/native:main' })
    expect(broker!.getPreBufferDuration()).toBeGreaterThan(0)
  })

  it('the hold-opened line carries the retention being applied, not the previous one', () => {
    const logger = makeLogger()
    const broker = new StreamBroker('640/native:main', logger)
    broker.setPrebuffer({ enabled: true, seconds: 5 })
    expect(logger.info).toHaveBeenCalledWith(
      'prebuffer hold opened',
      expect.objectContaining({ meta: expect.objectContaining({ retentionMs: 5000 }) }),
    )
  })

  it('never opens a hold for an enabled prebuffer of 0 seconds', () => {
    const logger = makeLogger()
    const broker = new StreamBroker('640/native:main', logger)
    broker.setPrebuffer({ enabled: true, seconds: 0 })
    expect(logger.info).not.toHaveBeenCalledWith('prebuffer hold opened', expect.anything())
  })
})
