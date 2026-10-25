/**
 * pipeline-analytics removes a deleted device's data through the paths the
 * operator already has, audited as `orphaned-device` (D865), and lists what it
 * holds for the admin clean-up.
 */
import type { IScopedLogger, TrackCascadeCounts } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { createAnalyticsRemovalHook } from '../device-removal-hook.js'

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

const NO_TRACKS: TrackCascadeCounts = {
  tracks: 0,
  events: 0,
  media: 0,
  faces: 0,
  plates: 0,
  embeddings: 0,
}

function hook(overrides: Partial<Parameters<typeof createAnalyticsRemovalHook>[0]> = {}) {
  const deleteDeviceEvents = vi.fn(async () => ({ motion: 2, object: 5, audio: 1 }))
  const wipeAllAnalytics = vi.fn(async () => ({ ...NO_TRACKS, tracks: 4, media: 9 }))
  const evictSensorEvents = vi.fn(async () => 3)
  const log = logger()
  const provider = createAnalyticsRemovalHook({
    logger: log,
    deleteDeviceEvents,
    wipeAllAnalytics,
    evictSensorEvents,
    eventCountsByDevice: async () => new Map([[4483, 8]]),
    trackDeviceIds: async () => [4483, 12],
    removeNotificationRows: async () => ({ 'nc-liveness': 1, 'nc-device-alerts': 2 }),
    listNotificationData: async () => [{ store: 'occupancy', deviceId: 4483, count: 3 }],
    ...overrides,
  })
  return { provider, deleteDeviceEvents, wipeAllAnalytics, evictSensorEvents, log }
}

describe('pipeline-analytics device-removal-hook', () => {
  it('deletes events (reason orphaned-device), the track cascade and sensor events, with counts', async () => {
    const h = hook()

    const out = await h.provider.onDeviceRemoved({
      deviceId: 4483,
      deletedAt: 1,
      providerAddonId: 'provider-dreame',
    })

    expect(h.deleteDeviceEvents).toHaveBeenCalledWith({
      deviceId: 4483,
      reason: 'orphaned-device',
    })
    expect(h.wipeAllAnalytics).toHaveBeenCalledWith({ deviceId: 4483 })
    expect(h.evictSensorEvents).toHaveBeenCalledWith(4483, Number.MAX_SAFE_INTEGER)
    expect(out.counts).toMatchObject({
      events: 8,
      tracks: 4,
      media: 9,
      'sensor-events': 3,
      'nc-liveness': 1,
    })
    expect(h.log.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: 4483 } }),
    )
  })

  it('is idempotent and quiet when there is nothing left', async () => {
    const h = hook({
      deleteDeviceEvents: async () => ({ motion: 0, object: 0, audio: 0 }),
      wipeAllAnalytics: async () => NO_TRACKS,
      evictSensorEvents: async () => 0,
      removeNotificationRows: async () => ({ 'nc-liveness': 0 }),
    })

    const out = await h.provider.onDeviceRemoved({
      deviceId: 4483,
      deletedAt: 1,
      providerAddonId: 'x',
    })

    expect(Object.values(out.counts).every((n) => n === 0)).toBe(true)
    expect(h.log.info).not.toHaveBeenCalled()
  })

  it('a failing store propagates, so the caller retries instead of believing it is clean', async () => {
    const h = hook({
      wipeAllAnalytics: async () => {
        throw new Error('sqlite busy')
      },
    })

    await expect(
      h.provider.onDeviceRemoved({ deviceId: 4483, deletedAt: 1, providerAddonId: 'x' }),
    ).rejects.toThrow('sqlite busy')
  })

  it('lists the devices it holds data for, per store', async () => {
    const h = hook()

    expect(await h.provider.listDeviceData()).toEqual([
      { store: 'events', deviceId: 4483, count: 8 },
      { store: 'tracks', deviceId: 4483, count: 1 },
      { store: 'tracks', deviceId: 12, count: 1 },
      { store: 'notification-occupancy', deviceId: 4483, count: 3 },
    ])
  })
})
