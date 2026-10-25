import { describe, expect, it } from 'vitest'
import { expandCalendarScope } from '../calendar-events-selection.js'

const KNOWN = ['ha:calendar.family', 'ha:calendar.trash', 'addon:x:work'] as const

describe('expandCalendarScope', () => {
  it('All (no lists) keeps every known id', () => {
    expect(expandCalendarScope(undefined, KNOWN)).toEqual([...KNOWN])
    expect(expandCalendarScope({}, KNOWN)).toEqual([...KNOWN])
    expect(expandCalendarScope({ calendars: [], calendarsExclude: [] }, KNOWN)).toEqual([...KNOWN])
  })

  it('Only keeps the include intersection with known', () => {
    expect(expandCalendarScope({ calendars: ['ha:calendar.family', 'missing'] }, KNOWN)).toEqual([
      'ha:calendar.family',
    ])
  })

  it('Except drops the exclude list from known', () => {
    expect(expandCalendarScope({ calendarsExclude: ['ha:calendar.trash'] }, KNOWN)).toEqual([
      'ha:calendar.family',
      'addon:x:work',
    ])
  })

  it('Only wins when both lists are present (legacy)', () => {
    expect(
      expandCalendarScope(
        {
          calendars: ['ha:calendar.family'],
          calendarsExclude: ['ha:calendar.family'],
        },
        KNOWN,
      ),
    ).toEqual(['ha:calendar.family'])
  })

  it('empty known yields empty under every mode', () => {
    expect(expandCalendarScope({ calendars: ['ha:calendar.family'] }, [])).toEqual([])
    expect(expandCalendarScope({ calendarsExclude: ['x'] }, [])).toEqual([])
    expect(expandCalendarScope(undefined, [])).toEqual([])
  })
})
