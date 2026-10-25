/**
 * Account preferences (D894) against the REAL records engine: one row per
 * (user, namespace), owner-isolated, compare-and-set on `baseRevision`, the
 * limits, the poll, and the wipes.
 *
 * Disarm checks (each was run):
 *   - drop the owner from the record id (`userPreferenceRecordId`) → the
 *     isolation and wipe cases fail;
 *   - drop the `baseRevision` comparison in `put` → the conflict cases write;
 *   - drop the namespace-count check → the 33rd namespace is stored;
 *   - make `changedSince` return every row → the "nothing changed" case fails.
 */
import {
  createRecordsAccess,
  PREFERENCES_MAX_NAMESPACES,
  PREFERENCES_MAX_VALUE_BYTES,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { localAuthPreferencesRecordKinds } from '../preferences-record-kinds.js'
import { preferencesLimitReasonOf, UserPreferencesStore } from '../user-preferences-store.js'

async function storeWorld(): Promise<UserPreferencesStore> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'local-auth',
    transport: world.transportFor('local-auth'),
    secrets: null,
  })
  await records.declare(localAuthPreferencesRecordKinds)
  let clock = 1_000
  return new UserPreferencesStore(
    records.kind(localAuthPreferencesRecordKinds['user-preferences']),
    { now: () => ++clock },
  )
}

async function limitOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error: unknown) {
    return preferencesLimitReasonOf(error)
  }
}

describe('UserPreferencesStore — owner isolation', () => {
  it("B never reads, overwrites or deletes A's rows", async () => {
    const store = await storeWorld()
    await store.put('user-a', { namespace: 'viewer.app', value: { theme: 'dark' } })

    expect(await store.get('user-b')).toEqual([])
    expect(await store.get('user-b', ['viewer.app'])).toEqual([])
    expect((await store.changedSince('user-b', {})).rows).toEqual([])

    // B writing the SAME namespace makes B's own row; A's is untouched.
    await store.put('user-b', { namespace: 'viewer.app', value: { theme: 'light' } })
    expect(await store.delete('user-b', 'viewer.app')).toBe(true)
    expect(await store.delete('user-b', 'viewer.app')).toBe(false)

    const a = await store.get('user-a')
    expect(a).toHaveLength(1)
    expect(a[0]?.value).toEqual({ theme: 'dark' })
    expect(a[0]?.revision).toBe(1)
  })
})

describe('UserPreferencesStore — revisions and conflicts', () => {
  it('stamps revision, updatedAt and the writing device', async () => {
    const store = await storeWorld()
    const first = await store.put('u', {
      namespace: 'viewer.grids',
      value: { n: 1 },
      deviceId: 'phone-1',
    })
    expect(first.status).toBe('saved')
    const second = await store.put('u', { namespace: 'viewer.grids', value: { n: 2 } })
    expect(second).toEqual({
      status: 'saved',
      row: {
        namespace: 'viewer.grids',
        value: { n: 2 },
        revision: 2,
        updatedAt: expect.any(Number),
        updatedByDevice: null,
      },
    })
  })

  it('a stale baseRevision answers conflict with the current row and writes nothing', async () => {
    const store = await storeWorld()
    await store.put('u', { namespace: 'viewer.app', value: { v: 'a' }, deviceId: 'tablet' })
    const ok = await store.put('u', {
      namespace: 'viewer.app',
      value: { v: 'b' },
      baseRevision: 1,
      deviceId: 'phone',
    })
    expect(ok.status).toBe('saved')

    const stale = await store.put('u', {
      namespace: 'viewer.app',
      value: { v: 'lost' },
      baseRevision: 1,
    })
    expect(stale.status).toBe('conflict')
    if (stale.status !== 'conflict') throw new Error('unreachable')
    expect(stale.current?.revision).toBe(2)
    expect(stale.current?.value).toEqual({ v: 'b' })
    expect(stale.current?.updatedByDevice).toBe('phone')
    expect((await store.get('u'))[0]?.value).toEqual({ v: 'b' })
  })

  it('baseRevision 0 means "must not exist"; a deleted row conflicts with current null', async () => {
    const store = await storeWorld()
    expect((await store.put('u', { namespace: 'n1', value: {}, baseRevision: 0 })).status).toBe(
      'saved',
    )
    expect((await store.put('u', { namespace: 'n1', value: {}, baseRevision: 0 })).status).toBe(
      'conflict',
    )
    await store.delete('u', 'n1')
    expect(await store.put('u', { namespace: 'n1', value: {}, baseRevision: 1 })).toEqual({
      status: 'conflict',
      current: null,
    })
  })
})

