/**
 * Fleet disk-wins reconcile — one operator action walks every camera:
 * recordings index is reseated from the walk, then analytics ghosts are
 * dropped. Failures are isolated per camera so one bad device cannot abort
 * the fleet.
 */
import { describe, expect, it } from 'vitest'
import { reconcileFleetFromDisk } from '../disk-reconcile-fleet.js'

describe('reconcileFleetFromDisk', () => {
  it('rescans recordings then analytics for every camera', async () => {
    const order: string[] = []
    const result = await reconcileFleetFromDisk({
      listDeviceIds: async () => [7, 9],
      rescanRecordings: async (deviceId) => {
        order.push(`rec:${deviceId}`)
      },
      reconcileAnalytics: async (deviceId) => {
        order.push(`an:${deviceId}`)
        return { mediaDropped: 1, tracks: 2, events: 3 }
      },
    })
    expect(order).toEqual(['rec:7', 'an:7', 'rec:9', 'an:9'])
    expect(result).toEqual({
      cameras: 2,
      failed: [],
      mediaDropped: 2,
      tracks: 4,
      events: 6,
    })
  })

  it('isolates a per-camera failure and continues', async () => {
    const seen: number[] = []
    const result = await reconcileFleetFromDisk({
      listDeviceIds: async () => [1, 2],
      rescanRecordings: async (deviceId) => {
        if (deviceId === 1) throw new Error('walk failed')
        seen.push(deviceId)
      },
      reconcileAnalytics: async (deviceId) => {
        seen.push(deviceId)
        return { mediaDropped: 0, tracks: 0, events: 0 }
      },
    })
    expect(seen).toEqual([2, 2])
    expect(result.cameras).toBe(1)
    expect(result.failed).toEqual([1])
  })
})
