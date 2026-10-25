/**
 * The PRAGMA configuration `SqliteSettingsBackend.initialize` applies.
 *
 * Why these are asserted rather than trusted: a pragma that fails to apply is
 * silent. `mmap_size` is a no-op on a build compiled with
 * `SQLITE_MAX_MMAP_SIZE=0`, and `cache_size` silently keeps the previous value
 * if the statement is mis-spelled. On the live hub, 20 Hz syscall sampling put
 * 210 of 2,561 samples inside `pread64` on `camstack.db` / `camstack.db-wal`
 * (4 KiB page reads — cache misses) — 8.2% of wall-clock and ~20% during
 * bursts. These assertions are what stops that regressing back in unnoticed.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveMapGrowth,
  SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
  SQLITE_MMAP_FLOOR_BYTES,
  SQLITE_PAGE_CACHE_FLOOR_KIB,
  SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES,
  sqliteMmapSizeFor,
  sqliteOccupancy,
} from '../sqlite-pragmas.js'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function openBackend(): Promise<SqliteSettingsBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-pragmas-'))
  tmpDirs.push(dir)
  const b = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await b.initialize()
  return b
}

/** Read a single-value pragma. Throws rather than returning a fabricated 0. */
function readNumberPragma(backend: SqliteSettingsBackend, name: string): number {
  const db = backend.getDatabase()
  if (db === null) throw new Error('backend is not open')
  const value = db.pragma(name, { simple: true })
  if (typeof value !== 'number') {
    throw new Error(`pragma ${name} returned ${typeof value}, expected number`)
  }
  return value
}

function readStringPragma(backend: SqliteSettingsBackend, name: string): string {
  const db = backend.getDatabase()
  if (db === null) throw new Error('backend is not open')
  const value = db.pragma(name, { simple: true })
  if (typeof value !== 'string') {
    throw new Error(`pragma ${name} returned ${typeof value}, expected string`)
  }
  return value
}

describe('SqliteSettingsBackend pragmas', () => {
  it('keeps WAL journal mode and foreign keys (unchanged contract)', async () => {
    const b = await openBackend()
    expect(readStringPragma(b, 'journal_mode')).toBe('wal')
    expect(readNumberPragma(b, 'foreign_keys')).toBe(1)
    await b.shutdown()
  })

  it('sizes the page cache from the file, never below the floor', async () => {
    const b = await openBackend()
    // A freshly seeded database is a few pages, so the derived size is the
    // floor. Negative `cache_size` means KiB rather than pages, and SQLite
    // reports it back in the same units it was given.
    expect(readNumberPragma(b, 'cache_size')).toBe(SQLITE_PAGE_CACHE_FLOOR_KIB)
    // Guard the intent, not just the constant: better-sqlite3 compiles with
    // SQLITE_DEFAULT_CACHE_SIZE=-16000 (≈16 MiB), so anything at or above that
    // magnitude would leave the measured pread64 storm in place.
    expect(SQLITE_PAGE_CACHE_FLOOR_KIB).toBeLessThan(-16_000)
    await b.shutdown()
  })

  it('enables mmap so main-DB page reads become faults, not pread64 syscalls', async () => {
    const b = await openBackend()
    const effective = readNumberPragma(b, 'mmap_size')
    // A build with SQLITE_MAX_MMAP_SIZE=0 reports 0 here. If that ever becomes
    // true of the bundled better-sqlite3, this fails loudly instead of leaving
    // a pragma that reads as configured but does nothing.
    expect(effective).toBe(SQLITE_MMAP_FLOOR_BYTES)
    await b.shutdown()
  })

  it('bounds the on-disk WAL after every checkpoint via journal_size_limit', async () => {
    const b = await openBackend()
    expect(readNumberPragma(b, 'journal_size_limit')).toBe(SQLITE_JOURNAL_SIZE_LIMIT_BYTES)
    await b.shutdown()
  })

  it('runs WAL at synchronous=NORMAL — the build default, not something we set', async () => {
    // better-sqlite3 compiles with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, so a WAL
    // database is ALREADY at NORMAL (1). This is a characterization test: it
    // records why `initialize()` does not set `synchronous` (it would be a
    // no-op that reads like a durability decision), and it goes red if a
    // dependency bump ever changes the default underneath us.
    const b = await openBackend()
    expect(readNumberPragma(b, 'synchronous')).toBe(1)
    await b.shutdown()
  })

  it('raises its own auto-checkpoint to the bound — the checkpoint is the worker’s job (D452)', async () => {
    // Under NORMAL the fsyncs happen at the checkpoint, and the engine runs
    // the auto-checkpoint inside the crossing writer's commit. The settings
    // connection keeps one only as a BOUND that fires if the worker is gone.
    const b = await openBackend()
    expect(readNumberPragma(b, 'wal_autocheckpoint')).toBe(SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES)
    expect(SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES).toBe(10 * 1000)
    await b.shutdown()
  })

  it('serves reads correctly with the new pragmas applied', async () => {
    // A cache/mmap change that broke reads would be the worst outcome; prove
    // a round trip still works rather than only that the pragmas took.
    const b = await openBackend()
    await b.set({ collection: 'system-settings', key: 'pragma-probe', value: { n: 42 } })
    expect(await b.get({ collection: 'system-settings', key: 'pragma-probe' })).toEqual({ n: 42 })
    await b.shutdown()
  })
})

