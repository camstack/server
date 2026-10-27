/**
 * Orphan series (D917): a series is REPORTED orphan when its device is absent
 * from the successful device listings (the departure clock), or when its
 * `cap:` key is declared by no capability any more. Nothing is purged on that
 * judgement alone: an admin deletes, and only a series that is orphan at the
 * moment of the delete.
 */
import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { type Harness, makeHarness } from '../../__tests__/support/harness.js'
import { emitState, rawOf, rollupOf, seriesOf } from '../../__tests__/support/read-helpers.js'
import type { CapturedLog } from '../../__tests__/support/real-door.js'
import { HOUR_MS } from '../../time/bucket-time.js'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

/** A tank level `vacuum-control` declared before D915 — no cap declares it now. */
const RETIRED = 'cap:vacuum-control.cleanWater.level'
const BATTERY = 'cap:battery.level'

async function seedRetired(harness: Harness, deviceId: number, values: readonly number[]) {
  for (const value of values) {
    harness.runtime.writer.enqueue({
      key: RETIRED,
      subject: { kind: 'device', deviceId },
      scope: '',
      ts: harness.now(),
      value,
    })
    harness.advance(60_000)
  }
  // Past the 5-minute bucket's close (+30 s), so its rollup row exists.
  harness.advance(6 * 60_000)
  await harness.settle()
}

function deletionLines(logs: readonly CapturedLog[]): readonly CapturedLog[] {
  return logs.filter((l) => l.message.includes('deleted an orphan series'))
}

describe('listOrphans', () => {
  it('reports a series whose key no cap declares, with its row counts per tier', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Vacuum } })
    await seedRetired(h, 7, [10, 20, 30])
    emitState(h, 7, 'battery', { level: 80 })
    await h.settle()
    const { series, truncated } = await h.runtime.listOrphans()
    expect(truncated).toBe(false)
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({
      seriesId: seriesOf(h, RETIRED, 7)?.id,
      deviceId: 7,
      key: RETIRED,
      scope: '',
      reason: 'undeclared',
      missingSince: null,
      rows: { raw: 3, '5m': 1, '1h': 0, '1d': 0 },
    })
  })

  it('reports every series of a device absent from the listing, and nothing is purged', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor, 8: DeviceType.Sensor } })
    emitState(h, 7, 'battery', { level: 80 })
    emitState(h, 8, 'battery', { level: 60 })
    await h.settle()
    h.devices.delete(7)
    await h.runtime.reconcile()
    const missingAt = h.now()
    h.advance(HOUR_MS)
    await h.runtime.retentionJob.run(
      { rawDays: 7, fiveMinuteDays: 30, hourDays: 365, dayDays: null },
      h.now(),
    )
    const { series } = await h.runtime.listOrphans()
    expect(series.map((s) => [s.deviceId, s.key, s.reason, s.missingSince])).toEqual([
      [7, BATTERY, 'device-gone', missingAt],
    ])
    expect(await rawOf(h, BATTERY, 7)).toHaveLength(1)
  })

  it('a device that comes back is no longer orphan', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor } })
    emitState(h, 7, 'battery', { level: 80 })
    await h.settle()
    h.devices.delete(7)
    await h.runtime.reconcile()
    h.devices.set(7, DeviceType.Sensor)
    await h.runtime.reconcile()
    expect((await h.runtime.listOrphans()).series).toEqual([])
  })
})

describe('deleteOrphans', () => {
  it('deletes an orphan tier by tier, logs it per device, and releases its state', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Vacuum } })
    await seedRetired(h, 7, [10, 20, 30])
    const id = seriesOf(h, RETIRED, 7)?.id ?? -1
    const results = await h.runtime.deleteOrphans([id])
    expect(results).toEqual([
      { seriesId: id, ok: true, deleted: { raw: 3, '5m': 1, '1h': 0, '1d': 0 } },
    ])
    expect(seriesOf(h, RETIRED, 7)).toBeUndefined()
    expect(await h.runtime.store.readRaw(id, 0, Number.MAX_SAFE_INTEGER, 100)).toEqual([])
    expect(await h.runtime.store.readRollups('5m', id, 0, Number.MAX_SAFE_INTEGER, 100)).toEqual([])
    expect(await h.runtime.store.findSeries(RETIRED, 'd:7', '')).toBeNull()
    const lines = deletionLines(h.logs)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.tags).toEqual({ deviceId: 7 })
    expect((await h.runtime.listOrphans()).series).toEqual([])
  })

  it('refuses a series that is not orphan, and an unknown id, deleting nothing', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor } })
    emitState(h, 7, 'battery', { level: 80 })
    await h.settle()
    h.advance(6 * 60_000)
    await h.settle()
    const live = seriesOf(h, BATTERY, 7)?.id ?? -1
    const results = await h.runtime.deleteOrphans([live, 99_999])
    expect(results).toEqual([
      { seriesId: live, ok: false, reason: 'not-orphan' },
      { seriesId: 99_999, ok: false, reason: 'not-found' },
    ])
    expect(await rawOf(h, BATTERY, 7)).toHaveLength(1)
    expect(await rollupOf(h, '5m', BATTERY, 7)).toHaveLength(1)
    expect(deletionLines(h.logs)).toEqual([])
  })

  it('re-judges at delete time: a device that came back is refused', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor } })
    emitState(h, 7, 'battery', { level: 80 })
    await h.settle()
    h.devices.delete(7)
    await h.runtime.reconcile()
    const id = (await h.runtime.listOrphans()).series[0]?.seriesId ?? -1
    h.devices.set(7, DeviceType.Sensor)
    await h.runtime.reconcile()
    expect(await h.runtime.deleteOrphans([id])).toEqual([
      { seriesId: id, ok: false, reason: 'not-orphan' },
    ])
    expect(await rawOf(h, BATTERY, 7)).toHaveLength(1)
  })
})
