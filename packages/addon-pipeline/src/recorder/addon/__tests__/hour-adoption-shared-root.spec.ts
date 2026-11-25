/**
 * planning#721 — the stock `recordings` and `recordingsLow` locations share ONE
 * physical root: `high` / `mid` belong to `recordings`, `low` to
 * `recordingsLow`. The adoption sweep runs once per location id and used to
 * walk every profile tree under the location's root, so the `recordingsLow`
 * pass adopted every closed `high` hour a second time under ITS id — 174
 * misfiled hours in a week on a camera that records `high` only, each one a
 * second durable row for footage `recordings:default` already accounts for.
 *
 * A pass adopts only the profile trees its location OWNS on that root, by the
 * same rule a hydrate attributes them (`locationForHydratedProfile`).
 */
import { describe, expect, it } from 'vitest'
import {
  HourAdoptionSweeper,
  type AdoptedHourCall,
  type HourAdoptionSweepDeps,
} from '../hour-adoption-sweep.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../roots.js'

const HOUR_MS = 3_600_000
const DAY = Date.UTC(2026, 10, 24)
const NOW = DAY + 30 * HOUR_MS
const DEVICE = 7
const ROOT = '/recordings/recordings'

const HIGH: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: ROOT },
  'active',
)
const LOW: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordingsLow:default', type: 'recordingsLow', root: ROOT },
  'active',
)

function sharedRootTree(): Record<string, readonly string[]> {
  const cam = `${ROOT}/${String(DEVICE)}`
  const entries: Record<string, readonly string[]> = {
    [ROOT]: [String(DEVICE)],
    [cam]: ['high', 'low', 'events'],
  }
  for (const profile of ['high', 'low']) {
    entries[`${cam}/${profile}`] = ['2026']
    entries[`${cam}/${profile}/2026`] = ['11']
    entries[`${cam}/${profile}/2026/11`] = ['24']
    entries[`${cam}/${profile}/2026/11/24`] = ['08']
    entries[`${cam}/${profile}/2026/11/24/08`] = [
      `${String(DAY + 8 * HOUR_MS)}-10000-120000.m4s`,
      `${String(DAY + 8 * HOUR_MS + 10_000)}-10000-120000.m4s`,
    ]
  }
  return entries
}

interface Harness {
  readonly sweeper: HourAdoptionSweeper
  readonly adopted: AdoptedHourCall[]
}

function harness(locations: readonly RecordingsLocation[]): Harness {
  const adopted: AdoptedHourCall[] = []
  const tree = sharedRootTree()
  const quiet = (): void => undefined
  const deps: HourAdoptionSweepDeps = {
    ledger: () => ({
      adoptWalkedHour: async (deviceId, profile, locationId, hourStartMs, paths) => {
        adopted.push({ deviceId, profile, locationId, hourStartMs, paths })
        return { created: true, added: paths.length, sealedNow: true }
      },
    }),
    locations: () => locations,
    listDir: async (dir) => tree[dir] ?? null,
    logger: { info: quiet, warn: quiet, debug: quiet },
    now: () => NOW,
    pace: async () => undefined,
  }
  return { sweeper: new HourAdoptionSweeper(deps), adopted }
}

describe('hour adoption on a root two locations share', () => {
  it('the recordingsLow pass leaves the high tree to recordings', async () => {
    const { sweeper, adopted } = harness([HIGH, LOW])
    const report = await sweeper.sweep({ locationId: LOW.id })
    expect(adopted.map((call) => `${call.profile}@${call.locationId}`)).toEqual([
      'low@recordingsLow:default',
    ])
    expect(report.hoursAdopted).toBe(1)
  })

  it('the recordings pass leaves the low tree to recordingsLow', async () => {
    const { sweeper, adopted } = harness([HIGH, LOW])
    await sweeper.sweep({ locationId: HIGH.id })
    expect(adopted.map((call) => `${call.profile}@${call.locationId}`)).toEqual([
      'high@recordings:default',
    ])
  })

  it('both passes together adopt every hour exactly once', async () => {
    const { sweeper, adopted } = harness([HIGH, LOW])
    await sweeper.sweep({ locationId: HIGH.id })
    await sweeper.sweep({ locationId: LOW.id })
    expect(adopted.map((call) => `${call.profile}@${call.locationId}`).toSorted()).toEqual([
      'high@recordings:default',
      'low@recordingsLow:default',
    ])
  })

  it('a location alone on its root still adopts every profile tree under it', async () => {
    const { sweeper, adopted } = harness([LOW])
    await sweeper.sweep({ locationId: LOW.id })
    expect(adopted.map((call) => call.profile).toSorted()).toEqual(['high', 'low'])
  })

  it('an alias that cannot be read does not own a tree: the readable one adopts it', async () => {
    const disabledHigh = recordingsLocationOfMode(
      { id: HIGH.id, type: 'recordings', root: ROOT },
      'disabled',
    )
    const { sweeper, adopted } = harness([disabledHigh, LOW])
    await sweeper.sweep({ locationId: LOW.id })
    expect(adopted.map((call) => call.profile).toSorted()).toEqual(['high', 'low'])
  })
})
