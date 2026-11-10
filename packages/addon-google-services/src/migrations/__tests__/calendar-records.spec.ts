/**
 * The calendar array of each Google account becomes one `calendars` record per calendar, linked to
 * its account (D1013), through the production port binding over the real records engine
 * (in-memory) and the real addon-settings table (SQLite).
 */
import {
  type CalendarRecordPorts,
  calendarRecordId,
  makeInMemoryRecords,
  type RecordKindHandle,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { googleBrokersEntryKind, googleCalendarsEntryKind } from '../../broker-record-kinds.js'
import { settingsFixture } from '../../__tests__/settings-fixture.js'
import {
  ADDON_MIGRATIONS,
  CALENDAR_IDS_TO_RECORDS_ID,
  type GoogleMigrationPorts,
} from '../index.js'
import { calendarIdsPortsOver, calendarRecordPortsOver } from '../ports.js'
import { NO_LEGACY_PORTS, NO_OAUTH_ACCOUNTS_PORTS } from './inert-ports.js'

type Body = Record<string, unknown>
const stringsOf = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined

const account = (name: string, extra: Body = {}): Body => ({
  name,
  clientId: `${name}-client`,
  clientSecret: `${name}-secret`,
  calendarFilter: 'keep-me',
  fromAddress: '',
  fromName: '',
  ...extra,
})

async function start(
  brokers: Record<string, Body>,
  wrap: (ports: CalendarRecordPorts) => CalendarRecordPorts = (ports) => ports,
) {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({
    brokers: googleBrokersEntryKind,
    calendars: googleCalendarsEntryKind,
  })
  const raw: RecordKindHandle<Body> = world.records.kind({
    name: googleBrokersEntryKind.name,
    declaration: googleBrokersEntryKind.declaration,
    schema: z.record(z.string(), z.unknown()),
  })
  for (const [id, data] of Object.entries(brokers)) await raw.put({ id, data })
  const calendars = world.records.kind(googleCalendarsEntryKind)
  const warnings: string[] = []
  const f = settingsFixture(
    'google-services',
    ADDON_MIGRATIONS,
    (readStored): GoogleMigrationPorts => ({
      ...calendarIdsPortsOver(raw, readStored),
      ...NO_LEGACY_PORTS,
      ...NO_OAUTH_ACCOUNTS_PORTS,
      ...wrap(
        calendarRecordPortsOver({
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

describe('google-services calendar ids to calendar records', () => {
  it('writes one linked record per calendar, then clears the array; a marked field survives', async () => {
    const { f, raw, calendars, arrayOf } = await start({
      google_001: account('A', {
        calendarIds: ['google_001:work@g', 'google_001:home@g'],
        mark: 'survive-A',
      }),
      google_002: account('B', { calendarIds: ['google_002:other@g'] }),
      google_003: account('C', { calendarIds: [] }),
    })
    const result = await f.boot()
    expect(result.failed).toEqual([])
    expect(result.applied).toContain(CALENDAR_IDS_TO_RECORDS_ID)
    const work = await calendars.get(calendarRecordId('google_001', 'work@g'))
    expect(work?.data).toEqual({ name: 'work@g', accountId: 'google_001', calendarId: 'work@g' })
    expect((await calendars.get(calendarRecordId('google_002', 'other@g')))?.data.accountId).toBe(
      'google_002',
    )
    expect((await calendars.query({ limit: 50 })).records).toHaveLength(3)
    for (const id of ['google_001', 'google_002', 'google_003']) {
      expect(await arrayOf(id)).toBeUndefined()
    }
    const kept = await raw.getResolved('google_001')
    expect(kept?.data['mark']).toBe('survive-A')
    expect(kept?.data['clientSecret']).toBe('A-secret')
    expect(kept?.data['calendarFilter']).toBe('keep-me')
    expect(await raw.get('google_003')).not.toBeNull()
  })

  it('a second run is a no-op', async () => {
    const { f, calendars } = await start({
      google_001: account('A', { calendarIds: ['google_001:work@g'] }),
    })
    await f.boot()
    const before = await calendars.query({ limit: 50 })
    const again = await f.boot()
    expect(again.failed).toEqual([])
    expect((await calendars.query({ limit: 50 })).records).toEqual(before.records)
  })

  it('an entry stamped for another account selected nothing: it is named and goes with the array', async () => {
    const { f, calendars, warnings } = await start({
      google_001: account('A', { calendarIds: ['google_001:work@g', 'google_002:x@g', 'plain'] }),
    })
    expect((await f.boot()).failed).toEqual([])
    expect((await calendars.query({ limit: 50 })).records.map((r) => r.data.calendarId)).toEqual([
      'work@g',
    ])
    expect(warnings.join('\n')).toMatch(/google_002:x@g, plain/)
  })

  it('a record that does not read back keeps the array, and the other accounts still move', async () => {
    const { f, calendars, arrayOf } = await start(
      {
        google_001: account('A', { calendarIds: ['google_001:lost@g'] }),
        google_002: account('B', { calendarIds: ['google_002:ok@g'] }),
      },
      (ports) => ({
        ...ports,
        readCalendar: async (id) =>
          id === calendarRecordId('google_001', 'lost@g') ? null : ports.readCalendar(id),
      }),
    )
    const result = await f.boot()
    expect(result.failed).toEqual([CALENDAR_IDS_TO_RECORDS_ID])
    expect(await arrayOf('google_001')).toEqual(['google_001:lost@g'])
    expect(await arrayOf('google_002')).toBeUndefined()
    expect(await calendars.get(calendarRecordId('google_002', 'ok@g'))).not.toBeNull()
  })

  it('an array that is not a list of ids stays where it is', async () => {
    const { f, raw } = await start({ google_001: account('A', { calendarIds: 'google_001:x' }) })
    expect((await f.boot()).failed).toEqual([CALENDAR_IDS_TO_RECORDS_ID])
    expect((await raw.get('google_001'))?.data['calendarIds']).toBe('google_001:x')
  })
})
