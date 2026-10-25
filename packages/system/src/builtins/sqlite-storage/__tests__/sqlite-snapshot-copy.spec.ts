/**
 * The snapshot copy and its checks, called in-process (D693).
 *
 * Three claims, each with its own gate in `sqlite-snapshot-worker.ts`:
 *
 * 1. The copy is ONE instant. The row counts and every backup step read the
 *    same pinned read transaction, so a write committed by another connection
 *    between two steps is in neither — the counts and the copy agree, and the
 *    copy does not restart. Disarmed by dropping the `BEGIN`, the copy picks up
 *    the interleaved writes and the counts no longer match it.
 * 2. A copy that fails `integrity_check` is refused, by name.
 * 3. A copy whose row counts differ from the pinned source is refused, by name.
 *
 * Plus: the verified copy is ONE self-contained file — journal mode DELETE, no
 * `-wal`/`-shm` beside it — so a restore has nothing to pair it with.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { SnapshotRefusedError } from '../sqlite-snapshot-protocol.js'
import {
  copyPinned,
  requireRollbackJournal,
  takeVerifiedCopy,
  verifyCopy,
} from '../sqlite-snapshot-worker.js'

const tmpDirs: string[] = []
const open: Database.Database[] = []
afterEach(async () => {
  for (const db of open.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-snapshot-copy-'))
  tmpDirs.push(dir)
  return dir
}

/** A WAL database with an indexed table big enough for many backup steps. */
function seed(file: string, rows: number): Database.Database {
  const db = new Database(file)
  open.push(db)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, k TEXT NOT NULL, body TEXT NOT NULL)')
  db.exec('CREATE INDEX item_k ON item (k)')
  db.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, v TEXT)')
  const ins = db.prepare('INSERT INTO item (k, body) VALUES (?, ?)')
  db.transaction(() => {
    for (let i = 0; i < rows; i++) ins.run(`k${i % 97}`, 'x'.repeat(200))
  })()
  db.prepare('INSERT INTO note (v) VALUES (?)').run('one')
  return db
}

function countOf(file: string, table: string): number {
  const db = new Database(file, { readonly: true })
  try {
    const row: unknown = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()
    if (typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number') {
      return row.n
    }
    throw new Error('no count')
  } finally {
    db.close()
  }
}

describe('copyPinned — the copy is one instant', () => {
  it('counts and copy agree, and exclude a write committed by another connection mid-copy', async () => {
    const dir = await tmpDir()
    const live = path.join(dir, 'live.db')
    const writer = seed(live, 4000)
    const reader = new Database(live, { readonly: true })
    open.push(reader)
    const copy = path.join(dir, 'copy')

    // Interleave: a write by ANOTHER connection after the first few steps. The
    // backup yields with `setImmediate` between steps, so this lands mid-copy.
    let steps = 0
    const pending = copyPinned(reader, copy, 4, () => {
      steps++
      if (steps === 3) writer.prepare('INSERT INTO item (k, body) VALUES (?, ?)').run('late', 'y')
    })
    const pinned = await pending
    expect(steps).toBeGreaterThan(3)

    const itemRows = pinned.tables.find((t) => t.name === 'item')?.rows
    expect(itemRows).toBe(4000)
    // The copy holds exactly the pinned instant — not the late write.
    expect(countOf(copy, 'item')).toBe(4000)
    // And the late write did commit on the live database.
    expect(countOf(live, 'item')).toBe(4001)
  })
})

describe('verifyCopy — a copy is checked before it may exist', () => {
  it('turns the copy into one self-contained file (journal mode DELETE, no sidecars)', async () => {
    const dir = await tmpDir()
    const live = path.join(dir, 'live.db')
    seed(live, 500)
    const workDir = path.join(dir, 'work')
    await fs.mkdir(workDir)
    const copy = path.join(workDir, 'copy')

    const verified = await takeVerifiedCopy({
      kind: 'sqlite-snapshot',
      livePath: live,
      copyPath: copy,
      pagesPerStep: 64,
    })

    expect(verified.tables).toEqual(
      expect.arrayContaining([
        { name: 'item', rows: 500 },
        { name: 'note', rows: 1 },
      ]),
    )
    expect(verified.pageCount).toBeGreaterThan(0)
    // Bytes 18/19 of the header: 1 = rollback journal, 2 = WAL.
    const header = await fs.readFile(copy)
    expect(header[18]).toBe(1)
    expect(header[19]).toBe(1)
    expect(await fs.readdir(workDir)).toEqual(['copy'])
  })

  it('refuses a copy whose journal-mode switch did not take — it would need sidecars to be read', () => {
    // SQLite answers the mode it is IN; a switch it could not make answers `wal`
    // without an error.
    expect(() => requireRollbackJournal('wal')).toThrow(SnapshotRefusedError)
    expect(() => requireRollbackJournal('wal')).toThrow(/journal mode wal/)
    expect(() => requireRollbackJournal('delete')).not.toThrow()
  })

  it('refuses a copy that fails integrity_check — reason `integrity`', async () => {
    const dir = await tmpDir()
    const file = path.join(dir, 'copy')
    const db = new Database(file)
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, k TEXT NOT NULL)')
    db.exec('CREATE INDEX item_k ON item (k)')
    const ins = db.prepare('INSERT INTO item (k) VALUES (?)')
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) ins.run(`key-${i}`)
    })()
    // Re-declare the index over a different column without rebuilding it: its
    // entries no longer match the rows they claim to index — exactly the
    // "missing index rows" a torn archive showed (D679).
    db.unsafeMode(true)
    db.pragma('writable_schema = ON')
    db.prepare(
      "UPDATE sqlite_schema SET sql = 'CREATE INDEX item_k ON item (id)' WHERE name = 'item_k'",
    ).run()
    db.close()

    let caught: unknown = null
    try {
      verifyCopy(file, [{ name: 'item', rows: 2000 }])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SnapshotRefusedError)
    if (caught instanceof SnapshotRefusedError) expect(caught.reason).toBe('integrity')
  })

  it('refuses a copy whose row counts differ from the pinned source — reason `row-count`', async () => {
    const dir = await tmpDir()
    const live = path.join(dir, 'live.db')
    const db = seed(live, 10)
    db.close()
    const copy = path.join(dir, 'copy')
    await fs.copyFile(live, copy)

    let caught: unknown = null
    try {
      verifyCopy(copy, [
        { name: 'item', rows: 11 },
        { name: 'note', rows: 1 },
      ])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SnapshotRefusedError)
    if (caught instanceof SnapshotRefusedError) {
      expect(caught.reason).toBe('row-count')
      expect(caught.detail).toContain('item')
    }
  })

  it('refuses a copy missing a table the source had — reason `row-count`', async () => {
    const dir = await tmpDir()
    const live = path.join(dir, 'live.db')
    const db = seed(live, 10)
    db.close()
    const copy = path.join(dir, 'copy')
    await fs.copyFile(live, copy)

    expect(() =>
      verifyCopy(copy, [
        { name: 'item', rows: 10 },
        { name: 'note', rows: 1 },
        { name: 'gone', rows: 3 },
      ]),
    ).toThrow(/row-count.*gone/)
  })
})
