/**
 * The contract of `MigrationApiV1` on REAL SQLite (planning#447). One `it` per behaviour id of
 * `migration-api.v1.schema.ts`, named by that id: `check-migration-api-append-only` refuses an
 * id with no `it('<id>'` here, and an id is never renamed. The world is the real engine, the
 * real MigrationsProvider, the real records provider and the real settings door over one
 * settings file; only the keychain is in memory.
 */
import {
  createSecretsAccess,
  defineRecordKinds,
  globalSecretScope,
  makeSecretMarker,
  MIGRATION_API_V1_METHODS,
  MIGRATION_API_VERSION,
  type MigrationMeta,
  RevConflictError,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ensureLegacyIntegrationRowsTable,
  patchLegacyIntegrationRows,
} from '../../../builtins/sqlite-storage/migrations/legacy-integration-rows-door.js'
import {
  makeMigrationWorld,
  type MigrationWorld,
} from '../../../builtins/sqlite-storage/__tests__/support/migration-world.js'

const OWNER = 'provider-demo'
const SIBLING = 'demo-export'
const FOREIGN = 'someone-else'
const INTEGRATION = 'int_0001'

const kinds = defineRecordKinds({
  thing: {
    schema: z.object({
      name: z.string(),
      group: z.string(),
      token: z.string().meta({ secret: true }).optional(),
    }),
    class: 'config',
    writeTrigger: 'a spec writes it',
    retention: { none: 'config' },
    indexes: [{ name: 'by_group', fields: ['group'] }],
  },
})

function meta(slug: string, seq: number, dependsOn: string[] = []): MigrationMeta {
  return {
    id: `${OWNER}/2026-11-05-${slug}`,
    owner: OWNER,
    level: 'addon-state',
    seq,
    dependsOn,
    store: 'settings',
    scope: 'cluster',
    onFailure: 'block-owner',
    bodyKind: 'procedure',
    description: slug,
    fixtureMark: 'mark',
  }
}

let world: MigrationWorld
beforeEach(async () => {
  world = await makeMigrationWorld({
    installed: [
      { dir: '@camstack/demo', addons: [{ id: OWNER }, { id: SIBLING, group: 'g' }] },
      { dir: '@camstack/other', addons: [{ id: FOREIGN, group: 'g' }] },
    ],
  })
  world.addIntegration({ id: INTEGRATION, addonId: OWNER })
})
afterEach(async () => {
  await world.cleanup()
})

const api = () => world.apiFor(OWNER)

function seedLegacy(values: Record<string, unknown>): void {
  ensureLegacyIntegrationRowsTable(world.db)
  patchLegacyIntegrationRows(world.db, INTEGRATION, values)
}

describe('MigrationApiV1: the surface', () => {
  it('names every contract method and nothing else', async () => {
    const a = api()
    expect(a.version).toBe(MIGRATION_API_VERSION)
    const present = [
      ...Object.keys(a.ledger).map((m) => `ledger.${m}`),
      ...Object.keys(a.legacyRows).map((m) => `legacyRows.${m}`),
      ...Object.keys(a.settings).map((m) => `settings.${m}`),
      ...Object.keys(a.secrets).map((m) => `secrets.${m}`),
      ...Object.keys(a.integrations).map((m) => `integrations.${m}`),
      ...Object.keys(a.devices).map((m) => `devices.${m}`),
      ...Object.keys(a.node).map((m) => `node.${m}`),
      ...Object.keys(a.log).map((m) => `log.${m}`),
    ]
    const bound = await world.recordsFor(OWNER).declare(kinds)
    expect(Object.keys(bound)).toEqual(['thing'])
    const handle = a.records.kind(kinds.thing)
    present.push(...Object.keys(handle).map((m) => `records.${m}`))
    expect(present.toSorted()).toEqual(Object.keys(MIGRATION_API_V1_METHODS).toSorted())
  })
})

