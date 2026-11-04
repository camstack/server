/**
 * The Home Assistant instance values leave `integration_settings` for the instance record
 * (planning#416), on the REAL records engine over SQLite. The fixture marks a calendar id
 * (`MARK-…`) in the integration rows only; it must read back from the record, the record's own
 * values must win, a rerun must write nothing, and the rows are cleared only after the record
 * shows the set.
 */
import {
  createRecordsAccess,
  createSecretsAccess,
  defineAddonMigrations,
  flattenPortsOver,
  type MigrationOwnerResult,
  type RecordKindHandle,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  makeFakeKeychain,
  makeRecordsWorld,
} from '../../../../system/src/builtins/sqlite-storage/__tests__/support/records-world.js'
import { fakeIntegrations, type FakeIntegrations } from '../../__tests__/fake-integrations.js'
import {
  type HaBrokerBody,
  HA_BROKERS_OWNER,
  haBrokersEntryKind,
} from '../../broker-record-kinds.js'
import { haInstanceRecordPortsOver } from '../../ha-instance-settings.js'
import { haInstanceSettingsPortsOver } from '../legacy-integration-rows.js'
import {
  ADDON_MIGRATIONS,
  CLEAR_INSTANCE_SETTINGS_ROWS_ID,
  INSTANCE_SETTINGS_TO_RECORD_ID,
} from '../index.js'

const MARK = 'calendar.MARK-family'

interface World {
  readonly handle: RecordKindHandle<HaBrokerBody>
  readonly integrations: FakeIntegrations
  readonly run: (id: string) => Promise<MigrationOwnerResult>
}

async function boot(rows: Record<string, Record<string, unknown>>): Promise<World> {
  const records = makeRecordsWorld()
  await records.provider.init()
  const access = createRecordsAccess({
    owner: HA_BROKERS_OWNER,
    transport: records.transportFor(HA_BROKERS_OWNER),
    secrets: createSecretsAccess({ owner: HA_BROKERS_OWNER, transport: makeFakeKeychain() }),
  })
  await access.declare({ brokers: haBrokersEntryKind })
  const handle = access.kind(haBrokersEntryKind)
  await handle.put(
    { id: 'ha_001', data: { name: 'Broker one', authKind: 'supervisor', supervisorToken: 's1' } },
    { ifRev: 0 },
  )
  await handle.put(
    {
      id: 'ha_002',
      data: {
        name: 'Broker two',
        authKind: 'supervisor',
        supervisorToken: 's2',
        calendarIds: ['calendar.own'],
      },
    },
    { ifRev: 0 },
  )
  const integrations = fakeIntegrations(rows)
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, {
    ...haInstanceSettingsPortsOver(integrations.api),
    ...haInstanceRecordPortsOver(handle),
    ...flattenPortsOver(handle),
    readStored: async () => ({ kind: 'absent' }),
  })
  return {
    handle,
    integrations,
    run: async (id) => {
      const entry = bound.find((b) => b.meta.id === id)
      if (entry === undefined) throw new Error(`no migration ${id}`)
      return entry.execute()
    },
  }
}

let w: World
beforeEach(async () => {
  w = await boot({
    int_1: { brokerId: 'ha_001', calendarIds: [MARK, 'calendar.work'] },
    int_2: { brokerId: 'ha_002', calendarIds: ['calendar.legacy'] },
  })
})

describe('HA instance settings -> instance record on real SQLite', () => {
  it('a marked calendar survives onto the record; the record wins where it holds a value', async () => {
    await w.run(INSTANCE_SETTINGS_TO_RECORD_ID)
    const one = await w.handle.get('ha_001')
    expect(one?.data.calendarIds).toEqual([MARK, 'calendar.work'])
    expect(one?.data.integrationId).toBe('int_1')
    const two = await w.handle.get('ha_002')
    expect(two?.data.calendarIds).toEqual(['calendar.own'])
    expect(two?.data.integrationId).toBe('int_2')
  })

  it('a second run changes nothing', async () => {
    await w.run(INSTANCE_SETTINGS_TO_RECORD_ID)
    const before = JSON.stringify((await w.handle.query({ limit: 10 })).records)
    expect(await w.run(INSTANCE_SETTINGS_TO_RECORD_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(JSON.stringify((await w.handle.query({ limit: 10 })).records)).toBe(before)
  })

  it('clears a row key only after the record shows the same set; a differing set stays parked', async () => {
    await w.run(INSTANCE_SETTINGS_TO_RECORD_ID)
    await w.run(CLEAR_INSTANCE_SETTINGS_ROWS_ID)
    expect(w.integrations.settingsOf('int_1')).toEqual({ brokerId: 'ha_001' })
    // The record held a different set, so the row keeps what it had.
    expect(w.integrations.settingsOf('int_2')).toEqual({
      brokerId: 'ha_002',
      calendarIds: ['calendar.legacy'],
    })
  })

  it('clearing before the move leaves every row untouched', async () => {
    await w.run(CLEAR_INSTANCE_SETTINGS_ROWS_ID)
    expect(w.integrations.settingsOf('int_1')).toEqual({
      brokerId: 'ha_001',
      calendarIds: [MARK, 'calendar.work'],
    })
  })

  it('an integration whose broker has no record is skipped, never recreated', async () => {
    const gone = await boot({ int_9: { brokerId: 'ha_999', calendarIds: [MARK] } })
    await gone.run(INSTANCE_SETTINGS_TO_RECORD_ID)
    expect(await gone.handle.get('ha_999')).toBeNull()
  })

  it('two integrations linking one broker are an ambiguity and move nothing', async () => {
    const dup = await boot({
      a: { brokerId: 'ha_001', calendarIds: [MARK] },
      b: { brokerId: 'ha_001', calendarIds: ['calendar.x'] },
    })
    expect(await dup.run(INSTANCE_SETTINGS_TO_RECORD_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringMatching(/both link broker/),
    })
    expect((await dup.handle.get('ha_001'))?.data.calendarIds).toBeUndefined()
  })
})
