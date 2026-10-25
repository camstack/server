/**
 * What a relocation VERIFIES against, and what it does when the row is wrong.
 *
 * `copyVerified` compared the destination it had just written against
 * `row.bytes` — a number that comes from the durable hour row, which derives it
 * from the segment's own FILENAME (`parseSegmentPath`). `fs.copyFile`
 * truncates and replaces, so the destination always equals the source: that
 * comparison can only ever fail when the RECORDED size disagrees with the file,
 * and it then reports a byte-perfect copy as corruption.
 *
 * It did, on 2026-08-30:
 *
 *     lane=footage state=failed files=12439/110749
 *     err=relocate verify failed:
 *       /media-fast/recordingsLow/108/low/2026/08/28/14/1787926410000-9966-274432.m4s
 *       is 783801B, expected 274432B
 *
 * Both files — source and destination — measured 783801 B on the hub. The copy
 * was faithful; the NAME understated the file by 509 369 B, and every one of
 * that hour's nineteen neighbours matched its own name exactly.
 *
 * Three things are pinned here, and they are three different defects:
 *
 *  1. the verify's reference is the SOURCE's own size, read from the
 *     filesystem — the only thing a copy can be faithful to;
 *  2. one such row does not kill a 110 749-file drain, and the drain does not
 *     re-fail on it forever (the copy was skipped only when the destination
 *     equalled the RECORDED size, so every restart re-copied and re-failed);
 *  3. the row is RECONCILED rather than carried over. The byte count lives in
 *     the filename, so the ledger's sums — which feed quota and pressure
 *     eviction through `StorageEvictableProvider` — understate the disk by
 *     exactly the difference until the name is corrected.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  hourDirRelPath,
  type RecordingsLocation,
  recordingsLocationOfMode,
} from '../addon/roots.js'
import { type HourLister, SegmentHourLedger } from '../addon/segment-hour-ledger.js'
import { RecordingIndex } from '../recording-index.js'
import { copyVerified, RelocateEngine } from '../relocate-engine.js'
import { parseSegmentPath, segmentRelPath } from '../segment-path.js'
import type { SegmentRow } from '../types.js'

const HOUR_MS = 3_600_000
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS
const DEVICE = 108

interface Line {
  readonly message: string
  readonly deviceId: number | undefined
  readonly meta: Record<string, unknown>
}

interface LogSpy {
  readonly logger: IScopedLogger
  readonly lines: Line[]
}

function capturingLogger(): LogSpy {
  const lines: Line[] = []
  const record = (message: string, extras?: unknown): void => {
    const bag = typeof extras === 'object' && extras !== null ? extras : {}
    const tags = 'tags' in bag ? bag.tags : undefined
    const meta = 'meta' in bag ? bag.meta : undefined
    lines.push({
      message,
      deviceId:
        typeof tags === 'object' && tags !== null && 'deviceId' in tags
          ? Number(tags.deviceId)
          : undefined,
      meta: typeof meta === 'object' && meta !== null ? { ...meta } : {},
    })
  }
  const logger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return { logger, lines }
}

interface StoreFilter {
  readonly where?: Record<string, unknown>
  readonly whereIn?: Record<string, readonly unknown[]>
  readonly whereBetween?: Record<string, readonly [unknown, unknown]>
  readonly orderBy?: { readonly field: string; readonly direction: 'asc' | 'desc' }
  readonly limit?: number
  readonly offset?: number
}

interface AggregateField {
  readonly as: string
  readonly field: string
  readonly op: 'sum' | 'min' | 'max'
}

interface StoreInput {
  readonly collection: string
  readonly key?: string
  readonly value?: Record<string, unknown>
  readonly filter?: StoreFilter
  readonly columns?: readonly string[]
  readonly fields?: readonly AggregateField[]
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function matches(data: Record<string, unknown>, id: string, filter?: StoreFilter): boolean {
  const valueOf = (field: string): unknown => (field === 'key' ? id : data[field])
  for (const [field, want] of Object.entries(filter?.where ?? {})) {
    if (valueOf(field) !== want) return false
  }
  for (const [field, wanted] of Object.entries(filter?.whereIn ?? {})) {
    if (!wanted.includes(valueOf(field))) return false
  }
  for (const [field, [lo, hi]] of Object.entries(filter?.whereBetween ?? {})) {
    const v = numberOf(valueOf(field))
    if (v === null) return false
    if (typeof lo === 'number' && v < lo) return false
    if (typeof hi === 'number' && v > hi) return false
  }
  return true
}

/**
 * A store that HONOURS every predicate the archive reads depend on — including
 * `aggregate`, because the SUM is the number `StorageEvictableProvider` asks
 * for when a disk fills, and a fixture that could not answer it would leave the
 * ledger-understates-the-disk claim untested.
 */
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
  const selected = (input: StoreInput): { id: string; data: Record<string, unknown> }[] => {
    let rows = [...ensure(input.collection).entries()]
      .filter(([id, data]) => matches(data, id, input.filter))
      .map(([id, data]) => ({ id, data }))
    const orderBy = input.filter?.orderBy
    if (orderBy) {
      const dir = orderBy.direction === 'desc' ? -1 : 1
      rows = rows.toSorted(
        (a, b) =>
          dir * ((numberOf(a.data[orderBy.field]) ?? 0) - (numberOf(b.data[orderBy.field]) ?? 0)),
      )
    }
    const offset = input.filter?.offset ?? 0
    const limit = input.filter?.limit
    rows = rows.slice(offset, limit === undefined ? undefined : offset + limit)
    const columns = input.columns
    if (columns === undefined) return rows
    return rows.map(({ id, data }) => {
      const projected: Record<string, unknown> = {}
      for (const c of columns) projected[c] = data[c]
      return { id, data: projected }
    })
  }
  return {
    declareCollection: {
      mutate: async (input: StoreInput): Promise<void> => {
        ensure(input.collection)
      },
    },
    set: {
      mutate: async (input: StoreInput): Promise<void> => {
        ensure(input.collection).set(input.key ?? '', input.value ?? {})
      },
    },
    delete: {
      mutate: async (input: StoreInput): Promise<void> => {
        ensure(input.collection).delete(input.key ?? '')
      },
    },
    query: { query: async (input: StoreInput) => selected(input) },
    aggregate: {
      query: async (input: StoreInput) => {
        const rows = selected({ ...input, filter: { ...input.filter, limit: undefined } })
        const values: Record<string, number | null> = {}
        for (const f of input.fields ?? []) {
          const nums = rows.map((r) => numberOf(r.data[f.field])).filter((n) => n !== null)
          if (nums.length === 0) {
            values[f.as] = null
            continue
          }
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
        type: 'recordingsLow',
        root: mkdtempSync(path.join(tmpdir(), 'truth-from-')),
      },
      'active',
    ),
    to: recordingsLocationOfMode(
      {
        id: 'recordingsLow:ssd',
        type: 'recordingsLow',
        root: mkdtempSync(path.join(tmpdir(), 'truth-to-')),
      },
      'active',
    ),
  }
}