describe('MigrationApiV1.ledger', () => {
  const declare = (...metas: MigrationMeta[]) => api().ledger.declare({ owner: OWNER, metas })

  it('ledger.declare.answers-steps-in-engine-order', async () => {
    const first = meta('first', 1)
    const second = meta('second', 2, [first.id])
    const answer = await declare(first, second)
    expect(answer.steps.map((s) => s.id)).toEqual([first.id, second.id])
  })

  it('ledger.declare.answers-the-migration-api', async () => {
    const answer = await declare(meta('only', 1))
    expect(answer.migrationApi?.version).toBe(MIGRATION_API_VERSION)
    expect(answer.migrationApi?.methods).toEqual(Object.keys(MIGRATION_API_V1_METHODS))
  })

  it('ledger.start.proceeds-when-predecessors-applied', async () => {
    const first = meta('first', 1)
    const second = meta('second', 2, [first.id])
    await declare(first, second)
    const blocked = await api().ledger.start({ id: second.id })
    expect(blocked.proceed).toBe(false)
    const go = await api().ledger.start({ id: first.id })
    expect(go.proceed).toBe(true)
    await api().ledger.finish({
      id: first.id,
      result: { kind: 'procedure', result: { outcome: 'done', summary: {} } },
    })
    expect((await api().ledger.start({ id: second.id })).proceed).toBe(true)
  })

  it('ledger.finish.records-the-outcome', async () => {
    const only = meta('only', 1)
    await declare(only)
    await api().ledger.start({ id: only.id })
    const done = await api().ledger.finish({
      id: only.id,
      result: { kind: 'procedure', result: { outcome: 'done', summary: {} } },
    })
    expect(done.status).toBe('applied')
    const row = world.db.prepare('SELECT status FROM _migrations WHERE id = ?').get(only.id)
    expect(row).toEqual({ status: 'applied' })
  })
})

describe('MigrationApiV1.legacyRows', () => {
  it('legacyRows.read.returns-stored-rows', async () => {
    seedLegacy({ url: 'http://x', keep: 1 })
    await expect(api().legacyRows.read({ integrationId: INTEGRATION })).resolves.toEqual({
      url: 'http://x',
      keep: 1,
    })
  })

  it('legacyRows.read.absent-store-is-empty', async () => {
    await expect(api().legacyRows.read({ integrationId: INTEGRATION })).resolves.toEqual({})
  })

  it('legacyRows.caller.sibling-package', async () => {
    seedLegacy({ url: 'http://x' })
    await expect(
      world.apiFor(SIBLING).legacyRows.read({ integrationId: INTEGRATION }),
    ).resolves.toEqual({ url: 'http://x' })
    await expect(async () =>
      world.apiFor(FOREIGN).legacyRows.read({ integrationId: INTEGRATION }),
    ).rejects.toThrow()
  })

  it('legacyRows.clear.deletes-the-rows', async () => {
    seedLegacy({ a: 1, b: makeSecretMarker('secret://provider-demo/global/b') })
    const out = await api().legacyRows.clear({ integrationId: INTEGRATION })
    expect(out).toEqual({ rows: 2, secrets: 1 })
    await expect(api().legacyRows.read({ integrationId: INTEGRATION })).resolves.toEqual({})
  })

  it('legacyRows.clear.absent-store-is-noop', async () => {
    await expect(api().legacyRows.clear({ integrationId: INTEGRATION })).resolves.toEqual({
      rows: 0,
      secrets: 0,
    })
  })

  it('legacyRows.patch.upserts-keys-and-keeps-the-rest', async () => {
    seedLegacy({ keep: 1, change: 'old' })
    const out = await api().legacyRows.patch({
      integrationId: INTEGRATION,
      patch: { change: 'new', added: true },
    })
    expect(out.written).toBe(true)
    await expect(api().legacyRows.read({ integrationId: INTEGRATION })).resolves.toEqual({
      keep: 1,
      change: 'new',
      added: true,
    })
  })

  it('legacyRows.patch.absent-store-writes-nothing', async () => {
    const out = await api().legacyRows.patch({ integrationId: INTEGRATION, patch: { a: 1 } })
    expect(out.written).toBe(false)
    await expect(api().legacyRows.read({ integrationId: INTEGRATION })).resolves.toEqual({})
  })

  it('legacyRows.deleteKeys.removes-the-named-keys', async () => {
    seedLegacy({ keep: 1, drop: 2 })
    const out = await api().legacyRows.deleteKeys({ integrationId: INTEGRATION, keys: ['drop'] })
    expect(out).toEqual({ present: true, removed: { drop: 2 } })
    await expect(api().legacyRows.read({ integrationId: INTEGRATION })).resolves.toEqual({
      keep: 1,
    })
  })

  it('legacyRows.deleteKeys.absent-store-reports-not-present', async () => {
    const out = await api().legacyRows.deleteKeys({ integrationId: INTEGRATION, keys: ['x'] })
    expect(out.present).toBe(false)
  })
})

