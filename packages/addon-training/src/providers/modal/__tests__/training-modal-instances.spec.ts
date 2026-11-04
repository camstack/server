/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import {
  type IIntegrationInstancesProvider,
  integrationInstancesCapability,
  makeInMemoryRecords,
  trainingProviderCapability,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrainingModalAddon } from '../training-modal.addon.js'
import {
  type TrainingAccountBody,
  trainingAccountEntryKind,
} from '../training-account-record-kinds.js'

function logger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

const BODY: Omit<TrainingAccountBody, 'name'> = {
  tokenId: 'ak-home',
  tokenSecret: 'as-SECRET',
  environment: '',
  gpuType: 'L4',
  region: '',
  costCapUsd: 5,
  maxRuntimeHours: 4,
  failedDatasetGraceHours: 24,
}
const HOME_ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const LAB_ID = 'a1b2c3d4-0000-4000-8000-000000000002'

interface TrainingView {
  listEntries(
    input: Record<string, never>,
  ): Promise<readonly { entryId: string; configured: boolean }[]>
  describe(input: Record<string, never>): Promise<readonly { entryId: string }[]>
}

async function boot(seed: readonly { id: string; body: TrainingAccountBody }[]) {
  const world = makeInMemoryRecords('training-modal')
  await world.records.declare({ 'training-account': trainingAccountEntryKind })
  const handle = world.records.kind(trainingAccountEntryKind)
  for (const row of seed) await handle.put({ id: row.id, data: row.body }, { ifRev: 0 })
  const ctx = {
    id: 'training-modal',
    logger: logger(),
    records: world.records,
    peerBytes: { open: vi.fn(), offer: vi.fn() },
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: {} })),
      writeAddonStore: vi.fn(async () => undefined),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId: 'hub' },
    api: {
      migrations: {
        declareOwner: { mutate: vi.fn(async () => ({ bootId: 'b', snapshot: 'none', steps: [] })) },
        startMigration: { mutate: vi.fn() },
        finishMigration: { mutate: vi.fn() },
      },
    },
  } as unknown as AddonContext
  const addon = new TrainingModalAddon()
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  const training = registrations.find((r) => r.capability.name === trainingProviderCapability.name)
  const instances = registrations.find(
    (r) => r.capability.name === integrationInstancesCapability.name,
  )
  if (training === undefined || instances === undefined) throw new Error('providers missing')
  return {
    addon,
    training: training.provider as TrainingView,
    instances: instances.provider as IIntegrationInstancesProvider,
  }
}

const SEED = [
  { id: HOME_ID, body: { name: 'Home account', ...BODY } },
  { id: LAB_ID, body: { name: 'Lab', ...BODY, tokenId: 'ak-lab', tokenSecret: 'as-LAB' } },
]

describe('TrainingModalAddon: the accounts are integration instances (D996)', () => {
  const addons: TrainingModalAddon[] = []
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('describes itself as a multiple-instance addon that mints ids and can test', async () => {
    const w = await boot(SEED)
    addons.push(w.addon)
    await expect(w.instances.describe()).resolves.toMatchObject({
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      mintsId: true,
    })
    expect((await w.instances.listInstances()).map((i) => i.id).sort()).toEqual([HOME_ID, LAB_ID])
  })

  it('the training-provider cap serves the same accounts under their record ids', async () => {
    const w = await boot(SEED)
    addons.push(w.addon)
    const entries = await w.training.listEntries({})
    expect(entries.map((e) => e.entryId).sort()).toEqual([HOME_ID, LAB_ID])
    expect(entries.every((e) => e.configured)).toBe(true)
  })

  it('creating through the instance cap mints an id and the provider lists it', async () => {
    const w = await boot(SEED)
    addons.push(w.addon)
    const { id } = await w.instances.createInstance({ name: 'Second lab' })
    expect(id).not.toBe(HOME_ID)
    const entries = await w.training.listEntries({})
    expect(entries.find((e) => e.entryId === id)).toMatchObject({ configured: false })
  })

  it('a switched-off account is not offered for a job; switching it on offers it again', async () => {
    const w = await boot(SEED)
    addons.push(w.addon)
    await w.instances.setInstanceEnabled({ id: LAB_ID, enabled: false })
    expect((await w.training.listEntries({})).map((e) => e.entryId)).toEqual([HOME_ID])
    await w.instances.setInstanceEnabled({ id: LAB_ID, enabled: true })
    expect(await w.training.listEntries({})).toHaveLength(2)
  })

  it('deleting an account removes it from the provider', async () => {
    const w = await boot(SEED)
    addons.push(w.addon)
    await w.instances.deleteInstance({ id: LAB_ID })
    expect((await w.training.listEntries({})).map((e) => e.entryId)).toEqual([HOME_ID])
  })

  it('the token secret never leaves the record through the instance view', async () => {
    const w = await boot(SEED)
    addons.push(w.addon)
    expect(JSON.stringify(await w.instances.listInstances())).not.toContain('as-SECRET')
    expect(JSON.stringify(await w.instances.getInstance({ id: HOME_ID }))).not.toContain(
      'as-SECRET',
    )
  })

  it('testInstance without a token answers inconclusive and never echoes a secret', async () => {
    const w = await boot([])
    addons.push(w.addon)
    const { id } = await w.instances.createInstance({ name: 'Empty' })
    const result = await w.instances.testInstance?.({ id, values: {} })
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
  })
})
