/**
 * D481 capture harness — the statements the media store REALLY prepares.
 *
 * Not an assertion spec: this drives every read path against the real engine
 * with `better-sqlite3`'s `prepare` observed, and writes the captured SQL to
 * `CAMSTACK_D481_CAPTURE` so the plans can be explained on a copy of the hub's
 * own database, where `sqlite_stat1` exists and the planner's choice between
 * two indexes that both fit is the real one. A hand-spelled statement would
 * assert a plan nobody runs (D447); a four-row temp database would answer with
 * no statistics at all.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/system'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeFakeStorageProvider, makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  MEDIA_COLLECTION,
  MediaStore,
  type MediaKind,
  type OwnerKind,
  slotTsFor,
} from '../media-store.js'

function clientOver(backend: SqliteSettingsBackend): SettingsStoreClient {
  return {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    insertMany: { mutate: (i: never) => backend.insertMany(i) },
    aggregate: { query: (i: never) => backend.aggregate(i) },
    histogram: { query: (i: never) => backend.histogram(i) },
    query: { query: (i: never) => backend.query(i) },
    count: { query: (i: never) => backend.count(i) },
    get: { query: (i: never) => backend.get(i) },
    set: { mutate: (i: never) => backend.set(i) },
    delete: { mutate: (i: never) => backend.delete(i) },
    updateWhere: { mutate: (i: never) => backend.updateWhere(i) },
  } as unknown as SettingsStoreClient
}

interface Capture {
  readonly path: string
  readonly sql: string
}

describe('D481 — capture every prepared statement against pipeline-analytics:media', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let store: SettingsStoreClient
  let mediaStore: MediaStore
  let captures: Capture[]
  let current: string
  let seen: string[]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'camstack-d481-capture-'))
    backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
    await backend.initialize()
    store = clientOver(backend)
    await MediaStore.declare(store)
    mediaStore = new MediaStore({
      storage: makeFakeStorageProvider(),
      store,
      logger: makeSilentLogger(),
    })
    await backend.insertMany({
      collection: MEDIA_COLLECTION,
      records: [
        row('m1', { locationId: 'loc-a', sizeBytes: 100, kind: 'thumbnail', ownerKind: 'track' }),
        row('m2', { locationId: 'loc-a', sizeBytes: 250, kind: 'snapshot', ownerKind: 'track' }),
        row('m3', { locationId: 'loc-b', sizeBytes: 1_000, kind: 'crop', ownerKind: 'face' }),
        row('m4', { locationId: null, sizeBytes: 7, kind: 'snapshot', ownerKind: 'motion' }),
      ],
    })

    captures = []
    current = 'setup'
    seen = []
    const original = Database.prototype.prepare
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      seen.push(sql)
      return original.call(this, sql)
    })
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    const out = process.env['CAMSTACK_D481_CAPTURE']
    if (out !== undefined && out.length > 0) {
      writeFileSync(out, `${JSON.stringify(captures, null, 2)}\n`)
    }
    await backend.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  function row(
    id: string,
    over: {
      readonly locationId: string | null
      readonly sizeBytes: number
      readonly kind: MediaKind
      readonly ownerKind: OwnerKind
    },
  ): { data: Record<string, unknown> } {
    const timestamp = 1_000
    return {
      data: {
        // No `id` field: the collection's primary key is now an
        // `INTEGER PRIMARY KEY` rowid alias (D482) that SQLite assigns —
        // `insertMany` drops any supplied `id` for an auto-key collection.
        deviceId: 104,
        ownerKind: over.ownerKind,
        ownerId: `t-${id}`,
        kind: over.kind,
        timestamp,
        // `NOT NULL`, and `insertMany` binds NULL (not the column default)
        // for an omitted field — must be supplied, computed the one way
        // production computes it.
        slotTs: slotTsFor({ kind: over.kind, timestamp }),
        path: `104/${id}.jpg`,
        sizeBytes: over.sizeBytes,
        locationId: over.locationId,
      },
    }
  }

  /** Run one read path and keep every statement it prepared against `media`. */
  async function capture(path: string, run: () => Promise<unknown>): Promise<void> {
    current = path
    seen = []
    await run()
    for (const sql of seen) {
      if (!sql.includes(MEDIA_COLLECTION)) continue
      if (captures.some((c) => c.sql === sql && c.path === current)) continue
      captures.push({ path: current, sql })
    }
  }

  it('captures the read paths', async () => {
    // ── MediaStore ───────────────────────────────────────────────────
    await capture('footprintByLocation', () => mediaStore.footprintByLocation(['loc-a', 'loc-b']))
    await capture('footprintByDevice', () => mediaStore.footprintByDevice())
    await capture('footprintByKind (fleet)', () => mediaStore.footprintByKind())
    await capture('footprintByKind (one camera)', () => mediaStore.footprintByKind(104))
    await capture('pageByKindForDevice (reclaim cursor)', () =>
      mediaStore.pageByKindForDevice({
        deviceId: 104,
        ownerKind: 'track',
        kind: 'snapshot',
        afterMs: 0,
        limit: 500,
      }),
    )
    await capture('listByOwner', () => mediaStore.listByOwner('track', 't-m1', 104))
    await capture('listByOwner (no device)', () => mediaStore.listByOwner('track', 't-m1'))
    await capture('listByOwner (kinds)', () =>
      mediaStore.listByOwner('track', 't-m1', 104, ['thumbnail', 'snapshot']),
    )
    await capture('listInfoByOwner', () => mediaStore.listInfoByOwner('track', 't-m1', 104))
    await capture('trackThumbnailProvenance', () =>
      mediaStore.trackThumbnailProvenance('t-m1', 104),
    )
    await capture('ownersWithMedia', () =>
      mediaStore.ownersWithMedia('track', ['t-m1', 't-m2'], 104),
    )
    await capture('getById', () => mediaStore.getById(1))
    await capture('pageForAudit', () => mediaStore.pageForAudit('track', 0, 500))
    await capture('pageForDevice', () => mediaStore.pageForDevice(104, 0, 500))
    await capture('relocateExemptMediaToGallery', () => mediaStore.relocateExemptMediaToGallery())

    // ── media-relocate-engine (seal gate) ────────────────────────────
    await capture('relocate: countUnstampedIn probe', () =>
      store.query.query({
        collection: MEDIA_COLLECTION,
        filter: { where: { locationId: null }, limit: 1 },
        columns: ['locationId'],
      }),
    )
    await capture('relocate: countUnstamped / sealable count', () =>
      store.count.query({
        collection: MEDIA_COLLECTION,
        filter: { where: { locationId: null } },
      }),
    )
    await capture('relocate: sealCollection batch', () =>
      store.query.query({
        collection: MEDIA_COLLECTION,
        filter: { where: { locationId: null }, limit: 500 },
        columns: ['locationId'],
      }),
    )
    await capture('relocate: pageRows (move/gallery census)', () =>
      store.query.query({
        collection: MEDIA_COLLECTION,
        filter: {
          whereBetween: { timestamp: [0, Number.MAX_SAFE_INTEGER] },
          orderBy: { field: 'timestamp', direction: 'asc' },
          limit: 500,
          offset: 0,
        },
      }),
    )

    // ── location-discard-job ─────────────────────────────────────────
    await capture('discard: deleteMediaRows page', () =>
      store.query.query({
        collection: MEDIA_COLLECTION,
        columns: ['id', 'ownerKind', 'ownerId'],
        filter: { where: { locationId: 'loc-a' }, limit: 500 },
      }),
    )
    await capture('discard: remainingMedia count', () =>
      store.count.query({
        collection: MEDIA_COLLECTION,
        filter: { where: { ownerKind: 'track', ownerId: 't-m1' } },
      }),
    )

    expect(captures.length).toBeGreaterThan(10)
  })
})