/**
 * The ledger's only connection to the array (D523): a real directory read of
 * one hour bucket, location-relative, `[]` when the directory is not there.
 *
 * Not fixture decoration. The table stopped naming files, so `streamSegments`
 * probes it for the HOURS and then LISTS each of those directories for the
 * names — a ledger with no lister hands the mover an empty work list and every
 * drain below would pass by moving nothing.
 */
function listerOver(roots: Roots): HourLister {
  const rootsById = new Map<string, string>([
    [roots.from.id, roots.from.root],
    [roots.to.id, roots.to.root],
  ])
  return async (locationId, deviceId, profile, hour) => {
    const root = rootsById.get(locationId)
    if (root === undefined) return null
    const rel = hourDirRelPath(deviceId, profile, hour)
    try {
      return readdirSync(path.join(root, rel))
        .filter((name) => name.endsWith('.m4s'))
        .map((name) => `${rel}/${name}`)
    } catch {
      return []
    }
  }
}

/**
 * One hour of 10 s segments, where segment `oddOneOut` is written with
 * `actualBytes` on disk while its NAME (and therefore its ledger row) says
 * `recordedBytes` — the production shape exactly.
 */
function seedHour(
  root: string,
  locationId: string,
  count: number,
  oddOneOut: { readonly index: number; readonly actualBytes: number } | null,
): SegmentRow[] {
  const rows: SegmentRow[] = []
  for (let i = 0; i < count; i++) {
    const startMs = HOUR0 + i * 10_000
    const recordedBytes = 1_000 + i
    const rel = segmentRelPath(DEVICE, 'low', startMs, 9_966, recordedBytes)
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    const onDisk =
      oddOneOut !== null && oddOneOut.index === i ? oddOneOut.actualBytes : recordedBytes
    writeFileSync(abs, Buffer.alloc(onDisk, 7))
    rows.push({
      deviceId: DEVICE,
      profile: 'low',
      startMs,
      durMs: 9_966,
      bytes: recordedBytes,
      path: rel,
      locationId,
    })
  }
  return rows
}

