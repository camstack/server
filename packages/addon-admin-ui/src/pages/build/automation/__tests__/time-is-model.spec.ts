import { type AutomationRecipe, AutomationWhenSchema, type TimeIsLeaf } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  recipeSiteError,
  selectedDays,
  toggleDay,
  withEnd,
  withWindow,
  wrapsMidnight,
} from '../time-is-model'

const night: TimeIsLeaf = {
  kind: 'time-is',
  between: {
    from: { kind: 'clock', hh: 22, mm: 0 },
    to: { kind: 'clock', hh: 6, mm: 0 },
  },
}
const legal = (leaf: TimeIsLeaf): boolean => AutomationWhenSchema.safeParse(leaf).success

describe('time-is row edits', () => {
  it('an absent day list shows every day pressed; releasing one stores the other six', () => {
    expect(selectedDays(night)).toHaveLength(7)
    const noSunday = toggleDay(night, 'sun')
    expect(noSunday.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'])
    expect(noSunday.between).toEqual(night.between)
  })

  it('pressing the seventh day of a window drops the list (every day), key omitted', () => {
    const back = toggleDay(toggleDay(night, 'sun'), 'sun')
    expect(back).toEqual(night)
    expect('days' in back).toBe(false)
  })

  it('dropping the window keeps the days explicit, so the row stays legal', () => {
    const wholeDay = withWindow(night, false)
    expect('between' in wholeDay).toBe(false)
    expect(wholeDay.days).toHaveLength(7)
    expect(legal(wholeDay)).toBe(true)
    // with no window, all seven stay listed: the row needs one of the two
    expect(toggleDay(toggleDay(wholeDay, 'mon'), 'mon').days).toHaveLength(7)
    expect(withWindow(wholeDay, true)).toEqual(night)
  })

  it('releasing the last day leaves a row the schema refuses, never a silent "every day"', () => {
    const onlyMon: TimeIsLeaf = { ...night, days: ['mon'] }
    const none = toggleDay(onlyMon, 'mon')
    expect(none.days).toEqual([])
    expect(legal(none)).toBe(false)
  })

  it('sets one end and keeps the other and the days', () => {
    const weekdays: TimeIsLeaf = { ...night, days: ['mon', 'tue'] }
    const sunStart = withEnd(weekdays, 'from', {
      kind: 'sun',
      event: 'sunset',
      offsetMin: -30,
    })
    expect(sunStart.between?.from).toEqual({
      kind: 'sun',
      event: 'sunset',
      offsetMin: -30,
    })
    expect(sunStart.between?.to).toEqual(night.between?.to)
    expect(sunStart.days).toEqual(['mon', 'tue'])
    expect(legal(sunStart)).toBe(true)
  })

  it('knows a clock window that ends the next day', () => {
    expect(wrapsMidnight(night)).toBe(true)
    expect(wrapsMidnight(withEnd(night, 'from', { kind: 'clock', hh: 1, mm: 0 }))).toBe(false)
    expect(
      wrapsMidnight(withEnd(night, 'from', { kind: 'sun', event: 'sunset', offsetMin: 0 })),
    ).toBe(false)
  })
})

describe('recipeSiteError — the save-time refusal the editor shows', () => {
  const recipe: AutomationRecipe = {
    when: {
      kind: 'all',
      children: [
        { kind: 'device-event', category: 'button.pressed' },
        {
          kind: 'time-is',
          between: {
            from: { kind: 'sun', event: 'sunset', offsetMin: 0 },
            to: { kind: 'clock', hh: 6, mm: 0 },
          },
        },
      ],
    },
    actions: [{ kind: 'wait', seconds: 1 }],
  }
  const ROME = 'Europe/Rome'

  it('refuses a sun end on a site that answered with no location', () => {
    const error = recipeSiteError(recipe, { location: null, timeZone: ROME })
    expect(error).toMatch(/^when\.1\.between\.from: .*needs the site location/)
  })

  it('does not refuse once the site has a location', () => {
    const located = {
      location: { latitude: 41.9, longitude: 12.5 },
      timeZone: ROME,
    }
    expect(recipeSiteError(recipe, located)).toBeNull()
  })

  it('never refuses while the site has not answered', () => {
    expect(recipeSiteError(recipe, undefined)).toBeNull()
  })
})