/**
 * A file that stopped growing is not the same as a file that is full.
 *
 * The live database reached 858 MB and stayed there: sampled 2026-08-25 it did
 * not move a byte in 90 s while the per-device retention sweeps were actively
 * deleting (`tracks=5 events=30 media=39 embeddings=5 bytesReclaimed=18157573`
 * in a single pass). SQLite reuses freed pages but never returns them to the
 * filesystem without a `VACUUM`, so a file at its high-water mark and a file
 * genuinely full of live rows are indistinguishable from the outside — and they
 * call for opposite actions: one is reclaimed by a VACUUM, the other means
 * retention is not keeping up.
 *
 * `dbSizeMb` alone could not tell them apart, so the boot line now carries the
 * occupancy too. The connection is the application's own handle; nothing here
 * opens the database a second time.
 */
describe('sqliteOccupancy', () => {
  it('splits the file into live and free from the page counters', () => {
    // 858 MB at 4 KiB pages, 60% of them on the freelist.
    const occ = sqliteOccupancy({ pageCount: 219_648, freelistCount: 131_789, pageSizeBytes: 4096 })
    expect(occ.freePct).toBe(60)
    expect(occ.freeMb).toBe(515)
    expect(occ.liveMb).toBe(343)
  })

  it('reports a full file as zero free rather than omitting the field', () => {
    const occ = sqliteOccupancy({ pageCount: 1000, freelistCount: 0, pageSizeBytes: 4096 })
    expect(occ).toEqual({ liveMb: 4, freeMb: 0, freePct: 0 })
  })

  it('never divides by zero on a database that has no pages yet', () => {
    expect(sqliteOccupancy({ pageCount: 0, freelistCount: 0, pageSizeBytes: 4096 })).toEqual({
      liveMb: 0,
      freeMb: 0,
      freePct: 0,
    })
  })
})

/**
 * The sizing autoscales — but only once, at open, and that is the same bug.
 *
 * `sqliteMmapSizeFor` already derives the map from the file on disk, so a
 * database of any size gets a map that fits it. What it could not do is follow
 * a file that grows while the process is up: the pragma is applied when the
 * connection opens and never again. This node got away with it because 130 MB →
 * 858 MB happened across seventeen days of restarts; a node up for two months
 * walks back into the identical failure — 70% of the file outside the map and a
 * synchronous page-in per read, measured at 418 pread64/s on 2026-08-25.
 *
 * `mmap_size` is settable at runtime, so the fix is to re-derive it. Only
 * GROWTH is applied: shrinking the map after a delete buys nothing and costs a
 * remap, and the file does not shrink without a VACUUM anyway.
 */
describe('resolveMapGrowth', () => {
  it('grows the map when the file has outgrown it', () => {
    const grown = resolveMapGrowth(268_435_456, 900_124_672)
    expect(grown).toBe(sqliteMmapSizeFor(900_124_672))
    expect(grown).toBeGreaterThan(268_435_456)
  })

  it('does nothing when the map already covers the file', () => {
    const current = sqliteMmapSizeFor(900_124_672)
    expect(resolveMapGrowth(current, 900_124_672)).toBeNull()
  })

  it('never shrinks — a delete does not return the file to the filesystem', () => {
    const current = sqliteMmapSizeFor(900_124_672)
    expect(resolveMapGrowth(current, 130_000_000)).toBeNull()
  })

  it('does nothing when the file size cannot be read', () => {
    expect(resolveMapGrowth(268_435_456, 0)).toBeNull()
  })
})
