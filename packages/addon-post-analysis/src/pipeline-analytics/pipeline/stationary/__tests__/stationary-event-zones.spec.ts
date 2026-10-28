import { describe, it, expect, vi } from 'vitest'
import type { Zone } from '@camstack/types'
import { resolveStationaryEventZones } from '../stationary-event-zones.js'

const topLeft: Zone = {
  id: 'top-left',
  name: 'Top Left',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 0, y: 0.5 },
  ],
  color: '#3b82f6',
}

const entry = {
  deviceId: 7,
  bbox: { x: 200, y: 100, w: 80, h: 70 },
  frameWidth: 960,
  frameHeight: 540,
}

describe('resolveStationaryEventZones', () => {
  it('returns the ids of the zones the parked box is in', async () => {
    const zones = await resolveStationaryEventZones(entry, {
      resolveZones: async () => [topLeft],
      resolveMinOverlap: async () => 0.1,
      logger: { warn: vi.fn() },
    })
    expect(zones).toEqual(['top-left'])
  })

  it('is empty when the camera has no zones', async () => {
    const zones = await resolveStationaryEventZones(entry, {
      resolveZones: async () => [],
      resolveMinOverlap: async () => 0.1,
      logger: { warn: vi.fn() },
    })
    expect(zones).toEqual([])
  })

  it('is empty, and logged with the deviceId tag, when the zone read throws', async () => {
    const warn = vi.fn()
    const zones = await resolveStationaryEventZones(entry, {
      resolveZones: async () => {
        throw new Error('boom')
      },
      resolveMinOverlap: async () => 0.1,
      logger: { warn },
    })
    expect(zones).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: 7 } }),
    )
  })
})
