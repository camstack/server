/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import {
  type IIntegrationInstancesProvider,
  integrationInstancesCapability,
  makeInMemoryRecords,
  turnProviderCapability,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaticTurnAddon } from '../static-turn.addon.js'
import { staticTurnServersKind } from '../turn-record-kinds.js'

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

const body = (name: string, urls: string, extra: Record<string, unknown> = {}) => ({
  name,
  urls,
  username: '',
  ...extra,
})

async function boot(seed = true) {
  const world = makeInMemoryRecords('static-turn')
  await world.records.declare({ servers: staticTurnServersKind })
  const handle = world.records.kind(staticTurnServersKind)
  if (seed) {
    await handle.put(
      { id: 'turn-aaaaaaaa', data: body('a', 'turn:a.test:3478, stun:a.test:3478') },
      { ifRev: 0 },
    )
    await handle.put({ id: 'turn-bbbbbbbb', data: body('b', 'turn:b.test:3478') }, { ifRev: 0 })
  }
  const ctx = {
    id: 'static-turn',
    logger: logger(),
    records: world.records,
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
  const addon = new StaticTurnAddon()
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  const turn = registrations.find((r) => r.capability.name === turnProviderCapability.name)
  const instances = registrations.find(
    (r) => r.capability.name === integrationInstancesCapability.name,
  )
  return {
    addon,
    getTurnServers: async () => {
      const provider = turn?.provider as { getTurnServers(): Promise<readonly { urls: unknown }[]> }
      return provider.getTurnServers()
    },
    instances: instances?.provider as IIntegrationInstancesProvider,
  }
}

describe('StaticTurnAddon: TURN servers are integration instances (D996)', () => {
  const addons: StaticTurnAddon[] = []
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('describes itself as a multiple-instance addon over the servers kind, with no connection test', async () => {
    const w = await boot()
    addons.push(w.addon)
    await expect(w.instances.describe()).resolves.toEqual({
      instanceMode: 'multiple',
      kind: 'servers',
      canTest: false,
      role: 'services',
      kinds: [expect.objectContaining({ id: 'servers', functionCap: 'turn-provider' })],
    })
    expect((await w.instances.listInstances()).map((i) => i.id)).toEqual([
      'turn-aaaaaaaa',
      'turn-bbbbbbbb',
    ])
  })

  it('getTurnServers returns one entry per enabled record; a disabled one drops out', async () => {
    const w = await boot()
    addons.push(w.addon)
    expect((await w.getTurnServers()).map((s) => s.urls)).toEqual([
      ['turn:a.test:3478', 'stun:a.test:3478'],
      ['turn:b.test:3478'],
    ])
    await w.instances.setInstanceEnabled({ id: 'turn-aaaaaaaa', enabled: false })
    expect((await w.getTurnServers()).map((s) => s.urls)).toEqual([['turn:b.test:3478']])
    await w.instances.setInstanceEnabled({ id: 'turn-aaaaaaaa', enabled: true })
    expect(await w.getTurnServers()).toHaveLength(2)
  })

  it('a server created through the cap serves at once, a deleted one stops; an unconfigured one is not served', async () => {
    const w = await boot(false)
    addons.push(w.addon)
    await w.instances.createInstance({ id: 'inst-0000000c', name: 'c' })
    expect(await w.getTurnServers()).toEqual([])
    await w.instances.updateInstance({
      id: 'inst-0000000c',
      values: { urls: 'turn:c.test:3478', username: 'u', credential: 'pw-SECRET' },
    })
    expect(await w.getTurnServers()).toEqual([
      { urls: ['turn:c.test:3478'], username: 'u', credential: 'pw-SECRET' },
    ])
    await w.instances.deleteInstance({ id: 'inst-0000000c' })
    expect(await w.getTurnServers()).toEqual([])
  })

  it('the credential never leaves the record through the instance view', async () => {
    const w = await boot()
    addons.push(w.addon)
    await w.instances.updateInstance({
      id: 'turn-aaaaaaaa',
      values: { username: 'u', credential: 'pw-SECRET' },
    })
    expect(JSON.stringify(await w.instances.getInstance({ id: 'turn-aaaaaaaa' }))).not.toContain(
      'pw-SECRET',
    )
    expect(JSON.stringify(await w.instances.listInstances())).not.toContain('pw-SECRET')
    expect((await w.getTurnServers())[0]).toMatchObject({ credential: 'pw-SECRET' })
  })

  it('the page owns no settings of its own: the scoped settings are empty', async () => {
    const w = await boot()
    addons.push(w.addon)
    expect(await w.addon.listScopedSettings()).toEqual([])
  })
})
