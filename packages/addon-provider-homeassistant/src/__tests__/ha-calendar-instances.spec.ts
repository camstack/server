import { makeInMemoryRecords, moveCalendarIdsToRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { haBrokersEntryKind, haCalendarsEntryKind } from '../broker-record-kinds.js'
import { buildHaCalendarInstances, selectedEntityIds } from '../ha-calendar-instances.js'
import { haCalendarRecordPortsOver } from '../migrations/calendar-ports.js'
import { rawBrokers } from './raw-brokers.js'

async function setup() {
  const world = makeInMemoryRecords('provider-homeassistant')
  await world.records.declare({ brokers: haBrokersEntryKind, calendars: haCalendarsEntryKind })
  const instances = buildHaCalendarInstances(world.records, {
    catalog: (id) => [{ value: 'calendar.work', label: `Work (${id})` }],
    onChanged: async () => undefined,
  })
  return { world, instances }
}

describe('Home Assistant calendars as integration instances', () => {
  it('a calendar record links to its connection and is configured only with a calendar', async () => {
    const { instances } = await setup()
    expect((await instances.describe()).links).toEqual([
      { kind: 'calendar', field: 'accountId', to: { cap: 'broker', kind: 'home-assistant' } },
    ])
    const { id } = await instances.createInstance({ name: 'Work' })
    expect(id).toMatch(/^cal_/)
    await instances.updateInstance({ id, values: { accountId: 'ha_001' } })
    expect((await instances.getInstance({ id }))?.configured).toBe(false)
    await instances.updateInstance({ id, values: { calendarId: 'calendar.work' } })
    expect((await instances.getInstance({ id }))?.configured).toBe(true)
    const form = await instances.instanceFormSchema({ id })
    expect(form.sections.map((s) => s.id)).toEqual(['links', 'ha-calendar-pick'])
    expect(form.sections[1]?.fields[0]).toMatchObject({
      key: 'calendarId',
      options: [{ value: 'calendar.work', label: 'Work (ha_001)' }],
    })
  })

  it('selects, per connection, the entity ids of the records that name a calendar and a connection', async () => {
    const { instances } = await setup()
    await instances.createInstance({
      id: 'cal_a',
      name: 'A',
      values: { accountId: 'ha_001', calendarId: 'calendar.work' },
    })
    await instances.createInstance({
      id: 'cal_b',
      name: 'B',
      values: { accountId: 'ha_002', calendarId: 'calendar.home' },
    })
    await instances.createInstance({ id: 'cal_c', name: 'Half', values: { accountId: 'ha_001' } })
    const selection = selectedEntityIds(await instances.listResolved())
    expect([...(selection.get('ha_001') ?? [])]).toEqual([['calendar.work', 'cal_a']])
    expect([...(selection.get('ha_002') ?? [])]).toEqual([['calendar.home', 'cal_b']])
  })

  it('after the move the connection selects the SAME entity ids as before', async () => {
    const { world, instances } = await setup()
    const raw = rawBrokers(world.records)
    await raw.put({
      id: 'ha_001',
      data: { name: 'A', authKind: 'supervisor', calendarIds: ['calendar.work'] },
    })
    await moveCalendarIdsToRecords(
      haCalendarRecordPortsOver({
        brokers: raw,
        calendars: world.records.kind(haCalendarsEntryKind),
        warn: () => undefined,
      }),
      { calendarIdOf: (_accountId, entry) => entry },
    )
    const selection = selectedEntityIds(await instances.listResolved())
    expect([...(selection.get('ha_001')?.keys() ?? [])]).toEqual(['calendar.work'])
  })
  it('a switched-off calendar leaves the connection selection and returns when switched on', async () => {
    const { instances } = await setup()
    await instances.createInstance({
      id: 'cal_a',
      name: 'A',
      values: { accountId: 'ha_001', calendarId: 'calendar.work' },
    })
    const entityIds = async () => [
      ...(selectedEntityIds(await instances.listResolved())
        .get('ha_001')
        ?.keys() ?? []),
    ]
    expect(await entityIds()).toEqual(['calendar.work'])
    await instances.toProvider().setInstanceEnabled({ id: 'cal_a', enabled: false })
    expect(await entityIds()).toEqual([])
    await instances.toProvider().setInstanceEnabled({ id: 'cal_a', enabled: true })
    expect(await entityIds()).toEqual(['calendar.work'])
  })
})
