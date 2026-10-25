/**
 * `RowMapStore` — the primitive that turns a `Record<key, T>` settings blob
 * into one row per entry.
 *
 * Every assertion here is about a property the BLOB could not have:
 *   - reading one entry costs ONE keyed read, not a parse of every entry;
 *   - writing one entry touches ONE row, so a concurrent writer on another key
 *     cannot be clobbered by a stale snapshot;
 *   - a single unparseable entry costs THAT entry, not the whole map (the blob
 *     fell back to `{}` — every camera silently unconfigured);
 *   - a truncated fleet read is LOUD.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { IScopedLogger } from '@camstack/types'
import { RowMapStore, type RowMapSpec } from '../row-map-store.js'
import { callsOn, makeSettingsStoreApi, type FakeSettingsStore } from './settings-store-api.js'

const COLLECTION = 'recorder:test-rows'

const ThingSchema = z.object({ deviceId: z.number().int(), label: z.string() })
type Thing = z.infer<typeof ThingSchema>

interface Recorded {
  readonly message: string
  readonly extras: unknown
}

function recordingLogger(warns: Recorded[]): IScopedLogger {
  const noop = (): void => {}
  const logger = {
    debug: noop,
    info: noop,
    warn: (message: string, extras?: unknown) => warns.push({ message, extras }),
    error: noop,
    child: () => logger,
  }
  // Documented type boundary: the specs only ever exercise `warn`.
  return logger as unknown as IScopedLogger
}

function spec(overrides: Partial<RowMapSpec<Thing>> = {}): RowMapSpec<Thing> {
  return {
    collection: COLLECTION,
    schema: ThingSchema,
    columns: [{ name: 'deviceId', type: 'INTEGER', notNull: true }],
    indexes: [{ name: 'idx_test_rows_device', columns: ['deviceId'] }],
    project: (_key, value) => ({ deviceId: value.deviceId }),
    deviceIdColumn: 'deviceId',
    loadLimit: 100,
    ...overrides,
  }
}

async function freshStore(
  warns: Recorded[] = [],
  overrides: Partial<RowMapSpec<Thing>> = {},
): Promise<{ readonly rows: RowMapStore<Thing>; readonly api: FakeSettingsStore }> {
  const api = await makeSettingsStoreApi()
  const rows = new RowMapStore<Thing>({
    spec: spec(overrides),
    store: api.api,
    logger: recordingLogger(warns),
  })
  await rows.declare()
  return { rows, api }
}

describe('RowMapStore', () => {
  it('round-trips one entry through one keyed read', async () => {
    const { rows, api } = await freshStore()
    await rows.write('101', { deviceId: 101, label: 'front door' })

    const before = api.calls.length
    expect(await rows.read('101')).toEqual({ deviceId: 101, label: 'front door' })

    // ONE keyed get. The blob answered this with a parse of every entry.
    expect(callsOn(api, COLLECTION, before)).toEqual([
      { op: 'get', collection: COLLECTION, key: '101' },
    ])
  })

  it('answers null for a key it never held', async () => {
    const { rows } = await freshStore()
    expect(await rows.read('404')).toBeNull()
  })

  it('writes one row per entry and never touches its siblings', async () => {
    const { rows, api } = await freshStore()
    await rows.write('101', { deviceId: 101, label: 'a' })
    const before = api.calls.length
    await rows.write('102', { deviceId: 102, label: 'b' })

    expect(callsOn(api, COLLECTION, before)).toEqual([
      { op: 'set', collection: COLLECTION, key: '102' },
    ])
    expect(await rows.read('101')).toEqual({ deviceId: 101, label: 'a' })
  })

  it('reads the whole map with an explicit bound', async () => {
    const { rows } = await freshStore()
    await rows.write('1', { deviceId: 1, label: 'one' })
    await rows.write('2', { deviceId: 2, label: 'two' })

    const all = await rows.readAll()
    expect([...all.keys()].toSorted()).toEqual(['1', '2'])
    expect(all.get('2')).toEqual({ deviceId: 2, label: 'two' })
  })

  it('projects a declared column so a per-device question is an indexed query', async () => {
    const { rows, api } = await freshStore()
    await rows.write('101/low', { deviceId: 101, label: 'low' })
    await rows.write('102/low', { deviceId: 102, label: 'low' })

    const found = await api.backend.query({
      collection: COLLECTION,
      filter: { where: { deviceId: 102 }, limit: 10 },
    })
    expect(found.map((r) => r.id)).toEqual(['102/low'])
  })

  it('SKIPS one unparseable row and keeps the rest — the blob lost everything', async () => {
    const warns: Recorded[] = []
    const { rows, api } = await freshStore(warns)
    await rows.write('good', { deviceId: 1, label: 'kept' })
    // A row written by an older build whose shape no longer parses.
    await api.backend.set({
      collection: COLLECTION,
      key: 'bad',
      value: { deviceId: 2, value: { deviceId: 'not-a-number' } },
    })

    const all = await rows.readAll()
    expect([...all.keys()]).toEqual(['good'])
    expect(warns.map((w) => w.message)).toContain('row-map rows skipped as unparseable')
  })

  it('a read of ONE unparseable row answers null and says so', async () => {
    const warns: Recorded[] = []
    const { rows, api } = await freshStore(warns)
    await api.backend.set({
      collection: COLLECTION,
      key: 'bad',
      value: { deviceId: 2, value: { nope: true } },
    })
    expect(await rows.read('bad')).toBeNull()
    expect(warns.map((w) => w.message)).toContain('row-map row skipped as unparseable')
  })

  it('WARNS when the bounded read comes back full — a truncated map is silent otherwise', async () => {
    const warns: Recorded[] = []
    const { rows } = await freshStore(warns, { loadLimit: 2 })
    await rows.write('1', { deviceId: 1, label: 'a' })
    await rows.write('2', { deviceId: 2, label: 'b' })
    await rows.write('3', { deviceId: 3, label: 'c' })

    const all = await rows.readAll()
    expect(all.size).toBe(2)
    expect(warns.map((w) => w.message)).toContain(
      'row-map read hit its own bound — the map may be truncated',
    )
  })

  it('removes one entry', async () => {
    const { rows } = await freshStore()
    await rows.write('101', { deviceId: 101, label: 'a' })
    await rows.remove('101')
    expect(await rows.read('101')).toBeNull()
  })

  it('replaceAll deletes the keys the authoritative map no longer holds, and says how many', async () => {
    const warns: Recorded[] = []
    const { rows } = await freshStore(warns)
    await rows.write('a', { deviceId: 1, label: 'a' })
    await rows.write('b', { deviceId: 2, label: 'b' })

    const removed = await rows.replaceAll(new Map([['a', { deviceId: 1, label: 'a2' }]]))

    expect(removed).toBe(1)
    expect([...(await rows.readAll()).keys()]).toEqual(['a'])
    expect(await rows.read('a')).toEqual({ deviceId: 1, label: 'a2' })
    // Dropped work is never silent.
    expect(warns.map((w) => w.message)).toContain('row-map replaceAll dropped rows')
  })

  it('replaceAll with the same set deletes nothing and logs nothing', async () => {
    const warns: Recorded[] = []
    const { rows } = await freshStore(warns)
    await rows.write('a', { deviceId: 1, label: 'a' })

    expect(await rows.replaceAll(new Map([['a', { deviceId: 1, label: 'a' }]]))).toBe(0)
    expect(warns).toEqual([])
  })

  it('tags every device-scoped warning with the numeric deviceId', async () => {
    const warns: Recorded[] = []
    const { rows, api } = await freshStore(warns)
    await api.backend.set({
      collection: COLLECTION,
      key: 'bad',
      value: { deviceId: 102, value: { nope: true } },
    })
    await rows.read('bad')

    const warn = warns.find((w) => w.message === 'row-map row skipped as unparseable')
    expect(warn?.extras).toMatchObject({ tags: { deviceId: 102 } })
  })
})

describe('RowMapStore query surface', () => {
  it('readWhere answers a projected-column question, ordered and bounded', async () => {
    const { rows } = await freshStore()
    await rows.write('a', { deviceId: 101, label: 'first' })
    await rows.write('b', { deviceId: 102, label: 'other' })
    await rows.write('c', { deviceId: 101, label: 'second' })

    const found = await rows.readWhere({
      where: { deviceId: 101 },
      orderBy: { field: 'id', direction: 'asc' },
      limit: 10,
    })
    expect(found.map((e) => e.key)).toEqual(['a', 'c'])
    expect(found.map((e) => e.value.label)).toEqual(['first', 'second'])
  })

  it('readWhere honours offset — the cursor a retention trim needs', async () => {
    const { rows } = await freshStore()
    await rows.write('a', { deviceId: 1, label: 'a' })
    await rows.write('b', { deviceId: 2, label: 'b' })
    await rows.write('c', { deviceId: 3, label: 'c' })

    const found = await rows.readWhere({
      orderBy: { field: 'deviceId', direction: 'desc' },
      limit: 1,
      offset: 1,
    })
    expect(found.map((e) => e.key)).toEqual(['b'])
  })

  it('count answers without materialising a row', async () => {
    const { rows } = await freshStore()
    await rows.write('a', { deviceId: 1, label: 'a' })
    await rows.write('b', { deviceId: 2, label: 'b' })
    expect(await rows.count()).toBe(2)
    expect(await rows.count({ where: { deviceId: 2 } })).toBe(1)
  })

  it('deleteWhere trims a bounded range in one statement and reports the count', async () => {
    const warns: Recorded[] = []
    const { rows } = await freshStore(warns)
    await rows.write('a', { deviceId: 10, label: 'a' })
    await rows.write('b', { deviceId: 20, label: 'b' })
    await rows.write('c', { deviceId: 30, label: 'c' })

    const deleted = await rows.deleteWhere({ whereBetween: { deviceId: [0, 20] } })
    expect(deleted).toBe(2)
    expect([...(await rows.readAll()).keys()]).toEqual(['c'])
    expect(warns.map((w) => w.message)).toContain('row-map deleteWhere dropped rows')
  })
})
