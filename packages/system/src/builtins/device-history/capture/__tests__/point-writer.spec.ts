import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Harness, makeHarness } from '../../__tests__/support/harness.js'
import { emitState, rawOf } from '../../__tests__/support/read-helpers.js'
import { MAX_BUFFER_AGE_MS } from '../point-writer.js'

let h: Harness
afterEach(async () => {
  vi.restoreAllMocks()
  await h.close()
})

const BATTERY = 'cap:battery.level'

describe('the raw write buffer', () => {
  it('keeps a batch the store would not take and writes it at the next flush', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: 80 })
    const failing = vi
      .spyOn(h.runtime.store, 'upsertRaw')
      .mockRejectedValueOnce(new Error('disk full'))
    await h.runtime.flushNow()
    expect(failing).toHaveBeenCalledTimes(1)
    expect(h.runtime.status().capture.flushFailures).toBe(1)
    expect(h.runtime.status().capture.bufferDepth).toBe(1)
    await h.runtime.flushNow()
    expect(h.runtime.status().capture.bufferDepth).toBe(0)
    expect(await rawOf(h, BATTERY, 1)).toHaveLength(1)
    expect(h.runtime.status().capture.pointsDropped).toBe(0)
  })

  it('drops points older than a minute with an ERROR naming the count and the devices (D391)', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor, 2: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { level: 80 })
    emitState(h, 2, 'battery', { level: 70 })
    vi.spyOn(h.runtime.store, 'upsertRaw').mockRejectedValue(new Error('store down'))
    h.advance(MAX_BUFFER_AGE_MS + 1_000)
    await h.runtime.flushNow()
    const status = h.runtime.status()
    expect(status.capture.pointsDropped).toBe(2)
    expect(status.capture.bufferDepth).toBe(0)
    const error = h.logs.find((l) => l.level === 'error')
    expect(error?.message).toContain('dropped points')
    expect(error?.meta['dropped']).toBe(2)
    expect(error?.meta['deviceIds']).toEqual([1, 2])
  })

  it('writes one batch for many points: a single upsert call per flush', async () => {
    h = await makeHarness({
      devices: { 1: DeviceType.Sensor, 2: DeviceType.Sensor, 3: DeviceType.Sensor },
    })
    for (const id of [1, 2, 3]) emitState(h, id, 'battery', { level: 50 + id })
    const spy = vi.spyOn(h.runtime.store, 'upsertRaw')
    await h.runtime.flushNow()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toHaveLength(3)
  })
})
