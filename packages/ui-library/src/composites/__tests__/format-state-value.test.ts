import { describe, it, expect } from 'vitest'
import {
  epochMsOf,
  formatLeafValue,
  formatLocalDate,
  isIsoDateString,
  isTimeKey,
} from '../format-state-value'

describe('isTimeKey', () => {
  it('matches keys that name an instant', () => {
    for (const key of [
      'lastFetchedAt',
      'updatedAt',
      'createdAt',
      'lastPushAtMs',
      'lastCheckedAtMs',
      'timestamp',
      'eventTimestamp',
      'sleepingSince',
      'lastSeen',
      'deviceLastSeen',
      'expires',
      'tokenExpiry',
    ]) {
      expect(isTimeKey(key), key).toBe(true)
    }
  })

  it('does NOT match durations, even when the name contains "time" or ends in Ms', () => {
    // This is the whole reason the key check exists. `uptimeSeconds` contains
    // "time"; `timeoutMs` and `batchIntervalMs` end in "Ms". None is an instant,
    // and rendering a duration as a 1970 date is worse than leaving it raw.
    for (const key of [
      'uptimeSeconds',
      'timeoutMs',
      'batchIntervalMs',
      'retentionDays',
      'batchSize',
      'bitrate',
      'memoryRss',
      'port',
      'level',
    ]) {
      expect(isTimeKey(key), key).toBe(false)
    }
  })
})

describe('epochMsOf', () => {
  it('accepts millisecond epochs', () => {
    expect(epochMsOf(1_785_060_000_000)).toBe(1_785_060_000_000)
  })

  it('promotes second epochs to milliseconds', () => {
    expect(epochMsOf(1_785_060_000)).toBe(1_785_060_000_000)
  })

  it('rejects 0 — in this codebase it means "never", not 1 January 1970', () => {
    expect(epochMsOf(0)).toBeNull()
  })

  it('rejects small numbers and implausible magnitudes', () => {
    expect(epochMsOf(30)).toBeNull() // retentionDays
    expect(epochMsOf(3100)).toBeNull() // a port
    expect(epochMsOf(-1)).toBeNull()
    // Well past the 2096 ceiling, and kept under 2^53 so the literal is exact —
    // a lossy literal here would be testing a different number than it reads as.
    expect(epochMsOf(9_007_199_254_740_991)).toBeNull()
    expect(epochMsOf(Number.NaN)).toBeNull()
    expect(epochMsOf(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('isIsoDateString', () => {
  it('accepts ISO-8601 with a time part, in the forms a wire round-trip produces', () => {
    expect(isIsoDateString('2026-07-26T10:00:00.000Z')).toBe(true)
    expect(isIsoDateString('2026-07-26T10:00:00Z')).toBe(true)
    expect(isIsoDateString('2026-07-26T10:00')).toBe(true)
    expect(isIsoDateString('2026-07-26T10:00:00+02:00')).toBe(true)
  })

  it('rejects a date with no time', () => {
    // `2026-07-26` is far more often a version or a label, and `Date.parse` would
    // read it as UTC midnight — shifting it a whole day in a negative-offset
    // locale.
    expect(isIsoDateString('2026-07-26')).toBe(false)
  })

  it('rejects things that merely contain digits and dashes', () => {
    expect(isIsoDateString('1.2.10')).toBe(false)
    expect(isIsoDateString('cam-2026-07-26')).toBe(false)
    expect(isIsoDateString('')).toBe(false)
  })
})

describe('formatLeafValue', () => {
  it('renders a timestamp under a time key as a local date, keeping the raw', () => {
    const leaf = formatLeafValue('lastFetchedAt', 1_785_060_000_000)
    expect(leaf.text).toBe(formatLocalDate(1_785_060_000_000))
    expect(leaf.text).not.toBe('1785060000000')
    // Debugging panel: the exact number has to remain reachable.
    expect(leaf.raw).toBe('1785060000000')
  })

  it('leaves the same number alone under a non-time key', () => {
    const leaf = formatLeafValue('bitrate', 1_785_060_000_000)
    expect(leaf.text).toBe('1785060000000')
    expect(leaf.raw).toBeNull()
  })

  it('leaves a small number alone even under a time key', () => {
    const leaf = formatLeafValue('lastFetchedAt', 0)
    expect(leaf.text).toBe('0')
    expect(leaf.raw).toBeNull()
  })

  it('formats an ISO string with no key hint — the shape is unambiguous', () => {
    // A Moleculer round-trip turns every Date into an ISO string, so these turn up
    // under keys that do not look temporal at all.
    const leaf = formatLeafValue('value', '2026-07-26T10:00:00.000Z')
    expect(leaf.text).toBe(formatLocalDate(Date.parse('2026-07-26T10:00:00.000Z')))
    expect(leaf.raw).toBe('2026-07-26T10:00:00.000Z')
  })

  it('passes through the ordinary leaf types untouched', () => {
    expect(formatLeafValue('k', null)).toEqual({ text: 'null', raw: null })
    expect(formatLeafValue('k', undefined)).toEqual({ text: 'undefined', raw: null })
    expect(formatLeafValue('k', true)).toEqual({ text: 'true', raw: null })
    expect(formatLeafValue('k', false)).toEqual({ text: 'false', raw: null })
    expect(formatLeafValue('k', 'sleeping')).toEqual({ text: 'sleeping', raw: null })
    expect(formatLeafValue('k', 42)).toEqual({ text: '42', raw: null })
  })

  it('never reports `raw` when the text was not rewritten', () => {
    // The caller uses `raw !== null` to decide whether to attach a tooltip; a
    // tooltip repeating the visible text on every row would be noise.
    for (const value of [null, undefined, true, 'x', 42, 0]) {
      expect(formatLeafValue('anything', value).raw).toBeNull()
    }
  })
})

describe('formatLocalDate', () => {
  it('produces a stable, non-numeric rendering', () => {
    const text = formatLocalDate(1_785_060_000_000)
    expect(text).not.toBe('1785060000000')
    expect(text).toMatch(/2026/)
  })

  it('falls back to the number rather than throwing on an invalid date', () => {
    expect(formatLocalDate(Number.NaN)).toBe('NaN')
  })
})