describe('MigrationApiV1.records', () => {
  async function thing() {
    await world.recordsFor(OWNER).declare(kinds)
    return api().records.kind(kinds.thing)
  }

  it('records.get.returns-the-row-or-null', async () => {
    const t = await thing()
    await t.put({ id: 'a', data: { name: 'A', group: 'g1' } })
    expect((await t.get({ id: 'a' }))?.data).toEqual({ name: 'A', group: 'g1' })
    await expect(t.get({ id: 'nope' })).resolves.toBeNull()
  })

  it('records.getResolved.resolves-secret-fields', async () => {
    const t = await thing()
    await t.put({ id: 'a', data: { name: 'A', group: 'g1', token: 'hunter2' } })
    expect((await t.get({ id: 'a' }))?.data.token).not.toBe('hunter2')
    expect((await t.getResolved({ id: 'a' }))?.data.token).toBe('hunter2')
  })

  it('records.put.creates-and-replaces', async () => {
    const t = await thing()
    const created = await t.put({ id: 'a', data: { name: 'A', group: 'g1' } })
    const replaced = await t.put({ id: 'a', data: { name: 'B', group: 'g1' } })
    expect(replaced.rev).toBeGreaterThan(created.rev)
    expect((await t.get({ id: 'a' }))?.data.name).toBe('B')
  })

  it('records.put.if-rev-conflict-throws', async () => {
    const t = await thing()
    await t.put({ id: 'a', data: { name: 'A', group: 'g1' } })
    await expect(
      t.put({ id: 'a', data: { name: 'B', group: 'g1' }, ifRev: 0 }),
    ).rejects.toBeInstanceOf(RevConflictError)
  })

  it('records.putMany.writes-every-row', async () => {
    const t = await thing()
    const out = await t.putMany({
      records: [
        { id: 'a', data: { name: 'A', group: 'g1' } },
        { id: 'b', data: { name: 'B', group: 'g2' } },
      ],
    })
    expect(out.count).toBe(2)
    expect((await t.get({ id: 'b' }))?.data.name).toBe('B')
  })

  it('records.patch.merges-and-null-removes', async () => {
    const t = await thing()
    await t.put({ id: 'a', data: { name: 'A', group: 'g1', token: 'x' } })
    await t.patch({ id: 'a', partial: { name: 'A2' } })
    expect((await t.getResolved({ id: 'a' }))?.data).toEqual({
      name: 'A2',
      group: 'g1',
      token: 'x',
    })
    await t.patch({ id: 'a', partial: { token: null } })
    expect((await t.get({ id: 'a' }))?.data).toEqual({ name: 'A2', group: 'g1' })
  })

  it('records.delete.reports-whether-a-row-went', async () => {
    const t = await thing()
    await t.put({ id: 'a', data: { name: 'A', group: 'g1' } })
    await expect(t.delete({ id: 'a' })).resolves.toEqual({ deleted: true })
    await expect(t.delete({ id: 'a' })).resolves.toEqual({ deleted: false })
  })

  it('records.query.pages-with-a-cursor', async () => {
    const t = await thing()
    await t.putMany({
      records: ['a', 'b', 'c'].map((id) => ({ id, data: { name: id, group: 'g1' } })),
    })
    const first = await t.query({ limit: 2 })
    expect(first.records).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const rest = await t.query({ limit: 2, cursor: first.nextCursor ?? '' })
    expect(rest.records).toHaveLength(1)
    expect(rest.nextCursor).toBeNull()
  })

  it('records.query.filters-on-a-declared-index', async () => {
    const t = await thing()
    await t.putMany({
      records: [
        { id: 'a', data: { name: 'A', group: 'g1' } },
        { id: 'b', data: { name: 'B', group: 'g2' } },
      ],
    })
    const page = await t.query({ where: { group: 'g2' } })
    expect(page.records.map((r) => r.id)).toEqual(['b'])
  })

  it('records.deleteWhere.deletes-the-matching-rows', async () => {
    const t = await thing()
    await t.putMany({
      records: [
        { id: 'a', data: { name: 'A', group: 'g1' } },
        { id: 'b', data: { name: 'B', group: 'g2' } },
      ],
    })
    await expect(t.deleteWhere({ where: { group: 'g1' } })).resolves.toEqual({ count: 1 })
    expect((await t.query({})).records.map((r) => r.id)).toEqual(['b'])
  })
})

describe('MigrationApiV1.settings', () => {
  it('settings.read.returns-the-addon-store', async () => {
    await api().settings.write({ patch: { host: '10.0.0.2' } })
    expect((await api().settings.read({})).store).toEqual({ host: '10.0.0.2' })
    expect((await world.apiFor(FOREIGN).settings.read({})).store).toEqual({})
  })

  it('settings.write.merges-and-keeps-other-keys', async () => {
    await api().settings.write({ patch: { a: 1, b: 2 } })
    await api().settings.write({ patch: { b: 3 } })
    expect((await api().settings.read({})).store).toEqual({ a: 1, b: 3 })
  })

  it('settings.deleteKeys.removes-only-the-named-keys', async () => {
    await api().settings.write({ patch: { a: 1, b: 2 } })
    const out = await api().settings.deleteKeys({ keys: ['a', 'missing'] })
    expect(out.removed).toEqual(['a'])
    expect((await api().settings.read({})).store).toEqual({ b: 2 })
  })
})