/** Every file under `root`, relative and sorted — "what does this disk still
 *  hold", which is the only question that can see a source the mover forgot. */
function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else out.push(rel)
    }
  }
  walk(root, '')
  return out.sort()
}

interface Drained {
  readonly state: string
  readonly rowsReconciled: number | undefined
  readonly filesMoved: number
}

async function runDrain(
  roots: Roots,
  index: RecordingIndex,
  ledger: SegmentHourLedger,
  logger: IScopedLogger,
): Promise<Drained> {
  const engine = new RelocateEngine({
    index,
    locations: () => [roots.from, roots.to],
    ledger: () => ledger,
    logger,
    now: () => Date.now(),
    newId: () => `job-${String(Math.random())}`,
    sleep: async () => {},
    freePercentOf: async () => 100,
  })
  const jobId = engine.start({ fromLocationId: roots.from.id, toLocationId: roots.to.id })
  for (let i = 0; i < 400; i++) {
    const job = engine.list().find((j) => j.jobId === jobId)
    if (job && job.state !== 'running' && job.state !== 'queued')
      return {
        state: job.state,
        rowsReconciled: job.rowsReconciled,
        filesMoved: job.filesMoved,
      }
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('drain never finished')
}

/**
 * The table as a restarted process reads it back — an ACCOUNT per
 * `(device, profile, location, hour)` and nothing else. Since D523 no boot can
 * rebuild an index from it, so what a cold ledger can answer is `census`: how
 * much a location holds. Which files those are is a question for the disk, and
 * every test below asks the disk directly.
 */
async function coldLedger(store: SettingsStoreClient): Promise<SegmentHourLedger> {
  const restarted = new SegmentHourLedger({ store, logger: capturingLogger().logger })
  await restarted.declare()
  await restarted.load()
  return restarted
}

async function seedLedger(
  store: SettingsStoreClient,
  roots: Roots,
  rows: readonly SegmentRow[],
): Promise<SegmentHourLedger> {
  const ledger = new SegmentHourLedger({
    store,
    logger: capturingLogger().logger,
    listHour: listerOver(roots),
  })
  await ledger.declare()
  for (const row of rows) await ledger.recordSegment(row)
  return ledger
}

/** What the files under `root` sum to — the fact every account here is judged against. */
function bytesUnder(root: string): number {
  return filesUnder(root).reduce((total, rel) => total + statSync(path.join(root, rel)).size, 0)
}

describe('a relocation verifies against the SOURCE, not against what the row remembers', () => {
  it('copyVerified refuses a destination that differs from the SOURCE, and accepts one that matches it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cv-'))
    const src = path.join(dir, 'src.bin')
    const dst = path.join(dir, 'out/dst.bin')
    // The production shape: the file is 783801 B, the row remembers 274432 B.
    writeFileSync(src, Buffer.alloc(783_801, 3))

    const result = await copyVerified(src, dst, 274_432)

    // The copy is byte-perfect and is REPORTED as such, and the size the verify
    // used is handed back so the caller can see the row was wrong.
    expect(statSync(dst).size).toBe(783_801)
    expect(result.srcBytes).toBe(783_801)
    expect(result.copied).toBe(783_801)
  })

  it('adopts a destination that matches the SOURCE even when the recorded size disagrees — a restart does not re-copy', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cv-'))
    const src = path.join(dir, 'src.bin')
    const dst = path.join(dir, 'dst.bin')
    writeFileSync(src, Buffer.alloc(783_801, 3))
    writeFileSync(dst, Buffer.alloc(783_801, 4)) // a previous run already copied it

    const result = await copyVerified(src, dst, 274_432)

    expect(result.copied).toBe(0) // nothing re-copied
    expect(result.srcBytes).toBe(783_801)
    expect(statSync(dst).size).toBe(783_801)
  })
})

