import { describe, expect, it } from 'vitest'
import { channelIndexOf, formatEventAge, formatEventHeadline } from '../event-emitter-format'

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
