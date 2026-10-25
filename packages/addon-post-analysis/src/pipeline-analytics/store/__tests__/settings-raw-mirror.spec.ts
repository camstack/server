/**
 * Every assertion here is a READ COUNT — same discipline as
 * `detection-pipeline/__tests__/device-override-mirror.spec.ts`, the working
 * example this module follows.
 *
 * The defect measured live 2026-08-26: `readDeviceSettings` fanned out to
 * EIGHT independent per-kind TTL caches (audio, sensitivity, tracking,
 * confirmation-gate, face, media, stationary, package-drop), each blind to
 * the other seven, each re-reading the SAME addon-level store
 * (`resolveGlobalStore`) and the SAME per-device blob (`readDeviceBlob`) on
 * its own 5 s clock — `get pipeline-analytics:addon-settings` at 547–694
 * calls/min, `get pipeline-analytics:addon-devices` at ~700/min. A test that
 * only checks the resolved VALUE passes on that code, so every case here
 * counts reads.
 */

import { describe, expect, it } from 'vitest'
import {
  RAW_SETTINGS_MISS_COOLDOWN_MS,
  RAW_SETTINGS_STALE_MS,
  RawDeviceBlobMirror,
  RawGlobalStoreMirror,
} from '../settings-raw-mirror.js'

function countingDevice(value: Record<string, unknown> = { faceThreshold: 0.4 }) {
  let reads = 0
  return {
    reads: () => reads,
    read: async (_deviceId: number): Promise<Record<string, unknown>> => {
      reads += 1
      return value
    },
  }
}

function countingGlobal(value: Record<string, unknown> = { retentionDays: 7 }) {
  let reads = 0
  return {
    reads: () => reads,
    read: async (): Promise<Record<string, unknown>> => {
      reads += 1
      return value
    },
  }
}

function clock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('RawDeviceBlobMirror', () => {
  it('eight settings kinds cold-reading the same device cost ONE read, not eight', async () => {
    // This is the exact shape of the incident: audio/sensitivity/tracking/
    // confirmation-gate/face/media/stationary/package-drop all resolve
    // `readDeviceSettings(102, …)` in the same tick.
    const store = countingDevice()
    const mirror = new RawDeviceBlobMirror({ read: store.read, now: clock().now })
    await Promise.all(Array.from({ length: 8 }, () => mirror.resolve(102)))
    expect(store.reads()).toBe(1)
  })

  it('a thousand frames inside the window cost ONE read', async () => {
    const store = countingDevice()
    const c = clock()
    const mirror = new RawDeviceBlobMirror({ read: store.read, now: c.now })

    for (let i = 0; i < 1000; i += 1) {
      expect(await mirror.resolve(102)).toEqual({ faceThreshold: 0.4 })
      c.advance(40) // 25 fps
    }

    // 1000 frames span ~40 s at a 5 s window, crossing 8 boundaries.
    expect(store.reads()).toBe(8)
  })

  it('two different devices are mirrored independently', async () => {
    const store = countingDevice()
    const mirror = new RawDeviceBlobMirror({ read: store.read, now: clock().now })
    await Promise.all([mirror.resolve(102), mirror.resolve(618), mirror.resolve(102)])
    expect(store.reads()).toBe(2)
  })

  it('serves the STALE value without awaiting the refresh it starts', async () => {
    let reads = 0
    const c = clock()
    const mirror = new RawDeviceBlobMirror({
      read: async () => {
        reads += 1
        if (reads === 1) return { faceThreshold: 0.4 }
        return new Promise<Record<string, unknown>>(() => undefined)
      },
      now: c.now,
    })

    expect(await mirror.resolve(102)).toEqual({ faceThreshold: 0.4 })
    c.advance(RAW_SETTINGS_STALE_MS)

    expect(await mirror.resolve(102)).toEqual({ faceThreshold: 0.4 })
    expect(reads).toBe(2)

    for (let i = 0; i < 20; i += 1)
      expect(await mirror.resolve(102)).toEqual({ faceThreshold: 0.4 })
    expect(reads).toBe(2)
  })

  it('a write invalidates: the next read reads, and reads only once', async () => {
    const store = countingDevice()
    const c = clock()
    const mirror = new RawDeviceBlobMirror({ read: store.read, now: c.now })

    await mirror.resolve(102)
    await mirror.resolve(102)
    expect(store.reads()).toBe(1)

    mirror.invalidate(102)
    await mirror.resolve(102)
    await mirror.resolve(102)
    expect(store.reads()).toBe(2)
  })

  it('invalidate(deviceId) does not touch another device entry', async () => {
    const store = countingDevice()
    const mirror = new RawDeviceBlobMirror({ read: store.read, now: clock().now })
    await mirror.resolve(102)
    await mirror.resolve(618)
    expect(store.reads()).toBe(2)

    mirror.invalidate(102)
    await mirror.resolve(102)
    await mirror.resolve(618)
    expect(store.reads()).toBe(3)
  })

  it('invalidateAll drops every device', async () => {
    const store = countingDevice()
    const mirror = new RawDeviceBlobMirror({ read: store.read, now: clock().now })
    await mirror.resolve(102)
    await mirror.resolve(618)
    expect(store.reads()).toBe(2)

    mirror.invalidateAll()
    await mirror.resolve(102)
    await mirror.resolve(618)
    expect(store.reads()).toBe(4)
  })

  it('holds the last value when a refresh fails, and does not retry per read', async () => {
    let reads = 0
    const failures: number[] = []
    const c = clock()
    const mirror = new RawDeviceBlobMirror({
      read: async () => {
        reads += 1
        if (reads === 1) return { faceThreshold: 0.4 }
        throw new Error('settings store down')
      },
      now: c.now,
      onRefreshFailed: (deviceId) => failures.push(deviceId),
    })

    expect(await mirror.resolve(102)).toEqual({ faceThreshold: 0.4 })
    c.advance(RAW_SETTINGS_STALE_MS)

    for (let i = 0; i < 100; i += 1) {
      expect(await mirror.resolve(102)).toEqual({ faceThreshold: 0.4 })
      c.advance(10)
    }
    expect(reads).toBe(2)
    expect(failures).toEqual([102])

    c.advance(RAW_SETTINGS_MISS_COOLDOWN_MS)
    await mirror.resolve(102)
    expect(reads).toBe(3)
  })

  it('a COLD failure is not cached as an empty blob — the next read tries again', async () => {
    let reads = 0
    const mirror = new RawDeviceBlobMirror({
      read: async () => {
        reads += 1
        if (reads === 1) throw new Error('down')
        return { faceThreshold: 0.4 }
      },
      now: clock().now,
      onRefreshFailed: () => undefined,
    })

    expect(await mirror.resolve(102)).toEqual({})
    expect(await mirror.resolve(102)).toEqual({ faceThreshold: 0.4 })
    expect(reads).toBe(2)
  })
})

