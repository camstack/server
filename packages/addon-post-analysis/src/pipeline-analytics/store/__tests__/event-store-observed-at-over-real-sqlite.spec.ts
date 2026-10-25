/**
 * `ObjectEvent.observedAt` — a pick-up's instant survives the WRITE (D684).
 *
 * Over the real `SqliteSettingsBackend`, because the failure this guards is a
 * backend one: an undeclared key is dropped WITHOUT ERROR
 * (`if (decl.columns.has(k))`), which is how `frameId` was written into the
 * void for years. A permissive fake would return the value production lost.
 *
 * And over a table that PREDATES the column: the hub's object-events table
 * already holds every pick-up ever written. `declareCollection` must add the
 * column in place, keep those rows, and they must keep reading as "moment
 * unknown" — absent, never 0.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ObjectEventDraft, SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type EventStoreLedgers,
  eventStoreLedgers,
  makeAnalyticsRecords,
} from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { EventStore, OBJECT_COLUMNS, OBJECT_EVENTS_COLLECTION } from '../event-store.js'

/**
 * The tRPC-shaped `SettingsStoreClient` over a real backend — the documented
 * test boundary `cascade-over-real-sqlite.spec.ts` uses: the generated client
 * type is a tRPC router, and only the procedures the stores call are modelled.
 */
function clientOver(backend: SqliteSettingsBackend): SettingsStoreClient {
  return {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    get: { query: (i: never) => backend.get(i) },
    set: { mutate: (i: never) => backend.set(i) },
    upsert: { mutate: (i: never) => backend.upsert(i) },
    insert: { mutate: (i: never) => backend.insert(i) },
    update: { mutate: (i: never) => backend.update(i) },
    delete: { mutate: (i: never) => backend.delete(i) },
    deleteWhere: { mutate: (i: never) => backend.deleteWhere(i) },
    query: { query: (i: never) => backend.query(i) },
    count: { query: (i: never) => backend.count(i) },
    isEmpty: { query: (i: never) => backend.isEmpty(i) },
  } as unknown as SettingsStoreClient
}

const DEVICE = 101
const PICKUP_AT = 1_790_000_000_000
const CONCLUDED_AT = PICKUP_AT + 300_000

function pickUpDraft(overrides: Partial<ObjectEventDraft> = {}): ObjectEventDraft {
  return {
    kind: 'object',
    deviceId: DEVICE,
    timestamp: CONCLUDED_AT,
    source: 'pipeline',
    idempotencyKey: 'package-picked-up:entry-1',
    trackId: 'trk-person',
    className: 'package',
    confidence: 1,
    state: 'left',
    observedAt: PICKUP_AT,
    ...overrides,
  }
}

describe('a pick-up row keeps its instant over the real SQLite store (D684)', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let store: SettingsStoreClient
  /** Motion and audio are records kinds; this spec is about the object table only. */
  let ledgers: EventStoreLedgers

  beforeEach(async () => {
    ledgers = eventStoreLedgers((await makeAnalyticsRecords()).records)
    dir = mkdtempSync(join(tmpdir(), 'camstack-observed-at-'))
    backend = new SqliteSettingsBackend(join(dir, 'test.db'))
    await backend.initialize()
    store = clientOver(backend)
  })

  afterEach(async () => {
    await backend.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips observedAt through every full read the NC and the timeline use', async () => {
    await EventStore.declareObjectCollection(store)
    const events = new EventStore({ store, logger: makeSilentLogger(), ...ledgers })
    const id = await events.insertObject(pickUpDraft())
    expect(id).not.toBeNull()

    const since = await events.queryObjectSince({ since: 0, until: CONCLUDED_AT + 1 })
    expect(since[0]?.observedAt).toBe(PICKUP_AT)
    // `timestamp` keeps its meaning: the conclusion.
    expect(since[0]?.timestamp).toBe(CONCLUDED_AT)
    const byDevice = await events.queryObject({ deviceId: DEVICE, classFilter: 'package' })
    expect(byDevice[0]?.observedAt).toBe(PICKUP_AT)
  })

  it('adds the column to a table that predates it, and the old rows read as unknown', async () => {
    // The table as every hub has it today: every column but `observedAt`.
    await store.declareCollection.mutate({
      collection: OBJECT_EVENTS_COLLECTION,
      columns: OBJECT_COLUMNS.filter((c) => c.name !== 'observedAt'),
    })
    const before = new EventStore({ store, logger: makeSilentLogger(), ...ledgers })
    const { observedAt: _absent, ...legacyDraft } = pickUpDraft()
    await before.insertObject(legacyDraft)

    // The upgrade: the addon boots and declares the collection as it is now.
    await EventStore.declareObjectCollection(store)
    const after = new EventStore({ store, logger: makeSilentLogger(), ...ledgers })
    await after.insertObject(pickUpDraft({ idempotencyKey: 'package-picked-up:entry-2' }))

    const rows = await after.queryObjectSince({ since: 0, until: CONCLUDED_AT + 1 })
    expect(rows).toHaveLength(2)
    const legacy = rows.find((r) => r.idempotencyKey === 'package-picked-up:entry-1')
    const fresh = rows.find((r) => r.idempotencyKey === 'package-picked-up:entry-2')
    // Absent — not 0, not null: "moment unknown" is what an old row IS.
    expect(legacy !== undefined && 'observedAt' in legacy).toBe(false)
    expect(fresh?.observedAt).toBe(PICKUP_AT)
  })
})
