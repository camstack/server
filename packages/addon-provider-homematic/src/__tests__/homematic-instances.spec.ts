/**
 * Homematic CCUs as typed records (planning#416, D1007): the rows-to-record migration moves each
 * integration's OWN connection and WebUI password into its record, and the reconciler reads the record.
 */
import { makeInMemoryRecords, REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { connectionFromSettings } from '../config.js'
import {
  buildHomematicConnectionTestProvider,
  CcuProbeError,
  type CcuProbeInput,
} from '../homematic-connection-test.js'
import {
  buildHomematicInstances,
  homematicConnectionsEntryKind,
  homematicRecordKinds,
  knownCcuHostsOf,
  readCcuConnection,
  settingsReadOf,
} from '../homematic-instances.js'
import {
  HOMEMATIC_ROWS_TO_RECORD_ID,
  HOMEMATIC_ROWS_TO_RECORD_MIGRATION,
} from '../migrations/index.js'
import { fakeRowsWorld } from './support/fake-integration-rows.js'

const ADDON = 'provider-homematic'
const SECRETS = homematicConnectionsEntryKind.declaration.secretPaths

const CCU_A = {
  id: 'int_0021',
  name: 'House CCU',
  addonId: ADDON,
  rows: {
    host: '10.0.21.1',
    enableHmipRf: true,
    enableBidcosRf: true,
    enableGroups: false,
    username: 'user-21',
    password: 'secret-of-0021',
    callbackHost: '10.0.21.9',
    callbackPort: 2221,
    tls: true,
    legacyUnreadKey: 'mark-21-unread',
  },
  secretRowKeys: ['password'],
} as const

const CCU_B = {
  id: 'int_0022',
  name: 'Garage CCU',
  addonId: ADDON,
  rows: { host: '10.0.22.1', username: 'user-22', password: 'secret-of-0022', callbackPort: '' },
  secretRowKeys: ['password'],
} as const

const OTHER_ADDON = {
  id: 'int_0099',
  name: 'Not Homematic',
  addonId: 'provider-other',
  rows: { host: '10.9.9.9', password: 'secret-of-0099' },
  secretRowKeys: ['password'],
} as const

describe('homematic rows-to-record migration', () => {
  it('is declared with the id the brief names and blocks its owner', () => {
    expect(HOMEMATIC_ROWS_TO_RECORD_ID).toBe(
      'provider-homematic/2026-11-05-integration-rows-to-record',
    )
    expect(HOMEMATIC_ROWS_TO_RECORD_MIGRATION.meta.onFailure).toBe('block-owner')
    expect(Object.keys(homematicRecordKinds)).toEqual(['connections'])
    expect(SECRETS).toEqual(['password'])
  })

  it('gives each CCU exactly its own connection and password, then clears its rows', async () => {
    const world = fakeRowsWorld([CCU_A, CCU_B, OTHER_ADDON], SECRETS)

    const first = await HOMEMATIC_ROWS_TO_RECORD_MIGRATION.procedure(world.ports)

    expect(first).toMatchObject({ outcome: 'done' })
    expect(world.records.get('int_0021')).toEqual({
      name: 'House CCU',
      host: '10.0.21.1',
      enableHmipRf: true,
      enableBidcosRf: true,
      enableGroups: false,
      username: 'user-21',
      callbackHost: '10.0.21.9',
      callbackPort: 2221,
      tls: true,
    })
    expect(world.recordKeychain.get('int_0021/password')).toBe('secret-of-0021')
    expect(world.records.get('int_0022')).toEqual({
      name: 'Garage CCU',
      host: '10.0.22.1',
      username: 'user-22',
    })
    expect(world.recordKeychain.get('int_0022/password')).toBe('secret-of-0022')
    expect(world.records.has('int_0099')).toBe(false)
    expect(world.rows.get('int_0021')).toEqual({})
    expect(world.rows.get('int_0022')).toEqual({})
    expect(world.rows.get('int_0099')).toEqual(OTHER_ADDON.rows)
    expect([...world.rowKeychain]).toEqual(['int_0099/password'])
    expect(world.warnings.join('\n')).toContain('legacyUnreadKey')
    expect(world.warnings.join('\n')).not.toContain('mark-21-unread')
    expect(world.warnings.join('\n')).not.toContain('secret-of')
  })

  it('is a no-op on a rerun', async () => {
    const world = fakeRowsWorld([CCU_A, CCU_B], SECRETS)
    await HOMEMATIC_ROWS_TO_RECORD_MIGRATION.procedure(world.ports)
    const snapshot = JSON.stringify([...world.records])
    const again = await HOMEMATIC_ROWS_TO_RECORD_MIGRATION.procedure(world.ports)
    expect(again).toMatchObject({ outcome: 'already-done' })
    expect(JSON.stringify([...world.records])).toBe(snapshot)
  })

  it('a moved CCU connects as it did: the record parses to the same connection', async () => {
    const world = fakeRowsWorld([CCU_A], SECRETS)
    await HOMEMATIC_ROWS_TO_RECORD_MIGRATION.procedure(world.ports)
    const back = await world.ports.readRecord('int_0021')
    expect(back).not.toBeNull()
    const read = settingsReadOf({
      id: 'int_0021',
      body: homematicConnectionsEntryKind.schema.parse(back),
      enabled: true,
      secrets: 'resolved',
    })
    expect(connectionFromSettings(read.values)).toMatchObject({
      host: '10.0.21.1',
      enableBidcosRf: true,
      enableGroups: false,
      username: 'user-21',
      password: 'secret-of-0021',
      callbackHost: '10.0.21.9',
      callbackPort: 2221,
      tls: true,
    })
  })
})

describe('homematic reconciler reads the record', () => {
  it('a record with its secrets read is a usable connection', () => {
    const stored = settingsReadOf({
      id: 'int_0021',
      body: { name: 'C', host: '10.0.21.1', password: 'pw' },
      enabled: true,
      secrets: 'resolved',
    })
    expect(stored.secretsLocked).toBe(false)
    expect(connectionFromSettings(stored.values)?.password).toBe('pw')
  })

  it('a record whose secrets the keychain could not serve is locked, never an empty password', () => {
    const stored = settingsReadOf({
      id: 'int_0021',
      body: { name: 'C', host: '10.0.21.1' },
      enabled: true,
      secrets: 'unavailable',
    })
    expect(stored.secretsLocked).toBe(true)
  })

  it('an absent record reads as no usable connection', () => {
    expect(connectionFromSettings(settingsReadOf(null).values)).toBeNull()
  })
})

describe('homematic migration verifies the secret before it clears the rows', () => {
  it('a record that lost its password is not trusted: the rows stay and the move stops', async () => {
    const world = fakeRowsWorld([CCU_A], SECRETS)
    const lossy = {
      ...world.ports,
      readRecord: async (id: string) => {
        const back = await world.ports.readRecord(id)
        if (back === null) return back
        return Object.fromEntries(Object.entries(back).filter(([key]) => !SECRETS.includes(key)))
      },
    }

    await expect(HOMEMATIC_ROWS_TO_RECORD_MIGRATION.procedure(lossy)).rejects.toThrow()

    expect(world.rows.get('int_0021')).toEqual(CCU_A.rows)
    expect(world.rowKeychain.has('int_0021/password')).toBe(true)
  })
})

describe('homematic readers go through the record', () => {
  async function engineWith(boards: Record<string, Record<string, unknown>>) {
    const engine = makeInMemoryRecords(ADDON)
    await engine.records.declare(homematicRecordKinds)
    const instances = buildHomematicInstances(engine.records, {
      onChanged: async () => undefined,
      tester: { testSettings: async () => ({ outcome: 'inconclusive', error: 'unused' }) },
    })
    const handle = engine.records.kind(homematicConnectionsEntryKind)
    for (const [id, body] of Object.entries(boards)) {
      await handle.put({ id, data: homematicConnectionsEntryKind.schema.parse(body) }, { ifRev: 0 })
    }
    return instances
  }

  it('a connection comes from the record with its own WebUI password', async () => {
    const instances = await engineWith({
      int_0021: { name: 'House', host: '10.0.21.1', username: 'u21', password: 'pw-21' },
      int_0022: { name: 'Garage', host: '10.0.22.1', username: 'u22', password: 'pw-22' },
    })
    expect((await readCcuConnection(instances, 'int_0021')).connection).toMatchObject({
      host: '10.0.21.1',
      username: 'u21',
      password: 'pw-21',
    })
    expect((await readCcuConnection(instances, 'int_0022')).connection).toMatchObject({
      host: '10.0.22.1',
      password: 'pw-22',
    })
    expect((await readCcuConnection(instances, 'int_0404')).connection).toBeNull()
  })

  it('discovery leaves out the hosts of the CCUs already set up, and skips an unreadable one', async () => {
    const instances = await engineWith({
      int_0021: { name: 'House', host: '10.0.21.1' },
      int_0022: { name: 'Garage', host: '10.0.22.1' },
    })
    const unreadable: string[] = []
    const hosts = await knownCcuHostsOf({
      instances: {
        readResolved: async (id) => {
          if (id === 'int_0023') throw new Error('records engine unreachable')
          return instances.readResolved(id)
        },
      },
      integrationIds: ['int_0021', 'int_0022', 'int_0023', 'int_0404'],
      onUnreadable: (id) => unreadable.push(id),
    })
    expect(hosts).toEqual(['10.0.21.1', '10.0.22.1'])
    expect(unreadable).toEqual(['int_0023'])
  })
})

describe('homematic testInstance', () => {
  async function testWorld() {
    const engine = makeInMemoryRecords(ADDON)
    await engine.records.declare(homematicRecordKinds)
    // A CCU whose WebUI accepts exactly one password; records every probe.
    const seen: CcuProbeInput[] = []
    const probe = async (input: CcuProbeInput) => {
      seen.push(input)
      if (input.password !== 'pw-ok') throw new CcuProbeError('bad-credentials', 'refused')
      return { interfaces: ['HmIP-RF'], namesUnlocked: true }
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const tester = buildHomematicConnectionTestProvider({ logger: logger as never, probe })
    const instances = buildHomematicInstances(engine.records, {
      onChanged: async () => undefined,
      tester,
    })
    await engine.records
      .kind(homematicConnectionsEntryKind)
      .put(
        {
          id: 'int_0031',
          data: homematicConnectionsEntryKind.schema.parse({
            name: 'House',
            host: '10.0.31.1',
            username: 'u31',
            password: 'pw-ok',
          }),
        },
        { ifRev: 0 },
      )
    return { instances, seen }
  }

  it('offers the Test action', async () => {
    const w = await testWorld()
    expect((await w.instances.describe()).canTest).toBe(true)
  })

  it('a stored CCU is tested with its keychain password when the form does not retype it', async () => {
    const w = await testWorld()
    const result = await w.instances.testInstance({
      id: 'int_0031',
      values: { host: '10.0.31.1', username: 'u31', password: REDACTED_SECRET },
    })
    expect(result).toMatchObject({ success: true, status: 'validated' })
    expect(w.seen.at(-1)).toMatchObject({ host: '10.0.31.1', username: 'u31', password: 'pw-ok' })
  })

  it('a draft with a wrong WebUI password is rejected', async () => {
    const w = await testWorld()
    const result = await w.instances.testInstance({
      id: null,
      values: { host: '10.0.31.1', username: 'u31', password: 'wrong' },
    })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(w.seen.at(-1)?.password).toBe('wrong')
  })
})
