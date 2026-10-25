/**
 * The one-shot `ANALYZE`, and the plan flip that justifies it.
 *
 * The load-bearing assertion is not "stat1 exists afterwards" — it is that the
 * PLANNER CHANGES ITS MIND. Reproduced here on the live shape: two candidate
 * indexes, one selective and unsorted, one unselective and already ordered,
 * against a query that wants both. That is exactly the choice the live hub got
 * wrong (727 ms instead of 0.3 ms) for want of statistics.
 */

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { hasIndexStatistics, runAnalyzeIfMissing } from '../analyze-stats.js'

const open: Database.Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

/**
 * A miniature `pipeline-analytics:media`: many rows per `deviceId`, two per
 * `(ownerKind, ownerId)`, and a `timestamp` the query wants to order by.
 */
function mediaLike(): Database.Database {
  const db = new Database(':memory:')
  open.push(db)
  db.exec(`
    CREATE TABLE media (
      id TEXT PRIMARY KEY NOT NULL,
      deviceId INTEGER NOT NULL,
      ownerKind TEXT NOT NULL,
      ownerId TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX idx_media_owner ON media (ownerKind, ownerId);
    CREATE INDEX idx_media_device_ts ON media (deviceId, timestamp);
  `)
  const insert = db.prepare(
    'INSERT INTO media (id, deviceId, ownerKind, ownerId, timestamp) VALUES (?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (let i = 0; i < 4_000; i++) {
      insert.run(`m-${i}`, 104, 'track', `owner-${Math.floor(i / 2)}`, 1_700_000_000_000 + i)
    }
  })()
  return db
}

const PRODUCTION_SHAPE = `SELECT * FROM media
   WHERE ownerKind = ? AND ownerId = ? AND deviceId = ?
   ORDER BY timestamp ASC LIMIT 501`

function planOf(db: Database.Database): string {
  const rows = db
    .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${PRODUCTION_SHAPE}`)
    .all('track', 'owner-7', 104)
  return rows.map((r) => r.detail).join(' | ')
}

describe('runAnalyzeIfMissing', () => {
  it('makes the planner abandon the ordered-but-unselective index for the selective one', () => {
    const db = mediaLike()
    // Before: the device index wins because it delivers `timestamp` order for
    // free, and nothing tells the planner it costs 2 000 rows to do so.
    expect(planOf(db)).toContain('idx_media_device_ts')

    expect(runAnalyzeIfMissing(db).kind).toBe('analyzed')

    const after = planOf(db)
    expect(after).toContain('idx_media_owner')
    expect(after).not.toContain('idx_media_device_ts')
  })

  it('reports how long it held the loop — a 14 s statement is not a detail', () => {
    const db = mediaLike()
    let clock = 1_000
    const outcome = runAnalyzeIfMissing(db, () => {
      clock += 500
      return clock
    })
    expect(outcome).toMatchObject({ kind: 'analyzed', tookMs: 500 })
  })

  it('does nothing the second time — this must never end up on a timer', () => {
    const db = mediaLike()
    expect(hasIndexStatistics(db)).toBe(false)
    expect(runAnalyzeIfMissing(db).kind).toBe('analyzed')
    expect(hasIndexStatistics(db)).toBe(true)
    expect(runAnalyzeIfMissing(db).kind).toBe('already-present')
  })

  it('reports a failure instead of taking the settings engine down with it', () => {
    const db = mediaLike()
    db.close()
    const outcome = runAnalyzeIfMissing(db)
    expect(outcome.kind).toBe('failed')
  })
})
