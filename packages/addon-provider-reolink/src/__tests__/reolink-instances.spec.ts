/**
 * Reolink integrations as typed records (planning#416, D1007): the rows-to-record migration moves
 * each integration's OWN settings and secret into its record, and the runtime reads the record.
 */
import type { RecordIntegrationInstances } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { REOLINK_ROWS_TO_RECORD_ID, REOLINK_ROWS_TO_RECORD_MIGRATION } from '../migrations/index.js'
import {
  type ReolinkConnectionBody,
  readHubConnections,
  reolinkConnectionsEntryKind,
  reolinkRecordKinds,
} from '../reolink-instances.js'
import { fakeRowsWorld } from './support/fake-integration-rows.js'

const ADDON = 'provider-reolink'
const SECRETS = reolinkConnectionsEntryKind.declaration.secretPaths

const DEFAULT = {
  id: 'int_0012',
  name: 'Reolink',
  addonId: ADDON,
  rows: {
    host: '10.0.12.1',
    port: 9012,
    rtspPort: 5012,
    username: 'user-12',
    password: 'secret-of-0012',
    transport: 'tcp',
    debugGeneral: true,
    legacyUnreadKey: 'mark-12-unread',
  },
  secretRowKeys: ['password'],
} as const

const MIGRATED = {
  id: 'int_0031',
  name: 'Former hub',
  addonId: ADDON,
  rows: {
    host: '10.0.31.1',
    port: 9031,
    rtspPort: 5031,
    username: 'user-31',
    password: 'secret-of-0031',
    transport: 'udp',
    uid: 'UID-0031',
    debugSocketLogs: ['traceEvents'],
  },
  secretRowKeys: ['password'],
} as const

const OTHER_ADDON = {
  id: 'int_0099',
  name: 'Not Reolink',
  addonId: 'provider-other',
  rows: { host: '10.9.9.9', password: 'secret-of-0099' },
  secretRowKeys: ['password'],
} as const

async function run(world: ReturnType<typeof fakeRowsWorld>) {
  return REOLINK_ROWS_TO_RECORD_MIGRATION.procedure(world.ports)
}

describe('reolink rows-to-record migration', () => {
  it('has the id the brief names, an addon-owned block-owner migration', () => {
    expect(REOLINK_ROWS_TO_RECORD_MIGRATION.meta.id).toBe(REOLINK_ROWS_TO_RECORD_ID)
    expect(REOLINK_ROWS_TO_RECORD_MIGRATION.meta.id).toBe(
      'provider-reolink/2026-11-05-integration-rows-to-record',
    )
    expect(REOLINK_ROWS_TO_RECORD_MIGRATION.meta.onFailure).toBe('block-owner')
    expect(Object.keys(reolinkRecordKinds)).toEqual(['connections'])
    expect(SECRETS).toEqual(['password'])
  })

  it('gives each integration exactly its own values and its own secret, then clears its rows', async () => {
    const world = fakeRowsWorld([DEFAULT, MIGRATED, OTHER_ADDON], SECRETS)

    const first = await run(world)

    expect(first).toMatchObject({ outcome: 'done' })
    // int_0012: its marked fields and its secret, nothing of int_0031
    expect(world.records.get('int_0012')).toEqual({
      name: 'Reolink',
      host: '10.0.12.1',
      port: 9012,
      rtspPort: 5012,
      username: 'user-12',
      transport: 'tcp',
      debugGeneral: true,
    })
    expect(world.recordKeychain.get('int_0012/password')).toBe('secret-of-0012')
    // int_0031: its marked fields and its secret, nothing of int_0012
    expect(world.records.get('int_0031')).toEqual({
      name: 'Former hub',
      host: '10.0.31.1',
      port: 9031,
      rtspPort: 5031,
      username: 'user-31',
      transport: 'udp',
      uid: 'UID-0031',
      debugSocketLogs: ['traceEvents'],
    })
    expect(world.recordKeychain.get('int_0031/password')).toBe('secret-of-0031')
    // another addon's integration is not touched
    expect(world.records.has('int_0099')).toBe(false)
    expect(world.rows.get('int_0099')).toEqual(OTHER_ADDON.rows)
    // the legacy rows and their keychain values are gone (only the other addon's entry is left)
    expect(world.rows.get('int_0012')).toEqual({})
    expect(world.rows.get('int_0031')).toEqual({})
    expect([...world.rowKeychain]).toEqual(['int_0099/password'])
    // a key nothing reads is named by key, its value is never logged
    expect(world.warnings.join('\n')).toContain('legacyUnreadKey')
    expect(world.warnings.join('\n')).not.toContain('mark-12-unread')
    expect(world.warnings.join('\n')).not.toContain('secret-of')
    // every stored body is valid for the kind
    for (const id of ['int_0012', 'int_0031']) {
      expect(
        reolinkConnectionsEntryKind.schema.safeParse(await world.ports.readRecord(id)).success,
      ).toBe(true)
    }
  })

  it('is a no-op on a rerun and never overwrites a record that exists', async () => {
    const world = fakeRowsWorld([DEFAULT, MIGRATED], SECRETS)
    await run(world)
    const snapshot = JSON.stringify([...world.records])
    const again = await run(world)
    expect(again).toMatchObject({ outcome: 'already-done' })
    expect(JSON.stringify([...world.records])).toBe(snapshot)
  })

  it('moves a default integration that holds no rows as a name-only record', async () => {
    const world = fakeRowsWorld(
      [{ id: 'int_0001', name: 'Reolink', addonId: ADDON, rows: {}, secretRowKeys: [] }],
      SECRETS,
    )
    await run(world)
    expect(world.records.get('int_0001')).toEqual({ name: 'Reolink' })
  })
})

describe('reolink runtime reads the record', () => {
  const bodies: Record<string, ReolinkConnectionBody> = {
    int_0012: { name: 'Reolink' },
    int_0031: {
      name: 'Former hub',
      host: '10.0.31.1',
      username: 'user-31',
      password: 'secret-of-0031',
    },
  }
  function instancesOver(
    secrets: 'resolved' | 'unavailable',
  ): Pick<RecordIntegrationInstances<ReolinkConnectionBody>, 'readResolved'> {
    return {
      readResolved: async (id) => {
        const body = bodies[id]
        if (body === undefined) return null
        const open = secrets === 'unavailable' ? { ...body, password: undefined } : body
        return { id, body: open, enabled: true, secrets }
      },
    }
  }
  const integrations = [
    { id: 'int_0012', name: 'Reolink' },
    { id: 'int_0031', name: 'Former hub' },
    { id: 'int_0404', name: 'No record' },
  ]

  it('gives each integration the hub its own record names', async () => {
    const read = await readHubConnections(instancesOver('resolved'), integrations)
    expect(read.map((r) => [r.id, r.read.kind])).toEqual([
      ['int_0012', 'no-host'],
      ['int_0031', 'ok'],
      ['int_0404', 'no-host'],
    ])
    const hub = read[1]?.read
    expect(hub?.kind === 'ok' ? hub.connection.host : null).toBe('10.0.31.1')
    expect(hub?.kind === 'ok' ? hub.connection.password : null).toBe('secret-of-0031')
  })

  it('reads a record whose secrets the keychain could not serve as a locked password, never an empty one', async () => {
    const read = await readHubConnections(instancesOver('unavailable'), integrations)
    expect(read[1]?.read.kind).toBe('password-locked')
  })
})
