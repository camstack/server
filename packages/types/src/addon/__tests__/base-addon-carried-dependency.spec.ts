/**
 * A later `runMigrations` call re-declares the earlier calls' ids so the catalogue stays whole, but
 * those ids are not its to run. A step of the later call that depends on one of them, unapplied, is
 * BLOCKED (and blocks the owner when it says so) exactly as when the later call declared only its
 * own ids: the earlier phase has passed, nothing in this call will apply the dependency.
 */
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { afterEach, describe, expect, it } from 'vitest'
import type { MigrationApiV1 } from '../../migrations/api/migration-api.v1.js'
import type { AppRouter } from '../../generated/addon-api.js'
import { type AddonMigration, defineAddonMigrations } from '../../migrations/addon-migration.js'
import { BaseAddon } from '../base-addon.js'
import { fakeAddonContext } from '../fake-addon-context.js'
import { registrySwitchToBodyId } from '../../migrations/registry-switch-to-body.js'
import { AddonMigrationsBlockedError } from '../migrations-blocked-error.js'
import { defineEntryKind, entryBody } from '../../records/entry-kind.js'
import {
  clearInstanceSwitches,
  clearServedInstanceKinds,
  registerServedInstanceKind,
} from '../instance-switches.js'

const ADDON = 'probe-carried'
const ONE = `${ADDON}/2026-11-01-one`
const MOVE_IN = registrySwitchToBodyId(ADDON, '2026-11-06')

const entry = (
  slug: string,
  seq: number,
  dependsOn: readonly string[],
  onFailure: 'tolerate' | 'block-owner',
): AddonMigration<Record<string, never>> => ({
  meta: {
    id: `${ADDON}/2026-11-01-${slug}`,
    owner: ADDON,
    level: 'addon-state',
    seq,
    dependsOn: [...dependsOn],
    store: 'settings',
    scope: 'cluster',
    onFailure,
    bodyKind: 'plan',
    description: slug,
    fixtureMark: 'mark',
  },
  plan: async () => ({ edits: [] }),
})

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

const link: TRPCLink<AppRouter> =
  () =>
  ({ op }) =>
    observable((observer) => {
      if (op.path === 'integrations.listByAddon') observer.next({ result: { data: [] } })
      else if (op.path === 'migrations.declareOwner') {
        const input = op.input as { metas: { id: string }[] }
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
        const { id } = op.input as { id: string }
        // Nothing earlier is ever applied (a failed tolerated one, a held one); a later step
        // that waits on one of them is refused as blocked.
        const data =
          id === ONE
            ? { proceed: false, state: 'failed', reason: null }
            : id === MOVE_IN
              ? { proceed: false, state: 'held', reason: null }
              : {
                  proceed: false,
                  state: 'blocked',
                  reason: `dependency-blocked:${id.endsWith('-two') ? ONE : MOVE_IN}`,
                }
        observer.next({ result: { data } })
      } else observer.next({ result: { data: undefined } })
      observer.complete()
    })

class Probe extends BaseAddon {
  constructor(private readonly lateKind: boolean) {
    super({})
    if (lateKind) {
      this.declareRegistrySwitch({
        kind: defineEntryKind('legacy', { title: 'l', schema: entryBody({}) }),
        initialBody: () => ({}),
      })
    }
  }
  protected async onInitialize() {
    await this.runMigrations(defineAddonMigrations([entry('one', 1, [], 'tolerate')], {}))
    if (this.lateKind) {
      // The late-kind path: an explicit `only`, the whole earlier catalogue carried.
      registerServedInstanceKind(ADDON, {
        kind: defineEntryKind('gadgets', { title: 'g', schema: entryBody({}) }),
        reapply: async () => {},
        unrowed: async () => [],
      })
    } else {
      await this.runMigrations(defineAddonMigrations([entry('two', 2, [ONE], 'block-owner')], {}))
    }
    return []
  }
}

afterEach(() => {
  clearInstanceSwitches()
  clearServedInstanceKinds()
})

describe('a step depending on an unapplied id of an EARLIER call', () => {
  it('is blocked, and blocks the owner, rather than deferred', async () => {
    const boot = new Probe(false).initialize(
      fakeAddonContext({ id: ADDON, api: createTRPCClient<AppRouter>({ links: [link] }) }),
    )
    await expect(boot).rejects.toBeInstanceOf(AddonMigrationsBlockedError)
  })

  it('on the explicit-only late-kind path too: the move waiting on an unapplied carried id is blocked', async () => {
    const boot = new Probe(true).initialize(
      fakeAddonContext({
        id: ADDON,
        migrationApi: stubMigrationApi(),
        api: createTRPCClient<AppRouter>({ links: [link] }),
      }),
    )
    await expect(boot).rejects.toBeInstanceOf(AddonMigrationsBlockedError)
  })
})
