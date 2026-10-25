/**
 * The ADD-only repair for damage already on the array (D521).
 *
 * `reconcileLedgerAgainstDisk` cannot repair camera 101's hole and never could:
 * it iterates the hours the LEDGER already claims, so an hour nobody ever wrote
 * a row for is invisible to it, and it refuses `source-writable` — every live
 * location — because its FORGET direction needs a listing to be the whole
 * truth. Adding needs no such licence: a file that is there is there, and a
 * union can only be short, never wrong (D148).
 *
 * So this pass enumerates DIRECTORIES rather than claimed rows, runs on an
 * `active` location, and calls exactly one thing: `adoptWalkedHour`.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { segmentRelPath } from '../../segment-path.js'
import {
  HourAdoptionSweeper,
  type AdoptedHourCall,
  type HourAdoptionSweepDeps,
} from '../hour-adoption-sweep.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../roots.js'
import type { WalkedHourOutcome } from '../segment-hour-ledger.js'

const HOUR_MS = 3_600_000
/** 2026-09-17T00:00:00Z, so the directory names in this file are readable. */
const DAY = Date.UTC(2026, 8, 17)
const NOW = DAY + 12 * HOUR_MS + 30 * 60_000
const DEVICE = 101
const LOCATION = 'recordingsLow:default'
const ROOT = '/mnt/mixed/recordingsLow'

function silent(): IScopedLogger {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  } as unknown as IScopedLogger
  return logger
}

function active(): RecordingsLocation {
  return recordingsLocationOfMode({ id: LOCATION, type: 'recordingsLow', root: ROOT }, 'active')
}

/** `<root>/101/low/2026/09/17/HH` for an hour of the fixture day. */
function hourDir(hour: number, profile = 'low'): string {
  const h = String(hour).padStart(2, '0')
  return `${ROOT}/${DEVICE.toString()}/${profile}/2026/09/17/${h}`
}

function files(count: number, hour: number): readonly string[] {
  return Array.from({ length: count }, (_, i) =>
    segmentRelPath(DEVICE, 'low', DAY + hour * HOUR_MS + i * 10_000, 10_000, 120_000)
      .split('/')
      .slice(-1)
      .join(''),
  )
}

/** A tree as a map of absolute directory → entries. Anything absent is `null`,
 *  which is "no such directory" — data, not a failure. */
function tree(entries: Record<string, readonly string[]>): HourAdoptionSweepDeps['listDir'] {
  return async (dir) => entries[dir] ?? null
}

interface Harness {
  readonly deps: HourAdoptionSweepDeps
  readonly adopted: AdoptedHourCall[]
  readonly paced: { count: number }
}

function harness(
  listDir: HourAdoptionSweepDeps['listDir'],
  overrides: Partial<HourAdoptionSweepDeps> = {},
): Harness {
  const adopted: AdoptedHourCall[] = []
  const paced = { count: 0 }
  const outcome: WalkedHourOutcome = { created: true, added: 3, sealedNow: true }
  const deps: HourAdoptionSweepDeps = {
    ledger: () => ({
      adoptWalkedHour: async (deviceId, profile, locationId, hourStartMs, paths) => {
        adopted.push({ deviceId, profile, locationId, hourStartMs, paths })
        return outcome
      },
    }),
    locations: () => [active()],
    listDir,
    logger: silent(),
    now: () => NOW,
    pace: async () => {
      paced.count += 1
    },
    ...overrides,
  }
  return { deps, adopted, paced }
}

/** One camera-day with three closed hours of footage and one live hour. */
function oneDay(): Record<string, readonly string[]> {
  return {
    [ROOT]: [String(DEVICE)],
    [`${ROOT}/${DEVICE.toString()}`]: ['low', 'events', 'strips'],
    [`${ROOT}/${DEVICE.toString()}/low`]: ['2026'],
    [`${ROOT}/${DEVICE.toString()}/low/2026`]: ['09'],
    [`${ROOT}/${DEVICE.toString()}/low/2026/09`]: ['17'],
    [`${ROOT}/${DEVICE.toString()}/low/2026/09/17`]: ['08', '09', '10', '12'],
    [hourDir(8)]: files(3, 8),
    [hourDir(9)]: [...files(2, 9), 'live.m3u8'],
    [hourDir(10)]: [],
    [hourDir(12)]: files(4, 12),
  }
}

