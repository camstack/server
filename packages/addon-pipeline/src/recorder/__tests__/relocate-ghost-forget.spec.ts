/**
 * A row whose file the mover CONFIRMED absent is forgotten DURABLY — under a
 * bound, and reported.
 *
 * The production drain of `recordingsLow:default → recordingsLow:ssd`
 * (2026-08-30) finished with `archiveSegments=63346 seen=63346 moved=52272`
 * and logged exactly 11 074 `relocate skipped missing source` warnings — the
 * shortfall to the file. Nothing was skipped silently, so the mover was not at
 * fault: the durable ledger claimed 11 074 segments and 5.65 GB that are not on
 * disk. `moveHour`'s ENOENT branch removed each row from `RecordingIndex` —
 * RAM — and told the ledger nothing, so `storageMigration.residue` kept
 * reporting them, they survived every restart, and the next drain would walk to
 * each of them, fail again, and log 11 074 more warnings. Forever.
 *
 * D148 is the reason this is not a plain delete. The ledger forgets only on a
 * trusted walk or an eviction, precisely so a transient read error cannot erase
 * an operator's index of real footage. Three things make the mover's
 * observation trustworthy enough to act on, and each is pinned below:
 *
 *  - it is PER PATH: a path the mover opened and was told is not there (D296),
 *    never an hour directory that came back short;
 *  - it goes through `SegmentHourLedger.dropSegments`, the SAME durable forget
 *    eviction uses — since D523 that is pure arithmetic on the hour's account,
 *    so what makes it safe is entirely the evidence the caller brings;
 *  - it is BOUNDED per job and counted on the job record, so one bad mount
 *    cannot empty the archive quietly: past the bound the mover keeps moving,
 *    keeps skipping, and REPORTS a reconcile the operator can act on.
 *
 * What CHANGED with D523 is how a ghost reaches the mover at all. The work list
 * used to be the durable `paths` column, so a row for a file that had not
 * existed for weeks was handed straight to `copyVerified`; it is a LISTING of
 * the hour directory now, so a long-dead file is simply not in it. The branch
 * survives for the two ways a listed path can still be missing when the copy
 * reaches it — the file went between the listing and the copy (eviction, a
 * writer's cleanup, an unmount), and the RAM-index fallback on a node with no
 * ledger at all — and the fixture below is the first of those: a listing taken
 * a moment before the files went.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type RecordingsLocation, recordingsLocationOfMode } from '../addon/roots.js'
import { type HourLister, SegmentHourLedger } from '../addon/segment-hour-ledger.js'
import { RecordingIndex } from '../recording-index.js'
import { RelocateEngine, type RelocateHourLedger } from '../relocate-engine.js'
import { segmentRelPath } from '../segment-path.js'
import type { SegmentRow } from '../types.js'

const HOUR_MS = 3_600_000
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS
const DEVICE = 102

interface LogLine {
  readonly message: string
  readonly deviceId: number | undefined
  readonly meta: Record<string, unknown>
}

interface LogCapture {
  readonly logger: IScopedLogger
  readonly warns: LogLine[]
}

function capturingLogger(): LogCapture {
  const warns: LogLine[] = []
  const noop = (): void => {}
  const record = (message: string, extras?: unknown): void => {
    const e = (extras ?? {}) as {
      tags?: { deviceId?: number }
      meta?: Record<string, unknown>
    }
    warns.push({ message, deviceId: e.tags?.deviceId, meta: e.meta ?? {} })
  }
  const logger = {
    debug: noop,
    info: noop,
    warn: record,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return { logger, warns }
}

/** The same in-memory settings store the hour-ledger suite uses. */
function fakeStore(): SettingsStoreClient {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const ensure = (collection: string): Map<string, Record<string, unknown>> => {
    let m = tables.get(collection)
    if (!m) {
      m = new Map()
      tables.set(collection, m)
    }
    return m
  }
  return {
    declareCollection: {
      mutate: async (input: { collection: string }): Promise<void> => {
        ensure(input.collection)
      },
    },
    set: {
      mutate: async (input: { collection: string; key: string; value: unknown }): Promise<void> => {
        ensure(input.collection).set(input.key, input.value as Record<string, unknown>)
      },
    },
    delete: {
      mutate: async (input: { collection: string; key: string }): Promise<void> => {
        tables.get(input.collection)?.delete(input.key)
      },
    },
    query: {
      query: async (input: {
        collection: string
      }): Promise<readonly { id: string; data: Record<string, unknown> }[]> =>
        [...(tables.get(input.collection)?.entries() ?? [])].map(([id, data]) => ({ id, data })),
    },
    // The census MUST be real here. `filesTotal` is the M the job reports
    // against AND the denominator of the ghost-forget budget, so a fake that
    // could not aggregate would make every test below pass for the wrong
    // reason: budget 0, nothing forgotten, "no ledger" and "budget spent"
    // indistinguishable from each other.
    aggregate: {
      query: async (input: {
        collection: string
        fields: readonly { as: string; field: string; op: string }[]
        filter?: { where?: Record<string, unknown> }
      }): Promise<{ count: number; values: Record<string, number> }> => {
        const where = input.filter?.where ?? {}
        const rows = [...(tables.get(input.collection)?.values() ?? [])].filter((data) =>
          Object.entries(where).every(([k, v]) => data[k] === v),
        )
        const values: Record<string, number> = {}
        for (const f of input.fields) {
          const nums = rows.map((r) => r[f.field]).filter((n) => typeof n === 'number')
          if (nums.length === 0) continue
          values[f.as] =
            f.op === 'sum'
              ? nums.reduce((a, b) => a + b, 0)
              : f.op === 'min'
                ? Math.min(...nums)
                : Math.max(...nums)
        }
        return { count: rows.length, values }
      },
    },
  } as unknown as SettingsStoreClient
}