describe('a drain makes progress past a row whose name understates the file', () => {
  it('does not fail the whole job, and moves every file', async () => {
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, 5, { index: 2, actualBytes: 783_801 })
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const ledger = await seedLedger(store, roots, rows)
    const { logger, lines } = capturingLogger()

    const drained = await runDrain(roots, index, ledger, logger)

    expect(drained.state).toBe('done')
    expect(drained.filesMoved).toBe(5)
    // Every file is at the destination and nothing is left at the source. The
    // question is put to the DISK: since D523 the table says how much an hour
    // holds, never which files, so "did all five move" is a directory fact.
    expect(filesUnder(roots.to.root)).toHaveLength(5)
    expect(filesUnder(roots.from.root)).toEqual([])
    // And the durable account followed them, whole, to the target.
    const cold = await coldLedger(store)
    expect(await cold.census({ locationId: roots.from.id })).toMatchObject({ segments: 0 })
    expect(await cold.census({ locationId: roots.to.id })).toMatchObject({ segments: 5 })
    // And it SAID so, per camera — a silent skip on a migration is the failure
    // D295 exists to prevent.
    const reconciled = lines.filter((l) => l.message.includes('RECONCILED'))
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]?.deviceId).toBe(DEVICE)
    expect(reconciled[0]?.meta).toMatchObject({ recordedBytes: 1_002, actualBytes: 783_801 })
    // And the terminal coverage line carries the count, so a run that rewrote
    // durable rows can never look like one that did not.
    expect(lines.some((l) => l.meta['rowsReconciled'] === 1)).toBe(true)
  })

  it('reconciles the row to the file: the ledger sum equals what the disk holds', async () => {
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, 5, { index: 2, actualBytes: 783_801 })
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const ledger = await seedLedger(store, roots, rows)

    // The ledger's own sum, BEFORE: short by exactly the difference. This is
    // the number `StorageEvictableProvider` asks for when the disk fills.
    const before = await ledger.census({ locationId: roots.from.id })
    const onDisk = rows.reduce(
      (total, r) => total + statSync(path.join(roots.from.root, r.path)).size,
      0,
    )
    expect(before?.bytes).toBe(onDisk - (783_801 - 1_002))

    const drained = await runDrain(roots, index, ledger, capturingLogger().logger)
    expect(drained.state).toBe('done')
    expect(drained.rowsReconciled).toBe(1)

    const cold = await coldLedger(store)
    const after = await cold.census({ locationId: roots.to.id })
    expect(after?.bytes).toBe(onDisk)
    expect(after?.segments).toBe(5)

    // The correction lives in the NAME, because that is where the byte count is
    // recorded — and since D523 the name is the ONLY place it is recorded for a
    // file: a walk re-derives the account from these names, so a name that lies
    // re-teaches the ledger the wrong number on every pass.
    for (const rel of filesUnder(roots.to.root)) {
      expect(parseSegmentPath(rel)?.bytes).toBe(statSync(path.join(roots.to.root, rel)).size)
    }
  })

  it('leaves every honest row exactly as it was — only the wrong one is re-stamped', async () => {
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, 5, { index: 2, actualBytes: 783_801 })
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const ledger = await seedLedger(store, roots, rows)

    expect((await runDrain(roots, index, ledger, capturingLogger().logger)).state).toBe('done')

    // The destination directory is the record of what was re-stamped: four
    // names came across untouched, and the fifth arrived under a corrected one.
    const landed = new Set(filesUnder(roots.to.root))
    expect(landed.size).toBe(rows.length)
    for (const [i, row] of rows.entries()) {
      if (i === 2) {
        expect(landed.has(row.path)).toBe(false) // re-stamped
        continue
      }
      expect(landed.has(row.path)).toBe(true) // untouched
    }
    // And the account agrees with the bytes those names claim.
    const cold = await coldLedger(store)
    expect(await cold.census({ locationId: roots.to.id })).toMatchObject({
      bytes: bytesUnder(roots.to.root),
      segments: rows.length,
    })
  })

  it('a file SMALLER than its recorded size is treated the same way — the file is the fact', async () => {
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, 3, { index: 1, actualBytes: 12 })
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const ledger = await seedLedger(store, roots, rows)

    const drained = await runDrain(roots, index, ledger, capturingLogger().logger)

    expect(drained.state).toBe('done')
    expect(drained.rowsReconciled).toBe(1)
    for (const rel of filesUnder(roots.to.root)) {
      expect(parseSegmentPath(rel)?.bytes).toBe(statSync(path.join(roots.to.root, rel)).size)
    }
    // A row corrected DOWNWARDS shrinks the account by the same difference —
    // the aggregate is re-derived from the corrected names, not carried over.
    const cold = await coldLedger(store)
    expect(await cold.census({ locationId: roots.to.id })).toMatchObject({
      bytes: bytesUnder(roots.to.root),
    })
  })

  it('leaves NOTHING behind on the source — not the file, and not the resident row', async () => {
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, 3, { index: 0, actualBytes: 783_801 })
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const ledger = await seedLedger(store, roots, rows)

    expect((await runDrain(roots, index, ledger, capturingLogger().logger)).state).toBe('done')

    // The reconciled row's `path` is the CORRECTED name, which never existed at
    // the source. Deleting and de-indexing by it deletes nothing (`force: true`
    // makes a missing file a no-op) and drops nothing — the file stays on the
    // disk being drained and the RAM index keeps a row pointing at it, both in
    // silence. Asking the SOURCE what it still holds is the only assertion that
    // can see that; asking about the paths the ledger now names cannot.
    expect(filesUnder(roots.from.root)).toEqual([])
    expect(index.segmentsOnLocation(roots.from.id)).toEqual([])
    expect(index.segmentsOnLocation(roots.to.id)).toHaveLength(3)
  })

  it('never renames a path this repo does not name — the file is moved as-is and the wrong number is REPORTED', async () => {
    const roots = makeRoots()
    // A segment whose own `startMs` does not produce the date directory it
    // sits in — mis-filed by a hand, an import, an older layout.
    // `segmentRelPath` cannot reproduce this path, so a "corrected" name would
    // move the file to a directory the copy never created.
    //
    // It is mis-filed INSIDE a real hour bucket on purpose: the work list is a
    // listing of hour DIRECTORIES now (D523), so a file parked under a date no
    // hour row names is out of the mover's reach entirely. This one is within
    // it, and still must not be renamed.
    const hourDir = hourDirRelPath(DEVICE, 'low', HOUR0)
    const strayPath = `${hourDir}/${String(HOUR0 - 86_400_000)}-9966-1000.m4s`
    const abs = path.join(roots.from.root, strayPath)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, Buffer.alloc(783_801, 7))
    const index = new RecordingIndex()
    index.hydrateDevice(DEVICE, roots.from.id, [strayPath])
    const store = fakeStore()
    const ledger = new SegmentHourLedger({
      store,
      logger: capturingLogger().logger,
      listHour: listerOver(roots),
    })
    await ledger.declare()
    // The hour row comes from a WALK, which is how production learns a closed
    // hour: an account derived from the listing that found this file.
    await ledger.adoptWalkedHour(DEVICE, 'low', roots.from.id, HOUR0, [strayPath])
    const { logger, lines } = capturingLogger()

    const drained = await runDrain(roots, index, ledger, logger)

    expect(drained.state).toBe('done')
    expect(drained.rowsReconciled).toBe(0)
    expect(existsSync(path.join(roots.to.root, strayPath))).toBe(true)
    expect(filesUnder(roots.from.root)).toEqual([])
    // Moved, not corrected — and it SAYS the durable number is still wrong.
    const refused = lines.filter((l) => l.message.includes('not a canonical segment name'))
    expect(refused).toHaveLength(1)
    expect(refused[0]?.deviceId).toBe(DEVICE)
  })

  it('a re-run after a reconcile moves nothing and re-stamps nothing', async () => {
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, 4, { index: 1, actualBytes: 783_801 })
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const ledger = await seedLedger(store, roots, rows)

    expect((await runDrain(roots, index, ledger, capturingLogger().logger)).state).toBe('done')
    const second = await runDrain(roots, index, ledger, capturingLogger().logger)

    // The source scope is empty, so there is nothing left to do — and in
    // particular the drain does not re-fail forever on the reconciled row.
    expect(second.state).toBe('done')
    expect(second.filesMoved).toBe(0)
    expect(second.rowsReconciled).toBe(0)
  })
})
