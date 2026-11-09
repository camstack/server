import {
  type CalendarRecordPorts,
  type IScopedLogger,
  makeInMemoryRecords,
  moveCalendarIdsToRecords,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { googleBrokersEntryKind, googleCalendarsEntryKind } from '../broker-record-kinds.js'
import { parseStampedCalendarId } from '../google-broker-registry.js'
import { buildGoogleCalendarInstances, selectedStampedIds } from '../google-calendar-instances.js'
import { createGoogleCalendarSource } from '../google-calendar-source.js'
import { calendarRecordPortsOver } from '../migrations/ports.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

async function setup() {
  const world = makeInMemoryRecords('google-services')
  await world.records.declare({
    brokers: googleBrokersEntryKind,
    calendars: googleCalendarsEntryKind,
  })
  const instances = buildGoogleCalendarInstances(world.records, {
    catalog: async (accountId) => [{ value: 'work@g', label: `Work (${accountId})` }],
    onChanged: async () => undefined,
  })
  return { world, instances }
}

describe('Google calendars as integration instances', () => {
  it('a calendar record links to its account and is configured only with a calendar', async () => {
    const { instances } = await setup()
    expect((await instances.describe()).links).toEqual([
      { kind: 'calendar', field: 'accountId', to: { cap: 'broker', kind: 'google' } },
    ])
    const { id } = await instances.createInstance({ name: 'Work' })
    expect(id).toMatch(/^cal_/)
    await instances.updateInstance({ id, values: { accountId: 'google_001' } })
    expect((await instances.getInstance({ id }))?.configured).toBe(false)
    await instances.updateInstance({ id, values: { calendarId: 'work@g' } })
    expect((await instances.getInstance({ id }))?.configured).toBe(true)
    const form = await instances.instanceFormSchema({ id })
    expect(form.sections.map((s) => s.id)).toEqual(['links', 'google-calendar-pick'])
    expect(form.sections[1]?.fields[0]).toMatchObject({
      key: 'calendarId',
      options: [{ value: 'work@g', label: 'Work (google_001)' }],
    })
  })

  it('selects, per account, the stamped ids of the records that name a calendar and an account', async () => {
    const { instances } = await setup()
    await instances.createInstance({
      id: 'cal_a',
      name: 'A',
      values: { accountId: 'google_001', calendarId: 'work@g' },
    })
    await instances.createInstance({
      id: 'cal_b',
      name: 'B',
      values: { accountId: 'google_002', calendarId: 'home@g' },
    })
    await instances.createInstance({
      id: 'cal_c',
      name: 'Half',
      values: { accountId: 'google_001' },
    })
    const selection = selectedStampedIds(await instances.listResolved())
    expect([...(selection.get('google_001') ?? [])]).toEqual([['google_001:work@g', 'cal_a']])
    expect([...(selection.get('google_002') ?? [])]).toEqual([['google_002:home@g', 'cal_b']])
  })

  it('after the move the calendar source answers the SAME stamped ids as before', async () => {
    const { world, instances } = await setup()
    const raw = world.records.kind({
      name: googleBrokersEntryKind.name,
      declaration: googleBrokersEntryKind.declaration,
      schema: z.record(z.string(), z.unknown()),
    })
    await raw.put({
      id: 'google_001',
      data: { name: 'A', clientId: 'c', clientSecret: 's', calendarIds: ['google_001:work@g'] },
    })
    const ports: CalendarRecordPorts = calendarRecordPortsOver({
      brokers: raw,
      calendars: world.records.kind(googleCalendarsEntryKind),
      warn: () => undefined,
    })
    await moveCalendarIdsToRecords(ports, {
      calendarIdOf: (accountId, entry) => {
        const parsed = parseStampedCalendarId(entry)
        return parsed?.brokerId === accountId ? parsed.googleCalendarId : null
      },
    })
    const selection = selectedStampedIds(await instances.listResolved())
    const source = createGoogleCalendarSource({
      logger: silent,
      accounts: () => [
        {
          brokerId: 'google_001',
          connected: true,
          api: {
            listCalendars: async () => [
              { id: 'work@g', summary: 'Work' },
              { id: 'not-imported@g', summary: 'Nope' },
            ],
            listEvents: async () => [],
          },
        },
      ],
      selectedCalendarIds: (brokerId) => selection.get(brokerId) ?? new Map(),
    })
    expect(await source.listCalendars()).toEqual([
      {
        id: 'google_001:work@g',
        instanceId: expect.any(String),
        name: 'Work',
        source: 'addon',
        enabled: true,
      },
    ])
  })
  it('a switched-off calendar leaves the source answer and its events, and returns when switched on', async () => {
    const { instances } = await setup()
    await instances.createInstance({
      id: 'cal_a',
      name: 'A',
      values: { accountId: 'google_001', calendarId: 'work@g' },
    })
    const listed: string[] = []
    const source = createGoogleCalendarSource({
      logger: silent,
      accounts: () => [
        {
          brokerId: 'google_001',
          connected: true,
          api: {
            listCalendars: async () => [{ id: 'work@g', summary: 'Work' }],
            listEvents: async ({ calendarId }) => {
              listed.push(calendarId)
              return []
            },
          },
        },
      ],
      selectedCalendarIds: (brokerId) =>
        selectedStampedIds(resolved).get(brokerId) ?? new Map<string, string>(),
    })
    let resolved = await instances.listResolved()
    expect((await source.listCalendars()).map((c) => c.id)).toEqual(['google_001:work@g'])
    await source.listEvents({ calendarIds: ['google_001:work@g'], startMs: 0, endMs: 1 })
    expect(listed).toEqual(['work@g'])
    listed.length = 0

    await instances.toProvider().setInstanceEnabled({ id: 'cal_a', enabled: false })
    resolved = await instances.listResolved()
    expect(await source.listCalendars()).toEqual([])
    await source.listEvents({ calendarIds: ['google_001:work@g'], startMs: 0, endMs: 1 })
    expect(listed).toEqual([])

    await instances.toProvider().setInstanceEnabled({ id: 'cal_a', enabled: true })
    resolved = await instances.listResolved()
    expect((await source.listCalendars()).map((c) => c.id)).toEqual(['google_001:work@g'])
    await source.listEvents({ calendarIds: ['google_001:work@g'], startMs: 0, endMs: 1 })
    expect(listed).toEqual(['work@g'])
  })
})
