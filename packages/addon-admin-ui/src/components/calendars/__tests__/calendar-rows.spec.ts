import type { CalendarEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HolderData } from '../../instances/instances-model'
import { calendarInstanceRefs, joinCalendarRows } from '../calendar-rows'

const entry = (id: string, name: string): CalendarEntry => ({
  id,
  name,
  source: 'addon',
  enabled: true,
  visible: true,
  defaultColor: '#3B82F6',
  color: '#3B82F6',
})

const holder = (
  addonId: string,
  accountId: string,
  calendarId: string,
  id: string,
  enabled?: boolean,
): HolderData => ({
  addonId,
  description: {
    role: 'services',
    instanceMode: 'multiple',
    kind: 'calendar',
    canTest: false,
    kinds: [],
  },
  instances: [
    {
      id,
      name: id,
      configured: true,
      kind: 'calendar',
      enabled,
      formValues: { accountId, calendarId },
    },
  ],
})

const names = new Map([['google-services', 'Google']])

describe('joinCalendarRows', () => {
  it('joins an account calendar by its stamped id and a connection entity by its entity id', () => {
    const refs = [
      ...calendarInstanceRefs([holder('google-services', 'g1', 'work@g', 'cal_a')], names),
      ...calendarInstanceRefs(
        [holder('provider-homeassistant', 'ha1', 'calendar.home', 'cal_b')],
        names,
      ),
    ]
    const rows = joinCalendarRows(
      [
        entry('google-services:g1:work@g', 'Work'),
        entry('provider-homeassistant:calendar.home', 'Home'),
      ],
      refs,
      () => 'x',
    )
    expect(rows.map((r) => r.instance?.id)).toEqual(['cal_a', 'cal_b'])
  })

  it('keeps a switched-off record in the list, with no calendar and its switch state', () => {
    const refs = calendarInstanceRefs(
      [holder('google-services', 'g1', 'work@g', 'cal_a', false)],
      names,
    )
    const rows = joinCalendarRows([], refs, () => 'x')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.calendar).toBeNull()
    expect(rows[0]?.instance?.enabled).toBe(false)
    expect(rows[0]?.providerName).toBe('Google')
  })

  it('a calendar with no record behind it has no switch', () => {
    const rows = joinCalendarRows([entry('x:y', 'Y')], [], () => 'x')
    expect(rows[0]?.instance).toBeNull()
  })
})
