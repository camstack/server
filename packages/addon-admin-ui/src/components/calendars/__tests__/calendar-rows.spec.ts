import type { CalendarEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HolderData } from '../../instances/instances-model'
import { calendarInstanceRefs, joinCalendarRows } from '../calendar-rows'

const entry = (
  providerAddonId: string,
  instanceId: string,
  id: string,
  name: string,
): CalendarEntry => ({
  id,
  providerAddonId,
  instanceId,
  name,
  source: 'addon',
  enabled: true,
  visible: true,
  defaultColor: '#3B82F6',
  color: '#3B82F6',
})

const holder = (
  addonId: string,
  records: readonly { id: string; formValues: Record<string, unknown>; enabled?: boolean }[],
): HolderData => ({
  addonId,
  description: {
    role: 'services',
    instanceMode: 'multiple',
    kind: 'calendar',
    canTest: false,
    kinds: [],
  },
  instances: records.map((r) => ({
    id: r.id,
    name: r.id,
    configured: true,
    kind: 'calendar',
    enabled: r.enabled,
    formValues: r.formValues,
  })),
})

const names = new Map([
  ['google-services', 'Google'],
  ['waste-collections', 'Waste'],
  ['provider-homeassistant', 'Home Assistant'],
])
const join = (calendars: readonly CalendarEntry[], holders: readonly HolderData[]) =>
  joinCalendarRows(calendars, calendarInstanceRefs(holders, names), () => 'x')

describe('joinCalendarRows', () => {
  it('joins a Google account calendar to its record', () => {
    const rows = join(
      [entry('google-services', 'cal_a', 'google-services:g1:work@g', 'Work')],
      [
        holder('google-services', [
          { id: 'cal_a', formValues: { accountId: 'g1', calendarId: 'work@g' } },
        ]),
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.instance?.id).toBe('cal_a')
    expect(rows[0]?.calendar?.name).toBe('Work')
  })

  it('joins a Home Assistant entity to its record', () => {
    const rows = join(
      [entry('provider-homeassistant', 'cal_b', 'provider-homeassistant:calendar.home', 'Home')],
      [
        holder('provider-homeassistant', [
          { id: 'cal_b', formValues: { accountId: 'ha1', calendarId: 'calendar.home' } },
        ]),
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.instance?.id).toBe('cal_b')
  })

  it('two connections that share an entity id each keep their own row and record', () => {
    const rows = join(
      [
        entry('provider-homeassistant', 'cal_1', 'provider-homeassistant:calendar.home', 'Home 1'),
        entry('provider-homeassistant', 'cal_2', 'provider-homeassistant:calendar.home', 'Home 2'),
      ],
      [
        holder('provider-homeassistant', [
          { id: 'cal_1', formValues: { accountId: 'ha1', calendarId: 'calendar.home' } },
          { id: 'cal_2', formValues: { accountId: 'ha2', calendarId: 'calendar.home' } },
        ]),
      ],
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.instance?.id)).toEqual(['cal_1', 'cal_2'])
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })

  it('a waste source (record id is the entry id, no calendarId form value) shows one row with a switch', () => {
    const rows = join(
      [entry('waste-collections', 'home', 'waste-collections:home', 'Home waste')],
      [holder('waste-collections', [{ id: 'home', formValues: { serviceId: 'x' } }])],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.calendar?.name).toBe('Home waste')
    expect(rows[0]?.instance?.id).toBe('home')
  })

  it('a switched-off waste source is one row with its switch and no calendar', () => {
    const rows = join(
      [],
      [holder('waste-collections', [{ id: 'home', formValues: {}, enabled: false }])],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.calendar).toBeNull()
    expect(rows[0]?.instance?.enabled).toBe(false)
    expect(rows[0]?.providerName).toBe('Waste')
  })

  it('keeps a switched-off record in the list, with no calendar and its switch state', () => {
    const rows = join(
      [],
      [
        holder('google-services', [
          { id: 'cal_a', formValues: { accountId: 'g1', calendarId: 'w' }, enabled: false },
        ]),
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.calendar).toBeNull()
    expect(rows[0]?.instance?.enabled).toBe(false)
    expect(rows[0]?.providerName).toBe('Google')
  })

  it('a record id that two addons share is not confused across addons', () => {
    const rows = join(
      [entry('waste-collections', 'x', 'waste-collections:x', 'W')],
      [
        holder('google-services', [{ id: 'x', formValues: {} }]),
        holder('waste-collections', [{ id: 'x', formValues: {} }]),
      ],
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.instance?.addonId).toBe('waste-collections')
  })

  it('a calendar with no record behind it has no switch', () => {
    const rows = join([entry('a', 'nope', 'a:y', 'Y')], [])
    expect(rows[0]?.instance).toBeNull()
  })

  it('a calendar from a source that predates instanceId stays listed, with no switch', () => {
    const { instanceId: _omitted, ...legacy } = entry('waste-collections', 's1', 'waste:s1', 'Old')
    const rows = join([legacy], [holder('waste-collections', [{ id: 's1', formValues: {} }])])
    expect(rows.find((r) => r.calendar?.id === 'waste:s1')?.instance).toBeNull()
  })
})
