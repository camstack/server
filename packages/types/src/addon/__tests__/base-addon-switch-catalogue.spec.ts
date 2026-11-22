/**
 * The switch migrations of an addon across SEVERAL declarations (a late instance kind declares the
 * catalogue again). Every declaration is run through the engine's own catalogue validator, because
 * a duplicate seq or id makes the engine refuse the catalogue and the addon runner with it.
 */
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppRouter } from '../../generated/addon-api.js'
import type { MigrationApiV1 } from '../../migrations/api/migration-api.v1.js'
import type { AddonMigration } from '../../migrations/addon-migration.js'
import { bodySwitchToRegistryId } from '../../migrations/body-switch-to-registry.js'
import { catalogueIssues, type MigrationOrderKey } from '../../migrations/migration.js'
import { registrySwitchToBodyId } from '../../migrations/registry-switch-to-body.js'
import { defineEntryKind, entryBody } from '../../records/entry-kind.js'
import type { DefinedRecordKind } from '../../records/record-kind.js'
import { BaseAddon } from '../base-addon.js'
import { fakeAddonContext } from '../fake-addon-context.js'
import {
  clearInstanceSwitches,
  clearServedInstanceKinds,
  registerServedInstanceKind,
} from '../instance-switches.js'

const ADDON = 'probe-catalogue'
const MOVE_BACK_DATE = '2026-11-19'

interface Meta extends MigrationOrderKey {
  readonly [key: string]: unknown
}

function hub(): {
  link: TRPCLink<AppRouter>
  declared: Meta[][]
  completeFlags: (boolean | undefined)[]
} {
  const declared: Meta[][] = []
  const completeFlags: (boolean | undefined)[] = []
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.path === 'integrations.listByAddon') observer.next({ result: { data: [] } })
        else if (op.path === 'migrations.declareOwner') {
          const input = op.input as { metas: Meta[]; complete?: boolean }
          declared.push(input.metas)
          completeFlags.push(input.complete)
          observer.next({
            result: {
              data: {
                bootId: 'b',
                snapshot: 'none',
                steps: input.metas.map((m) => ({
                  id: m.id,
                  action: 'skip',
                  state: 'done',
                })),
              },
            },
          })
        } else observer.next({ result: { data: undefined } })
        observer.complete()
      })
  return { link, declared, completeFlags }
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

function kindOf(name: string): DefinedRecordKind {
  return defineEntryKind(name, { title: name, schema: entryBody({}) })
}

function serve(kind: DefinedRecordKind): void {
  registerServedInstanceKind(ADDON, {
    kind,
    reapply: async () => {},
    unrowed: async () => [],
  })
}

interface Plan {
  readonly early: readonly string[]
  /** Kinds a later declare registers, one array per declare. */
  readonly late: readonly (readonly string[])[]
  readonly withMoveIn?: boolean
}

class Probe extends BaseAddon {
  constructor(private readonly plan: Plan) {
    super({})
    if (plan.withMoveIn === true) {
      this.declareRegistrySwitch({
        kind: kindOf('legacy'),
        initialBody: () => ({}),
      })
    }
  }
  protected async onInitialize() {
    await this.runMigrations([])
    // Each group but the last declares again here; the last is the late move after initialise.
    for (const [index, names] of this.plan.late.entries()) {
      for (const name of names) serve(kindOf(name))
      if (index < this.plan.late.length - 1) await this.runMigrations([])
    }
    return []
  }
}

async function run(plan: Plan): Promise<Meta[][]> {
  for (const name of plan.early) serve(kindOf(name))
  const h = hub()
  await new Probe(plan).initialize(
    fakeAddonContext({
      id: ADDON,
      migrationApi: stubMigrationApi(),
      api: createTRPCClient<AppRouter>({ links: [h.link] }),
    }),
  )
  return h.declared
}

function expectCatalogue(declared: readonly Meta[][]): void {
  for (const metas of declared) {
    expect(catalogueIssues(metas)).toEqual([])
  }
}

const moveBack = (kind: string) => bodySwitchToRegistryId(ADDON, MOVE_BACK_DATE, kind)
const seqOf = (metas: readonly Meta[], id: string) => metas.find((m) => m.id === id)?.seq

afterEach(() => {
  clearInstanceSwitches()
  clearServedInstanceKinds()
})

