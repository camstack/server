/**
 * `SqliteLocationStore` round-trip (SP1 node-aware storage).
 *
 * Focus: `nodeId` is persisted INSIDE the `config` blob under a reserved key
 * rather than in a dedicated `node_id` column. A new column would put the
 * table through `declareCollection`'s destructive rebuild and wipe operator
 * customizations such as `recordings:default`'s `minFreePercent`. The store
 * must:
 *   - round-trip the top-level `nodeId` field through the blob,
 *   - keep the reserved key OUT of the returned `config`,
 *   - leave `nodeId` undefined for locations persisted without one,
 *   - never declare a `node_id` column.
 *
 * Driven by a real in-memory `SqliteSettingsBackend`, not a fake. The fake
 * this replaces returned rows verbatim — `config` as the JSON STRING the
 * store had handed it — which is precisely what the collection surface does
 * NOT do (it parses JSON columns on read). It would have gone on passing
 * while production returned an empty config for every location.
 */

import type { StorageLocation } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import { SqliteLocationStore } from '../location-store.js'

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

describe('SqliteLocationStore — nodeId persisted in config blob', () => {
  let backend: SqliteSettingsBackend
  let store: SqliteLocationStore

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
    store = new SqliteLocationStore(backend)
  })

  it('does NOT persist a node_id column', async () => {
    await store.upsert(
      makeLocation({
        id: 'recordings:disk',
        type: 'recordings',
        providerId: 'filesystem-storage',
        nodeId: 'hub',
      }),
    )
    const rows = await backend.query({ collection: 'storage_locations' })
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]!.data).toSorted()).toEqual([
      'config',
      'created_at',
      'display_name',
      'id',
      'is_default',
      'is_system',
      'provider_id',
      'type',
      'updated_at',
    ])
  })

  it('round-trips a location WITH nodeId: top-level nodeId set, reserved key stripped from config', async () => {
    await store.upsert(
      makeLocation({
        id: 'recordings:disk',
        type: 'recordings',
        providerId: 'filesystem-storage',
        config: { basePath: '/data/rec', minFreePercent: 2 },
        nodeId: 'hub',
      }),
    )

    // The reserved key lives inside the persisted config blob — NOT a column.
    const rows = await backend.query({ collection: 'storage_locations' })
    expect(rows[0]!.data['config']).toEqual({
      basePath: '/data/rec',
      minFreePercent: 2,
      __nodeId: 'hub',
    })

    const [read] = await store.loadAll()
    expect(read).toBeDefined()
    expect(read!.nodeId).toBe('hub')
    // Consumers + provider see ONLY provider-facing keys.
    expect(read!.config).toEqual({ basePath: '/data/rec', minFreePercent: 2 })
    expect(read!.config).not.toHaveProperty('__nodeId')
  })

  it('round-trips a location WITHOUT nodeId: nodeId undefined, config has no reserved key', async () => {
    await store.upsert(
      makeLocation({
        id: 'backups:nas',
        type: 'backups',
        providerId: 'sftp-storage',
        config: { host: 'nas.local' },
      }),
    )

    const [read] = await store.loadAll()
    expect(read).toBeDefined()
    expect(read!.nodeId).toBeUndefined()
    expect(read!.config).toEqual({ host: 'nas.local' })
    expect(read!.config).not.toHaveProperty('__nodeId')
  })

  it('upsert overwrites a prior nodeId (re-stamped via the blob)', async () => {
    await store.upsert(
      makeLocation({
        id: 'recordings:disk',
        type: 'recordings',
        providerId: 'filesystem-storage',
        config: { basePath: '/data/rec' },
        nodeId: 'node-2',
      }),
    )
    await store.upsert(
      makeLocation({
        id: 'recordings:disk',
        type: 'recordings',
        providerId: 'filesystem-storage',
        config: { basePath: '/data/rec' },
        nodeId: 'hub',
      }),
    )

    const all = await store.loadAll()
    expect(all).toHaveLength(1)
    expect(all[0]!.nodeId).toBe('hub')
    expect(all[0]!.config).toEqual({ basePath: '/data/rec' })
  })

  it('preserves the remaining fields through the round trip', async () => {
    // `isDefault` no longer exists on `StorageLocation` (D383) — the write
    // path always persists `is_default: 0` (dead data, kept only because the
    // column is NOT NULL) regardless of what the caller sends, so it is not
    // asserted on here any more. See `PersistedStorageLocation` for the one
    // reader still allowed to look at that column: the boot migration.
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
    expect(read!.displayName).toBe('Logs')
    expect(read!.providerId).toBe('filesystem-storage')
    expect(read!.type).toBe('logs')
    expect(read!.isSystem).toBe(true)
    expect(read!.createdAt).toBe(1_700_000_000_000)
  })

  it('delete removes the row', async () => {
    await store.upsert(
      makeLocation({
        id: 'logs:default',
        type: 'logs',
        providerId: 'filesystem-storage',
        nodeId: 'hub',
      }),
    )
    expect((await store.loadAll()).length).toBe(1)
    await store.delete('logs:default')
    expect((await store.loadAll()).length).toBe(0)
  })

  // ── `enabled` rides the same reserved-key channel, for the same reason ──
  // A dedicated `enabled` COLUMN would trip `declareCollection`'s destructive
  // rebuild and wipe every operator customization on the table — the exact
  // failure the `__nodeId` comment above records. So the flag lives in the
  // blob under `__enabled` and is stripped from the returned `config`.
  it('round-trips enabled:false through the reserved config key', async () => {
    await store.upsert({
      ...makeLocation({
        id: 'recordings:nas',
        type: 'recordings',
        providerId: 'filesystem-storage',
        config: { basePath: '/mnt/nas' },
      }),
      enabled: false,
    })

    const rows = await backend.query({ collection: 'storage_locations' })
    expect(rows[0]!.data['config']).toEqual({ basePath: '/mnt/nas', __enabled: false })

    const [read] = await store.loadAll()
    expect(read!.enabled).toBe(false)
    expect(read!.config).toEqual({ basePath: '/mnt/nas' })
    expect(read!.config).not.toHaveProperty('__enabled')
  })

  it('round-trips enabled:true', async () => {
    await store.upsert({
      ...makeLocation({
        id: 'recordings:ssd',
        type: 'recordings',
        providerId: 'filesystem-storage',
      }),
      enabled: true,
    })
    const [read] = await store.loadAll()
    expect(read!.enabled).toBe(true)
  })

  it('a row persisted WITHOUT the flag reads back with enabled undefined — absent means active', async () => {
    // No migration ships with the flag: every pre-existing location keeps
    // working precisely because absent is not false.
    await store.upsert(
      makeLocation({
        id: 'recordings:legacy',
        type: 'recordings',
        providerId: 'filesystem-storage',
      }),
    )
    const [read] = await store.loadAll()
    expect(read!.enabled).toBeUndefined()
    expect(read!.config).not.toHaveProperty('__enabled')
  })

  it('still declares no extra column for enabled', async () => {
    await store.upsert({
      ...makeLocation({
        id: 'recordings:nas',
        type: 'recordings',
        providerId: 'filesystem-storage',
      }),
      enabled: false,
    })
    const rows = await backend.query({ collection: 'storage_locations' })
    expect(Object.keys(rows[0]!.data)).not.toContain('enabled')
  })

  it('skips a row whose type does not parse instead of failing the boot read', async () => {
    await store.upsert(
      makeLocation({ id: 'logs:default', type: 'logs', providerId: 'filesystem-storage' }),
    )
    await backend.insert({
      collection: 'storage_locations',
      record: {
        id: 'gone:archive',
        data: {
          // Violates the id format the type schema enforces.
          type: '9 not a type',
          display_name: 'Archive',
          provider_id: 'filesystem-storage',
          config: {},
          is_default: 0,
          is_system: 0,
          created_at: 1,
          updated_at: 1,
        },
      },
    })

    const all = await store.loadAll()
    expect(all.map((l) => l.id)).toEqual(['logs:default'])
  })
})
