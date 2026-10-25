/**
 * `hydrateWindowFromStorage` reads every hour of the window from the ARRAY, and
 * asks the durable ledger nothing at all (D523).
 *
 * This file was `hydrate-window-ledger-first.spec.ts` and it pinned the
 * opposite: "a window the ledger covers touches the array ZERO times", and "the
 * live hour is the ONLY hour directory the walk reads". Both were true, both
 * were paid for with the `paths` column, and the column is what made a row
 * short by a torn-down writer's segments into an hour the index believed
 * complete forever (camera 101, 2026-09-17; camera 4374, 2026-09-10→11). The
 * column is gone; the walk is the only thing left that can say what an hour
 * holds, and a directory cannot be SHORT about itself.
 *
 * What is pinned here now:
 *
 *  - every hour of the window is read from the array, whether or not the ledger
 *    accounts for it, and whether or not anybody sealed it;
 *  - each hour is read ONCE PER PROCESS — that skip is what makes the always-
 *    read affordable, and it rests on this process having listed the directory
 *    itself, never on a durable row's claim about it;
 *  - the LIVE hour is read again whenever the walk runs, because it is the one
 *    hour whose directory can still grow;
 *  - the walk REPAIRS the durable account for the closed hours it read, and
 *    never writes on the live hour;
 *  - an `adoptWalkedHour` that answers `null` changes nothing for the reader
 *    (D49), and a walk with no ledger at all still fills the index.
 */
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { RecordingIndex } from '../../recording-index.js'
import { segmentRelPath } from '../../segment-path.js'
import {
  hydrateWindowFromStorage,
  type HourAdoptionSink,
  recordingsLocationOfMode,
} from '../roots.js'
import type { RecordingsLocation } from '../roots.js'

const HOUR_MS = 3_600_000
const HOUR0 = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS
const DEVICE = 102
const LOCATION = 'recordings:default'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hydrate-walks-spec-'))
  tmpDirs.push(root)
  return root
}

function locations(root: string): readonly RecordingsLocation[] {
  return [recordingsLocationOfMode({ id: LOCATION, type: 'recordings', root }, 'active')]
}

/** Write `count` finalized segments of an hour to disk AND return their paths. */
async function writeHour(root: string, hour: number, count: number): Promise<readonly string[]> {
  const paths: string[] = []
  for (let i = 0; i < count; i += 1) {
    const rel = segmentRelPath(DEVICE, 'high', hour + i * 10_000, 10_000, 1_000 + i)
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, new Uint8Array(4))
    paths.push(rel)
  }
  return paths
}

/** One hour the walk handed to the ledger. */
interface AdoptedHour {
  readonly locationId: string
  readonly hourStartMs: number
  readonly paths: readonly string[]
}

interface StubLedger extends HourAdoptionSink {
  readonly adopted: AdoptedHour[]
  /** Answer `null` to every adopt — "known, and nothing was written". */
  refuse: boolean
}

/** A ledger that records what the walk asked it to write, and can refuse. */
function stubLedger(): StubLedger {
  const adopted: AdoptedHour[] = []
  const stub: StubLedger = {
    adopted,
    refuse: false,
    adoptWalkedHour: async (_deviceId, _profile, locationId, hour, paths) => {
      if (stub.refuse) return null
      adopted.push({ locationId, hourStartMs: hour, paths })
      return { created: true, added: paths.length, sealedNow: true }
    },
  }
  return stub
}

/** Every `hoursRead` figure the walk reported, in order. */
function hoursReadLogger(sink: number[]): IScopedLogger {
  return {
    debug: () => {},
    info: (_message: string, extras?: unknown) => {
      const read = (extras as { meta?: { hoursRead?: number } } | undefined)?.meta?.hoursRead
      if (typeof read === 'number') sink.push(read)
    },
    warn: () => {},
    error: () => {},
  } as unknown as IScopedLogger
}

