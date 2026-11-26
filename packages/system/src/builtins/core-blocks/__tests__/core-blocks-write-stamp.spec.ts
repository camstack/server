/**
 * The block write stamp through the REAL core-blocks addon (D1098): a stale `expectedUpdatedAt`
 * on `update`, `delete` and `setEnabled` is refused with `[stale-stamp]` and writes nothing; a
 * write with no stamp goes through and says so; two saves that read the same stamp cannot both
 * pass.
 */
import {
  type Composition,
  type CoreBlock,
  CoreBlockSchema,
  type ICoreBlocksProvider,
  StaleStampError,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { makeSettingsStoreApi } from '../../device-manager/__tests__/settings-store-api.js'
import {
  makeAddonContext,
  providerOf,
  registrationsOf,
} from '../../device-manager/__tests__/typed-addon-context.js'
import { CoreBlocksAddon } from '../core-blocks.addon.js'
import { coreBlocksRecordKinds, type CoreBlockRowBody } from '../record-kinds.js'
import { recordingLogger } from './fixtures.js'

function isCoreBlocksProvider(value: unknown): value is ICoreBlocksProvider {
  if (typeof value !== 'object' || value === null) return false
  return ['list', 'update', 'delete', 'setEnabled'].every(
    (name) => typeof Reflect.get(value, name) === 'function',
  )
}

const COMPOSITION: Composition = {
  target: { kind: 'existing', device: { addonId: 'provider-x', stableId: 'lock-1' } },
  features: [],
}
const STAMP = 700
const CALLER = { userId: 'admin', role: 'admin', isAdmin: true } as const

function block(id: string): CoreBlock {
  return CoreBlockSchema.parse({
    id,
    name: `name-${id}`,
    code: '',
    enabled: true,
    source: { kind: 'composition', composition: COMPOSITION },
    createdBy: 'seed',
    createdAt: 10,
    updatedAt: STAMP,
    status: 'stopped',
    lastChangedAt: STAMP,
  })
}

/** An engine that judges the catalogue and finds nothing to run: the migrations have their own specs. */
const NO_STEPS_ENGINE = {
  declareOwner: { mutate: async () => ({ bootId: 'b', snapshot: 'none', steps: [] }) },
  startMigration: { mutate: async () => ({ proceed: false, state: 'skipped', reason: null }) },
  finishMigration: { mutate: async () => ({ status: 'applied', error: null, rowsChanged: 0 }) },
}

async function boot() {
  const records = await makeRecordsAccessForOwner('core-blocks')
  await records.declare(coreBlocksRecordKinds)
  const handle = records.kind(coreBlocksRecordKinds.blocks)
  for (const id of ['a', 'b', 'c']) {
    const b = block(id)
    const data: CoreBlockRowBody = {
      name: b.name,
      enabled: b.enabled,
      updatedAt: b.updatedAt,
      block: b,
    }
    await handle.put({ id, data })
  }
  const { logger, lines } = recordingLogger()
  const store = await makeSettingsStoreApi()
  const ctx = makeAddonContext({
    id: 'core-blocks',
    logger,
    settings: {
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => undefined,
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
    } as never,
    records,
    api: { settingsStore: store.api, migrations: NO_STEPS_ENGINE },
  })
  const addon = new CoreBlocksAddon()
  const regs = registrationsOf(await addon.initialize(ctx))
  const provider = providerOf(regs, 'core-blocks', isCoreBlocksProvider)
  return { provider, lines }
}

describe('core blocks: a stale stamp is refused on every write', () => {
  it('update', async () => {
    const { provider } = await boot()
    await expect(
      provider.update({
        blockId: 'a',
        block: { name: 'renamed' },
        caller: CALLER,
        expectedUpdatedAt: STAMP - 1,
      }),
    ).rejects.toBeInstanceOf(StaleStampError)
    expect((await provider.get({ blockId: 'a' })).block?.name).toBe('name-a')
  })

  it('setEnabled', async () => {
    const { provider } = await boot()
    await expect(
      provider.setEnabled({ blockId: 'b', enabled: false, expectedUpdatedAt: STAMP - 1 }),
    ).rejects.toBeInstanceOf(StaleStampError)
    expect((await provider.get({ blockId: 'b' })).block?.enabled).toBe(true)
  })

  it('delete', async () => {
    const { provider } = await boot()
    await expect(
      provider.delete({ blockId: 'c', expectedUpdatedAt: STAMP - 1 }),
    ).rejects.toBeInstanceOf(StaleStampError)
    expect((await provider.get({ blockId: 'c' })).block).not.toBeNull()
  })
})

describe('core blocks: the stamp the caller read', () => {
  it('lets a fresh stamp write and answers the next one', async () => {
    const { provider } = await boot()
    const saved = await provider.setEnabled({
      blockId: 'a',
      enabled: false,
      expectedUpdatedAt: STAMP,
    })
    expect(saved.block.enabled).toBe(false)
    expect(saved.block.updatedAt).toBeGreaterThan(STAMP)
  })

  it('serialises two saves that read the same stamp: one wins, the other is refused', async () => {
    const { provider } = await boot()
    const first = provider.setEnabled({ blockId: 'a', enabled: false, expectedUpdatedAt: STAMP })
    const second = provider.setEnabled({ blockId: 'a', enabled: true, expectedUpdatedAt: STAMP })
    const settled = await Promise.allSettled([first, second])
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'rejected'])
    expect((await provider.get({ blockId: 'a' })).block?.enabled).toBe(false)
  })

  it('a write without a stamp goes through and logs that it was not checked', async () => {
    const { provider, lines } = await boot()
    await provider.setEnabled({ blockId: 'b', enabled: false })
    expect((await provider.get({ blockId: 'b' })).block?.enabled).toBe(false)
    expect(
      lines.some(
        (l) =>
          l.level === 'info' &&
          l.message.includes('without a stamp') &&
          JSON.stringify(l.extras).includes('setEnabled'),
      ),
    ).toBe(true)
  })
})
