/**
 * The switch of an instance is the hub registry row's alone (D1066). The addon learns it from
 * `integrations.listByAddon` once, on its own boot path, and a record kind a helper serves gets its
 * body-to-registry move declared without the addon listing it.
 */
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppRouter } from '../../generated/addon-api.js'
import type { MigrationApiV1 } from '../../migrations/api/migration-api.v1.js'
import { bodySwitchToRegistryId } from '../../migrations/body-switch-to-registry.js'
import { defineEntryKind, entryBody } from '../../records/entry-kind.js'
import { BaseAddon } from '../base-addon.js'
import { fakeAddonContext } from '../fake-addon-context.js'
import {
  clearInstanceSwitches,
  isInstanceOn,
  registerServedInstanceKind,
} from '../instance-switches.js'

const ADDON = 'probe-switch'

interface Hub {
  readonly link: TRPCLink<AppRouter>
  readonly paths: string[]
  readonly declared: string[][]
}

function hubWith(rows: readonly { id: string; enabled: boolean }[] | 'down'): Hub {
  const paths: string[] = []
  const declared: string[][] = []
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        paths.push(op.path)
        if (op.path === 'integrations.listByAddon') {
          if (rows === 'down') observer.error(TRPCClientError.from(new Error('hub down')))
          else observer.next({ result: { data: rows } })
        } else if (op.path === 'migrations.declareOwner') {
          const input = op.input as { metas: { id: string }[] }
          declared.push(input.metas.map((m) => m.id))
          observer.next({
            result: {
              data: {
                bootId: 'b',
                snapshot: 'none',
                steps: input.metas.map((m) => ({ id: m.id, action: 'run', state: 'pending' })),
              },
            },
          })
        } else if (op.path === 'migrations.startMigration') {
          observer.next({ result: { data: { proceed: false, state: 'failed', reason: 'test' } } })
        } else {
          observer.next({ result: { data: undefined } })
        }
        observer.complete()
      })
  return { link, paths, declared }
}

class Probe extends BaseAddon {
  protected async onInitialize() {
    return []
  }
}

function stubMigrationApi(): MigrationApiV1 {
  const none = async (): Promise<never> => {
    throw new Error('not part of this test')
  }
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
    secrets: { resolve: none, put: none, delete: none },
    integrations: { list: none, get: none },
    deviceSettings: { listIds: none, read: none },
    devices: { list: none, get: none, aliases: none, setIntegrationId: none },
    node: { localNodeId: none },
    log: { info: none, warn: none },
  }
}

afterEach(() => clearInstanceSwitches())

describe('instance switches in BaseAddon', () => {
  it('hydrates the switch store from the registry rows of the addon at boot', async () => {
    const hub = hubWith([
      { id: 'a', enabled: false },
      { id: 'b', enabled: true },
    ])
    await new Probe({}).initialize(
      fakeAddonContext({ id: ADDON, api: createTRPCClient<AppRouter>({ links: [hub.link] }) }),
    )
    expect(isInstanceOn('a')).toBe(false)
    expect(isInstanceOn('b')).toBe(true)
    expect(hub.paths).toContain('integrations.listByAddon')
  })

  it('a hub that cannot answer leaves every instance reading as on, and the boot goes on', async () => {
    const hub = hubWith('down')
    await new Probe({}).initialize(
      fakeAddonContext({ id: ADDON, api: createTRPCClient<AppRouter>({ links: [hub.link] }) }),
    )
    expect(isInstanceOn('a')).toBe(true)
  })

  it('declares the body-to-registry move of a record kind a helper serves, with no list in the addon', async () => {
    const kind = defineEntryKind('widgets', { title: 'Widgets', schema: entryBody({}) })
    registerServedInstanceKind(ADDON, { kind, reapplyOff: async () => undefined })
    const hub = hubWith([])
    await new Probe({}).initialize(
      fakeAddonContext({
        id: ADDON,
        migrationApi: stubMigrationApi(),
        api: createTRPCClient<AppRouter>({ links: [hub.link] }),
      }),
    )
    expect(hub.declared.flat()).toContain(bodySwitchToRegistryId(ADDON, '2026-11-19', 'widgets'))
  })
})