describe('switch migrations across declarations', () => {
  it('one declare: the early kinds keep seq 1001, 1002 (unchanged from before)', async () => {
    const declared = await run({ early: ['widgets', 'gadgets'], late: [] })
    expectCatalogue(declared)
    const first = declared[0] ?? []
    expect(seqOf(first, moveBack('widgets'))).toBe(1001)
    expect(seqOf(first, moveBack('gadgets'))).toBe(1002)
  })

  it('a late declare with new kinds keeps the early moves and gives the new one the next seq', async () => {
    const declared = await run({ early: ['widgets'], late: [['gadgets']] })
    expectCatalogue(declared)
    const first = declared[0] ?? []
    const last = declared[declared.length - 1] ?? []
    expect(declared.length).toBeGreaterThan(1)
    expect(seqOf(first, moveBack('widgets'))).toBe(1001)
    expect(seqOf(last, moveBack('widgets'))).toBe(1001)
    expect(seqOf(last, moveBack('gadgets'))).toBe(1002)
  })

  it('with the registry-to-body move: it is declared once, at 1000, in every declare', async () => {
    const declared = await run({
      early: ['widgets'],
      late: [['gadgets']],
      withMoveIn: true,
    })
    expectCatalogue(declared)
    const moveIn = registrySwitchToBodyId(ADDON, '2026-11-06')
    for (const metas of declared) {
      expect(metas.filter((m) => m.id === moveIn)).toHaveLength(1)
      expect(seqOf(metas, moveIn)).toBe(1000)
    }
    expect(seqOf(declared[0] ?? [], moveBack('widgets'))).toBe(1001)
  })

  it('a late declare that repeats a kind adds nothing and refuses nothing', async () => {
    const declared = await run({ early: ['widgets'], late: [['widgets']] })
    expectCatalogue(declared)
    const last = declared[declared.length - 1] ?? []
    expect(last.filter((m) => m.id === moveBack('widgets'))).toHaveLength(1)
  })

  it('three declares: every kind keeps its seq and the catalogue only grows', async () => {
    const declared = await run({
      early: ['widgets'],
      late: [['gadgets'], ['doodads']],
    })
    expectCatalogue(declared)
    expect(declared.length).toBeGreaterThan(2)
    const last = declared[declared.length - 1] ?? []
    expect(seqOf(last, moveBack('widgets'))).toBe(1001)
    expect(seqOf(last, moveBack('gadgets'))).toBe(1002)
    expect(seqOf(last, moveBack('doodads'))).toBe(1003)
    for (let i = 1; i < declared.length; i += 1) {
      const before = (declared[i - 1] ?? []).map((m) => m.id)
      const now = (declared[i] ?? []).map((m) => m.id)
      expect(now).toEqual(expect.arrayContaining(before))
    }
  })
})

const OWN = (slug: string, seq: number): AddonMigration<Record<string, never>> => ({
  meta: {
    id: `${ADDON}/2026-11-01-${slug}`,
    owner: ADDON,
    level: 'addon-state',
    seq,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    onFailure: 'tolerate',
    bodyKind: 'plan',
    description: slug,
    fixtureMark: 'mark',
  },
  plan: async () => ({ edits: [] }),
})

class TwoCalls extends BaseAddon {
  constructor() {
    super({})
  }
  protected async onInitialize() {
    await this.runMigrations([OWN('one', 1)], () => ({}))
    await this.runMigrations([OWN('two', 2)], () => ({}))
    serve(kindOf('gadgets'))
    return []
  }
}

async function runTwoCalls(): Promise<ReturnType<typeof hub>> {
  serve(kindOf('widgets'))
  const h = hub()
  await new TwoCalls().initialize(
    fakeAddonContext({
      id: ADDON,
      migrationApi: stubMigrationApi(),
      api: createTRPCClient<AppRouter>({ links: [h.link] }),
    }),
  )
  return h
}

describe('a catalogue declared in phases is complete only at the end of initialise', () => {
  it('every declare inside onInitialize is partial, the closing one is complete and carries the union', async () => {
    const h = await runTwoCalls()
    expectCatalogue(h.declared)
    expect(h.completeFlags.slice(0, -1).every((flag) => flag === false)).toBe(true)
    expect(h.completeFlags[h.completeFlags.length - 1]).toBe(true)
    const ids = (h.declared[h.declared.length - 1] ?? []).map((m) => m.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        `${ADDON}/2026-11-01-one`,
        `${ADDON}/2026-11-01-two`,
        moveBack('widgets'),
        moveBack('gadgets'),
      ]),
    )
  })

  it('the second call still declares the first call ids (a partial offer would read them newer)', async () => {
    const h = await runTwoCalls()
    expect((h.declared[1] ?? []).map((m) => m.id)).toContain(`${ADDON}/2026-11-01-one`)
  })

  it('an addon with no late kind still closes with a complete declare', async () => {
    const declared = hub()
    serve(kindOf('widgets'))
    await new Probe({ early: [], late: [] }).initialize(
      fakeAddonContext({
        id: ADDON,
        migrationApi: stubMigrationApi(),
        api: createTRPCClient<AppRouter>({ links: [declared.link] }),
      }),
    )
    expect(declared.completeFlags).toEqual([false, true])
  })
})
