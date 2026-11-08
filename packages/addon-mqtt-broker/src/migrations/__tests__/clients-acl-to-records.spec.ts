import { defineAddonMigrations, makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { mqttAclEntryKind, mqttClientEntryKind } from '../../mqtt-entry-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  CLIENTS_ACL_TO_RECORDS_ID,
  type ClientAclMigrationPorts,
  DROP_CLIENTS_ACL_KEYS_ID,
} from '../index.js'

const LEGACY_CLIENTS = [
  { username: 'marked-client', passwordHash: '$2b$10$markedhash' },
  { username: 'second', passwordHash: '$2b$10$other' },
]
const LEGACY_ACL = [{ username: 'marked-client', topicPattern: 'home/#', access: 'both' }]

async function setup(
  options: { existingClientHash?: string; raw?: Readonly<Record<string, unknown>> } = {},
) {
  const world = makeInMemoryRecords('mqtt-broker')
  await world.records.declare({
    'mqtt-client': mqttClientEntryKind,
    'mqtt-acl-rule': mqttAclEntryKind,
  })
  const clients = world.records.kind(mqttClientEntryKind)
  const acl = world.records.kind(mqttAclEntryKind)
  if (options.existingClientHash !== undefined) {
    await clients.put(
      {
        id: 'marked-client',
        data: {
          name: 'marked-client',
          passwordHash: options.existingClientHash,
        },
      },
      { ifRev: 0 },
    )
  }
  const warnings: string[] = []
  const ports: ClientAclMigrationPorts = {
    readRawBrokers: async () => undefined,
    readRecords: async () => new Map(),
    readLegacyEmbedded: async () => null,
    readRawEmbeddedKeys: async () => ({}),
    putOnboardRecord: async () => undefined,
    readRawClientsAcl: async () =>
      options.raw ?? {
        embeddedClients: LEGACY_CLIENTS,
        embeddedAcl: LEGACY_ACL,
      },
    readClientAclRecordIds: async () => ({
      clients: new Set((await clients.query({ limit: 100 })).records.map((r) => r.id)),
      acl: new Set((await acl.query({ limit: 100 })).records.map((r) => r.id)),
    }),
    putClient: async (entry) => {
      await clients.put(
        {
          id: entry.username,
          data: mqttClientEntryKind.schema.parse({
            name: entry.username,
            passwordHash: entry.passwordHash,
          }),
        },
        { ifRev: 0 },
      )
    },
    putAcl: async (entry) => {
      await acl.put(
        {
          id: `${entry.username}\u0000${entry.topicPattern}`,
          data: mqttAclEntryKind.schema.parse({
            name: `${entry.username} · ${entry.topicPattern}`,
            ...entry,
          }),
        },
        { ifRev: 0 },
      )
    },
    warn: (m) => {
      warnings.push(m)
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const execute = (id: string) => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { clients, acl, warnings, execute, ports }
}

describe('the embedded clients and ACL become records', () => {
  it('keeps every id and carries the marked hash and rule onto its record', async () => {
    const w = await setup()
    const result = await w.execute(CLIENTS_ACL_TO_RECORDS_ID)
    expect(result).toMatchObject({
      result: { outcome: 'done', summary: { migrated: 3 } },
    })
    const client = await w.clients.get('marked-client')
    expect(client?.data.passwordHash).toBe('$2b$10$markedhash')
    expect((await w.clients.get('second'))?.data.passwordHash).toBe('$2b$10$other')
    const rule = await w.acl.get('marked-client\u0000home/#')
    expect(rule?.data.access).toBe('both')
  })

  it('never overwrites a record that is already there, and a second run does nothing', async () => {
    const w = await setup({ existingClientHash: '$2b$10$live' })
    expect(await w.execute(CLIENTS_ACL_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'done', summary: { migrated: 2 } },
    })
    expect((await w.clients.get('marked-client'))?.data.passwordHash).toBe('$2b$10$live')
    expect(await w.execute(CLIENTS_ACL_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
  })

  it('plans to delete both keys only once every entry has its record', async () => {
    const w = await setup()
    const refused = await w.execute(DROP_CLIENTS_ACL_KEYS_ID)
    expect(refused).toMatchObject({ kind: 'failed' })
    expect(w.warnings.join(' ')).toContain('kept')
    await w.execute(CLIENTS_ACL_TO_RECORDS_ID)
    expect(await w.execute(DROP_CLIENTS_ACL_KEYS_ID)).not.toMatchObject({
      kind: 'failed',
    })
  })

  it('names every rejected legacy entry with its reason, copies the rest, and keeps the keys', async () => {
    const w = await setup({
      raw: {
        embeddedClients: [
          { username: 'good', passwordHash: '$2b$10$ok' },
          { username: 'nohash' },
          'not-an-object',
        ],
        embeddedAcl: [{ username: 'good', topicPattern: 'a/#', access: 'rw' }],
      },
    })
    expect(await w.execute(CLIENTS_ACL_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'done', summary: { migrated: 1 } },
    })
    const log = w.warnings.join('\n')
    expect(log).toContain("'nohash'")
    expect(log).toContain('passwordHash')
    expect(log).toContain("'#2'")
    expect(log).toContain('good a/#')
    // The valid client has its record, yet the plan still refuses: unreadable entries remain.
    expect(await w.execute(DROP_CLIENTS_ACL_KEYS_ID)).toMatchObject({ kind: 'failed' })
  })
})
