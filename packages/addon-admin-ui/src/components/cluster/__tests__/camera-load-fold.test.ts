/**
 * The fold is where a reported cost could still become a lie: by apportioning
 * a shared pool across cameras, by hiding a process nobody claims, or by
 * summing a partial set into a number that looks complete.
 */
import { describe, expect, it } from 'vitest'
import {
  foldContributionsByCamera,
  UNCLAIMED_BUCKET_KEY,
  type CameraLoadEntry,
} from '../load/camera-load-fold'

const recording101: CameraLoadEntry = {
  addonId: 'recorder',
  role: 'recording',
  deviceId: 101,
  attribution: 'measured',
  unit: '101/high',
  pid: 100,
  cpuSeconds: 12,
  rssBytes: 1000,
}

const streaming101: CameraLoadEntry = {
  addonId: 'stream-broker',
  role: 'streaming',
  deviceId: 101,
  attribution: 'measured',
  unit: '101/native',
  pid: 101,
  cpuSeconds: 8,
  rssBytes: 500,
}

const sharedPool: CameraLoadEntry = {
  addonId: 'detection-pipeline',
  role: 'detection',
  deviceId: null,
  attribution: 'unattributable',
  unit: 'inference pool default',
  pid: 200,
  cpuSeconds: 900,
  rssBytes: 90_000,
}

describe('foldContributionsByCamera', () => {
  it('sums one camera across the addons that reported it', () => {
    const [bucket] = foldContributionsByCamera([recording101, streaming101])
    expect(bucket?.kind).toBe('camera')
    expect(bucket?.deviceId).toBe(101)
    expect(bucket?.cpuSeconds).toBe(20)
    expect(bucket?.rssBytes).toBe(1500)
    expect(bucket?.roles).toEqual(['recording', 'streaming'])
  })

  it('never spreads a shared pool across the cameras that happen to be present', () => {
    // The failure the whole surface exists to prevent. 900 CPU seconds of
    // inference pool must NOT become 450 for each of two cameras.
    const buckets = foldContributionsByCamera([recording101, sharedPool])
    const camera = buckets.find((b) => b.deviceId === 101)
    const shared = buckets.find((b) => b.kind === 'shared')
    expect(camera?.cpuSeconds).toBe(12)
    expect(shared?.cpuSeconds).toBe(900)
    expect(shared?.deviceId).toBeNull()
  })

  it('lets the DECLARATION beat the deviceId when a shared entry names a camera', () => {
    // A contributor may label a shared cost with the camera that triggered it.
    // `attribution: 'unattributable'` is the contributor saying "this is not
    // one camera's", and it must win — otherwise the pool's whole cost lands
    // on whichever camera happened to be named.
    const labelledShared: CameraLoadEntry = { ...sharedPool, deviceId: 101, pid: 201 }
    const buckets = foldContributionsByCamera([recording101, labelledShared])
    expect(buckets.find((b) => b.deviceId === 101)?.cpuSeconds).toBe(12)
    const shared = buckets.find((b) => b.kind === 'shared')
    expect(shared?.cpuSeconds).toBe(900)
    expect(shared?.deviceId).toBeNull()
  })

  it('keeps a process NOBODY claimed in its own bucket', () => {
    // The observer sees three processes; two are claimed. The third is either
    // a leak or a family nobody taught to report — it is the finding, so it
    // must not vanish and it must not be folded into 101.
    const buckets = foldContributionsByCamera(
      [recording101, streaming101],
      [
        { pid: 100, memoryRssBytes: 1000 },
        { pid: 101, memoryRssBytes: 500 },
        { pid: 999, memoryRssBytes: 7000 },
      ],
    )
    const unclaimed = buckets.find((b) => b.key === UNCLAIMED_BUCKET_KEY)
    expect(unclaimed?.kind).toBe('unclaimed')
    expect(unclaimed?.unitCount).toBe(1)
    expect(unclaimed?.rssBytes).toBe(7000)
    // The observer reports no cumulative CPU seconds, so this stays unknown
    // rather than borrowing the lifetime average, which is a different number.
    expect(unclaimed?.cpuSeconds).toBeNull()
    expect(buckets.find((b) => b.deviceId === 101)?.rssBytes).toBe(1500)
  })

  it('emits NO unclaimed bucket when nothing was observed — "did not look" is not "nothing"', () => {
    const buckets = foldContributionsByCamera([recording101])
    expect(buckets.some((b) => b.key === UNCLAIMED_BUCKET_KEY)).toBe(false)
  })

  it('reports a PARTIAL sum as unknown, not as a smaller complete number', () => {
    const noNumbers: CameraLoadEntry = {
      addonId: 'recorder',
      role: 'recording',
      deviceId: 101,
      attribution: 'measured',
      unit: '101/low',
      pid: 102,
    }
    const [bucket] = foldContributionsByCamera([recording101, noNumbers])
    expect(bucket?.cpuSeconds).toBeNull()
    expect(bucket?.rssBytes).toBeNull()
    // The bucket still says how many units it holds — that part IS known.
    expect(bucket?.unitCount).toBe(2)
  })
})
