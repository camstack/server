import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IScopedLogger } from '@dominevo/types'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'
import type { StorageRowsReader } from '../storage-report-runner.js'
import {
  openReportConnection,
  readStorageRows,
  STORAGE_REPORT_CACHE_PRAGMA,
} from '../storage-report-worker.js'
import { STORAGE_REPORT_DELAY_MS } from '../table-sizes.js'

describe('the storage report connection', () => {
  let dir: string
  let dbPath: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'storage-report-'))
    dbPath = path.join(dir, 'x.db')
    const db = new Database(dbPath)
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a')")
    db.close()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is read-only with the map off and a small cache', () => {
    const db = openReportConnection(dbPath)
    try {
      expect(db.readonly).toBe(true)
      expect(db.pragma('mmap_size', { simple: true })).toBe(0)
      expect(db.pragma('cache_size', { simple: true })).toBe(STORAGE_REPORT_CACHE_PRAGMA)
    } finally {
      db.close()
    }
  })

  it('answers the same dbstat rows the report always read', () => {
    const rows = readStorageRows(dbPath)
    expect(rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 't', kind: 'table' })]),
    )
  })
})

interface Line {
  readonly message: string
  readonly meta: Record<string, unknown>
}

function recorder(): { lines: Line[]; logger: IScopedLogger } {
  const lines: Line[] = []
  const push = (message: string, extras?: { meta?: Record<string, unknown> }): void => {
    lines.push({ message, meta: extras?.meta ?? {} })
  }
  const logger: IScopedLogger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: () => logger,
    withTags: () => logger,
  }
  return { lines, logger }
}

describe('the boot storage report', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'storage-report-be-'))
    vi.useFakeTimers({ toFake: ['setTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads dbstat through the report reader, not the serving connection', async () => {
    const dbPath = path.join(dir, 'main.db')
    const reader = vi.fn<StorageRowsReader>(async () => [
      { name: 'big', tableName: 'big', bytes: 4096, pages: 1, kind: 'table' },
    ])
    const { lines, logger } = recorder()
    const backend = new SqliteSettingsBackend(dbPath, undefined, logger, { storageRows: reader })
    await backend.initialize()
    await vi.advanceTimersByTimeAsync(STORAGE_REPORT_DELAY_MS + 10)
    expect(reader).toHaveBeenCalledWith(dbPath)
    const line = lines.find((l) => l.message.startsWith('sqlite storage report —'))
    expect(line?.meta['tableCount']).toBe(1)
    await backend.shutdown()
  })
})