interface Roots {
  readonly from: RecordingsLocation
  readonly to: RecordingsLocation
}

function makeRoots(): Roots {
  return {
    from: recordingsLocationOfMode(
      {
        id: 'recordingsLow:default',
        type: 'recordings',
        root: mkdtempSync(path.join(tmpdir(), 'ghost-from-')),
      },
      'active',
    ),
    to: recordingsLocationOfMode(
      {
        id: 'recordingsLow:ssd',
        type: 'recordings',
        root: mkdtempSync(path.join(tmpdir(), 'ghost-to-')),
      },
      'active',
    ),
  }
}

/** Write `count` 10 s segments of one hour to `root`, and return their rows. */
function seedHour(root: string, locationId: string, hour: number, count: number): SegmentRow[] {
  const rows: SegmentRow[] = []
  for (let i = 0; i < count; i++) {
    const startMs = hour + i * 10_000
    const bytes = 100 + i
    const rel = segmentRelPath(DEVICE, 'low', startMs, 10_000, bytes)
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, Buffer.alloc(bytes, 7))
    rows.push({
      deviceId: DEVICE,
      profile: 'low',
      startMs,
      durMs: 10_000,
      bytes,
      path: rel,
      locationId,
    })
  }
  return rows
}

interface Drained {
  readonly state: string
  readonly rowsForgotten: number | undefined
}

