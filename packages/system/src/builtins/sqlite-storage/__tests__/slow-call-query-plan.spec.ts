/**
 * The slow-call WARN carries a REAL query plan, from the real engine.
 *
 * The profiler unit spec proves the wiring against an injected explainer, and
 * that is exactly the shape of test this repo has been burned by twice: a fake
 * that supplies the value production forgot to fetch. So this one uses a real
 * `SqliteSettingsBackend`, a real table, a real index, and asserts the two
 * plans the engine actually produces — the indexed read and the scan.
 *
 * It is the assertion that closes 2026-08-25: `query pipeline-analytics:tracks
 * — max 1615 ms, rows 501` named a table and could not say whether that second
 * and a half was a full scan or a cold disk. `SCAN … USE TEMP B-TREE FOR ORDER
 * BY` says it in one line.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

interface CapturedLog {
  readonly message: string
  readonly meta: Record<string, unknown>
}

function recordingLogger(sink: CapturedLog[]): IScopedLogger {
  const push = () => (message: string, ctx?: { meta?: Record<string, unknown> }) => {
    sink.push({ message, meta: ctx?.meta ?? {} })
  }
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: push(),
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const COLLECTION = 'plan-test:tracks'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function openBackend(warnings: CapturedLog[]): Promise<SqliteSettingsBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-plan-'))
  tmpDirs.push(dir)
  const backend = new SqliteSettingsBackend(
    path.join(dir, 'camstack.db'),
    undefined,
    recordingLogger(warnings),
  )
  await backend.initialize()
  await backend.declareCollection({
    collection: COLLECTION,
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
      { name: 'deviceId', type: 'INTEGER', notNull: true },
      { name: 'lastSeen', type: 'INTEGER', notNull: true },
    ],
    // The live shape: (deviceId, lastSeen), leading column deviceId.
    indexes: [{ name: 'idx_plan_device_lastSeen', columns: ['deviceId', 'lastSeen'] }],
  })
  const db = backend.getDatabase()
  if (db === null) throw new Error('backend not open')
  const insert = db.prepare(`INSERT INTO "${COLLECTION}" (id, deviceId, lastSeen) VALUES (?, ?, ?)`)
  db.transaction(() => {
    for (let i = 0; i < 400; i++) insert.run(`t-${i}`, 101 + (i % 3), 1_700_000_000_000 + i)
  })()
  return backend
}

describe('slow-call query plan, over a real SQLite engine', () => {
  it('reports SCAN + TEMP B-TREE for a range that the leading index column cannot serve', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackend(warnings)
    const profiler = backend.getProfiler()
    if (profiler === undefined) throw new Error('backend built no profiler')

    // `collectDeviceIds`: a `lastSeen` range with NO deviceId, ordered by
    // lastSeen. `(deviceId, lastSeen)` cannot serve it from the left.
    profiler.record({
      op: 'query',
      collection: COLLECTION,
      durationMs: 1_101,
      rows: 501,
      sql: `SELECT "id", "deviceId", "lastSeen" FROM "${COLLECTION}" WHERE "lastSeen" BETWEEN ? AND ? ORDER BY "lastSeen" ASC LIMIT ?`,
      params: [0, Number.MAX_SAFE_INTEGER, 501],
    })

    const warn = warnings.find((l) => l.message.includes('held the event loop'))
    const plan = warn?.meta['plan']
    expect(Array.isArray(plan)).toBe(true)
    const text = (plan as readonly string[]).join(' | ')
    expect(text).toContain('SCAN')
    expect(text).toContain('TEMP B-TREE')
    await backend.shutdown()
  })

  it('reports SEARCH … USING INDEX for the same table read through its index', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackend(warnings)
    const profiler = backend.getProfiler()
    if (profiler === undefined) throw new Error('backend built no profiler')

    profiler.record({
      op: 'query',
      collection: COLLECTION,
      durationMs: 1_200,
      rows: 501,
      sql: `SELECT "id", "deviceId", "lastSeen" FROM "${COLLECTION}" WHERE "deviceId" = ? AND "lastSeen" BETWEEN ? AND ? ORDER BY "lastSeen" DESC LIMIT ?`,
      params: [101, 0, Number.MAX_SAFE_INTEGER, 501],
    })

    const warn = warnings.find((l) => l.message.includes('held the event loop'))
    const plan = warn?.meta['plan']
    expect(Array.isArray(plan)).toBe(true)
    const text = (plan as readonly string[]).join(' | ')
    expect(text).toContain('SEARCH')
    expect(text).toContain('idx_plan_device_lastSeen')
    expect(text).not.toContain('TEMP B-TREE')
    await backend.shutdown()
  })

  it('does not turn an unexplainable statement into a crash', async () => {
    const warnings: CapturedLog[] = []
    const backend = await openBackend(warnings)
    const profiler = backend.getProfiler()
    if (profiler === undefined) throw new Error('backend built no profiler')

    expect(() =>
      profiler.record({
        op: 'query',
        collection: COLLECTION,
        durationMs: 1_200,
        rows: 0,
        sql: 'SELECT this is not sql',
        params: [],
      }),
    ).not.toThrow()
    const warn = warnings.find((l) => l.message.includes('held the event loop'))
    expect(warn).toBeDefined()
    expect(warn?.meta['plan']).toBeUndefined()
    await backend.shutdown()
  })
})
