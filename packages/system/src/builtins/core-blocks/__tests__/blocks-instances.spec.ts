/**
 * The Blocks integration keeps a name-only instance record under its registry id (epic #440),
 * over REAL SQLite: a first pass writes it, a later pass never overwrites it, and a hub that
 * minted the row before the record existed gains the record without touching the row.
 */
import {
  createRecordsAccess,
  type DeviceManagerApi,
  type IIntegrationInstancesProvider,
  type IScopedLogger,
  seedInstanceOnce,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { BLOCKS_INTEGRATION_NAME, reconcileBlocksIntegration } from '../blocks-integration.js'
import {
  blocksConnectionsEntryKind,
  blocksInstanceRecordKinds,
  buildBlocksInstances,
} from '../blocks-instances.js'

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Kit {
  readonly instances: IIntegrationInstancesProvider
  readonly rename: (id: string, name: string) => Promise<void>
  readonly reconcile: (existing: { id: string; name?: string } | null) => Promise<string | null>
  readonly createIntegration: ReturnType<typeof vi.fn>
}

async function makeKit(): Promise<Kit> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: world.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(blocksInstanceRecordKinds)
  const built = buildBlocksInstances(records)
  const instances = built.toProvider()
  const createIntegration = vi.fn(async () => ({ id: 'int_0024' }))
  // Documented type boundary (as in blocks-integration.spec): `core-blocks` declares no device, so
  // the primitive never reaches past `create` / `remove` / `getAll`.
  const devices = {
    create: vi.fn(),
    remove: vi.fn(),
    getAll: vi.fn(async () => []),
  } as unknown as DeviceManagerApi
  const reconcile = (existing: { id: string; name?: string } | null) =>
    reconcileBlocksIntegration({
      logger: silentLogger(),
      devices,
      localNodeId: 'hub',
      getIntegration: async () =>
        existing === null ? null : { ...existing, info: { fixed: true } },
      createIntegration,
      updateIntegration: async () => undefined,
      listOwnDevices: async () => [],
      seedInstance: async (seed) => {
        await seedInstanceOnce(instances, seed)
      },
    })
  const rename = async (id: string, name: string) => {
    await records.kind(blocksConnectionsEntryKind).patch(id, { name })
  }
  return { instances, rename, reconcile, createIntegration }
}

describe('the Blocks integration instance record', () => {
  let kit: Kit
  beforeEach(async () => {
    kit = await makeKit()
  })

  it('is written under the registry id on the pass that mints the row', async () => {
    expect(await kit.reconcile(null)).toBe('int_0024')
    const instance = await kit.instances.getInstance({ id: 'int_0024' })
    expect(instance).toMatchObject({ id: 'int_0024', name: BLOCKS_INTEGRATION_NAME })
  })

  it('is written for a row that predates it, under the name the row carries now', async () => {
    await kit.reconcile({ id: 'int_0024', name: 'My blocks' })
    expect(await kit.instances.getInstance({ id: 'int_0024' })).toMatchObject({ name: 'My blocks' })
    expect(kit.createIntegration).not.toHaveBeenCalled()
  })

  it('is never overwritten by a later pass', async () => {
    await kit.reconcile({ id: 'int_0024', name: BLOCKS_INTEGRATION_NAME })
    await kit.rename('int_0024', 'Renamed in the record')
    await kit.reconcile({ id: 'int_0024', name: BLOCKS_INTEGRATION_NAME })
    expect(await kit.instances.getInstance({ id: 'int_0024' })).toMatchObject({
      name: 'Renamed in the record',
    })
    expect(await kit.instances.listInstances()).toHaveLength(1)
  })

  it('carries no switch: the registry flag is the one store of a fixed builtin', async () => {
    await kit.reconcile({ id: 'int_0024' })
    const instance = await kit.instances.getInstance({ id: 'int_0024' })
    expect(instance?.formValues).not.toHaveProperty('enabled')
    const described = await kit.instances.describe()
    expect(described).toMatchObject({ role: 'devices', instanceMode: 'single' })
  })
})
