/**
 * Raw points have two windows: a discrete series (`boolean`, `enum`) keeps them
 * `rawDiscreteDays` (default 30), a continuous one (`gauge`, `counter`) `rawDays` (default 7).
 * A per-device override of either wins over the cluster value.
 */
import { DeviceType } from '@dominevo/types'
import { afterEach, describe, expect, it } from 'vitest'
import { type Harness, makeHarness } from '../../__tests__/support/harness.js'
import { DAY_MS } from '../../time/bucket-time.js'
import { DEFAULT_RETENTION } from '../retention.js'

let h: Harness

const SUBJECT = { kind: 'device', deviceId: 1 } as const
const GAUGE = 'cap:air-quality-sensor.co2'
const BOOLEAN = 'cap:binary.on'
const ENUM = 'cap:alarm-panel.state'

async function seed(key: string, ages: readonly number[]) {
  const now = h.now()
  const series = await h.runtime.registry.ensure(key, SUBJECT, '', now - 4000 * DAY_MS)
  await h.runtime.store.upsertRaw(
    ages.map((d) => ({ seriesId: series.id, ts: now - d * DAY_MS, value: 1 })),
  )
  return series
}

const daysLeft = async (seriesId: number): Promise<number[]> =>
  (await h.runtime.store.readRaw(seriesId, 0, Number.MAX_SAFE_INTEGER, 100))
    .map((p) => Math.round((h.now() - p.ts) / DAY_MS))
    .sort((a, b) => a - b)

it('defaults a discrete series to 30 days beside the 7 of a continuous one', () => {
  expect(DEFAULT_RETENTION.rawDays).toBe(7)
  expect(DEFAULT_RETENTION.rawDiscreteDays).toBe(30)
})

describe('raw retention by series kind', () => {
  afterEach(async () => {
    await h.close()
  })

  it('purges a gauge raw at 7 days and boolean and enum raw at 30', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    expect(h.runtime.registry.metric(GAUGE)?.kind).toBe('gauge')
    expect(h.runtime.registry.metric(BOOLEAN)?.kind).toBe('boolean')
    expect(h.runtime.registry.metric(ENUM)?.kind).toBe('enum')
    const gauge = await seed(GAUGE, [1, 8, 20, 40])
    const bool = await seed(BOOLEAN, [1, 8, 20, 40])
    const en = await seed(ENUM, [1, 8, 20, 40])
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, h.now())
    expect(await daysLeft(gauge.id)).toEqual([1])
    expect(await daysLeft(bool.id)).toEqual([1, 8, 20])
    expect(await daysLeft(en.id)).toEqual([1, 8, 20])
  })

  it('lets a per-device override win, shorter or longer', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    h.runtime.retentionJob.attachDeviceOverrides(
      async () => new Map([[1, { rawDays: 15, rawDiscreteDays: 10 }]]),
    )
    const gauge = await seed(GAUGE, [1, 8, 20])
    const bool = await seed(BOOLEAN, [1, 8, 20])
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, h.now())
    expect(await daysLeft(gauge.id)).toEqual([1, 8])
    expect(await daysLeft(bool.id)).toEqual([1, 8])
  })
})
