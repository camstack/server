/**
 * A window hydrate LISTS the hour directory. Always. (D523)
 *
 * This file used to be `hydrate-window-ledger-incomplete.spec.ts` and it pinned
 * the opposite trade: a CLOSED hour whose durable row was SEALED was served
 * from that row's `paths` column and the array was never touched. The first
 * case in it was titled "a SEALED short row is still short when nobody asks to
 * verify — the trade, pinned", and it passed on ten files with two known.
 *
 * That trade cost camera 101 two hours of timeline on 2026-09-17 with all 355
 * and 358 files present on the disk, and camera 4374 10,246 of the 10,734 `low`
 * segments of the night of 2026-09-10→11. The chain is always the same: the row
 * is written write-behind per FINALIZED segment, a writer torn down mid-hour
 * leaves segments no row mentions, the rollover seals the short row,
 * `hydrateHour` seeds the index from it, `hourSegmentsFromIndex` returns
 * non-null — which means COMPLETE — and nothing readdirs that hour again for
 * the life of the footage.
 *
 * D521 gated the seal. D523 removes the possibility: the column is gone, so the
 * walk has nothing to be served from, and **a directory cannot be SHORT about
 * itself**. Each case here runs the real walk over a real directory against a
 * stub ledger that records what the walk asked it to write.
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
import { hourAggregate, type WalkedHourOutcome } from '../segment-hour-ledger.js'

const HOUR_MS = 3_600_000
const HOUR0 = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS
const DEVICE = 4374
const LOCATION = 'recordingsLow:ssd'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

/** One captured log line, flattened to the two fields these cases assert on. */
interface CapturedLine {
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

function capturingLogger(sink: CapturedLine[]): IScopedLogger {
  const take = (message: string, extras?: unknown): void => {
    const e = extras as
      | { meta?: Record<string, unknown>; tags?: Record<string, unknown> }
      | undefined
    sink.push({ message, meta: e?.meta ?? {}, tags: e?.tags ?? {} })
  }
  return {
    debug: () => {},
    info: take,
    warn: take,
    error: () => {},
  } as unknown as IScopedLogger
}

const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hydrate-lists-spec-'))
  tmpDirs.push(root)
  return root
}

function locations(root: string): readonly RecordingsLocation[] {
  return [recordingsLocationOfMode({ id: LOCATION, type: 'recordingsLow', root }, 'active')]
}

/** Write `count` finalized segments of an hour to disk AND return their paths. */
async function writeHour(root: string, hour: number, count: number): Promise<readonly string[]> {
  const paths: string[] = []
  for (let i = 0; i < count; i += 1) {
    const rel = segmentRelPath(DEVICE, 'low', hour + i * 10_000, 10_000, 1_000 + i)
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, new Uint8Array(4))
    paths.push(rel)
  }
  return paths
}

/** One row as the stub holds it — an ACCOUNT, not a path list (D523). */
interface StubRow {
  readonly segments: number
  readonly bytes: number
  readonly sealed: boolean
}

/** What the walk asked the ledger to write, per call. */
interface AdoptCall {
  readonly hourStartMs: number
  readonly paths: readonly string[]
  readonly outcome: WalkedHourOutcome
}

interface StubLedger extends HourAdoptionSink {
  readonly adopted: AdoptCall[]
  /** The rows as the walk left them. */
  readonly rows: Map<number, StubRow>
}

/**
 * A ledger that accounts for exactly the hours it was given, and applies the
 * real D523 rule when the walk hands it a closed hour's listing: the listing
 * REPLACES the account and seals it.
 */
function stubLedger(known: ReadonlyMap<number, StubRow>): StubLedger {
  const adopted: AdoptCall[] = []
  const rows = new Map(known)
  return {
    adopted,
    rows,
    adoptWalkedHour: async (_deviceId, _profile, _locationId, hour, paths) => {
      const held = rows.get(hour)
      const walked = hourAggregate(paths)
      const outcome: WalkedHourOutcome = {
        created: held === undefined,
        added: Math.max(0, walked.segments - (held?.segments ?? 0)),
        sealedNow: held === undefined || !held.sealed,
      }
      rows.set(hour, { segments: walked.segments, bytes: walked.bytes, sealed: true })
      adopted.push({ hourStartMs: hour, paths, outcome })
      return outcome
    },
  }
}

const account = (paths: readonly string[], sealed: boolean): StubRow => {
  const agg = hourAggregate(paths)
  return { segments: agg.segments, bytes: agg.bytes, sealed }
}

