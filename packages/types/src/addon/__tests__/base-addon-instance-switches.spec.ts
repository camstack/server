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
import type { DefinedRecordKind } from '../../records/record-kind.js'
import { BaseAddon } from '../base-addon.js'
import { AddonMigrationsBlockedError } from '../migrations-blocked-error.js'
import { fakeAddonContext } from '../fake-addon-context.js'
import {
  clearInstanceSwitches,
  clearServedInstanceKinds,
  isInstanceOn,
  recordInstanceSwitch,
  registerServedInstanceKind,
  type ServedInstanceKind,
  type UnrowedInstance,
} from '../instance-switches.js'

const ADDON = 'probe-switch'

interface HubState {
  rows: readonly { id: string; enabled: boolean }[] | 'down'
  declareDown: boolean
}

interface Hub {
  readonly link: TRPCLink<AppRouter>
  readonly state: HubState
  readonly paths: string[]
  readonly declared: string[][]
  readonly adopted: unknown[]
}

function hubWith(rows: HubState['rows'], options: { readonly declareDown?: boolean } = {}): Hub {
  const state: HubState = { rows, declareDown: options.declareDown ?? false }
  const paths: string[] = []
  const declared: string[][] = []
  const adopted: unknown[] = []
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        paths.push(op.path)
        if (op.path === 'integrations.listByAddon') {
          if (state.rows === 'down') observer.error(TRPCClientError.from(new Error('hub down')))
          else observer.next({ result: { data: state.rows } })
        } else if (op.path === 'integrations.adoptInstanceRows') {
          adopted.push(op.input)
          observer.next({ result: { data: { created: 0, updated: 0, conflicts: [] } } })
        } else if (op.path === 'migrations.declareOwner') {
          if (state.declareDown) {
            observer.error(TRPCClientError.from(new Error('engine down')))
          } else {
            const input = op.input as { metas: { id: string }[] }
            declared.push(input.metas.map((m) => m.id))
            observer.next({
              result: {
                data: {
                  bootId: 'b',
                  snapshot: 'none',
                  // The engine answers and has nothing to run: the run is declared, the step never starts.
                  steps: input.metas.map((m) => ({ id: m.id, action: 'skip', state: 'done' })),
                },
              },
            })
          }
        } else if (op.path === 'migrations.startMigration') {
          observer.next({ result: { data: { proceed: false, state: 'failed', reason: 'test' } } })
        } else {
          observer.next({ result: { data: undefined } })
        }
        observer.complete()
      })
  return { link, state, paths, declared, adopted }
}

class Probe extends BaseAddon {
  /** What an instance reads while the addon is still initialising. */
  seenInInit: boolean | undefined
  constructor(private readonly during?: () => void) {
    super({})
  }
  protected async onInitialize() {
    this.during?.()
    this.seenInInit = isInstanceOn('probe-instance')
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

afterEach(() => {
  clearInstanceSwitches()
  clearServedInstanceKinds()
})

function served(kind: DefinedRecordKind, unrowed: readonly UnrowedInstance[] = []) {
  const reapplied: number[] = []
  const entry: ServedInstanceKind = {
    kind,
    reapply: async () => {
      reapplied.push(1)
    },
    unrowed: async () => unrowed,
  }
  return { entry, reapplied }
}

const widgets = defineEntryKind('widgets', { title: 'Widgets', schema: entryBody({}) })

describe('instance switches in BaseAddon', () => {
  it('hydrates the switch store from the registry rows of the addon at boot', async () => {
    const hub = hubWith([
      { id: 'a', enabled: false },
      { id: 'b', enabled: true },
    ])
    await new Probe().initialize(
      fakeAddonContext({ id: ADDON, api: createTRPCClient<AppRouter>({ links: [hub.link] }) }),
    )
    expect(isInstanceOn('a')).toBe(false)
    expect(isInstanceOn('b')).toBe(true)
    expect(hub.paths).toContain('integrations.listByAddon')
  })

  it('fails closed: a hub that cannot answer leaves every instance off, and the boot goes on', async () => {
    registerServedInstanceKind(ADDON, served(widgets).entry)
    const hub = hubWith('down')
    await new Probe().initialize(
      fakeAddonContext({ id: ADDON, api: createTRPCClient<AppRouter>({ links: [hub.link] }) }),
    )
    expect(isInstanceOn('a')).toBe(false)
    expect(isInstanceOn('anything-nobody-stated')).toBe(false)
  })

  it('the hub-reachable event reads again: instances come on once the registry answers', async () => {
    registerServedInstanceKind(ADDON, served(widgets).entry)
    const hub = hubWith('down')
    const addon = new Probe()
    await addon.initialize(
      fakeAddonContext({ id: ADDON, api: createTRPCClient<AppRouter>({ links: [hub.link] }) }),
    )
    expect(isInstanceOn('a')).toBe(false)
    hub.state.rows = [
      { id: 'a', enabled: true },
      { id: 'off', enabled: false },
    ]
    await addon.hubReachable()
    expect(isInstanceOn('a')).toBe(true)
    expect(isInstanceOn('off')).toBe(false)
    expect(isInstanceOn('never-heard-of')).toBe(true)
  })

  it('an instance nobody stated reads on once the registry answered (a fresh instance)', async () => {
    const hub = hubWith([])
    const addon = new Probe()
    await addon.initialize(
      fakeAddonContext({ id: ADDON, api: createTRPCClient<AppRouter>({ links: [hub.link] }) }),
    )
    expect(addon.seenInInit).toBe(true)
    expect(isInstanceOn('probe-instance')).toBe(true)
  })

  it('declares the body-to-registry move of a record kind a helper serves, with no list in the addon', async () => {
    registerServedInstanceKind(ADDON, served(widgets).entry)
    const hub = hubWith([])
    await new Probe().initialize(
      fakeAddonContext({
        id: ADDON,
        migrationApi: stubMigrationApi(),
        api: createTRPCClient<AppRouter>({ links: [hub.link] }),
      }),
    )
    expect(hub.declared.flat()).toContain(bodySwitchToRegistryId(ADDON, '2026-11-19', 'widgets'))
  })

  it('a kind built DURING onInitialize whose move is blocked fails the boot, as an early kind does', async () => {
    const hub = hubWith([], { declareDown: true })
    const addon = new Probe(() => registerServedInstanceKind(ADDON, served(widgets).entry))
    await expect(
      addon.initialize(
        fakeAddonContext({
          id: ADDON,
          migrationApi: stubMigrationApi(),
          api: createTRPCClient<AppRouter>({ links: [hub.link] }),
        }),
      ),
    ).rejects.toBeInstanceOf(AddonMigrationsBlockedError)
  })

  it('adopts the records of a served kind that have no registry row, with the state they held', async () => {
    recordInstanceSwitch('seed', false)
    const { entry, reapplied } = served(widgets, [
      { id: 'seed', name: 'Seed', enabled: false },
      { id: 'plain', name: 'Plain', enabled: true },
    ])
    registerServedInstanceKind(ADDON, entry)
    const hub = hubWith([])
    await new Probe().initialize(
      fakeAddonContext({ id: ADDON, api: createTRPCClient<AppRouter>({ links: [hub.link] }) }),
    )
    expect(hub.adopted).toContainEqual({
      addonId: ADDON,
      rows: [
        { id: 'seed', name: 'Seed', enabled: false, stated: false },
        { id: 'plain', name: 'Plain', enabled: true, stated: false },
      ],
    })
    expect(isInstanceOn('seed')).toBe(false)
    expect(reapplied.length).toBeGreaterThan(0)
  })
})
