/**
 * The top two rungs of the hydration ladder, against a real directory tree.
 *
 * Measured on the live archive (device 104, `low`): which DAYS have footage is
 * 1 ms over 28 entries, which HOURS is 1 ms over 8 — against 68,457 ms to walk
 * that camera's 258,449 files. Today `getDaysWithRecordings` answers from
 * `index.segments(deviceId)`, so the cheapest question in the product waits on
 * the most expensive data in it.
 *
 * The trap these pin: on the real archive **15 of 28 day directories are
 * EMPTY** — retention deletes files and leaves the tree behind. A rung that
 * equates "the directory exists" with "there is footage" would show fifteen
 * phantom days in the date selector.
 */
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { describe, it, expect, afterEach } from 'vitest'
import {
  daysWithFootage,
  hoursWithFootage,
  localDaysWithFootage,
  segmentsOfHour,
} from '../calendar-scan.js'

const made: string[] = []

afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

/** Build `<root>/<device>/<profile>/YYYY/MM/DD/HH/` with the given segments. */
async function tree(spec: Record<string, readonly string[]>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cal-'))
  made.push(root)
  for (const [rel, files] of Object.entries(spec)) {
    const dir = path.join(root, rel)
    await fs.mkdir(dir, { recursive: true })
    for (const f of files) await fs.writeFile(path.join(dir, f), '')
  }
  return root
}

const SEG = '1785276000000-8000-50000.m4s'

describe('daysWithFootage (L0)', () => {
  it('lists the days of a month that actually hold segments', async () => {
    const root = await tree({
      '7/low/2026/07/28/03': [SEG],
      '7/low/2026/07/29/05': [SEG],
    })
    expect(await daysWithFootage(root, 7, 2026, 7)).toEqual([28, 29])
  })

  it('does NOT report a day whose directory tree is a retention shell', async () => {
    // 15 of 28 day directories on the real archive are shells with NO entries
    // at all — that is the shape of the garbage, and one read per day removes
    // it from the answer.
    const root = await tree({
      '7/low/2026/07/28/03': [SEG],
      '7/low/2026/07/26': [], // swept: day dir survives, hours gone
    })
    expect(await daysWithFootage(root, 7, 2026, 7)).toEqual([28])
  })

  it('reaps the shell it found, so the next scan is smaller', async () => {
    const root = await tree({ '7/low/2026/07/28/03': [SEG], '7/low/2026/07/26': [] })
    await daysWithFootage(root, 7, 2026, 7)
    await expect(fs.stat(path.join(root, '7/low/2026/07/26'))).rejects.toThrow()
  })

  it('still reports a day whose only hour is an emptied shell — healed one rung down', async () => {
    // Measured 1 in 261. Confirming it here would cost a read per hour, nine
    // for a typical day, to correct a case the segment scan clears the first
    // time anyone seeks into it. The smallest wrong answer available.
    const root = await tree({ '7/low/2026/07/27/04': [] })
    expect(await daysWithFootage(root, 7, 2026, 7)).toEqual([27])
  })

  it('falls past a profile directory left empty by a config change', async () => {
    // `low` exists but records nothing; the footage is under `high`. Picking a
    // profile by existence alone would report the whole camera as empty.
    const root = await tree({
      '7/low': [],
      '7/high/2026/07/28/03': [SEG],
    })
    expect(await daysWithFootage(root, 7, 2026, 7)).toEqual([28])
  })

  it('is empty, not an error, for a device with nothing on this location', async () => {
    const root = await tree({ '9/low/2026/07/28/03': [SEG] })
    expect(await daysWithFootage(root, 7, 2026, 7)).toEqual([])
  })
})

describe('hoursWithFootage (L1)', () => {
  it('lists the hours of a day from their names — one read, not one per hour', async () => {
    const root = await tree({ '7/low/2026/07/29/00': [SEG], '7/low/2026/07/29/05': [SEG] })
    expect(await hoursWithFootage(root, 7, 2026, 7, 29)).toEqual([0, 5])
  })

  it('reads ONE profile — the lowest — not the union of all of them', async () => {
    // Availability answers "was anything recorded", not "at what quality".
    // Enumerating every profile triples the reads for the same bar: measured
    // 75 reads / 16,028 ms against 25 / 1,489 ms for a cold day.
    const root = await tree({
      '7/low/2026/07/29/01': [SEG],
      '7/mid/2026/07/29/02': [SEG],
    })
    expect(await hoursWithFootage(root, 7, 2026, 7, 29)).toEqual([1])
  })

  it('ignores a non-numeric entry so a stray file never invents an hour', async () => {
    const root = await tree({ '7/low/2026/07/29/03': [SEG] })
    await fs.writeFile(path.join(root, '7/low/2026/07/29/live.m3u8'), '')
    expect(await hoursWithFootage(root, 7, 2026, 7, 29)).toEqual([3])
  })
})

