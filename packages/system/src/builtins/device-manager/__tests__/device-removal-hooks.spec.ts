/**
 * A deleted device is a RECORDED fact other addons can rely on (D865).
 *
 *  - the delete path writes a tombstone and calls every `device-removal-hook`
 *    implementer, retrying the one that fails without re-calling the others;
 *  - a device that is only unregistered / offline gets no tombstone and no call;
 *  - the admin clean-up of data that predates tombstones is a dry run until
 *    confirmed, takes the absence check from TWO answered reads of the device
 *    ledger, and does nothing when a read fails.
 */
import { DEVICE_TOMBSTONE_RETENTION_MS } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOVAL_RETRY_DELAYS_MS } from '../removal-cleanup.js'
import {
  type FakeHook,
  fakeHook,
  type Harness,
  registerCamera,
  setup,
} from './device-manager-harness.js'

const DAY_MS = 24 * 60 * 60 * 1000

interface World {
  readonly h: Harness
  readonly hookA: FakeHook
  readonly hookB: FakeHook
  readonly live: number
  readonly doomed: number
  readonly listFails: { current: boolean }
}

async function world(): Promise<World> {
  const hookA = fakeHook('recorder')
  const hookB = fakeHook('pipeline-analytics')
  const listFails = { current: false }
  const h = await setup({ hooks: [hookA, hookB], hookListFails: listFails })
  const live = await registerCamera(h, 'provider-rtsp', 'cam-live')
  const doomed = await registerCamera(h, 'provider-rtsp', 'cam-doomed')
  hookA.data.push(
    { store: 'footage', deviceId: doomed, count: 12 },
    { store: 'footage', deviceId: live, count: 30 },
  )
  hookB.data.push({ store: 'events', deviceId: doomed, count: 5 })
  return { h, hookA, hookB, live, doomed, listFails }
}

describe('a delete is recorded and announced to every implementer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes the tombstone and calls each implementer with the device, time and owner', async () => {
    const { h, hookA, hookB, doomed, live } = await world()
    const before = Date.now()

    await h.provider.removeDevice({ deviceId: doomed })

    for (const hook of [hookA, hookB]) {
      expect(hook.calls).toHaveLength(1)
      expect(hook.calls[0]).toMatchObject({ deviceId: doomed, providerAddonId: 'provider-rtsp' })
      expect(hook.calls[0]?.deletedAt).toBeGreaterThanOrEqual(before)
    }
    expect(hookA.data.map((d) => d.deviceId)).toEqual([live])
    const tombstones = await h.provider.listDeletedSince({ sinceMs: 0 })
    expect(tombstones).toEqual([
      { deviceId: doomed, deletedAt: expect.any(Number), providerAddonId: 'provider-rtsp' },
    ])
  })

  it('retries only the implementer that failed, on the bounded schedule, then stops', async () => {
    const { h, hookA, hookB, doomed } = await world()
    hookA.failTimes = 1

    await h.provider.removeDevice({ deviceId: doomed })
    expect(hookA.calls).toHaveLength(1)
    expect(hookB.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(REMOVAL_RETRY_DELAYS_MS[0] ?? 0)
    expect(hookA.calls).toHaveLength(2)
    expect(hookB.calls).toHaveLength(1)
    expect(hookA.data.some((d) => d.deviceId === doomed)).toBe(false)

    await vi.advanceTimersByTimeAsync(REMOVAL_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0))
    expect(hookA.calls).toHaveLength(2)
  })

  it('an implementer that never answers is retried a bounded number of times and logged', async () => {
    const { h, hookA, doomed } = await world()
    hookA.failTimes = 99

    await h.provider.removeDevice({ deviceId: doomed })
    await vi.advanceTimersByTimeAsync(REMOVAL_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1)

    expect(hookA.calls).toHaveLength(1 + REMOVAL_RETRY_DELAYS_MS.length)
    const gaveUp = vi
      .mocked(h.logger.error)
      .mock.calls.find((c) => String(c[0]).startsWith('device removal hooks gave up'))
    expect(gaveUp?.[1]).toMatchObject({ tags: { deviceId: doomed } })
    // The tombstone is still there for the implementer's own reconcile.
    expect(await h.provider.listDeletedSince({ sinceMs: 0 })).toHaveLength(1)
  })

  it('an enumeration that fails is retried and the implementers are called once it answers', async () => {
    const { h, hookA, doomed, listFails } = await world()
    listFails.current = true

    await expect(h.provider.removeDevice({ deviceId: doomed })).resolves.toBeUndefined()
    expect(hookA.calls).toHaveLength(0)

    listFails.current = false
    await vi.advanceTimersByTimeAsync(REMOVAL_RETRY_DELAYS_MS[0] ?? 0)
    expect(hookA.calls).toHaveLength(1)
  })
})

