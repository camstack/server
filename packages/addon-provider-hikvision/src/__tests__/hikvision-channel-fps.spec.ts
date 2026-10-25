import { describe, it, expect } from 'vitest'
import type { HikvisionDeviceCache } from '../schema.js'
import { resolveProbedFps } from '../hikvision-channel-fps.js'

/**
 * Pure helper that surfaces the camera's per-channel `maxFrameRate`
 * from the cached probe (populated once at boot by
 * `probeAndPersistFeatures` via `getStreamingChannel(id)`).
 *
 * The broker `channelToDescriptor` reads this so the "Source (probed)"
 * widget card shows an fps chip alongside codec + resolution. The list
 * endpoint `/ISAPI/Streaming/channels` doesn't carry `maxFrameRate`;
 * the per-channel endpoint does — so we use the cached probe to avoid
 * an extra ISAPI round-trip per ~30s catalog pull.
 */
describe('resolveProbedFps', () => {
  it('returns undefined when no device cache is persisted yet', () => {
    expect(resolveProbedFps('101', undefined)).toBeUndefined()
  })

  it('returns undefined when no streamSnapshots have been probed', () => {
    const cache: HikvisionDeviceCache = { probedAt: 0 }
    expect(resolveProbedFps('101', cache)).toBeUndefined()
  })

  it('returns undefined when the requested channel has no snapshot', () => {
    const cache: HikvisionDeviceCache = {
      streamSnapshots: { '102': { maxFrameRate: 25 } },
    }
    expect(resolveProbedFps('101', cache)).toBeUndefined()
  })

  it('returns undefined when maxFrameRate is null (legacy firmware did not advertise)', () => {
    const cache: HikvisionDeviceCache = {
      streamSnapshots: { '101': { maxFrameRate: null } },
    }
    expect(resolveProbedFps('101', cache)).toBeUndefined()
  })

  it('returns undefined when maxFrameRate is zero (unconfigured channel)', () => {
    const cache: HikvisionDeviceCache = {
      streamSnapshots: { '101': { maxFrameRate: 0 } },
    }
    expect(resolveProbedFps('101', cache)).toBeUndefined()
  })

  it('returns the cached maxFrameRate for the requested channel', () => {
    const cache: HikvisionDeviceCache = {
      streamSnapshots: { '101': { maxFrameRate: 25 } },
    }
    expect(resolveProbedFps('101', cache)).toBe(25)
  })

  it('isolates per-channel snapshots — main vs sub vs third can carry distinct fps', () => {
    const cache: HikvisionDeviceCache = {
      streamSnapshots: {
        '101': { maxFrameRate: 25 },
        '102': { maxFrameRate: 15 },
        '103': { maxFrameRate: 10 },
      },
    }
    expect(resolveProbedFps('101', cache)).toBe(25)
    expect(resolveProbedFps('102', cache)).toBe(15)
    expect(resolveProbedFps('103', cache)).toBe(10)
  })
})
