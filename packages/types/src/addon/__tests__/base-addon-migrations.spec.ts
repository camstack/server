/**
 * `BaseAddon.runMigrations` (D987 M3): the addon offers its bound catalogue to the hub's
 * `migrations` capability through `ctx.api`, runs what it is told to run, and refuses to
 * serve when a `block-owner` migration did not apply. The engine itself is proven on real
 * SQLite in `@camstack/server/system`; this pins the addon side of the seam.
 */
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { describe, expect, it } from 'vitest'
import type { AppRouter } from '../../generated/addon-api.js'
import { type AddonMigration, defineAddonMigrations } from '../../migrations/addon-migration.js'
import type { MigrationApiV1 } from '../../migrations/api/migration-api.v1.js'
import type { MigrationMeta } from '../../migrations/migration.js'
import { defineEntryKind, entryBody } from '../../records/entry-kind.js'
import { BaseAddon } from '../base-addon.js'
import { AddonMigrationsBlockedError } from '../migrations-blocked-error.js'
import { fakeAddonContext } from '../fake-addon-context.js'

const meta = (slug: string, onFailure: MigrationMeta['onFailure']): MigrationMeta => ({
  id: `probe/2026-11-01-${slug}`,
  owner: 'probe',
  level: 'addon-state',
  seq: 1,
  dependsOn: [],
  store: 'settings',
  scope: 'cluster',
  onFailure,
  bodyKind: 'procedure',
  description: slug,
  fixtureMark: 'mark',
})

/** A hub that says "run it" and records the outcome the addon reports. */
function scriptedHub(
  calls: string[],
  finishStatus: 'applied' | 'failed' | 'refused',
): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        calls.push(op.path)
        if (finishStatus === 'refused') {
          observer.error(TRPCClientError.from(new Error('declare refused')))
          return
        }
        const answer =
          op.path === 'migrations.declareOwner'
            ? {
                bootId: 'b1',
                snapshot: 'written',
                steps: [{ id: stepId(op.input), action: 'run', state: 'pending' }],
              }
            : op.path === 'migrations.startMigration'
              ? { proceed: true, state: 'pending', reason: null }
              : {
                  status: finishStatus,
                  error: finishStatus === 'failed' ? 'boom' : null,
                  rowsChanged: 0,
                }
        observer.next({ result: { data: answer } })
        observer.complete()
      })
}

function stepId(input: unknown): string {
  if (
    typeof input === 'object' &&
    input !== null &&
    'metas' in input &&
    Array.isArray(input.metas)
  ) {
    const first: unknown = input.metas[0]
    if (
      typeof first === 'object' &&
      first !== null &&
      'id' in first &&
      typeof first.id === 'string'
    )
      return first.id
  }
  throw new Error('declareOwner was called without a catalogue')
}

class Probe extends BaseAddon {
  protected async onInitialize() {
    return []
  }
  migrate(entries: readonly AddonMigration<Record<string, never>>[]) {
    return this.runMigrations(defineAddonMigrations(entries, {}))
  }
}

async function probeWith(
  finishStatus: 'applied' | 'failed' | 'refused',
  calls: string[],
): Promise<Probe> {
  const addon = new Probe({})
  await addon.initialize(
    fakeAddonContext({
      api: createTRPCClient<AppRouter>({ links: [scriptedHub(calls, finishStatus)] }),
    }),
  )
  return addon
}

const entry = (
  slug: string,
  onFailure: MigrationMeta['onFailure'],
): AddonMigration<Record<string, never>> => ({
  meta: meta(slug, onFailure),
  procedure: async () => ({ outcome: 'done', summary: {} }),
})

describe('BaseAddon.runMigrations', () => {
  it('declares, gates and finishes each migration through ctx.api', async () => {
    const calls: string[] = []
    const addon = await probeWith('applied', calls)
    const report = await addon.migrate([entry('one', 'block-owner')])
    expect(calls).toEqual([
      'migrations.declareOwner',
      'migrations.startMigration',
      'migrations.finishMigration',
    ])
    expect(report.applied).toEqual(['probe/2026-11-01-one'])
  })

  it('throws, naming the id, when a block-owner migration failed', async () => {
    const addon = await probeWith('failed', [])
    await expect(addon.migrate([entry('one', 'block-owner')])).rejects.toThrow(
      /probe\/2026-11-01-one/,
    )
  })

  it('does not throw for a tolerate migration that failed', async () => {
    const addon = await probeWith('failed', [])
    const report = await addon.migrate([entry('one', 'tolerate')])
    expect(report.failed).toEqual(['probe/2026-11-01-one'])
    expect(report.blockOwner).toEqual([])
  })

  it('throws when the engine refuses the catalogue and a block-owner migration was not evaluated', async () => {
    const addon = await probeWith('refused', [])
    await expect(addon.migrate([entry('one', 'block-owner')])).rejects.toThrow(/one/)
    await expect(addon.migrate([entry('one', 'tolerate')])).resolves.toMatchObject({
      declared: false,
    })
  })

  it('an addon with no catalogue never calls the engine', async () => {
    const calls: string[] = []
    const addon = await probeWith('applied', calls)
    expect((await addon.migrate([])).declared).toBe(false)
    expect(calls).toEqual([])
  })
})

/** A migration API whose every method is a stub: the seam only needs the object's identity. */
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
    devices: { list: none, get: none, setIntegrationId: none },
    node: { localNodeId: none },
    log: { info: none, warn: none },
  }
}

