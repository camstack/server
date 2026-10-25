/**
 * The reconcile half of `device-removal-hook` (D865): an implementer that was
 * down catches up from device-manager's TOMBSTONES, and from nothing else.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DeviceTombstone } from '../capabilities/device-manager.cap.js'
import type { DeviceRemovedInput } from '../capabilities/device-removal-hook.cap.js'
import type { IScopedLogger } from '../interfaces/logging.js'
import { reconcileRemovedDevices } from '../device/device-removal-reconcile.js'

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

const tombstones: readonly DeviceTombstone[] = [
  { deviceId: 4483, deletedAt: 1_000, providerAddonId: 'provider-dreame' },
  { deviceId: 4484, deletedAt: 2_000, providerAddonId: 'provider-dreame' },
]

describe('reconcileRemovedDevices', () => {
  it('runs the implementer removal for every tombstone — a missed deletion is caught', async () => {
    const remove = vi.fn(async (_input: DeviceRemovedInput) => ({ counts: { footage: 3 } }))
    const query = vi.fn(async () => tombstones)

    const out = await reconcileRemovedDevices({
      api: { deviceManager: { listDeletedSince: { query } } },
      logger: logger(),
      remove,
      now: () => 10_000,
    })

    expect(out).toEqual({ read: true, applied: 2, failed: 0 })
    expect(remove.mock.calls.map((c) => c[0].deviceId)).toEqual([4483, 4484])
    expect(query).toHaveBeenCalledWith({ sinceMs: expect.any(Number) })
  })

  it('a failed tombstone read deletes NOTHING and says so', async () => {
    const remove = vi.fn(async () => ({ counts: {} }))
    const log = logger()

    const out = await reconcileRemovedDevices({
      api: {
        deviceManager: {
          listDeletedSince: {
            query: async () => {
              throw new Error('hub unreachable')
            },
          },
        },
      },
      logger: log,
      remove,
    })

    expect(out).toEqual({ read: false, applied: 0, failed: 0 })
    expect(remove).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalled()
  })

  it('one device failing is logged with its deviceId and does not stop the others', async () => {
    const log = logger()
    const remove = vi.fn(async (input: { deviceId: number }) => {
      if (input.deviceId === 4483) throw new Error('disk busy')
      return { counts: { footage: 1 } }
    })

    const out = await reconcileRemovedDevices({
      api: { deviceManager: { listDeletedSince: { query: async () => tombstones } } },
      logger: log,
      remove,
    })

    expect(out).toEqual({ read: true, applied: 1, failed: 1 })
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: 4483 } }),
    )
  })
})
