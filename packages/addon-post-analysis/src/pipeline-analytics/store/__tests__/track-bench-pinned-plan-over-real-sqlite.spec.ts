/**
 * `countBenchPinned` is a scheduled aggregate — called on every retention
 * pass (`index.ts`'s hourly sweep, mirroring `countFavourited`) — served from
 * a COVERING index, proved on the real engine, from the statement the store
 * really prepares (fix round, L4, D447).
 *
 * `idx_tracks_device_lastSeen` carries `deviceId` and `lastSeen` but not
 * `benchPinned`: without `idx_tracks_device_benchPinned`, `COUNT(*) WHERE
 * deviceId = ? AND benchPinned = ?` finds the range on the existing index
 * and fetches the table row behind every match — the exact shape D447's
 * `idx_media_location` letter warned against, on the same synchronous
 * `hub/sqlite-settings` thread every configuration read in the cluster
 * queues behind.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../track-store.js'

/** Same documented test boundary as the other `*-over-real-sqlite` specs. */
function clientOver(backend: SqliteSettingsBackend): SettingsStoreClient {
  return {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    insertMany: { mutate: (i: never) => backend.insertMany(i) },
    count: { query: (i: never) => backend.count(i) },
  } as unknown as SettingsStoreClient
}

interface PreparedStatement {
  readonly sql: string
}

describe('countBenchPinned over the real SQLite settings store', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let store: SettingsStoreClient
  let trackStore: TrackStore
  let prepared: string[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'camstack-tracks-benchpinned-plan-'))
    backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
    await backend.initialize()
    store = clientOver(backend)
    await TrackStore.declare(store)
    trackStore = new TrackStore({ store, logger: makeSilentLogger() })
    await backend.insertMany({
      collection: TRACKS_COLLECTION,
      records: [
        trackRow('t1', 101, 100, true),
        trackRow('t2', 101, 200, true),
        trackRow('t3', 101, 300, false),
        trackRow('t4', 102, 400, true),
      ],
    })
    prepared = []
    const original = Database.prototype.prepare
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      prepared.push(sql)
      return original.call(this, sql)
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await backend.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  function trackRow(
    id: string,
    deviceId: number,
    lastSeen: number,
    benchPinned: boolean,
  ): { id: string; data: Record<string, unknown> } {
    return {
      id,
      data: {
        deviceId,
        className: 'person',
        firstSeen: 0,
        lastSeen,
        benchPinned,
        retrainStatus: 'none',
      },
    }
  }

  function statementsFor(needle: string): readonly PreparedStatement[] {
    return prepared
      .filter(
        (sql) =>
          sql.includes('COUNT(*)') && sql.includes(TRACKS_COLLECTION) && sql.includes(needle),
      )
      .map((sql) => ({ sql }))
  }

  it('answers the bare count from a covering index — no table row is fetched', async () => {
    expect(await trackStore.countBenchPinned({ deviceId: 101 })).toBe(2)

    const reads = statementsFor('"benchPinned" = ?')
    expect(reads.length).toBeGreaterThan(0)
    for (const { sql } of reads) {
      const plan = backend.explainQueryPlan(sql, [101, 1])
      expect(plan.join(' | ')).toContain(
        `SEARCH ${TRACKS_COLLECTION} USING COVERING INDEX idx_tracks_device_benchPinned`,
      )
    }
  })

  it('answers the olderThanMs form from the same covering index', async () => {
    expect(await trackStore.countBenchPinned({ deviceId: 101, olderThanMs: 250 })).toBe(2)

    const reads = statementsFor('"benchPinned" = ?')
    expect(reads.length).toBeGreaterThan(0)
    for (const { sql } of reads) {
      const plan = backend.explainQueryPlan(sql, [101, 1, 0, 249])
      expect(plan.join(' | ')).toContain(
        `SEARCH ${TRACKS_COLLECTION} USING COVERING INDEX idx_tracks_device_benchPinned`,
      )
    }
  })
})
