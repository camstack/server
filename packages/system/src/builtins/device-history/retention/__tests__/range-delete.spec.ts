/**
 * Deleting a time range of one series' points (admin, `deleteSeriesRange`): the
 * raw points inside `[from, to]` go, the rollup rows covering them are rebuilt
 * from what remains, a dry run deletes nothing, and the same range answers the
 * same counts dry or real. Real `history.db`, marked values: a spike of 999
 * inside the range, 10 everywhere else — a stale rollup shows as max 999.
 */
import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { type Harness, makeHarness } from '../../__tests__/support/harness.js'
import { rawOf, rollupOf, seriesOf } from '../../__tests__/support/read-helpers.js'
import { DAY_MS } from '../../time/bucket-time.js'
import type { RollupTier } from '../../time/bucket-time.js'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const KEY = 'cap:battery.level'
const SPIKE = 999
const NORMAL = 10
const MINUTE = 60_000

/** 10:50 → 11:15 UTC: crosses an hour boundary, so two hourly rows are touched. */
const FROM_OFFSET = 50 * MINUTE
const TO_OFFSET = 75 * MINUTE

async function seed(harness: Harness, deviceId: number): Promise<{ from: number; to: number }> {
  const t0 = harness.now()
  const from = t0 + FROM_OFFSET
  const to = t0 + TO_OFFSET
  const at = (ts: number, value: number) =>
    harness.runtime.writer.enqueue({
      key: KEY,
      subject: { kind: 'device', deviceId },
      scope: '',
      ts,
      value,
    })
  // A point per minute for 3 hours; the spike sits on every minute inside the range.
  for (let minute = 0; minute < 180; minute += 1) {
    const ts = t0 + minute * MINUTE
    at(ts, ts >= from && ts <= to ? SPIKE : NORMAL)
  }
  // One millisecond outside each bound: both must survive (bounds are exact).
  at(from - 1, NORMAL)
  at(to + 1, NORMAL)
  // Roll everything up: past the day's end + grace so 5m, 1h and 1d rows all exist.
  harness.advance(2 * DAY_MS)
  await harness.settle()
  return { from, to }
}

async function rowsOf(harness: Harness, deviceId: number) {
  const out: Record<string, unknown> = { raw: await rawOf(harness, KEY, deviceId) }
  for (const tier of ['5m', '1h', '1d'] as const) {
    out[tier] = await rollupOf(harness, tier, KEY, deviceId)
  }
  return out
}

function totalSamples(rows: readonly { samples: number }[]): number {
  return rows.reduce((n, r) => n + r.samples, 0)
}

