/**
 * Unit tests for the data-door dispatcher — the `settings-store` provider
 * the storage orchestrator registers, which forwards every call to the
 * `data-store-provider` engine behind it (D44).
 *
 * What these pin, in order of how much a regression would cost:
 *
 *  1. **`namespace` is forwarded verbatim.** The engine composes its table
 *     name as `namespace ? `${namespace}:${collection}` : collection`, and
 *     the namespace arrives IN THE PAYLOAD — nothing consults the caller's
 *     identity. A dispatcher that injected, defaulted or dropped it would
 *     silently rename every table in the database.
 *  2. **No engine is an error, never a no-op.** A silent dispatcher would
 *     make every read return `undefined` and every write vanish — the
 *     "branch that drops work silently" the repo forbids.
 *  3. **Method parity with the cap.** Adding a method to `settings-store`
 *     without teaching the dispatcher would fail at the call site, in
 *     production, on whichever addon called it first.
 */

import {
  type IDataStoreProvider,
  type MutationFilter,
  settingsStoreCapability,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createDataStoreDispatch } from '../data-store-dispatch.js'

interface RecordedCall {
  readonly method: string
  readonly input: unknown
}

/**
 * An engine that records what it was handed and answers with a marker.
 * Every method is present because the cap requires it; none of them
 * interprets its input, which is the point — the dispatcher must not be
 * able to hide a mangled payload behind a helpful engine.
 */
function fakeEngine(engineId: string, calls: RecordedCall[]): IDataStoreProvider {
  const record =
    <T>(method: string, result: T) =>
    (input: unknown): Promise<T> => {
      calls.push({ method, input })
      return Promise.resolve(result)
    }
  return {
    getEngineInfo: () =>
      Promise.resolve({ engineId, kind: 'relational' as const, displayName: engineId }),
    get: record('get', `value-from-${engineId}`),
    set: record('set', undefined),
    query: record('query', []),
    insert: record('insert', { id: 1 }),
    upsert: record('upsert', { id: 1 }),
    insertMany: record('insertMany', { inserted: 0 }),
    upsertMany: record('upsertMany', { upserted: 0 }),
    transact: record('transact', { applied: true }),
    update: record('update', undefined),
    delete: record('delete', undefined),
    deleteWhere: record('deleteWhere', { deleted: 7 }),
    updateWhere: record('updateWhere', { updated: 3 }),
    count: record('count', 0),
    aggregate: record('aggregate', { count: 0, values: {} }),
    histogram: record('histogram', []),
    isEmpty: record('isEmpty', true),
    declareCollection: record('declareCollection', undefined),
  }
}

describe('createDataStoreDispatch', () => {
  it('forwards the namespace verbatim when the caller supplies one', async () => {
    const calls: RecordedCall[] = []
    const door = createDataStoreDispatch(() => [fakeEngine('sqlite', calls)])

    await door.get({ namespace: 'pipeline-analytics', collection: 'object-events', key: 'k' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({
      namespace: 'pipeline-analytics',
      collection: 'object-events',
      key: 'k',
    })
  })

  it('leaves the namespace ABSENT when the caller omits it — it must not default', async () => {
    const calls: RecordedCall[] = []
    const door = createDataStoreDispatch(() => [fakeEngine('sqlite', calls)])

    await door.set({ collection: 'addon-settings', key: 'root', value: { a: 1 } })

    const input = calls[0]?.input as Record<string, unknown>
    expect('namespace' in input).toBe(false)
  })

  it('returns what the engine returned', async () => {
    const door = createDataStoreDispatch(() => [fakeEngine('sqlite', [])])
    await expect(door.get({ collection: 'c', key: 'k' })).resolves.toBe('value-from-sqlite')
  })

  it('forwards a bulk delete verbatim and returns the engine’s row count', async () => {
    const calls: RecordedCall[] = []
    const door = createDataStoreDispatch(() => [fakeEngine('sqlite', calls)])
    const filter: MutationFilter = {
      where: { deviceId: 101 },
      whereBetween: { timestamp: [0, 99] },
    }

    await expect(
      door.deleteWhere({ namespace: 'pipeline-analytics', collection: 'object-events', filter }),
    ).resolves.toEqual({ deleted: 7 })

    expect(calls[0]?.input).toEqual({
      namespace: 'pipeline-analytics',
      collection: 'object-events',
      filter,
    })
  })

  it('throws — never resolves silently — when no engine is registered', async () => {
    const door = createDataStoreDispatch(() => [])
    await expect(door.get({ collection: 'c', key: 'k' })).rejects.toThrow(/data-store-provider/)
  })

  it('refuses to guess when several engines are registered', async () => {
    const calls: RecordedCall[] = []
    const door = createDataStoreDispatch(() => [
      fakeEngine('sqlite', calls),
      fakeEngine('vector', calls),
    ])
    await expect(door.get({ collection: 'c', key: 'k' })).rejects.toThrow(/engine/i)
    expect(calls).toHaveLength(0)
  })

  it('implements every method the settings-store cap declares', () => {
    const door: Readonly<Record<string, unknown>> = createDataStoreDispatch(() => [
      fakeEngine('sqlite', []),
    ])
    for (const name of Object.keys(settingsStoreCapability.methods)) {
      expect(typeof door[name]).toBe('function')
    }
  })
})

/**
 * The REMOTE behind the door — an agent, whose persistence is the hub's.
 *
 * A node with no local engine is not a broken node any more: it is an agent,
 * and the door has `createHubSettingsForward` behind it instead. What must
 * never happen is the reverse — a LOCAL engine losing to a remote. The local
 * engine is the hub's own store; a hub that forwarded would route its door
 * back into itself.
 */
describe('createDataStoreDispatch — the remote fallback', () => {
  it('uses the remote when this node registers no engine', async () => {
    const remoteCalls: RecordedCall[] = []
    const door = createDataStoreDispatch(
      () => [],
      () => fakeEngine('hub-forward', remoteCalls),
    )

    await expect(
      door.get({ namespace: 'native-metrics', collection: 'c', key: 'root' }),
    ).resolves.toBe('value-from-hub-forward')
    expect(remoteCalls[0]?.input).toEqual({
      namespace: 'native-metrics',
      collection: 'c',
      key: 'root',
    })
  })

  it('prefers the LOCAL engine whenever there is one — the remote is a fallback, not a policy', async () => {
    const localCalls: RecordedCall[] = []
    const remoteCalls: RecordedCall[] = []
    const door = createDataStoreDispatch(
      () => [fakeEngine('sqlite', localCalls)],
      () => fakeEngine('hub-forward', remoteCalls),
    )

    await expect(door.get({ collection: 'c', key: 'k' })).resolves.toBe('value-from-sqlite')
    expect(remoteCalls).toHaveLength(0)
  })

  it('still throws when there is neither an engine nor a remote', async () => {
    const door = createDataStoreDispatch(
      () => [],
      () => null,
    )
    await expect(door.get({ collection: 'c', key: 'k' })).rejects.toThrow(/data-store-provider/)
  })

  it('refuses to guess between several LOCAL engines even with a remote present', async () => {
    const remoteCalls: RecordedCall[] = []
    const door = createDataStoreDispatch(
      () => [fakeEngine('sqlite', []), fakeEngine('vector', [])],
      () => fakeEngine('hub-forward', remoteCalls),
    )
    await expect(door.get({ collection: 'c', key: 'k' })).rejects.toThrow(/routing rule/)
    expect(remoteCalls).toHaveLength(0)
  })
})