describe('MigrationApiV1.secrets', () => {
  const ref = (owner: string) =>
    createSecretsAccess({ owner, transport: world.keychain }).ref(globalSecretScope(), 'token')

  it('secrets.resolve.answers-null-for-a-missing-ref', async () => {
    await api().secrets.put({ ref: ref(OWNER), value: 'v' })
    const missing = ref(OWNER).replace('token', 'other')
    const out = await api().secrets.resolve({ refs: [ref(OWNER), missing] })
    expect(out.values).toEqual({ [ref(OWNER)]: 'v', [missing]: null })
  })

  it('secrets.put.stores-under-the-owner', async () => {
    await api().secrets.put({ ref: ref(OWNER), value: 'v' })
    expect(world.keychain.values.get(ref(OWNER))).toBe('v')
  })

  it('secrets.delete.ignores-unknown-refs', async () => {
    await api().secrets.put({ ref: ref(OWNER), value: 'v' })
    const unknown = ref(OWNER).replace('token', 'never')
    await expect(api().secrets.delete({ refs: [ref(OWNER), unknown] })).resolves.toEqual({
      deleted: 1,
    })
    expect(world.keychain.values.has(ref(OWNER))).toBe(false)
  })
})

describe('MigrationApiV1.devices', () => {
  beforeEach(() => {
    world.addDevice({ id: 1, addonId: OWNER, integrationId: INTEGRATION, name: 'one' })
    world.addDevice({ id: 2, addonId: OWNER, parentDeviceId: 1, name: 'two', config: { k: 1 } })
    world.addDevice({ id: 3, addonId: FOREIGN, integrationId: 'int_other', name: 'three' })
  })

  it('devices.list.scoped-to-the-addon', async () => {
    const out = await api().devices.list({ addonId: OWNER })
    expect(out.devices.map((d) => d.id)).toEqual([1, 2])
    expect(out.devices[1]?.parentDeviceId).toBe(1)
  })

  it('devices.list.filters-by-integration', async () => {
    const out = await api().devices.list({ addonId: OWNER, integrationId: INTEGRATION })
    expect(out.devices.map((d) => d.id)).toEqual([1])
  })

  it('devices.get.null-for-an-unknown-id', async () => {
    await expect(api().devices.get({ deviceId: 99 })).resolves.toBeNull()
  })

  it('devices.get.reports-link-and-config', async () => {
    await expect(api().devices.get({ deviceId: 1 })).resolves.toEqual({
      id: 1,
      integrationId: INTEGRATION,
      hasConfig: false,
    })
    await expect(api().devices.get({ deviceId: 2 })).resolves.toEqual({
      id: 2,
      integrationId: null,
      hasConfig: true,
    })
  })

  it('devices.setIntegrationId.links-the-device', async () => {
    await api().devices.setIntegrationId({ deviceId: 2, integrationId: INTEGRATION })
    expect((await api().devices.get({ deviceId: 2 }))?.integrationId).toBe(INTEGRATION)
    expect((await api().devices.get({ deviceId: 3 }))?.integrationId).toBe('int_other')
  })
})

describe('MigrationApiV1.integrations, node, log', () => {
  it('integrations.list.lists-every-integration', async () => {
    world.addIntegration({ id: 'int_0002', addonId: FOREIGN, name: 'second' })
    const out = await api().integrations.list({})
    expect(out.integrations.map((i) => [i.id, i.addonId])).toEqual([
      [INTEGRATION, OWNER],
      ['int_0002', FOREIGN],
    ])
  })

  it('integrations.get.null-for-an-unknown-id', async () => {
    expect((await api().integrations.get({ id: INTEGRATION }))?.addonId).toBe(OWNER)
    await expect(api().integrations.get({ id: 'int_9999' })).resolves.toBeNull()
  })

  it('node.localNodeId.names-this-node', async () => {
    await expect(api().node.localNodeId({})).resolves.toEqual({ nodeId: 'hub-test' })
  })

  it('log.info.writes-a-line', async () => {
    await api().log.info({ message: 'hello info' })
    expect(world.lines.some((l) => l.level === 'info' && l.message === 'hello info')).toBe(true)
  })

  it('log.warn.writes-a-line', async () => {
    await api().log.warn({ message: 'hello warn', meta: { n: 1 } })
    expect(world.lines.some((l) => l.level === 'warn' && l.message === 'hello warn')).toBe(true)
  })
})
