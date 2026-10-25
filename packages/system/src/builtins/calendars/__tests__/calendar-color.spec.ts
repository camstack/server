import { describe, expect, it } from 'vitest'
import { CALENDAR_COLOR_PALETTE, defaultCalendarColor } from '../calendar-color.js'

describe('defaultCalendarColor', () => {
  it('returns a palette colour for any id', () => {
    const color = defaultCalendarColor('provider-homeassistant:calendar.family')
    expect(CALENDAR_COLOR_PALETTE).toContain(color)
  })

  it('is stable for the same id', () => {
    const a = defaultCalendarColor('ha:calendar.work')
    const b = defaultCalendarColor('ha:calendar.work')
    expect(a).toBe(b)
  })

  it('spreads distinct ids across the palette', () => {
    const colors = new Set(
      ['a:cal.1', 'a:cal.2', 'a:cal.3', 'b:cal.1', 'b:cal.2', 'c:cal.x', 'd:cal.y', 'e:cal.z'].map(
        defaultCalendarColor,
      ),
    )
    expect(colors.size).toBeGreaterThan(1)
  })
})