describe('reconcile is driven by tombstones', () => {
  it('lists what was deleted since a cursor — a missed deletion is found, an older one is not', async () => {
    const { h, doomed, live } = await world()
    await h.provider.removeDevice({ deviceId: doomed })
    const t = (await h.provider.listDeletedSince({ sinceMs: 0 }))[0]?.deletedAt ?? 0

    expect(await h.provider.listDeletedSince({ sinceMs: t })).toHaveLength(1)
    expect(await h.provider.listDeletedSince({ sinceMs: t + 1 })).toHaveLength(0)
    expect(
      (await h.provider.listDeletedSince({ sinceMs: 0 })).map((x) => x.deviceId),
    ).not.toContain(live)
  })

  it('a tombstone expires after the retention window', async () => {
    vi.useFakeTimers()
    try {
      const { h, doomed } = await world()
      await h.provider.removeDevice({ deviceId: doomed })
      expect(await h.provider.listDeletedSince({ sinceMs: 0 })).toHaveLength(1)

      vi.setSystemTime(Date.now() + DEVICE_TOMBSTONE_RETENTION_MS + DAY_MS)
      expect(await h.provider.listDeletedSince({ sinceMs: 0 })).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a device that is only unregistered or offline has no tombstone and no hook call', async () => {
    const { h, hookA, hookB, live } = await world()

    // The provider restarts: its live objects leave the hub registry, the row stays.
    h.registry.remove(live)

    expect(await h.provider.listDeletedSince({ sinceMs: 0 })).toEqual([])
    expect(hookA.calls).toHaveLength(0)
    expect(hookB.calls).toHaveLength(0)
  })
})

describe('clean data of deleted devices (admin action)', () => {
  it('a dry run lists counts per store and deletes nothing', async () => {
    const { h, hookA, hookB, live } = await world()
    hookA.data.push({ store: 'footage', deviceId: 9001, count: 7 })
    hookB.data.push({ store: 'events', deviceId: 9001, count: 3 })

    const res = await h.provider.cleanupDeletedDevicesData({ confirm: false })

    expect(res.status).toBe('dry-run')
    expect(res.devices).toEqual([
      { deviceId: 9001, stores: { 'recorder:footage': 7, 'pipeline-analytics:events': 3 } },
    ])
    expect(hookA.calls).toHaveLength(0)
    expect(hookA.data.some((d) => d.deviceId === live)).toBe(true)
  })

  it('a confirmed run deletes only the absent devices and logs counts with the deviceId tag', async () => {
    const { h, hookA, hookB, live } = await world()
    hookA.data.push({ store: 'footage', deviceId: 9001, count: 7 })
    hookB.data.push({ store: 'events', deviceId: 9001, count: 3 })

    const res = await h.provider.cleanupDeletedDevicesData({ confirm: true })

    expect(res.status).toBe('cleaned')
    expect(res.devices[0]).toMatchObject({
      deviceId: 9001,
      stores: { 'recorder:footage': 7, 'pipeline-analytics:events': 3 },
    })
    expect(hookA.data.filter((d) => d.deviceId === 9001)).toEqual([])
    expect(hookA.data.some((d) => d.deviceId === live)).toBe(true)
    const line = vi
      .mocked(h.logger.info)
      .mock.calls.find((c) => c[0] === 'cleaned data of a device deleted before tombstones')
    expect(line?.[1]).toMatchObject({ tags: { deviceId: 9001 } })
  })

  it('a device that is registered but whose provider is gone is NOT a deleted device', async () => {
    const { h, hookA, live } = await world()
    h.registry.remove(live)

    const res = await h.provider.cleanupDeletedDevicesData({ confirm: true })

    expect(res.devices.map((d) => d.deviceId)).not.toContain(live)
    expect(hookA.data.some((d) => d.deviceId === live)).toBe(true)
  })

  it('skips — nothing listed, nothing deleted — when the device list read fails', async () => {
    const { h, hookA } = await world()
    hookA.data.push({ store: 'footage', deviceId: 9001, count: 7 })
    const spy = vi.spyOn(h.settingsStore.backend, 'query').mockRejectedValue(new Error('busy'))
    try {
      const res = await h.provider.cleanupDeletedDevicesData({ confirm: true })
      expect(res.status).toBe('skipped')
      expect(res.devices).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(hookA.data.some((d) => d.deviceId === 9001)).toBe(true)
    expect(hookA.calls).toHaveLength(0)
  })

  it('skips when an implementer cannot be asked rather than guessing what it holds', async () => {
    const { h, hookA, hookB } = await world()
    hookA.data.push({ store: 'footage', deviceId: 9001, count: 7 })
    hookB.listFails = true

    const res = await h.provider.cleanupDeletedDevicesData({ confirm: false })

    expect(res.status).toBe('dry-run')
    expect(res.unreachable).toEqual(['pipeline-analytics'])
    expect(res.devices.map((d) => d.deviceId)).toEqual([9001])
  })

  it('refuses when none of many device ids holding data is a known device (id space drift)', async () => {
    const { h, hookA, hookB } = await world()
    hookB.data = []
    hookA.data = [1, 2, 3, 4, 5, 6].map((n) => ({ store: 'footage', deviceId: 9000 + n, count: 1 }))

    const res = await h.provider.cleanupDeletedDevicesData({ confirm: true })

    expect(res.status).toBe('skipped')
    expect(hookA.data).toHaveLength(6)
  })
})

describe('per-device settings are cleared centrally, for every addon (D865)', () => {
  const put = async (h: Harness, addonId: string, deviceId: number, key: string): Promise<void> => {
    await h.settingsStore.backend.set({
      collection: 'addon-device-settings',
      key: `${addonId}:${deviceId}.${key}`,
      value: { addonId, deviceId: String(deviceId), key, value: 1 },
    })
  }
  const rows = async (h: Harness): Promise<string[]> =>
    (await h.settingsStore.backend.query({ collection: 'addon-device-settings' })).map((r) => r.id)

  it('a delete removes the device scope of every addon and no other device', async () => {
    const { h, doomed, live } = await world()
    await put(h, 'audio-analyzer', doomed, 'a')
    await put(h, 'motion-wasm', doomed, 'b')
    await put(h, 'recorder', doomed, 'recordingConfig')
    await put(h, 'audio-analyzer', live, 'a')

    await h.provider.removeDevice({ deviceId: doomed })

    expect(await rows(h)).toEqual([`audio-analyzer:${live}.a`])
  })

  it('the admin clean-up lists settings of a device that is not in the fleet and removes them on confirm', async () => {
    const { h, live } = await world()
    await put(h, 'audio-analyzer', 9001, 'a')
    await put(h, 'motion-wasm', 9001, 'b')
    await put(h, 'audio-analyzer', live, 'a')

    const dry = await h.provider.cleanupDeletedDevicesData({ confirm: false })
    expect(dry.devices).toEqual([
      { deviceId: 9001, stores: { 'settings:audio-analyzer': 1, 'settings:motion-wasm': 1 } },
    ])
    expect(await rows(h)).toHaveLength(3)

    const done = await h.provider.cleanupDeletedDevicesData({ confirm: true })
    expect(done.status).toBe('cleaned')
    expect(await rows(h)).toEqual([`audio-analyzer:${live}.a`])
  })
})

describe('tombstones live in records at init (phase 4)', () => {
  it('does not declare the legacy collection on hub boot', async () => {
    const h = await setup()
    expect(h.settingsStore.declared.has('device-manager:tombstones')).toBe(false)
  })
})