describe('every hour of the window is read from the array', () => {
  it('an hour the ledger accounts for and one it does not are indexed identically', async () => {
    const root = await makeRoot()
    await writeHour(root, HOUR0, 4)
    await writeHour(root, HOUR0 + HOUR_MS, 5)

    const index = new RecordingIndex()
    // The stub accounts for nothing and refuses nothing; the point is that
    // neither answer can change what the index ends up holding.
    await hydrateWindowFromStorage(
      index,
      DEVICE,
      HOUR0,
      HOUR0 + 2 * HOUR_MS,
      locations(root),
      noopLogger,
      stubLedger(),
    )

    expect(index.segments(DEVICE)).toHaveLength(9)
    expect(index.hydrationOf(DEVICE, HOUR0, HOUR0 + 2 * HOUR_MS)).toBe('hydrated')
  })

  it('a ledger that refuses every write leaves the index exactly as complete as no ledger at all', async () => {
    const root = await makeRoot()
    await writeHour(root, HOUR0, 7)

    const withoutLedger = new RecordingIndex()
    await hydrateWindowFromStorage(
      withoutLedger,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      noopLogger,
    )

    const withRefusingLedger = new RecordingIndex()
    const ledger = stubLedger()
    ledger.refuse = true
    await hydrateWindowFromStorage(
      withRefusingLedger,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      noopLogger,
      ledger,
    )

    // D49: a durable write that did not land changes nothing about what the
    // reader can see. The array already answered.
    expect(withRefusingLedger.segments(DEVICE)).toEqual(withoutLedger.segments(DEVICE))
    expect(withRefusingLedger.hydrationOf(DEVICE, HOUR0, HOUR0 + HOUR_MS)).toBe('hydrated')
  })

  it('reads each hour once per process, and the LIVE one again — the cost shape of D523', async () => {
    // The pin this replaces said "the live hour is the ONLY hour directory the
    // walk reads", which was the `paths` column doing the reading instead. The
    // whole window is read now. What keeps that affordable is the second walk:
    // the hours this process already listed are skipped, and only the hour that
    // can still GROW is read again.
    //
    // (A second walk of the IDENTICAL span costs nothing at all — the whole
    // call returns on `hydrationOf(...) === 'hydrated'` before any of this. So
    // the window has to move for the live hour to be re-read, which is what a
    // scrub cursor and a timeline both do. That top gate predates D523 and is
    // untouched by it.)
    const root = await makeRoot()
    const liveHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
    for (let h = 1; h <= 6; h += 1) await writeHour(root, liveHour - h * HOUR_MS, 4)
    await writeHour(root, liveHour, 2)

    const hoursRead: number[] = []
    const index = new RecordingIndex()
    const walk = (fromHours: number): Promise<void> =>
      hydrateWindowFromStorage(
        index,
        DEVICE,
        liveHour - fromHours * HOUR_MS,
        liveHour + HOUR_MS,
        locations(root),
        hoursReadLogger(hoursRead),
        stubLedger(),
      )

    await walk(6)
    expect(index.segments(DEVICE)).toHaveLength(26)

    // One more closed hour of history, and the tail a crashed writer left in
    // the live hour — the exact thing the live-hour re-read exists to recover.
    await writeHour(root, liveHour - 7 * HOUR_MS, 3)
    await writeHour(root, liveHour, 5)
    await walk(7)

    // Seven directories the first time; the second time only the hour that was
    // never listed and the hour that can still grow — not eight.
    expect(hoursRead).toEqual([7, 2])
    expect(index.segments(DEVICE)).toHaveLength(24 + 3 + 5)
  })
})

describe('the walk repairs the durable account it just rebuilt', () => {
  it('adopts a CLOSED hour with exactly what the directory holds', async () => {
    const root = await makeRoot()
    const paths = await writeHour(root, HOUR0, 6)
    const ledger = stubLedger()

    await hydrateWindowFromStorage(
      new RecordingIndex(),
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      noopLogger,
      ledger,
    )

    expect(ledger.adopted).toHaveLength(1)
    expect(ledger.adopted[0]?.hourStartMs).toBe(HOUR0)
    expect(ledger.adopted[0]?.paths).toEqual(paths)
  })

  it('never writes on the LIVE hour — a listing of it races its own writer', async () => {
    const root = await makeRoot()
    const liveHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
    await writeHour(root, liveHour, 3)
    const ledger = stubLedger()

    await hydrateWindowFromStorage(
      new RecordingIndex(),
      DEVICE,
      liveHour,
      liveHour + HOUR_MS,
      locations(root),
      noopLogger,
      ledger,
    )

    expect(ledger.adopted).toEqual([])
  })

  it('adopts nothing when there is no ledger to repair, and still fills the index', async () => {
    const root = await makeRoot()
    await writeHour(root, HOUR0, 2)
    const index = new RecordingIndex()
    await hydrateWindowFromStorage(
      index,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      noopLogger,
    )
    expect(index.segments(DEVICE)).toHaveLength(2)
  })
})
