/**
 * A later `runMigrations` call re-declares the earlier calls' ids so the catalogue stays whole, but
 * those ids are not its to run. A step of the later call that depends on one of them, unapplied, is
 * BLOCKED (and blocks the owner when it says so) exactly as when the later call declared only its
 * own ids: the earlier phase has passed, nothing in this call will apply the dependency.
 */
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppRouter } from '../../generated/addon-api.js'
import { type AddonMigration, defineAddonMigrations } from '../../migrations/addon-migration.js'
import { BaseAddon } from '../base-addon.js'
import { fakeAddonContext } from '../fake-addon-context.js'
import { AddonMigrationsBlockedError } from '../migrations-blocked-error.js'
import { clearInstanceSwitches, clearServedInstanceKinds } from '../instance-switches.js'

const ADDON = 'probe-carried'
const ONE = `${ADDON}/2026-11-01-one`

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
        // The first call's migration is never applied; the second waits on it.
        observer.next({
          result: {
            data:
              id === ONE
                ? { proceed: false, state: 'failed', reason: null }
                : { proceed: false, state: 'blocked', reason: `dependency-blocked:${ONE}` },
          },
        })
      } else observer.next({ result: { data: undefined } })
      observer.complete()
    })

class Probe extends BaseAddon {
  constructor() {
    super({})
  }
  protected async onInitialize() {
    await this.runMigrations(defineAddonMigrations([entry('one', 1, [], 'tolerate')], {}))
    await this.runMigrations(defineAddonMigrations([entry('two', 2, [ONE], 'block-owner')], {}))
    return []
  }
}

afterEach(() => {
  clearInstanceSwitches()
  clearServedInstanceKinds()
})

describe('a step depending on an unapplied id of an EARLIER call', () => {
  it('is blocked, and blocks the owner, rather than deferred', async () => {
    const boot = new Probe().initialize(
      fakeAddonContext({ id: ADDON, api: createTRPCClient<AppRouter>({ links: [link] }) }),
    )
    await expect(boot).rejects.toBeInstanceOf(AddonMigrationsBlockedError)
  })
})
