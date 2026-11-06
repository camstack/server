/**
 * The calendar array of each Home Assistant connection becomes one `calendars` record per
 * calendar, linked to its connection (D1013), through the production port binding over the real
 * records engine (in-memory) and the real addon-settings table (SQLite).
 */
import {
  type CalendarRecordPorts,
  calendarRecordId,
  makeInMemoryRecords,
  type FlattenRowPorts,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { haBrokersEntryKind, haCalendarsEntryKind } from '../../broker-record-kinds.js'
import { NO_LINK_PORTS } from '../../__tests__/no-link-ports.js'
import { rawBrokers } from '../../__tests__/raw-brokers.js'
import { settingsFixture } from '../../__tests__/settings-fixture.js'
import { ADDON_MIGRATIONS, CALENDAR_IDS_TO_RECORDS_ID } from '../index.js'
import { haCalendarRecordPortsOver } from '../calendar-ports.js'

type Body = Record<string, unknown>
const NO_FLATTEN_PORTS: FlattenRowPorts = {
  listNested: async () => [],
  readResolved: async () => ({}),
  patch: async () => undefined,
}
const stringsOf = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined

const connection = (name: string, extra: Body = {}): Body => ({
  name,
  authKind: 'long-lived',
  baseUrl: `http://${name}.local:8123`,
  accessToken: `${name}-token`,
  ...extra,
})

async function start(
  brokers: Record<string, Body>,
  wrap: (ports: CalendarRecordPorts) => CalendarRecordPorts = (ports) => ports,
) {
  const world = makeInMemoryRecords('provider-homeassistant')
  await world.records.declare({
    brokers: haBrokersEntryKind,
    calendars: haCalendarsEntryKind,
  })
  const raw = rawBrokers(world.records)
  for (const [id, data] of Object.entries(brokers)) await raw.put({ id, data })
  const calendars = world.records.kind(haCalendarsEntryKind)
  const warnings: string[] = []
  const f = settingsFixture(
    'provider-homeassistant',
    ADDON_MIGRATIONS.filter((m) => m.meta.id === CALENDAR_IDS_TO_RECORDS_ID),
    (readStored) => ({
      readStored,
      listInstances: async () => [],
      patchInstanceSettings: async () => false,
      clearInstanceSettingsKeys: async () => false,
      readInstance: async () => null,
      patchInstance: async () => false,
      ...NO_FLATTEN_PORTS,
      ...NO_LINK_PORTS,
      ...wrap(
        haCalendarRecordPortsOver({
          brokers: raw,
          calendars,
          warn: (message) => warnings.push(message),
        }),
      ),
    }),
    {},
    'keep-me',
  )
  const arrayOf = async (id: string) => stringsOf((await raw.get(id))?.data['calendarIds'])
  return { f, raw, calendars, warnings, arrayOf }
}

describe('provider-homeassistant calendar ids to calendar records', () => {
  it('writes one linked record per calendar, then clears the array; a marked field survives', async () => {
    const { f, raw, calendars, arrayOf } = await start({
      ha_001: connection('A', {
        calendarIds: ['calendar.work', 'calendar.home'],
        mark: 'survive-A',
      }),
      ha_002: connection('B', { calendarIds: ['calendar.other'] }),
      ha_003: connection('C', { calendarIds: [] }),
    })
    const result = await f.boot()
    expect(result.failed).toEqual([])
    expect(result.applied).toContain(CALENDAR_IDS_TO_RECORDS_ID)
    const work = await calendars.get(calendarRecordId('ha_001', 'calendar.work'))
    expect(work?.data).toEqual({
      name: 'calendar.work',
      accountId: 'ha_001',
      calendarId: 'calendar.work',
    })
    expect(
      (await calendars.get(calendarRecordId('ha_002', 'calendar.other')))?.data.accountId,
    ).toBe('ha_002')
    expect((await calendars.query({ limit: 50 })).records).toHaveLength(3)
    for (const id of ['ha_001', 'ha_002', 'ha_003']) expect(await arrayOf(id)).toBeUndefined()
    const kept = await raw.getResolved('ha_001')
    expect(kept?.data['mark']).toBe('survive-A')
    expect(kept?.data['accessToken']).toBe('A-token')
    expect(await raw.get('ha_003')).not.toBeNull()
  })

  it('a second run is a no-op', async () => {
    const { f, calendars } = await start({
      ha_001: connection('A', { calendarIds: ['calendar.work'] }),
    })
    await f.boot()
    const before = await calendars.query({ limit: 50 })
    const again = await f.boot()
    expect(again.failed).toEqual([])
    expect((await calendars.query({ limit: 50 })).records).toEqual(before.records)
  })

  it('a record that does not read back keeps the array, and the other connections still move', async () => {
    const { f, calendars, arrayOf } = await start(
      {
        ha_001: connection('A', { calendarIds: ['calendar.lost'] }),
        ha_002: connection('B', { calendarIds: ['calendar.ok'] }),
      },
      (ports) => ({
        ...ports,
        readCalendar: async (id) =>
          id === calendarRecordId('ha_001', 'calendar.lost') ? null : ports.readCalendar(id),
      }),
    )
    const result = await f.boot()
    expect(result.failed).toEqual([CALENDAR_IDS_TO_RECORDS_ID])
    expect(await arrayOf('ha_001')).toEqual(['calendar.lost'])
    expect(await arrayOf('ha_002')).toBeUndefined()
    expect(await calendars.get(calendarRecordId('ha_002', 'calendar.ok'))).not.toBeNull()
  })

  it('an array that is not a list of ids stays where it is', async () => {
    const { f, raw } = await start({ ha_001: connection('A', { calendarIds: 'calendar.x' }) })
    expect((await f.boot()).failed).toEqual([CALENDAR_IDS_TO_RECORDS_ID])
    expect((await raw.get('ha_001'))?.data['calendarIds']).toBe('calendar.x')
  })
})