async function runDrain(
  roots: Roots,
  index: RecordingIndex,
  ledger: RelocateHourLedger | null,
  logger: IScopedLogger,
  ghostForgetBudget?: number,
): Promise<Drained> {
  const engine = new RelocateEngine({
    index,
    locations: () => [roots.from, roots.to],
    ledger: () => ledger,
    logger,
    now: () => Date.now(),
    newId: () => 'job-1',
    sleep: async () => {},
    freePercentOf: async () => 100,
    ...(ghostForgetBudget !== undefined ? { ghostForgetBudget } : {}),
  })
  const jobId = engine.start({ fromLocationId: roots.from.id, toLocationId: roots.to.id })
  for (let i = 0; i < 400; i++) {
    const job = engine.list().find((j) => j.jobId === jobId)
    if (job && job.state !== 'running' && job.state !== 'queued')
      return { state: job.state, rowsForgotten: job.rowsForgotten }
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('drain never finished')
}

/**
 * What the DURABLE table holds for the hour after a cold restart: segments per
 * location, and nothing about WHICH files they are.
 *
 * That is the whole of D523 in one helper. A forgotten ghost is no longer "a
 * path that is missing from a list" — it is one segment that stopped being
 * charged to the source hour — and every assertion below is written in those
 * terms, against a count a `residue` report and the next drain both read.
 */
async function durableSegments(store: SettingsStoreClient): Promise<Map<string, number>> {
  const restarted = new SegmentHourLedger({ store, logger: capturingLogger().logger })
  await restarted.declare()
  await restarted.load()
  const out = new Map<string, number>()
  for (const row of restarted.snapshot()) {
    if (row.deviceId !== DEVICE || row.hourStartMs !== HOUR0) continue
    out.set(row.locationId, (out.get(row.locationId) ?? 0) + row.segments)
  }
  return out
}

interface Seeded {
  readonly roots: Roots
  readonly index: RecordingIndex
  readonly store: SettingsStoreClient
  readonly ledger: SegmentHourLedger
  readonly rows: readonly SegmentRow[]
  readonly ghosts: readonly SegmentRow[]
}

/**
 * An hour of `count` segments in the ledger and the index, of which the LAST
 * `ghosts` have no file on disk — the production shape: the ledger is fuller
 * than the disk, not the other way round.
 */
async function seedGhostedHour(count: number, ghosts: number): Promise<Seeded> {
  const roots = makeRoots()
  const rows = seedHour(roots.from.root, roots.from.id, HOUR0, count)
  const index = new RecordingIndex()
  index.hydrateDevice(
    DEVICE,
    roots.from.id,
    rows.map((r) => r.path),
  )
  const store = fakeStore()
  // The listing the drain works from — taken while every file was still there.
  // The files go a moment later, which is the race the ENOENT branch exists
  // for now that the work list comes from the directory (D523): eviction, a
  // writer's cleanup or a mount that drops out between the readdir and the
  // copy. A lister that re-read the disk would hand the mover only the
  // survivors and this whole suite would pass by never reaching the branch.
  const listedWhole: HourLister = async (locationId, _deviceId, _profile, hour) =>
    locationId === roots.from.id && hour === HOUR0 ? rows.map((r) => r.path) : []
  const ledger = new SegmentHourLedger({
    store,
    logger: capturingLogger().logger,
    listHour: listedWhole,
  })
  await ledger.declare()
  for (const row of rows) await ledger.recordSegment(row)
  const missing = rows.slice(count - ghosts)
  for (const row of missing) rmSync(path.join(roots.from.root, row.path))
  return { roots, index, store, ledger, rows, ghosts: missing }
}

describe('a source file the mover confirmed absent is forgotten DURABLY', () => {
  it('drops the ghost row from the ledger, so the residue and the next drain stop seeing it', async () => {
    const { roots, index, store, ledger, rows } = await seedGhostedHour(4, 1)
    const { logger, warns } = capturingLogger()

    const drained = await runDrain(roots, index, ledger, logger)
    expect(drained.state).toBe('done')

    const durable = await durableSegments(store)
    // The source hour stops being charged for ANY of its four segments: three
    // went with the bytes, and the ghost was subtracted rather than carried.
    // This is the assertion the old RAM-only branch fails — it would leave one
    // segment charged here forever, which is what `storageMigration.residue`
    // reads and what the next drain would walk to and fail on again.
    expect(durable.get(roots.from.id) ?? 0).toBe(0)
    expect(durable.get(roots.to.id)).toBe(3)
    // …and every file that was really there is at the destination.
    for (const row of rows.slice(0, 3))
      expect(existsSync(path.join(roots.to.root, row.path))).toBe(true)
    // The census the next drain reads no longer counts the ghost.
    const census = await ledger.census({ locationId: roots.from.id })
    expect(census?.segments ?? 0).toBe(0)

    // Still logged per file, still `tags: { deviceId }` — a branch that drops
    // work says so, and that is the only reason this was diagnosable at all.
    const skipped = warns.filter((w) => w.message === 'relocate skipped missing source')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.deviceId).toBe(DEVICE)
    expect(skipped[0]!.meta['forgotten']).toBe(true)
  })

  it('counts the forgets on the JOB, because a mover that rewrites durable rows may not do it quietly', async () => {
    const { roots, index, ledger } = await seedGhostedHour(4, 2)
    const { logger } = capturingLogger()

    const drained = await runDrain(roots, index, ledger, logger)

    expect(drained.state).toBe('done')
    expect(drained.rowsForgotten).toBe(2)
  })

  it('a node with NO durable ledger forgets nothing and never claims it did', async () => {
    const { roots, index, store, rows } = await seedGhostedHour(4, 1)
    const { logger, warns } = capturingLogger()

    const drained = await runDrain(roots, index, null, logger)

    expect(drained.state).toBe('done')
    expect(drained.rowsForgotten).toBe(0)
    // The account the seed wrote is untouched, ghost included: a RAM-only
    // mover changes nothing durable, and a node that cannot read the table is
    // exactly the node that must not rewrite it.
    expect((await durableSegments(store)).get(roots.from.id)).toBe(rows.length)
    const skipped = warns.filter((w) => w.message === 'relocate skipped missing source')
    expect(skipped[0]!.meta['forgotten']).toBe(false)
  })

  it('a budget an operator SET does not license a RAM-only mover to forget', async () => {
    // Without this the `ledger === null` arm is unreachable in the default
    // configuration — a job with no archive already has no census and so no
    // budget — and an explicit budget would walk straight past it, claiming
    // forgets nobody performed.
    const { roots, index, store, rows } = await seedGhostedHour(4, 2)
    const { logger, warns } = capturingLogger()

    const drained = await runDrain(roots, index, null, logger, 100)

    expect(drained.rowsForgotten).toBe(0)
    // Both ghosts are still charged to the source — the budget bought the
    // RAM-only mover nothing.
    expect((await durableSegments(store)).get(roots.from.id)).toBe(rows.length)
    for (const skipped of warns.filter((w) => w.message === 'relocate skipped missing source'))
      expect(skipped.meta['forgotten']).toBe(false)
  })

  it('BOUNDS the forgets: past the budget it stops erasing and reports a reconcile instead', async () => {
    // D148's whole point. A mount that answers ENOENT for everything looks
    // exactly like a location that is genuinely empty, and the difference is
    // the entire archive. The bound is what makes the difference survivable.
    const { roots, index, store, ledger } = await seedGhostedHour(4, 3)
    const { logger, warns } = capturingLogger()

    const drained = await runDrain(roots, index, ledger, logger, 1)

    expect(drained.state).toBe('done')
    expect(drained.rowsForgotten).toBe(1)
    // One file moved and one ghost was forgotten, so the source is still
    // charged for the two ghosts the bound refused to erase. That number is
    // the operator's reconcile backlog: it says the table is still wrong.
    const durable = await durableSegments(store)
    expect(durable.get(roots.from.id)).toBe(2)
    expect(durable.get(roots.to.id)).toBe(1)
    // And it SHOUTS, once, with the counts — a silent stop is the same failure
    // as a silent erase.
    const refusal = warns.filter(
      (w) => w.message === 'relocate: ghost-row forget BUDGET reached — the durable rows are KEPT',
    )
    expect(refusal).toHaveLength(1)
    expect(refusal[0]!.meta['budget']).toBe(1)
    expect(refusal[0]!.meta['stillMissing']).toBe(2)
  })
})