describe('localDaysWithFootage — the date selector', () => {
  /**
   * Paths are UTC; the selector shows the operator's LOCAL days, and a local day
   * straddles two UTC ones. So the answer needs hour granularity — but only
   * until each local day is confirmed, which is almost always its first hour.
   */
  const CEST = 120 // minutes to add to UTC

  it('attributes an hour to the operator local day, not the UTC one', async () => {
    // 2026-07-28T23:30Z is 2026-07-29 01:30 in CEST — a different DAY.
    const root = await tree({ '7/low/2026/07/28/23': [SEG] })
    const from = Date.UTC(2026, 6, 25)
    const to = Date.UTC(2026, 6, 31)
    expect(await localDaysWithFootage(root, 7, from, to, CEST)).toEqual(['2026-07-29'])
  })

  it('reports both local days when a UTC day feeds each', async () => {
    const root = await tree({
      '7/low/2026/07/28/10': [SEG], // → 2026-07-28 local
      '7/low/2026/07/28/23': [SEG], // → 2026-07-29 local
    })
    const from = Date.UTC(2026, 6, 25)
    const to = Date.UTC(2026, 6, 31)
    expect(await localDaysWithFootage(root, 7, from, to, CEST)).toEqual([
      '2026-07-28',
      '2026-07-29',
    ])
  })

  it('does not invent a day from directories retention emptied', async () => {
    const root = await tree({ '7/low/2026/07/28/10': [], '7/low/2026/07/27': [] })
    const from = Date.UTC(2026, 6, 25)
    const to = Date.UTC(2026, 6, 31)
    expect(await localDaysWithFootage(root, 7, from, to, CEST)).toEqual([])
  })

  it('stops probing an hour once its local day is already confirmed', async () => {
    // The cost control: a day with 20 recorded hours must not cost 20 readdirs.
    const spec: Record<string, readonly string[]> = {}
    for (let h = 0; h < 20; h++) spec[`7/low/2026/07/28/${String(h).padStart(2, '0')}`] = [SEG]
    const root = await tree(spec)
    const from = Date.UTC(2026, 6, 28)
    const to = Date.UTC(2026, 6, 29)
    const probes: string[] = []
    const days = await localDaysWithFootage(root, 7, from, to, CEST, (abs) => probes.push(abs))
    expect(days).toContain('2026-07-28')
    // Two local days are reachable from this UTC day (CEST splits it), so at
    // most a couple of probes — never one per hour.
    expect(probes.length).toBeLessThanOrEqual(3)
  })
})

describe('segmentsOfHour — the exact rung', () => {
  it('reads start and duration out of the NAMES, opening nothing', async () => {
    const root = await tree({
      '7/low/2026/07/29/05': ['1785294000000-8000-50000.m4s', '1785294008000-7989-49000.m4s'],
    })
    const at = Date.UTC(2026, 6, 29, 5)
    expect(await segmentsOfHour(root, 7, 'low', at)).toEqual([
      { startMs: 1785294000000, durMs: 8000, bytes: 50000 },
      { startMs: 1785294008000, durMs: 7989, bytes: 49000 },
    ])
  })

  it('ignores a two-field name so a legacy file cannot become a phantom range', async () => {
    const root = await tree({ '7/low/2026/07/29/05': ['1785294000000-8000.m4s'] })
    expect(await segmentsOfHour(root, 7, 'low', Date.UTC(2026, 6, 29, 5))).toEqual([])
  })

  it('reaps an hour emptied by retention, healing what the rung above trusts', async () => {
    const root = await tree({ '7/low/2026/07/29/06': [] })
    const at = Date.UTC(2026, 6, 29, 6)
    expect(await segmentsOfHour(root, 7, 'low', at)).toEqual([])
    await expect(fs.stat(path.join(root, '7/low/2026/07/29/06'))).rejects.toThrow()
  })
})