describe('UserPreferencesStore — limits', () => {
  it('refuses a value over 256 KiB and stores nothing', async () => {
    const store = await storeWorld()
    const big = { blob: 'x'.repeat(PREFERENCES_MAX_VALUE_BYTES) }
    expect(await limitOf(store.put('u', { namespace: 'viewer.app', value: big }))).toBe(
      'value-too-large',
    )
    expect(await store.get('u')).toEqual([])
  })

  it('refuses the 33rd namespace but still updates an existing one', async () => {
    const store = await storeWorld()
    for (let i = 0; i < PREFERENCES_MAX_NAMESPACES; i++) {
      await store.put('u', { namespace: `ns-${i}`, value: { i } })
    }
    expect(await limitOf(store.put('u', { namespace: 'one-too-many', value: {} }))).toBe(
      'too-many-namespaces',
    )
    expect((await store.put('u', { namespace: 'ns-0', value: { i: 'again' } })).status).toBe(
      'saved',
    )
    // The limit is per user: another account starts empty.
    expect((await store.put('other', { namespace: 'one-too-many', value: {} })).status).toBe(
      'saved',
    )
    expect(await store.get('u')).toHaveLength(PREFERENCES_MAX_NAMESPACES)
  })
})

describe('UserPreferencesStore — changedSince', () => {
  it('answers only what the client is missing', async () => {
    const store = await storeWorld()
    await store.put('u', { namespace: 'viewer.app', value: { a: 1 } })
    await store.put('u', { namespace: 'viewer.cameras', value: { c: 1 } })

    expect(await store.changedSince('u', { 'viewer.app': 1, 'viewer.cameras': 1 })).toEqual({
      rows: [],
      deleted: [],
    })

    await store.put('u', { namespace: 'viewer.cameras', value: { c: 2 }, deviceId: 'tablet' })
    await store.put('u', { namespace: 'viewer.grids', value: { g: 1 } })
    await store.delete('u', 'viewer.app')

    const delta = await store.changedSince('u', { 'viewer.app': 1, 'viewer.cameras': 1 })
    expect(delta.deleted).toEqual(['viewer.app'])
    expect(delta.rows.map((r) => [r.namespace, r.revision])).toEqual([
      ['viewer.cameras', 2],
      ['viewer.grids', 1],
    ])
  })
})

describe('UserPreferencesStore — wipes', () => {
  it("wipeUser removes every row of that user and nobody else's", async () => {
    const store = await storeWorld()
    await store.put('gone', { namespace: 'viewer.app', value: {} })
    await store.put('gone', { namespace: 'viewer.grids', value: {} })
    await store.put('kept', { namespace: 'viewer.app', value: {} })

    expect(await store.wipeUser('gone')).toBe(2)
    expect(await store.get('gone')).toEqual([])
    expect(await store.changedSince('gone', {})).toEqual({ rows: [], deleted: [] })
    expect(await store.get('kept')).toHaveLength(1)
  })

  it('wipeOrphans removes the rows of users that no longer exist', async () => {
    const store = await storeWorld()
    await store.put('ghost', { namespace: 'viewer.app', value: {} })
    await store.put('alive', { namespace: 'viewer.app', value: {} })
    expect(await store.wipeOrphans(new Set(['alive']))).toBe(1)
    expect(await store.get('ghost')).toEqual([])
    expect(await store.get('alive')).toHaveLength(1)
  })
})
