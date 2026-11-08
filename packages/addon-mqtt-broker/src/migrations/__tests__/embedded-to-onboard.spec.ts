import { defineAddonMigrations, makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { mqttBrokersEntryKind } from '../../broker-record-kinds.js'
import { planDropEmbeddedKeys } from '../embedded-to-onboard.js'
import {
  ADDON_MIGRATIONS,
  type ClientAclMigrationPorts,
  EMBEDDED_TO_ONBOARD_ID,
  type LegacyEmbedded,
} from '../index.js'

/** Marked values: each one has to arrive on the record, or the migration lost it. */
const MARKED: LegacyEmbedded = {
  enabled: true,
  id: 'emb-legacy-77',
  port: 18_841,
  allowAnonymous: true,
  username: 'mark-user',
  password: 'mark-password',
}

async function setup(options: { legacy?: LegacyEmbedded | null; existing?: string } = {}) {
  const world = makeInMemoryRecords('mqtt-broker')
  await world.records.declare({ brokers: mqttBrokersEntryKind })
  const handle = world.records.kind(mqttBrokersEntryKind)
  if (options.existing !== undefined) {
    await handle.put(
      {
        id: options.existing,
        data: { name: 'Existing', url: 'mqtt://keep:1883' },
      },
      { ifRev: 0 },
    )
  }
  const legacy = options.legacy === undefined ? MARKED : options.legacy
  const warnings: string[] = []
  const ports: ClientAclMigrationPorts = {
    readRawClientsAcl: async () => ({}),
    readClientAclRecordIds: async () => ({ clients: new Set<string>(), acl: new Set<string>() }),
    putClient: async () => undefined,
    putAcl: async () => undefined,
    readRawBrokers: async () => undefined,
    readRecords: async () => {
      const page = await handle.query({ limit: 100 })
      return new Map(
        page.records.map((r): [string, { hasPassword: boolean }] => [
          r.id,
          { hasPassword: (r.data.password ?? '').length > 0 },
        ]),
      )
    },
    readLegacyEmbedded: async () => legacy,
    readRawEmbeddedKeys: async () =>
      legacy === null
        ? {}
        : {
            embeddedEnabled: legacy.enabled,
            embeddedId: legacy.id,
            embeddedPort: legacy.port,
          },
    putOnboardRecord: async (id, body) => {
      await handle.put({ id, data: mqttBrokersEntryKind.schema.parse(body) }, { ifRev: 0 })
    },
    warn: (m) => {
      warnings.push(m)
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const find = (id: string) => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry
  }
  return {
    handle,
    warnings,
    execute: (id: string) => find(id).execute(),
    ports,
  }
}

describe('the legacy embedded broker becomes an onboard record', () => {
  it('keeps its id and carries every marked field onto the record', async () => {
    const w = await setup()
    await w.execute(EMBEDDED_TO_ONBOARD_ID)
    const row = await w.handle.get(MARKED.id)
    expect(row?.data).toMatchObject({
      name: 'Embedded broker',
      url: 'mqtt://127.0.0.1:18841',
      username: 'mark-user',
      onboard: { port: 18_841, allowAnonymous: true },
    })
    const resolved = await w.handle.getResolved(MARKED.id)
    expect(resolved?.data.password).toBe('mark-password')
  })

  it('does nothing when the broker was never enabled, and never overwrites a record of that id', async () => {
    const none = await setup({ legacy: null })
    await none.execute(EMBEDDED_TO_ONBOARD_ID)
    expect((await none.handle.query({ limit: 10 })).records).toEqual([])

    const taken = await setup({ existing: MARKED.id })
    await taken.execute(EMBEDDED_TO_ONBOARD_ID)
    expect((await taken.handle.get(MARKED.id))?.data.url).toBe('mqtt://keep:1883')
  })

  it('plans to delete the flat keys only once the record exists with its password', async () => {
    const before = await setup()
    await expect(planDropEmbeddedKeys(before.ports)).rejects.toThrow(/does not exist/)
    expect(before.warnings.join(' ')).toContain('keys are kept')

    const after = await setup()
    await after.execute(EMBEDDED_TO_ONBOARD_ID)
    const plan = await planDropEmbeddedKeys(after.ports)
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      op: 'deleteKeys',
      scope: 'addon-settings',
      keys: ['mqtt-broker.embeddedEnabled', 'mqtt-broker.embeddedId', 'mqtt-broker.embeddedPort'],
    })

    const nothing = await setup({ legacy: null })
    expect((await planDropEmbeddedKeys(nothing.ports)).edits).toEqual([])
  })

  it('migrates a STOPPED broker as a switched-off record, then drops its keys', async () => {
    const w = await setup({ legacy: { ...MARKED, enabled: false } })
    await w.execute(EMBEDDED_TO_ONBOARD_ID)
    const row = await w.handle.get(MARKED.id)
    expect(row?.data).toMatchObject({
      url: 'mqtt://127.0.0.1:18841',
      username: 'mark-user',
      enabled: false,
      onboard: { port: 18_841, allowAnonymous: true },
    })
    expect((await w.handle.getResolved(MARKED.id))?.data.password).toBe('mark-password')
    const plan = await planDropEmbeddedKeys(w.ports)
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      op: 'deleteKeys',
      scope: 'addon-settings',
    })
  })

  it('an enabled broker carries no enabled flag (it runs)', async () => {
    const w = await setup()
    await w.execute(EMBEDDED_TO_ONBOARD_ID)
    expect((await w.handle.get(MARKED.id))?.data.enabled).toBeUndefined()
  })
})