describe('a closed hour whose durable row is SHORT', () => {
  it('a SEALED short row no longer hides its hour — the walk lists the directory', async () => {
    const root = await makeRoot()
    const onDisk = await writeHour(root, HOUR0, 10)
    // The exact shape of the 2026-09-17 defect: a row a respawned writer sealed
    // after persisting a fraction of the hour. Under the `paths` column this
    // returned 2 and the array was never touched again.
    const ledger = stubLedger(new Map([[HOUR0, account(onDisk.slice(0, 2), true)]]))

    const index = new RecordingIndex()
    await hydrateWindowFromStorage(
      index,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      noopLogger,
      ledger,
    )

    expect(index.segments(DEVICE)).toHaveLength(10)
    // …and the account is repaired to what the directory holds, so the storage
    // page stops under-reporting this camera too.
    expect(ledger.rows.get(HOUR0)).toEqual({
      segments: 10,
      bytes: hourAggregate(onDisk).bytes,
      sealed: true,
    })
    expect(ledger.adopted.map((a) => a.paths)).toEqual([onDisk])
  })

  it('an UNSEALED short row is read from the array too — the seal gates nothing here', async () => {
    const root = await makeRoot()
    const onDisk = await writeHour(root, HOUR0, 10)
    const ledger = stubLedger(new Map([[HOUR0, account(onDisk.slice(0, 2), false)]]))

    const index = new RecordingIndex()
    await hydrateWindowFromStorage(
      index,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      noopLogger,
      ledger,
    )

    expect(index.segments(DEVICE)).toHaveLength(10)
    expect(ledger.adopted[0]?.outcome).toEqual({ created: false, added: 8, sealedNow: true })
  })

  it('a FRESH process lists the hour again — a sealed row buys nothing at rest', async () => {
    const root = await makeRoot()
    const onDisk = await writeHour(root, HOUR0, 6)
    const ledger = stubLedger(new Map([[HOUR0, account(onDisk, true)]]))

    const first = new RecordingIndex()
    await hydrateWindowFromStorage(
      first,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      noopLogger,
      ledger,
    )
    expect(first.segments(DEVICE)).toHaveLength(6)

    // A fresh process, the index knowing nothing, and the root GONE. Under the
    // old trade this came back with six segments out of the sealed row. It must
    // come back empty now: nothing is served from the ledger, ever.
    const second = new RecordingIndex()
    await hydrateWindowFromStorage(
      second,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations('/nonexistent-root-sealed-hour'),
      noopLogger,
      ledger,
    )
    expect(second.segments(DEVICE)).toHaveLength(0)
  })

  it('a closed hour already walked IN THIS PROCESS is not listed twice', async () => {
    const root = await makeRoot()
    await writeHour(root, HOUR0, 6)
    const ledger = stubLedger(new Map())

    const index = new RecordingIndex()
    await hydrateWindowFromStorage(
      index,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      noopLogger,
      ledger,
    )
    expect(ledger.adopted).toHaveLength(1)

    // The skip that makes the always-list affordable: it rests on THIS process
    // having listed the directory, never on a durable row's claim about it.
    await hydrateWindowFromStorage(
      index,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      noopLogger,
      ledger,
    )
    expect(ledger.adopted).toHaveLength(1)
    expect(index.segments(DEVICE)).toHaveLength(6)
  })

  it('a VERIFYING caller lists an hour this process already walked', async () => {
    const root = await makeRoot()
    const onDisk = await writeHour(root, HOUR0, 6)
    const ledger = stubLedger(new Map())

    const index = new RecordingIndex()
    const walk = (verify: boolean): Promise<void> =>
      hydrateWindowFromStorage(
        index,
        DEVICE,
        HOUR0,
        HOUR0 + HOUR_MS,
        locations(root),
        noopLogger,
        ledger,
        { verifyClosedHours: verify },
      )
    await walk(false)
    await writeHour(root, HOUR0, 9)
    await walk(true)

    expect(index.segments(DEVICE)).toHaveLength(9)
    expect(ledger.adopted).toHaveLength(2)
    expect(ledger.adopted[1]?.paths).toHaveLength(9)
    expect(onDisk).toHaveLength(6)
  })

  it('names how many segments the account had forgotten, per camera', async () => {
    const root = await makeRoot()
    const onDisk = await writeHour(root, HOUR0, 10)
    const ledger = stubLedger(new Map([[HOUR0, account(onDisk.slice(0, 2), true)]]))

    const lines: CapturedLine[] = []
    await hydrateWindowFromStorage(
      new RecordingIndex(),
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      capturingLogger(lines),
      ledger,
    )

    // Silence would read as "the account was right". Eight segments of this
    // camera's night were unaccounted for; this line is the only thing that
    // says so.
    const line = lines.find((l) => typeof l.meta['forgottenSegments'] === 'number')
    expect(line?.meta['forgottenSegments']).toBe(8)
    expect(line?.meta['forgottenHours']).toBe(1)
    // The row was ALREADY sealed — that is the defect shape — so this walk
    // sealed nothing and the loss is still named. A seal has stopped being a
    // reason not to look.
    expect(line?.meta['sealed']).toBe(0)
    // Always the numeric id, always the same key — a gap is asked per-camera.
    expect(line?.tags['deviceId']).toBe(DEVICE)
  })

  it('leaves a row that already agrees alone: no line claiming a loss', async () => {
    const root = await makeRoot()
    const onDisk = await writeHour(root, HOUR0, 6)
    const ledger = stubLedger(new Map([[HOUR0, account(onDisk, true)]]))

    const lines: CapturedLine[] = []
    const index = new RecordingIndex()
    await hydrateWindowFromStorage(
      index,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      locations(root),
      capturingLogger(lines),
      ledger,
      { verifyClosedHours: true },
    )

    expect(index.segments(DEVICE)).toHaveLength(6)
    expect(ledger.adopted.map((a) => a.outcome)).toEqual([
      { created: false, added: 0, sealedNow: false },
    ])
    expect(lines.find((l) => (l.meta['forgottenSegments'] ?? 0) !== 0)).toBeUndefined()
  })

  it('never writes the durable row for the LIVE hour, sealed or not', async () => {
    const root = await makeRoot()
    const liveHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
    const onDisk = await writeHour(root, liveHour, 5)
    const ledger = stubLedger(new Map([[liveHour, account(onDisk.slice(0, 1), false)]]))

    const index = new RecordingIndex()
    await hydrateWindowFromStorage(
      index,
      DEVICE,
      liveHour,
      liveHour + HOUR_MS,
      locations(root),
      noopLogger,
      ledger,
      { verifyClosedHours: true },
    )

    // The disk still wins for the live hour — that was already true — but a row
    // written from a directory racing its own writer would be a lower bound
    // persisted as a fact.
    expect(index.segments(DEVICE)).toHaveLength(5)
    expect(ledger.adopted).toEqual([])
  })
})
