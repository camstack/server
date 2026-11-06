/**
 * `SqliteLocationStore` round-trip on the storage-orchestrator's record kinds (SP1 node-aware
 * storage): the location body carries `nodeId`, `enabled` and `mode` as typed fields, the
 * `config` comes back without any reserved key.
 */

import { createRecordsAccess, createSecretsAccess, type StorageLocation } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  makeFakeKeychain,
  makeRecordsWorld,
} from '../../sqlite-storage/__tests__/support/records-world.js'
import { SqliteLocationStore } from '../location-store.js'
import { storageOrchestratorRecordKinds } from '../record-kinds.js'

function makeLocation(input: {
  id: string
  type: StorageLocation['type']
  providerId: string
  config?: Record<string, unknown>
  nodeId?: string
}): StorageLocation {
  const now = 1_700_000_000_000
  return {
    id: input.id,
    type: input.type,
    displayName: input.id,
    providerId: input.providerId,
    config: input.config ?? {},
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    isSystem: false,
    createdAt: now,
    updatedAt: now,
  }
}

describe('SqliteLocationStore on the locations record kind', () => {
  let store: SqliteLocationStore

  beforeEach(async () => {
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'storage-orchestrator',
      transport: world.transportFor('storage-orchestrator'),
      secrets: createSecretsAccess({
        owner: 'storage-orchestrator',
        transport: makeFakeKeychain(),
      }),
    })
    await records.declare(storageOrchestratorRecordKinds)
    store = new SqliteLocationStore(
      SqliteLocationStore.recordStoresOf(records),
      SqliteLocationStore.seedMarkersOf(records),
    )
  })

  it('round-trips a location WITH nodeId and keeps the config provider-facing only', async () => {
    await store.upsert(
      makeLocation({
        id: 'recordings:disk',
        type: 'recordings',
        providerId: 'filesystem-storage',
        config: { basePath: '/data/rec', minFreePercent: 2 },
        nodeId: 'hub',
      }),
    )
    const [read] = await store.loadAll()
    expect(read?.nodeId).toBe('hub')
    expect(read?.config).toEqual({ basePath: '/data/rec', minFreePercent: 2 })
  })

  it('round-trips a location WITHOUT nodeId', async () => {
    await store.upsert(
      makeLocation({
        id: 'backups:nas',
        type: 'backups',
        providerId: 'sftp-storage',
        config: { host: 'nas.local' },
      }),
    )
    const [read] = await store.loadAll()
    expect(read?.nodeId).toBeUndefined()
    expect(read?.config).toEqual({ host: 'nas.local' })
  })

  it('upsert overwrites a prior nodeId', async () => {
    for (const nodeId of ['node-2', 'hub']) {
      await store.upsert(
        makeLocation({
          id: 'recordings:disk',
          type: 'recordings',
          providerId: 'filesystem-storage',
          config: { basePath: '/data/rec' },
          nodeId,
        }),
      )
    }
    const all = await store.loadAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.nodeId).toBe('hub')
  })

  it('preserves the remaining fields through the round trip', async () => {
    await store.upsert({
      ...makeLocation({
        id: 'logs:default',
        type: 'logs',
        providerId: 'filesystem-storage',
      }),
      displayName: 'Logs',
      isSystem: true,
    })
    const [read] = await store.loadAll()
    expect(read?.displayName).toBe('Logs')
    expect(read?.providerId).toBe('filesystem-storage')
    expect(read?.type).toBe('logs')
    expect(read?.isSystem).toBe(true)
    expect(read?.createdAt).toBe(1_700_000_000_000)
  })

  it('delete removes the row', async () => {
    await store.upsert(
      makeLocation({
        id: 'logs:default',
        type: 'logs',
        providerId: 'filesystem-storage',
      }),
    )
    expect((await store.loadAll()).length).toBe(1)
    await store.delete('logs:default')
    expect((await store.loadAll()).length).toBe(0)
  })

  it('round-trips enabled:false and enabled:true', async () => {
    await store.upsert({
      ...makeLocation({
        id: 'recordings:nas',
        type: 'recordings',
        providerId: 'fs',
      }),
      enabled: false,
    })
    await store.upsert({
      ...makeLocation({
        id: 'recordings:ssd',
        type: 'recordings',
        providerId: 'fs',
      }),
      enabled: true,
    })
    const byId = new Map((await store.loadAll()).map((l) => [l.id, l]))
    expect(byId.get('recordings:nas')?.enabled).toBe(false)
    expect(byId.get('recordings:ssd')?.enabled).toBe(true)
  })

  it('round-trips the typed mode', async () => {
    await store.upsert({
      ...makeLocation({
        id: 'recordings:old',
        type: 'recordings',
        providerId: 'fs',
      }),
      mode: 'drain',
    })
    const [read] = await store.loadAll()
    expect(read?.mode).toBe('drain')
  })

  it('a row persisted WITHOUT the flag reads back with enabled undefined - absent means active', async () => {
    await store.upsert(
      makeLocation({
        id: 'recordings:legacy',
        type: 'recordings',
        providerId: 'fs',
      }),
    )
    const [read] = await store.loadAll()
    expect(read?.enabled).toBeUndefined()
  })
})
