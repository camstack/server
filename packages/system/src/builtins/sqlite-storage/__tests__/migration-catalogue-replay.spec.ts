/**
 * REPLAY (planning#447): every catalogue is run, as the real engine runs it, over data an old
 * release left behind, on real SQLite - so a migration written long ago is shown to still apply
 * after the code around it moved on.
 *
 * Covered: the hub catalogue, end to end (seeded by hand in `__fixtures__/seed.ts`), and the
 * default-integration catalogue every converted provider runs, through the real facade behind a
 * Proxy that refuses any method outside the contract. A catalogue that still binds ctx-bound ports
 * is named in `scripts/migration-ports-surface-pending.json`; it joins the replay as it is
 * converted (`scripts/check-migrations-well-formed.ts` asks for its seed).
 */
import {
  defaultIntegrationDepsOver,
  defaultIntegrationMigrations,
  defaultIntegrationPortsOver,
  defineAddonMigrations,
  defineEntryKind,
  entryBody,
  MIGRATION_API_V1_METHODS,
  type MigrationApiV1,
} from '@camstack/types'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { type HubSeedMarks, seedHubCatalogue } from '../../../migrations/hub/__fixtures__/seed.js'
import { HUB_MIGRATIONS } from '../../../migrations/hub/index.js'
import { type MigrationWorld, makeMigrationWorld } from './support/migration-world.js'

const worlds: MigrationWorld[] = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((w) => w.cleanup()))
})

interface LedgerRow {
  readonly id: string
  readonly status: string
  readonly error: string | null
}

function ledgerOf(db: Database.Database): readonly LedgerRow[] {
  return db.prepare<[], LedgerRow>('SELECT id, status, error FROM _migrations ORDER BY id').all()
}

function markOf(db: Database.Database, sql: string, ...args: string[]): unknown {
  const row = db.prepare<string[], { data: string }>(sql).get(...args)
  if (row === undefined) return undefined
  const parsed: unknown = JSON.parse(row.data)
  return typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'mark') : undefined
}

describe('hub catalogue replay', () => {
  it('applies every migration over a seeded old node, keeps every mark, and a second boot changes nothing', async () => {
    let marks: HubSeedMarks | undefined
    const world = await makeMigrationWorld({
      hubCatalogue: HUB_MIGRATIONS,
      installed: [{ dir: 'net-access', addons: [{ id: 'static-turn', group: 'net-access' }] }],
      seedBefore: (db) => {
        marks = seedHubCatalogue(db)
      },
    })
    worlds.push(world)
    if (marks === undefined) throw new Error('the seed did not run')

    const first = ledgerOf(world.db)
    for (const migration of HUB_MIGRATIONS) {
      expect(first.find((r) => r.id === migration.meta.id)).toMatchObject({
        status: 'applied',
        error: null,
      })
    }
    expect(first.filter((r) => r.status !== 'applied')).toEqual([])

    for (const [id, mark] of Object.entries(marks.nodeRows)) {
      const data = world.db
        .prepare<[string], { data: string }>('SELECT data FROM "addon-settings" WHERE id = ?')
        .get(id)
      expect(data && JSON.parse(data.data)).toMatchObject({ mark, nodeId: 'agent-1' })
    }
    const recordMark = (owner: string, kind: string, id: string): unknown =>
      markOf(
        world.db,
        'SELECT json(r.data) AS data FROM records r JOIN _record_kinds k ON k.kind_id = r.kind_id WHERE k.owner = ? AND k.kind = ? AND r.id = ?',
        owner,
        kind,
        id,
      )
    expect(recordMark('integration-registry', 'integrations', marks.integration.id)).toBe(
      marks.integration.mark,
    )
    const stamped = world.db
      .prepare<[string], { data: string }>(
        'SELECT json(r.data) AS data FROM records r WHERE r.id = ?',
      )
      .get(marks.integration.id)
    expect(stamped && JSON.parse(stamped.data)).toMatchObject({
      addonId: marks.integration.bareAddonId,
    })
    const [owner, kind, id] = marks.regrouped.key.split('/')
    expect(recordMark(owner ?? '', kind ?? '', id ?? '')).toBe(marks.regrouped.mark)

    await world.rerunHubCatalogue()
    expect(ledgerOf(world.db)).toEqual(first)
  })
})

/** The API behind a Proxy: a method the contract does not list is a failure, named. */
function contractOnly(api: MigrationApiV1, calls: string[]): MigrationApiV1 {
  const listed = new Set(Object.keys(MIGRATION_API_V1_METHODS))
  const guard = <T extends object>(target: T, prefix: string): T =>
    new Proxy(target, {
      get(inner, property, receiver) {
        const value: unknown = Reflect.get(inner, property, receiver)
        if (typeof property !== 'string') return value
        const path = prefix === '' ? property : `${prefix}.${property}`
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            calls.push(path)
            if (!listed.has(path) && path !== 'records.kind') {
              throw new Error(`${path} is not a method of the migration API contract`)
            }
            return Reflect.apply(value, inner, args)
          }
        }
        if (typeof value === 'object' && value !== null) return guard(value, path)
        return value
      },
    })
  return guard(api, '')
}

const OWNER = 'provider-spec-default'
const KIND = defineEntryKind('connections', { title: 'Spec connections', schema: entryBody({}) })

describe('default-integration catalogue replay, through the contract only', () => {
  it('moves an integration into a record, claims its device, and a second run is a no-op', async () => {
    const world = await makeMigrationWorld()
    worlds.push(world)
    await world.recordsFor(OWNER).declare({ connections: KIND })
    world.addIntegration({ id: 'int_0001', addonId: OWNER, name: 'Default' })
    world.addDevice({ id: 11, addonId: OWNER, name: 'Cam', config: { host: '10.0.0.1' } })
    const calls: string[] = []
    const api = contractOnly(world.apiFor(OWNER), calls)

    const run = async () => {
      const bound = defineAddonMigrations(
        defaultIntegrationMigrations({ addonId: OWNER, date: '2026-11-04' }),
        defaultIntegrationPortsOver({ ...defaultIntegrationDepsOver(api), kind: KIND }),
      )
      return Promise.all(bound.map((m) => m.execute()))
    }
    const first = await run()
    expect(first.length).toBeGreaterThan(0)
    expect(JSON.stringify(first)).not.toContain('"failed"')
    expect((await world.recordsFor(OWNER).kind(KIND).get('int_0001'))?.data).toEqual({
      name: 'Default',
    })
    expect(world.db.prepare('SELECT integration_id FROM spec_devices WHERE id = 11').get()).toEqual(
      { integration_id: 'int_0001' },
    )

    const again = await run()
    expect(JSON.stringify(again)).toContain('already-done')
    expect(calls.length).toBeGreaterThan(0)
  })

  it('refuses a method outside the contract', async () => {
    const world = await makeMigrationWorld()
    worlds.push(world)
    const calls: string[] = []
    const api = contractOnly(world.apiFor(OWNER), calls)
    const sneaky = Reflect.get(api.devices, 'deleteEverything')
    expect(sneaky).toBeUndefined()
    const stray = new Proxy(world.apiFor(OWNER), {
      get: (t, p, r) => (p === 'stray' ? { call: () => 0 } : Reflect.get(t, p, r)),
    })
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a stray method on purpose
    const guarded = contractOnly(stray as MigrationApiV1 & { stray: { call(): number } }, calls)
    expect(() => Reflect.get(guarded, 'stray').call()).toThrow(/not a method of the migration API/)
  })
})