describe('deleteSeriesRange', () => {
  it('a dry run deletes nothing and reports the counts a real run removes', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor } })
    const { from, to } = await seed(h, 7)
    const before = await rowsOf(h, 7)
    const insideRaw = (await rawOf(h, KEY, 7)).filter((p) => p.ts >= from && p.ts <= to).length
    expect(insideRaw).toBe(26)

    const dry = await h.runtime.deleteSeriesRange({
      deviceId: 7,
      key: KEY,
      scope: '',
      fromMs: from,
      toMs: to,
      dryRun: true,
    })
    expect(dry).toMatchObject({ ok: true, dryRun: true, rewritten: null })
    expect(dry.ok && dry.rows.raw).toBe(insideRaw)
    expect(dry.ok && dry.rows['5m']).toBeGreaterThan(0)
    expect(dry.ok && dry.rows['1h']).toBeGreaterThan(0)
    expect(dry.ok && dry.rows['1d']).toBeGreaterThan(0)
    expect(await rowsOf(h, 7)).toEqual(before)

    const real = await h.runtime.deleteSeriesRange({
      deviceId: 7,
      key: KEY,
      scope: '',
      fromMs: from,
      toMs: to,
      dryRun: false,
    })
    expect(real).toMatchObject({ ok: true, dryRun: false })
    expect(real.ok && real.rows).toEqual(dry.ok && dry.rows)
  })

  it('removes only the points inside the inclusive bounds, of this device and key', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor, 8: DeviceType.Sensor } })
    const { from, to } = await seed(h, 7)
    // Another device with the same marked data inside the same window.
    for (let minute = 50; minute <= 75; minute += 1) {
      h.runtime.writer.enqueue({
        key: KEY,
        subject: { kind: 'device', deviceId: 8 },
        scope: '',
        ts: from + (minute - 50) * MINUTE,
        value: SPIKE,
      })
    }
    await h.settle()
    const otherBefore = await rawOf(h, KEY, 8)

    await h.runtime.deleteSeriesRange({
      deviceId: 7,
      key: KEY,
      scope: '',
      fromMs: from,
      toMs: to,
      dryRun: false,
    })
    const raw = await rawOf(h, KEY, 7)
    expect(raw.some((p) => p.value === SPIKE)).toBe(false)
    expect(raw.some((p) => p.ts === from - 1)).toBe(true)
    expect(raw.some((p) => p.ts === to + 1)).toBe(true)
    expect(raw).toHaveLength(180 - 26 + 2)
    expect(await rawOf(h, KEY, 8)).toEqual(otherBefore)
  })

  it('rebuilds the rollups of every touched bucket from the points that remain', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor } })
    const { from, to } = await seed(h, 7)
    const staleMax = Math.max(...(await rollupOf(h, '1h', KEY, 7)).map((r) => r.max))
    expect(staleMax).toBe(SPIKE)

    await h.runtime.deleteSeriesRange({
      deviceId: 7,
      key: KEY,
      scope: '',
      fromMs: from,
      toMs: to,
      dryRun: false,
    })
    const remaining = await rawOf(h, KEY, 7)
    for (const tier of ['5m', '1h', '1d'] as const satisfies readonly RollupTier[]) {
      const rows = await rollupOf(h, tier, KEY, 7)
      expect(Math.max(...rows.map((r) => r.max)), tier).toBe(NORMAL)
      expect(totalSamples(rows), tier).toBe(remaining.length)
      expect(
        rows.reduce((n, r) => n + r.sum, 0),
        tier,
      ).toBe(remaining.length * NORMAL)
    }
  })

  it('refuses an inverted or empty range and an unknown series', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor } })
    const { from, to } = await seed(h, 7)
    const base = { deviceId: 7, key: KEY, scope: '', dryRun: false }
    expect(await h.runtime.deleteSeriesRange({ ...base, fromMs: to, toMs: from })).toEqual({
      ok: false,
      reason: 'invalid-range',
    })
    expect(await h.runtime.deleteSeriesRange({ ...base, fromMs: from, toMs: from })).toEqual({
      ok: false,
      reason: 'invalid-range',
    })
    expect(
      await h.runtime.deleteSeriesRange({ ...base, key: 'cap:nope.x', fromMs: from, toMs: to }),
    ).toEqual({ ok: false, reason: 'series-not-found' })
    expect(await rawOf(h, KEY, 7)).toHaveLength(182)
    expect(seriesOf(h, KEY, 7)).toBeDefined()
  })

  it('logs a real deletion with the device tag and the counts, a dry run logs no deletion', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor } })
    const { from, to } = await seed(h, 7)
    const input = { deviceId: 7, key: KEY, scope: '', fromMs: from, toMs: to }
    await h.runtime.deleteSeriesRange({ ...input, dryRun: true })
    const lines = () => h?.logs.filter((l) => l.message.includes('deleted a range of points')) ?? []
    expect(lines()).toHaveLength(0)
    await h.runtime.deleteSeriesRange({ ...input, dryRun: false })
    expect(lines()).toHaveLength(1)
    expect(lines()[0]?.tags).toEqual({ deviceId: 7 })
    expect(JSON.stringify(lines()[0]?.meta)).toContain('"raw":26')
  })
})

// An hour below the range the test seeds must not be touched at all.
describe('deleteSeriesRange untouched buckets', () => {
  it('leaves the rollup rows outside the covering buckets byte-for-byte', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Sensor } })
    const { from, to } = await seed(h, 7)
    const untouchedStart = h.now() - 2 * DAY_MS + 2 * 60 * 60_000
    const untouchedHour = (await rollupOf(h, '1h', KEY, 7)).find(
      (r) => r.bucketStart === untouchedStart,
    )
    await h.runtime.deleteSeriesRange({
      deviceId: 7,
      key: KEY,
      scope: '',
      fromMs: from,
      toMs: to,
      dryRun: false,
    })
    const after = (await rollupOf(h, '1h', KEY, 7)).find((r) => r.bucketStart === untouchedStart)
    expect(after).toEqual(untouchedHour)
    expect(untouchedHour).toBeDefined()
  })
})
