/**
 * Ecowitt gateways as typed records (planning#416, D1007): the rows-to-record migration moves each
 * integration's OWN connection and password into its record, and the reconciler reads the record.
 */
import { describe, expect, it } from 'vitest'
import { connectionFromSettings } from '../config.js'
import {
  ecowittConnectionsEntryKind,
  ecowittRecordKinds,
  settingsReadOf,
} from '../ecowitt-instances.js'
import { ECOWITT_ROWS_TO_RECORD_ID, ECOWITT_ROWS_TO_RECORD_MIGRATION } from '../migrations/index.js'
import { fakeRowsWorld } from './support/fake-integration-rows.js'

const ADDON = 'provider-ecowitt'
const SECRETS = ecowittConnectionsEntryKind.declaration.secretPaths

const GATEWAY = {
  id: 'int_0034',
  name: 'Garden gateway',
  addonId: ADDON,
  rows: {
    transport: 'local',
    host: '10.0.34.1',
    port: 8034,
    password: 'secret-of-0034',
    pollIntervalMs: 34_000,
    mappingIntervalMs: 340_000,
    stationId: 'station-34',
    legacyUnreadKey: 'mark-34-unread',
  },
  secretRowKeys: ['password'],
} as const

const LISTENER = {
  id: 'int_0035',
  name: 'Pushed station',
  addonId: ADDON,
  rows: { transport: 'listener', listenPort: 4235, listenHost: '10.0.35.2' },
  secretRowKeys: [],
} as const

const OTHER_ADDON = {
  id: 'int_0099',
  name: 'Not Ecowitt',
  addonId: 'provider-other',
  rows: { host: '10.9.9.9', password: 'secret-of-0099' },
  secretRowKeys: ['password'],
} as const

describe('ecowitt rows-to-record migration', () => {
  it('is declared with the id the brief names', () => {
    expect(ECOWITT_ROWS_TO_RECORD_ID).toBe('provider-ecowitt/2026-11-05-integration-rows-to-record')
    expect(ECOWITT_ROWS_TO_RECORD_MIGRATION.meta.onFailure).toBe('block-owner')
    expect(Object.keys(ecowittRecordKinds)).toEqual(['connections'])
    expect(SECRETS).toEqual(['password'])
  })

  it('gives each gateway exactly its own connection and password, then clears its rows', async () => {
    const world = fakeRowsWorld([GATEWAY, LISTENER, OTHER_ADDON], SECRETS)

    const first = await ECOWITT_ROWS_TO_RECORD_MIGRATION.procedure(world.ports)

    expect(first).toMatchObject({ outcome: 'done' })
    expect(world.records.get('int_0034')).toEqual({
      name: 'Garden gateway',
      transport: 'local',
      host: '10.0.34.1',
      port: 8034,
      pollIntervalMs: 34_000,
      mappingIntervalMs: 340_000,
      stationId: 'station-34',
    })
    expect(world.recordKeychain.get('int_0034/password')).toBe('secret-of-0034')
    expect(world.records.get('int_0035')).toEqual({
      name: 'Pushed station',
      transport: 'listener',
      listenPort: 4235,
      listenHost: '10.0.35.2',
    })
    expect(world.recordKeychain.has('int_0035/password')).toBe(false)
    expect(world.records.has('int_0099')).toBe(false)
    expect(world.rows.get('int_0034')).toEqual({})
    expect(world.rows.get('int_0035')).toEqual({})
    expect(world.rows.get('int_0099')).toEqual(OTHER_ADDON.rows)
    expect([...world.rowKeychain]).toEqual(['int_0099/password'])
    expect(world.warnings.join('\n')).toContain('legacyUnreadKey')
    expect(world.warnings.join('\n')).not.toContain('mark-34-unread')
    expect(world.warnings.join('\n')).not.toContain('secret-of')
  })

  it('is a no-op on a rerun', async () => {
    const world = fakeRowsWorld([GATEWAY, LISTENER], SECRETS)
    await ECOWITT_ROWS_TO_RECORD_MIGRATION.procedure(world.ports)
    const snapshot = JSON.stringify([...world.records])
    const again = await ECOWITT_ROWS_TO_RECORD_MIGRATION.procedure(world.ports)
    expect(again).toMatchObject({ outcome: 'already-done' })
    expect(JSON.stringify([...world.records])).toBe(snapshot)
  })

  it('a moved gateway dials as it did: the record parses to the same connection', async () => {
    const world = fakeRowsWorld([GATEWAY], SECRETS)
    await ECOWITT_ROWS_TO_RECORD_MIGRATION.procedure(world.ports)
    const back = await world.ports.readRecord('int_0034')
    expect(back).not.toBeNull()
    const read = connectionFromSettings(
      settingsReadOf({
        id: 'int_0034',
        body: ecowittConnectionsEntryKind.schema.parse(back),
        enabled: true,
        secrets: 'resolved',
      }).values,
      false,
    )
    expect(read?.connection).toMatchObject({
      transport: 'local',
      host: '10.0.34.1',
      port: 8034,
      password: 'secret-of-0034',
      pollIntervalMs: 34_000,
    })
  })
})

describe('ecowitt reconciler reads the record', () => {
  it('a record with its secrets read is a usable connection with its password', () => {
    const stored = settingsReadOf({
      id: 'int_0034',
      body: { name: 'G', transport: 'local', host: '10.0.34.1', password: 'pw' },
      enabled: true,
      secrets: 'resolved',
    })
    expect(stored.secretsLocked).toBe(false)
    expect(connectionFromSettings(stored.values, stored.secretsLocked)?.passwordLocked).toBe(false)
  })

  it('a record whose secrets the keychain could not serve is locked, never an empty password', () => {
    const stored = settingsReadOf({
      id: 'int_0034',
      body: { name: 'G', transport: 'local', host: '10.0.34.1' },
      enabled: true,
      secrets: 'unavailable',
    })
    expect(stored.secretsLocked).toBe(true)
    expect(connectionFromSettings(stored.values, stored.secretsLocked)?.passwordLocked).toBe(true)
  })

  it('an absent record reads as no usable connection', () => {
    const stored = settingsReadOf(null)
    expect(connectionFromSettings(stored.values, stored.secretsLocked)).toBeNull()
  })
})

describe('ecowitt migration verifies the secret before it clears the rows', () => {
  it('a record that lost its password is not trusted: the rows stay and the move stops', async () => {
    const world = fakeRowsWorld([GATEWAY], SECRETS)
    const lossy = {
      ...world.ports,
      readRecord: async (id: string) => {
        const back = await world.ports.readRecord(id)
        if (back === null) return back
        return Object.fromEntries(Object.entries(back).filter(([key]) => !SECRETS.includes(key)))
      },
    }

    await expect(ECOWITT_ROWS_TO_RECORD_MIGRATION.procedure(lossy)).rejects.toThrow()

    expect(world.rows.get('int_0034')).toEqual(GATEWAY.rows)
    expect(world.rowKeychain.has('int_0034/password')).toBe(true)
  })
})
