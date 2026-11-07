/**
 * The credentials of a storage location move into the location's own record, on the REAL
 * records engine and a keychain double (planning#440 step 6, D879, D987).
 */
import {
  createRecordsAccess,
  createSecretsAccess,
  makeSecretMarker,
  type RecordKindHandle,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  makeFakeKeychain,
  makeRecordsWorld,
} from '../../../sqlite-storage/__tests__/support/records-world.js'
import {
  isOwnLocationMarker,
  legacyLocationSecretRef,
  locationSecretRef,
} from '../../location-secret-refs.js'
import { SqliteLocationStore } from '../../location-store.js'
import { type StorageLocationBody, storageOrchestratorRecordKinds } from '../../record-kinds.js'
import { LOCATION_SECRETS_TO_RECORD_MIGRATION } from '../index.js'
import { locationSecretPortsOver } from '../location-secret-ports.js'

const OWNER = 'storage-orchestrator'

function body(
  over: Partial<StorageLocationBody> & Pick<StorageLocationBody, 'config'>,
): StorageLocationBody {
  return {
    type: 'recordings',
    displayName: 'Place',
    providerId: 'filesystem-storage',
    isSystem: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

async function boot() {
  const world = makeRecordsWorld()
  await world.provider.init()
  const kc = makeFakeKeychain()
  const secrets = createSecretsAccess({ owner: OWNER, transport: kc })
  const records = createRecordsAccess({
    owner: OWNER,
    transport: world.transportFor(OWNER),
    secrets: secrets,
  })
  await records.declare(storageOrchestratorRecordKinds)
  const locations: RecordKindHandle<StorageLocationBody> =
    SqliteLocationStore.recordStoresOf(records)
  let refreshes = 0
  const ports = locationSecretPortsOver({
    locations,
    secrets,
    refreshLocations: async () => {
      refreshes += 1
    },
  })
  const run = () => {
    const entry = LOCATION_SECRETS_TO_RECORD_MIGRATION
    if (!('procedure' in entry)) throw new Error('procedure entry missing')
    return entry.procedure(ports)
  }
  /** A row written the way the old build did: the marker in `config`, the value under the row ref. */
  const seedLegacy = async (
    id: string,
    credentials: Readonly<Record<string, string>>,
    over: Partial<StorageLocationBody> & {
      config?: Record<string, unknown>
    } = {},
  ) => {
    const config: Record<string, unknown> = { ...over.config }
    for (const [key, value] of Object.entries(credentials)) {
      const ref = legacyLocationSecretRef(id, key)
      kc.values.set(ref, value)
      config[key] = makeSecretMarker(ref)
    }
    await locations.put({ id, data: body({ ...over, config }) })
  }
  return { locations, kc, run, seedLegacy, ports, refreshes: () => refreshes }
}

describe('location-secrets-to-record (real SQLite)', () => {
  it('moves an SFTP password to the record and reads it back equal, releasing the old ref', async () => {
    const { locations, kc, run, seedLegacy } = await boot()
    await seedLegacy(
      'sftp-1',
      { password: 'hunter2' },
      { config: { host: 'nas', minFreePercent: 7 } },
    )

    const result = await run()

    expect(result.outcome).toBe('done')
    const row = await locations.getResolved('sftp-1')
    expect(row?.data.secrets).toEqual({ password: 'hunter2' })
    expect(row?.data.config).toEqual({ host: 'nas', minFreePercent: 7 })
    expect(kc.values.has(legacyLocationSecretRef('sftp-1', 'password'))).toBe(false)
    expect(kc.values.get(locationSecretRef('sftp-1', 'password'))).toBe('hunter2')
    // The plain read never shows the value, only the marker the door stored.
    const plain = await locations.get('sftp-1')
    expect(JSON.stringify(plain)).not.toContain('hunter2')
    expect(isOwnLocationMarker('sftp-1', 'password', plain?.data.secrets?.password)).toBe(false)
  })

  it('leaves recordings:default and a drain row exactly as they were', async () => {
    const { locations, run, seedLegacy } = await boot()
    await seedLegacy(
      'recordings:default',
      {},
      { config: { path: '/data/rec', minFreePercent: 12 } },
    )
    await seedLegacy('old-nas', {}, { mode: 'drain', enabled: false, config: { path: '/mnt/old' } })
    await seedLegacy('sftp-1', { password: 'p' }, { config: { host: 'h' } })
    const before = await Promise.all([
      locations.get('recordings:default'),
      locations.get('old-nas'),
    ])

    await run()

    const after = await Promise.all([locations.get('recordings:default'), locations.get('old-nas')])
    expect(after.map((r) => r?.rev)).toEqual(before.map((r) => r?.rev))
    expect(after[0]?.data.config).toEqual({
      path: '/data/rec',
      minFreePercent: 12,
    })
    expect(after[0]?.data.secrets).toBeUndefined()
    expect(after[1]?.data.mode).toBe('drain')
  })

  it('is a no-op the second time', async () => {
    const { kc, run, seedLegacy, refreshes } = await boot()
    await seedLegacy('sftp-1', { password: 'p' }, { config: { host: 'h' } })
    await run()
    const puts = kc.puts.length
    const refreshed = refreshes()

    const again = await run()

    expect(again.outcome).toBe('already-done')
    expect(kc.puts.length).toBe(puts)
    expect(refreshes()).toBe(refreshed)
  })

  it('releases the legacy refs a crash left behind (patch applied, release never ran)', async () => {
    const { kc, run, seedLegacy, ports, locations } = await boot()
    await seedLegacy('sftp-1', { password: 'p1' }, { config: { host: 'h' } })
    await seedLegacy('sftp-2', { password: 'p2' }, { config: { host: 'h2' } })
    const entry = LOCATION_SECRETS_TO_RECORD_MIGRATION
    if (!('procedure' in entry)) throw new Error('procedure entry missing')
    // The hub dies after the patch of the first row, before its legacy value is released.
    await expect(
      entry.procedure({
        ...ports,
        releaseLegacy: async () => {
          throw new Error('hub restarted')
        },
      }),
    ).rejects.toThrow('hub restarted')
    expect(kc.values.has(legacyLocationSecretRef('sftp-1', 'password'))).toBe(true)
    expect((await locations.getResolved('sftp-1'))?.data.secrets).toEqual({ password: 'p1' })

    const again = await run()

    expect(again.outcome).toBe('done')
    expect(kc.values.has(legacyLocationSecretRef('sftp-1', 'password'))).toBe(false)
    expect(kc.values.has(legacyLocationSecretRef('sftp-2', 'password'))).toBe(false)
    expect(kc.values.get(locationSecretRef('sftp-1', 'password'))).toBe('p1')
    expect(kc.values.get(locationSecretRef('sftp-2', 'password'))).toBe('p2')
    expect((await run()).outcome).toBe('already-done')
  })

  it('does not release a legacy ref whose record credential cannot be read back', async () => {
    const { kc, seedLegacy, ports } = await boot()
    await seedLegacy('sftp-1', { password: 'p1' }, { config: { host: 'h' } })
    const entry = LOCATION_SECRETS_TO_RECORD_MIGRATION
    if (!('procedure' in entry)) throw new Error('procedure entry missing')
    await entry.procedure(ports)
    // A stray legacy value reappears while the record's own credential no longer resolves.
    kc.values.set(legacyLocationSecretRef('sftp-1', 'password'), 'p1')

    const again = await entry.procedure({
      ...ports,
      readMoved: async () => {
        throw new Error('the secret cannot be served (missing)')
      },
    })

    expect(again.outcome).toBe('already-done')
    expect(kc.values.has(legacyLocationSecretRef('sftp-1', 'password'))).toBe(true)
  })

  it('writes nothing when a read fails (a locked keychain)', async () => {
    const { locations, kc, run, seedLegacy } = await boot()
    await seedLegacy('sftp-1', { password: 'p' }, { config: { host: 'h' } })
    const before = await locations.get('sftp-1')
    kc.locked = true

    await expect(run()).rejects.toThrow(/nothing was moved/)

    kc.locked = false
    expect((await locations.get('sftp-1'))?.rev).toBe(before?.rev)
    expect(kc.values.get(legacyLocationSecretRef('sftp-1', 'password'))).toBe('p')
    expect(kc.puts).toEqual([])
  })

  it('moves no row when only ONE credential of another row is gone', async () => {
    const { locations, kc, run, seedLegacy } = await boot()
    await seedLegacy('a', { password: 'pa' }, { config: { host: 'a' } })
    await seedLegacy('b', { password: 'pb' }, { config: { host: 'b' } })
    kc.values.delete(legacyLocationSecretRef('b', 'password'))
    const revs = (await Promise.all([locations.get('a'), locations.get('b')])).map((r) => r?.rev)

    await expect(run()).rejects.toThrow(/b\.password/)

    const after = (await Promise.all([locations.get('a'), locations.get('b')])).map((r) => r?.rev)
    expect(after).toEqual(revs)
    expect(kc.puts).toEqual([])
  })
})
