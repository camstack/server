import { describe, expect, it } from 'vitest'
import { patchCalendarPreference } from '../calendar-prefs-store.js'

describe('patchCalendarPreference', () => {
  it('sets visible and colour on an empty prefs blob', () => {
    const next = patchCalendarPreference({ calendars: {} }, 'ha:cal.a', {
      visible: false,
      color: '#FF0000',
    })
    expect(next.calendars['ha:cal.a']).toEqual({ visible: false, color: '#FF0000' })
  })

  it('clears a colour override with null without dropping visible', () => {
    const next = patchCalendarPreference(
      { calendars: { 'ha:cal.a': { visible: false, color: '#FF0000' } } },
      'ha:cal.a',
      { color: null },
    )
    expect(next.calendars['ha:cal.a']).toEqual({ visible: false })
  })

  it('drops an empty entry when the last field is cleared', () => {
    const next = patchCalendarPreference(
      { calendars: { 'ha:cal.a': { color: '#FF0000' } } },
      'ha:cal.a',
      { color: null },
    )
    expect(next.calendars['ha:cal.a']).toBeUndefined()
  })

  it('leaves unrelated calendars untouched', () => {
    const next = patchCalendarPreference(
      { calendars: { 'ha:cal.b': { visible: false } } },
      'ha:cal.a',
      { visible: true },
    )
    expect(next.calendars['ha:cal.b']).toEqual({ visible: false })
    expect(next.calendars['ha:cal.a']).toEqual({ visible: true })
  })
})
