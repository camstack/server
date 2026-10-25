import { promises as fsp, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SQLITE_MMAP_CEILING_BYTES,
  SQLITE_MMAP_FLOOR_BYTES,
  SQLITE_PAGE_CACHE_CEILING_KIB,
  SQLITE_PAGE_CACHE_FLOOR_KIB,
  sqliteMmapSizeFor,
  sqlitePageCacheKibFor,
} from '../sqlite-pragmas.js'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const MIB = 1_048_576

describe('pragma sizing follows the database, not a constant', () => {
  it('covers a database larger than the mmap window that shipped for the 130 MB file', () => {
    // The live hub on 2026-08-25: an 858 MB file against a 256 MiB window.
    // Every blocked `pread64` offset sampled from `/proc/<pid>/syscall` was
    // beyond 256 MiB — i.e. outside the map, by construction.
    const mmap = sqliteMmapSizeFor(858 * MIB)
    expect(mmap).toBeGreaterThan(858 * MIB)
    expect(mmap).toBeLessThanOrEqual(SQLITE_MMAP_CEILING_BYTES)
  })

  it('never drops below the window the 130 MB sizing already proved', () => {
    expect(sqliteMmapSizeFor(0)).toBe(SQLITE_MMAP_FLOOR_BYTES)
    expect(sqliteMmapSizeFor(10 * MIB)).toBe(SQLITE_MMAP_FLOOR_BYTES)
  })

  it('bounds the map so an unbounded database cannot map itself into trouble', () => {
    expect(sqliteMmapSizeFor(100_000 * MIB)).toBe(SQLITE_MMAP_CEILING_BYTES)
  })

  it('grows the page cache with the file and keeps it negative (KiB, not pages)', () => {
    const kib = sqlitePageCacheKibFor(858 * MIB)
    expect(kib).toBeLessThan(0)
    expect(Math.abs(kib)).toBeGreaterThan(Math.abs(SQLITE_PAGE_CACHE_FLOOR_KIB))
    expect(Math.abs(kib)).toBeLessThanOrEqual(Math.abs(SQLITE_PAGE_CACHE_CEILING_KIB))
  })

  it('keeps the floor for a small or missing database', () => {
    expect(sqlitePageCacheKibFor(0)).toBe(SQLITE_PAGE_CACHE_FLOOR_KIB)
    expect(sqlitePageCacheKibFor(64 * MIB)).toBe(SQLITE_PAGE_CACHE_FLOOR_KIB)
  })

  it('caps the page cache so a huge database cannot pin unbounded anonymous memory', () => {
    expect(sqlitePageCacheKibFor(100_000 * MIB)).toBe(SQLITE_PAGE_CACHE_CEILING_KIB)
  })

  it('is monotonic — a bigger database never gets a smaller allowance', () => {
    const sizes = [0, 50, 130, 300, 858, 2_000, 8_000].map((mb) => mb * MIB)
    for (let i = 1; i < sizes.length; i++) {
      const prev = sizes[i - 1] ?? 0
      const cur = sizes[i] ?? 0
      expect(sqliteMmapSizeFor(cur)).toBeGreaterThanOrEqual(sqliteMmapSizeFor(prev))
      expect(Math.abs(sqlitePageCacheKibFor(cur))).toBeGreaterThanOrEqual(
        Math.abs(sqlitePageCacheKibFor(prev)),
      )
    }
  })

  it('treats a non-finite or negative size as unknown rather than as an error', () => {
    expect(sqliteMmapSizeFor(Number.NaN)).toBe(SQLITE_MMAP_FLOOR_BYTES)
    expect(sqliteMmapSizeFor(-1)).toBe(SQLITE_MMAP_FLOOR_BYTES)
    expect(sqlitePageCacheKibFor(Number.NaN)).toBe(SQLITE_PAGE_CACHE_FLOOR_KIB)
  })
})

/**
 * The functions above can be right while nothing calls them — which is the
 * exact shape of the bug they replace: a well-argued constant that no longer
 * described the file. These assert the connection READS BACK what the file on
 * disk implies, so a revert to a constant fails here rather than in production
 * eight months later.
 */
describe('the live connection is configured from the file on disk', () => {
  const tmpDirs: string[] = []
  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await fsp.rm(d, { recursive: true, force: true })
  })

  async function openAt(): Promise<{ backend: SqliteSettingsBackend; dbPath: string }> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pragma-sizing-'))
    tmpDirs.push(dir)
    const dbPath = path.join(dir, 'camstack.db')
    const backend = new SqliteSettingsBackend(dbPath)
    await backend.initialize()
    return { backend, dbPath }
  }

  function pragma(backend: SqliteSettingsBackend, name: string): number {
    const db = backend.getDatabase()
    if (db === null) throw new Error('backend is not open')
    const value = db.pragma(name, { simple: true })
    if (typeof value !== 'number') throw new Error(`pragma ${name} is not a number`)
    return value
  }

  it('applies exactly the mmap window the measured size implies', async () => {
    const { backend, dbPath } = await openAt()
    expect(pragma(backend, 'mmap_size')).toBe(sqliteMmapSizeFor(statSync(dbPath).size))
    await backend.shutdown()
  })

  it('applies exactly the page cache the measured size implies', async () => {
    const { backend, dbPath } = await openAt()
    expect(pragma(backend, 'cache_size')).toBe(sqlitePageCacheKibFor(statSync(dbPath).size))
    await backend.shutdown()
  })

  it('re-derives on every open, so a database that grew is re-sized', async () => {
    const { backend, dbPath } = await openAt()
    await backend.shutdown()

    // Grow the file past the mmap floor without touching SQLite's own bytes:
    // the size is what `initialize` reads, and a bigger file must widen the
    // window. (SQLite reads its page count from the header, not from the
    // file length, so trailing space is inert.)
    const grownTo = Math.round(SQLITE_MMAP_FLOOR_BYTES * 1.5)
    await fsp.truncate(dbPath, grownTo)

    const reopened = new SqliteSettingsBackend(dbPath)
    await reopened.initialize()
    expect(statSync(dbPath).size).toBeGreaterThanOrEqual(grownTo)
    expect(pragma(reopened, 'mmap_size')).toBe(sqliteMmapSizeFor(grownTo))
    expect(pragma(reopened, 'mmap_size')).toBeGreaterThan(SQLITE_MMAP_FLOOR_BYTES)
    await reopened.shutdown()
  })
})