describe('the add-only sweep adopts hours it finds on the array', () => {
  it('adopts every CLOSED hour that holds segments, on an ACTIVE location', async () => {
    const { deps, adopted } = harness(tree(oneDay()))
    const report = await new HourAdoptionSweeper(deps).sweep({ locationId: LOCATION })

    expect(report.refused).toBeNull()
    expect(adopted.map((call) => call.hourStartMs)).toEqual([DAY + 8 * HOUR_MS, DAY + 9 * HOUR_MS])
    expect(adopted[0]?.deviceId).toBe(DEVICE)
    expect(adopted[0]?.profile).toBe('low')
    expect(adopted[0]?.locationId).toBe(LOCATION)
    expect(report.hoursAdopted).toBe(2)
  })

  it('hands over the segment files only — never a playlist or a stray', async () => {
    const { deps, adopted } = harness(tree(oneDay()))
    await new HourAdoptionSweeper(deps).sweep({ locationId: LOCATION })

    const ninth = adopted.find((call) => call.hourStartMs === DAY + 9 * HOUR_MS)
    expect(ninth?.paths).toHaveLength(2)
    expect(ninth?.paths.every((p) => p.endsWith('.m4s'))).toBe(true)
    // Location-RELATIVE, exactly as the ledger stores them.
    expect(ninth?.paths[0]).toMatch(/^101\/low\/2026\/09\/17\/09\//)
  })

  it('leaves the LIVE tail alone — a live hour races its writer', async () => {
    const { deps, adopted } = harness(tree(oneDay()))
    const report = await new HourAdoptionSweeper(deps).sweep({ locationId: LOCATION })

    expect(adopted.some((call) => call.hourStartMs === DAY + 12 * HOUR_MS)).toBe(false)
    expect(report.hoursSkippedLive).toBe(1)
  })

  it('walks only the canonical profile trees', async () => {
    const entries = oneDay()
    entries[`${ROOT}/${DEVICE.toString()}/events`] = ['2026']
    const { deps, adopted } = harness(tree(entries))
    await new HourAdoptionSweeper(deps).sweep({ locationId: LOCATION })

    expect(adopted.every((call) => call.profile === 'low')).toBe(true)
  })

  it('refuses a location it does not know, and one with no ledger', async () => {
    const { deps } = harness(tree(oneDay()))
    const unknown = await new HourAdoptionSweeper(deps).sweep({ locationId: 'nope' })
    expect(unknown.refused).toBe('location-unknown')

    const { deps: noLedger } = harness(tree(oneDay()), { ledger: () => null })
    const report = await new HourAdoptionSweeper(noLedger).sweep({ locationId: LOCATION })
    expect(report.refused).toBe('no-ledger')
  })

  it('counts an hour the ledger could not write as skipped, never as adopted', async () => {
    const { deps } = harness(tree(oneDay()), {
      ledger: () => ({
        adoptWalkedHour: async (): Promise<WalkedHourOutcome | null> => null,
      }),
    })
    const report = await new HourAdoptionSweeper(deps).sweep({ locationId: LOCATION })

    expect(report.hoursAdopted).toBe(0)
    expect(report.hoursRefusedByLedger).toBe(2)
  })
})

describe('the sweep stays off the array’s critical path', () => {
  it('is BOUNDED per pass and resumes where it stopped', async () => {
    const { deps, adopted } = harness(tree(oneDay()), { maxHours: 1 })
    const sweeper = new HourAdoptionSweeper(deps)

    let report = await sweeper.sweep({ locationId: LOCATION })
    expect(report.bounded).toBe(true)
    expect(adopted.map((call) => call.hourStartMs)).toEqual([DAY + 8 * HOUR_MS])

    report = await sweeper.sweep({ locationId: LOCATION })
    expect(adopted.map((call) => call.hourStartMs)).toEqual([DAY + 8 * HOUR_MS, DAY + 9 * HOUR_MS])

    // Drain what is left of the tree one bounded pass at a time.
    for (let i = 0; i < 5 && report.bounded; i += 1) {
      report = await sweeper.sweep({ locationId: LOCATION })
    }
    expect(report.bounded).toBe(false)

    // Exhausted ⇒ the next pass starts over, rather than sitting forever on a
    // cursor past the end of an archive that keeps growing at its head.
    await sweeper.sweep({ locationId: LOCATION })
    expect(adopted.map((call) => call.hourStartMs)).toEqual([
      DAY + 8 * HOUR_MS,
      DAY + 9 * HOUR_MS,
      DAY + 8 * HOUR_MS,
    ])
  })

  it('pauses between batches of hour listings', async () => {
    const entries = oneDay()
    const hours: string[] = []
    for (let h = 0; h < 12; h += 1) {
      const name = String(h).padStart(2, '0')
      hours.push(name)
      entries[hourDir(h)] = files(1, h)
    }
    entries[`${ROOT}/${DEVICE.toString()}/low/2026/09/17`] = hours
    const { deps, paced } = harness(tree(entries))

    await new HourAdoptionSweeper(deps).sweep({ locationId: LOCATION })
    // 12 hour listings, a pause every WALK_HOUR_BATCH (8) of them.
    expect(paced.count).toBeGreaterThan(0)
  })

  it('a listing that FAILS decides nothing and the pass goes on', async () => {
    const entries = oneDay()
    const { deps, adopted } = harness(async (dir) => {
      if (dir === hourDir(8)) throw new Error('EIO')
      return entries[dir] ?? null
    })
    const report = await new HourAdoptionSweeper(deps).sweep({ locationId: LOCATION })

    expect(report.listingErrors).toBe(1)
    expect(adopted.map((call) => call.hourStartMs)).toEqual([DAY + 9 * HOUR_MS])
  })
})