class CatalogueProbe extends BaseAddon {
  protected async onInitialize() {
    return []
  }
  migrate(entries: readonly AddonMigration<{ readonly api: MigrationApiV1 }>[]) {
    return this.runMigrations(entries, (api) => ({ api }))
  }
}

describe('BaseAddon.runMigrations, catalogue form', () => {
  it('builds the ports from ctx.migrationApi and from nothing else', async () => {
    const api = stubMigrationApi()
    const addon = new CatalogueProbe({})
    await addon.initialize(
      fakeAddonContext({
        migrationApi: api,
        api: createTRPCClient<AppRouter>({ links: [scriptedHub([], 'applied')] }),
      }),
    )
    const seen: MigrationApiV1[] = []
    const report = await addon.migrate([
      {
        meta: meta('ported', 'block-owner'),
        procedure: async (ports) => {
          seen.push(ports.api)
          return { outcome: 'done', summary: {} }
        },
      },
    ])
    expect(report.applied).toEqual(['probe/2026-11-01-ported'])
    expect(seen).toEqual([api])
  })

  it('refuses to run when the context carries no migration API', async () => {
    const addon = new CatalogueProbe({})
    await addon.initialize(
      fakeAddonContext({
        api: createTRPCClient<AppRouter>({ links: [scriptedHub([], 'applied')] }),
      }),
    )
    await expect(addon.migrate([])).rejects.toThrow(/migration API is not available/)
  })

  it('refuses a mixed array instead of silently dropping the other kind', async () => {
    class MixedProbe extends BaseAddon {
      protected async onInitialize() {
        return []
      }
      mixed(entries: readonly AddonMigration<Record<string, never>>[]) {
        return this.runMigrations(entries, (): Record<string, never> => ({}))
      }
    }
    const addon = new MixedProbe({})
    await addon.initialize(
      fakeAddonContext({
        migrationApi: stubMigrationApi(),
        api: createTRPCClient<AppRouter>({ links: [scriptedHub([], 'applied')] }),
      }),
    )
    const one = {
      meta: meta('one', 'block-owner'),
      procedure: async () => ({ outcome: 'done' as const, summary: {} }),
    }
    // The overloads keep a mixed array out of typed callers; this entry is a catalogue entry
    // that also carries a bound entry's `execute`, the shape an untyped caller could build.
    const two = { ...one, meta: meta('two', 'block-owner'), execute: async () => undefined }
    await expect(addon.mixed([one, two])).rejects.toThrow(/other kind/)
  })
})

/** A hub that runs the step and judges it from what the addon REPORTED: a failed body fails the step. */
function judgingHub(calls: string[], refuseDeclare: boolean): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        calls.push(op.path)
        if (refuseDeclare && op.path === 'migrations.declareOwner') {
          observer.error(TRPCClientError.from(new Error('declare refused')))
          return
        }
        const answer =
          op.path === 'migrations.declareOwner'
            ? {
                bootId: 'b1',
                snapshot: 'written',
                steps: [{ id: stepId(op.input), action: 'run', state: 'pending' }],
              }
            : op.path === 'migrations.startMigration'
              ? { proceed: true, state: 'pending', reason: null }
              : reportedFailure(op.input)
                ? { status: 'failed', error: 'reported', rowsChanged: 0 }
                : { status: 'applied', error: null, rowsChanged: 0 }
        observer.next({ result: { data: answer } })
        observer.complete()
      })
}

function reportedFailure(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    'result' in input &&
    typeof input.result === 'object' &&
    input.result !== null &&
    'kind' in input.result &&
    input.result.kind === 'failed'
  )
}

const switchKind = defineEntryKind('connections', {
  title: 'Probe integrations',
  schema: entryBody({}),
})

class SwitchProbe extends BaseAddon {
  protected async onInitialize() {
    return []
  }
  migrate() {
    this.declareRegistrySwitch({ kind: switchKind, initialBody: (name) => ({ name }) })
    return this.runMigrations([])
  }
}

describe('BaseAddon one-switch migration (epic #440 step 3)', () => {
  // A registry-disabled instance reads as ON when its body has no `enabled`, so an addon whose
  // switch migration did not apply must not come up: it fails closed, loudly, instead of serving.
  it('does not initialise when the registry rows could not be read (a failing port)', async () => {
    const addon = new SwitchProbe({})
    await addon.initialize(
      fakeAddonContext({
        migrationApi: stubMigrationApi(), // integrations.list throws
        api: createTRPCClient<AppRouter>({ links: [judgingHub([], false)] }),
      }),
    )
    await expect(addon.migrate()).rejects.toBeInstanceOf(AddonMigrationsBlockedError)
  })

  it('does not initialise when the engine refuses the catalogue', async () => {
    const addon = new SwitchProbe({})
    await addon.initialize(
      fakeAddonContext({
        migrationApi: stubMigrationApi(),
        api: createTRPCClient<AppRouter>({ links: [judgingHub([], true)] }),
      }),
    )
    await expect(addon.migrate()).rejects.toBeInstanceOf(AddonMigrationsBlockedError)
  })

  it('initialises once the switch migration applied (no registry rows to move)', async () => {
    const api = stubMigrationApi()
    const addon = new SwitchProbe({})
    await addon.initialize(
      fakeAddonContext({
        migrationApi: {
          ...api,
          integrations: { ...api.integrations, list: async () => ({ integrations: [] }) },
        },
        api: createTRPCClient<AppRouter>({ links: [judgingHub([], false)] }),
      }),
    )
    const report = await addon.migrate()
    expect(report.applied).toHaveLength(1)
  })
})
