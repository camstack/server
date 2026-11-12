import { describe, expect, it } from 'vitest'
import {
  channelIndexOf,
  describeFire,
  formatEventAge,
  formatEventHeadline,
  groupVocabulary,
  sharedVocabularyNotice,
} from '../event-emitter-format'

describe('channelIndexOf', () => {
  it('reads an integer channel', () => {
    expect(channelIndexOf({ channel: 3 })).toBe(3)
    expect(channelIndexOf({ channel: 0 })).toBe(0)
  })

  it('returns null when the device reports no channel', () => {
    // Every single-button emitter and every generic HA bus event lands here —
    // the hero must still render, showing the event type alone.
    expect(channelIndexOf({})).toBeNull()
    expect(channelIndexOf(null)).toBeNull()
    expect(channelIndexOf(undefined)).toBeNull()
  })

  it('rejects a value that is not a plausible index', () => {
    expect(channelIndexOf({ channel: '2' })).toBeNull()
    expect(channelIndexOf({ channel: 1.5 })).toBeNull()
    expect(channelIndexOf({ channel: -1 })).toBeNull()
  })
})

describe('formatEventHeadline', () => {
  const fire = (data: Record<string, unknown> | null) => ({
    eventType: 'PRESS_SHORT',
    data,
    timestamp: 1,
    seq: 1,
  })

  it('names the button when the device reports one', () => {
    expect(formatEventHeadline(fire({ channel: 1 }))).toBe('Button 1 · PRESS_SHORT')
  })

  it('falls back to the event type alone', () => {
    expect(formatEventHeadline(fire({}))).toBe('PRESS_SHORT')
    expect(formatEventHeadline(fire(null))).toBe('PRESS_SHORT')
  })

  it('returns null for a device that has never fired', () => {
    expect(formatEventHeadline(null)).toBeNull()
  })
})

describe('formatEventAge', () => {
  const now = 1_000_000_000_000

  it('is second-granular — the window an operator is actually watching', () => {
    expect(formatEventAge(now - 300, now)).toBe('just now')
    expect(formatEventAge(now - 3_000, now)).toBe('3s ago')
    expect(formatEventAge(now - 45_000, now)).toBe('45s ago')
  })

  it('rolls up to minutes, hours and days', () => {
    expect(formatEventAge(now - 90_000, now)).toBe('1m ago')
    expect(formatEventAge(now - 7_200_000, now)).toBe('2h ago')
    expect(formatEventAge(now - 3 * 86_400_000, now)).toBe('3d ago')
  })

  it('renders a dash for a missing timestamp', () => {
    expect(formatEventAge(null, now)).toBe('—')
    expect(formatEventAge(0, now)).toBe('—')
  })
})

describe('the declared vocabulary', () => {
  const button = (n: string) => ({ id: n, label: `Button ${n}` })
  const VOCABULARY = [
    { id: 'PRESS_SHORT', source: button('1'), label: 'Short press', kind: 'press' as const },
    { id: 'PRESS_LONG', source: button('1'), label: 'Long press', kind: 'long-press' as const },
    { id: 'PRESS_SHORT', source: button('2'), label: 'Short press', kind: 'press' as const },
    { id: 'TILT', label: 'Tilted' },
  ]

  it('groups the events under the part that fires them, sourceless ones last', () => {
    const groups = groupVocabulary(VOCABULARY)
    expect(groups.map((g) => g.source?.label ?? null)).toEqual(['Button 1', 'Button 2', null])
    expect(groups[0]?.entries.map((e) => e.label)).toEqual(['Short press', 'Long press'])
    expect(groups[2]?.entries.map((e) => e.id)).toEqual(['TILT'])
  })

  it('names a fire by its button and its label, as the device declares them', () => {
    const fire = {
      eventType: 'PRESS_LONG',
      sourceId: '1',
      data: { channel: '1' },
      timestamp: 1,
      seq: 1,
    }
    expect(describeFire(fire, VOCABULARY)).toEqual({ source: 'Button 1', label: 'Long press' })
  })

  it('a fire the vocabulary does not declare keeps its token, and its button when that is known', () => {
    const fire = { eventType: 'PRESS_NEW', sourceId: '2', data: null, timestamp: 1, seq: 1 }
    expect(describeFire(fire, VOCABULARY)).toEqual({ source: 'Button 2', label: 'PRESS_NEW' })
    expect(describeFire({ ...fire, sourceId: '9' }, VOCABULARY)).toEqual({
      source: null,
      label: 'PRESS_NEW',
    })
  })

  it('a fire with no source reads a numeric data.channel as before, and nothing otherwise', () => {
    const fire = { eventType: 'TILT', data: { channel: 3 }, timestamp: 1, seq: 1 }
    expect(describeFire(fire, VOCABULARY)).toEqual({ source: 'Button 3', label: 'Tilted' })
    expect(describeFire({ ...fire, data: {} }, VOCABULARY)).toEqual({
      source: null,
      label: 'Tilted',
    })
    expect(describeFire(null, VOCABULARY)).toBeNull()
  })
})

describe('sharedVocabularyNotice', () => {
  it('returns the description every entry agrees on', () => {
    const notice = 'The CCU does not send these presses — enable button events on the CCU page'
    expect(
      sharedVocabularyNotice([
        { id: 'PRESS_SHORT', label: 'Short press', description: notice },
        { id: 'PRESS_LONG', label: 'Long press', description: notice },
      ]),
    ).toBe(notice)
  })

  it('returns null when the entries disagree or say nothing', () => {
    expect(sharedVocabularyNotice([{ id: 'PRESS_SHORT', label: 'Short press' }])).toBeNull()
    expect(
      sharedVocabularyNotice([
        { id: 'PRESS_SHORT', label: 'Short', description: 'one' },
        { id: 'PRESS_LONG', label: 'Long', description: 'two' },
      ]),
    ).toBeNull()
  })
})