describe('RawGlobalStoreMirror', () => {
  it('eight settings kinds cold-reading the addon store cost ONE read, not eight', async () => {
    const store = countingGlobal()
    const mirror = new RawGlobalStoreMirror({ read: store.read, now: clock().now })
    await Promise.all(Array.from({ length: 8 }, () => mirror.resolve()))
    expect(store.reads()).toBe(1)
  })

  it('a thousand frames inside the window cost ONE read', async () => {
    const store = countingGlobal()
    const c = clock()
    const mirror = new RawGlobalStoreMirror({ read: store.read, now: c.now })

    for (let i = 0; i < 1000; i += 1) {
      expect(await mirror.resolve()).toEqual({ retentionDays: 7 })
      c.advance(40)
    }
    // Same arithmetic as the device mirror: ~40 s span / 5 s window ≈ 8 reads.
    expect(store.reads()).toBe(8)
  })

  it('serves the STALE value without awaiting the refresh it starts', async () => {
    let reads = 0
    const c = clock()
    const mirror = new RawGlobalStoreMirror({
      read: async () => {
        reads += 1
        if (reads === 1) return { retentionDays: 7 }
        return new Promise<Record<string, unknown>>(() => undefined)
      },
      now: c.now,
    })

    expect(await mirror.resolve()).toEqual({ retentionDays: 7 })
    c.advance(RAW_SETTINGS_STALE_MS)

    expect(await mirror.resolve()).toEqual({ retentionDays: 7 })
    expect(reads).toBe(2)
  })

  it('a write invalidates: the next read reads, and reads only once', async () => {
    const store = countingGlobal()
    const c = clock()
    const mirror = new RawGlobalStoreMirror({ read: store.read, now: c.now })

    await mirror.resolve()
    await mirror.resolve()
    expect(store.reads()).toBe(1)

    mirror.invalidate()
    await mirror.resolve()
    await mirror.resolve()
    expect(store.reads()).toBe(2)
  })

  it('holds the last value when a refresh fails, and does not retry per read', async () => {
    let reads = 0
    const failures: unknown[] = []
    const c = clock()
    const mirror = new RawGlobalStoreMirror({
      read: async () => {
        reads += 1
        if (reads === 1) return { retentionDays: 7 }
        throw new Error('settings store down')
      },
      now: c.now,
      onRefreshFailed: (err) => failures.push(err),
    })

    expect(await mirror.resolve()).toEqual({ retentionDays: 7 })
    c.advance(RAW_SETTINGS_STALE_MS)

    for (let i = 0; i < 100; i += 1) {
      expect(await mirror.resolve()).toEqual({ retentionDays: 7 })
      c.advance(10)
    }
    expect(reads).toBe(2)
    expect(failures).toHaveLength(1)

    c.advance(RAW_SETTINGS_MISS_COOLDOWN_MS)
    await mirror.resolve()
    expect(reads).toBe(3)
  })

  it('a COLD failure is not cached as an empty store — the next read tries again', async () => {
    let reads = 0
    const mirror = new RawGlobalStoreMirror({
      read: async () => {
        reads += 1
        if (reads === 1) throw new Error('down')
        return { retentionDays: 7 }
      },
      now: clock().now,
      onRefreshFailed: () => undefined,
    })

    expect(await mirror.resolve()).toEqual({})
    expect(await mirror.resolve()).toEqual({ retentionDays: 7 })
    expect(reads).toBe(2)
  })
})
