/**
 * How the VeSync addon reacts to an instance switch (epic #440 step 3): `instances.onSwitched`
 * replaced the `IntegrationEnabled` / `IntegrationDisabled` event subscriptions. Driven through
 * the real `initialize` and the real `setInstanceEnabled`, with only the hub and records faked.
 *
 * `setInstanceEnabled` also runs the instances' `onChanged` (a reconcile). What only the switch
 * listener does is observed: a second `integrations.list` read on enable, and the device cascade
 * (`kernel.deviceRegistry` read) on disable.
 */
import {
  type AddonContext,
  type AppRouter,
  type IIntegrationInstancesProvider,
  makeInMemoryRecords,
  type MigrationApiV1,
} from '@camstack/types'
import { fakeAddonContext } from '@camstack/types/testing'
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { describe, expect, it } from 'vitest'
import { VeSyncProviderAddon } from '../addon.js'

const ADDON = 'provider-vesync'

function none(): Promise<never> {
  return Promise.reject(new Error('not part of this test'))
}

function migrationApi(): MigrationApiV1 {
  return {
    version: 1,
    ledger: { declare: none, start: none, finish: none },
    legacyRows: { read: none, clear: none, patch: none, deleteKeys: none },
    records: {
      kind: () => ({
        get: none,
        getResolved: none,
        put: none,
        putMany: none,
        patch: none,
        delete: none,
        query: none,
        deleteWhere: none,
      }),
    },
    settings: { read: none, write: none, deleteKeys: none },
    deviceSettings: { listIds: none, read: none },
    secrets: { resolve: none, put: none, delete: none },
    integrations: { list: async () => ({ integrations: [] }), get: none },
    devices: { list: none, get: none, aliases: none, setIntegrationId: none },
    node: { localNodeId: none },
    log: { info: none, warn: none },
  }
}

/** A hub that runs every migration step and lists one enabled VeSync integration. */
function hub(calls: string[]): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        calls.push(op.path)
        const metas = metasOf(op.input)
        const answer =
          op.path === 'migrations.declareOwner'
            ? {
                bootId: 'b1',
                snapshot: 'written',
                steps: metas.map((id) => ({ id, action: 'run', state: 'pending' })),
              }
            : op.path === 'migrations.startMigration'
              ? { proceed: true, state: 'pending', reason: null }
              : op.path === 'migrations.finishMigration'
                ? { status: 'applied', error: null, rowsChanged: 0 }
                : op.path === 'integrations.list'
                  ? [{ id: 'int_1', addonId: ADDON, name: 'Home', enabled: true }]
                  : null
        if (answer === null) {
          observer.error(TRPCClientError.from(new Error(`unscripted ${op.path}`)))
          return
        }
        observer.next({ result: { data: answer } })
        observer.complete()
      })
}

function metasOf(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || !('metas' in input)) return []
  const metas: unknown = input.metas
  if (!Array.isArray(metas)) return []
  return metas.flatMap((m: unknown) =>
    typeof m === 'object' && m !== null && 'id' in m && typeof m.id === 'string' ? [m.id] : [],
  )
}

function isInstancesProvider(value: unknown): value is IIntegrationInstancesProvider {
  return typeof value === 'object' && value !== null && 'setInstanceEnabled' in value
}

async function world() {
  const calls: string[] = []
  const reads = { deviceRegistry: 0 }
  const base = fakeAddonContext({
    id: ADDON,
    migrationApi: migrationApi(),
    api: createTRPCClient<AppRouter>({ links: [hub(calls)] }),
  })
  const ctx: AddonContext = {
    ...base,
    records: makeInMemoryRecords(ADDON).records,
    kernel: {
      ...base.kernel,
      get deviceRegistry() {
        reads.deviceRegistry += 1
        return undefined
      },
    },
  }
  const addon = new VeSyncProviderAddon()
  const result = await addon.initialize(ctx)
  const provider = result?.providers?.map((p) => p.provider).find(isInstancesProvider)
  if (provider === undefined) throw new Error('no integration-instances provider')
  const lists = () => calls.filter((c) => c === 'integrations.list').length
  return { provider, lists, reads }
}

describe('VeSync reacts to an instance switch', () => {
  it('reconciles once more on enable than onChanged alone does', async () => {
    const w = await world()
    const before = w.lists()
    await w.provider.setInstanceEnabled({ id: 'int_1', enabled: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(w.lists() - before).toBe(2)
  })

  it('drops the integration and its devices on disable', async () => {
    const w = await world()
    const before = w.reads.deviceRegistry
    await w.provider.setInstanceEnabled({ id: 'int_1', enabled: false })
    await new Promise((r) => setTimeout(r, 20))
    expect(w.reads.deviceRegistry - before).toBeGreaterThan(0)
  })
})
