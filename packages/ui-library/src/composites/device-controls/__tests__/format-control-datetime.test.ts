import { describe, it, expect } from 'vitest'
import { formatControlDateTime } from '../../../lib/format-control-datetime'

describe('formatControlDateTime', () => {
  describe('date format', () => {
    it('formats a YYYY-MM-DD value in en-US locale', () => {
      expect(formatControlDateTime('2026-06-07', 'date', 'en-US')).toBe('6/7/2026')
    })

    it('formats a YYYY-MM-DD value in en-GB locale (day-first)', () => {
      expect(formatControlDateTime('2026-06-07', 'date', 'en-GB')).toBe('07/06/2026')
    })

    it('does NOT shift the day across timezone boundaries (year-end boundary)', () => {
      // Constructed as a LOCAL date — the exact day component must be preserved
      // regardless of the runtime offset. A year-end date is the worst case:
      // UTC-midnight parsing in a negative-offset zone would roll back to
      // 12/30/2026 (or further into the prior year), which this exact assertion
      // would catch.
      expect(formatControlDateTime('2026-12-31', 'date', 'en-US')).toBe('12/31/2026')
    })

    it('never throws on a malformed locale tag', () => {
      // `toLocaleDateString` throws RangeError on a malformed BCP-47 tag; the
      // helper must swallow it. Note: 'not-a-valid-locale-xyz' is actually a
      // STRUCTURALLY VALID tag (each subtag <= 8 chars), so ICU tolerates it and
      // falls back to the default locale rather than throwing — the call still
      // must not throw and returns a formatted (non-raw) value.
      expect(() =>
        formatControlDateTime('2026-06-07', 'date', 'not-a-valid-locale-xyz'),
      ).not.toThrow()
      expect(formatControlDateTime('2026-06-07', 'date', 'not-a-valid-locale-xyz')).not.toBe('')

      // A genuinely malformed tag (underscore separators / too-long subtag) DOES
      // make ICU throw RangeError; the try/catch returns the raw value unchanged.
      expect(formatControlDateTime('2026-06-07', 'date', 'en_US_invalid')).toBe('2026-06-07')
    })

    it('takes the date part of a full timestamp', () => {
      expect(formatControlDateTime('2026-06-07T23:30:00', 'date', 'en-US')).toBe('6/7/2026')
    })

    it('returns the raw value when unparseable', () => {
      expect(formatControlDateTime('not-a-date', 'date', 'en-US')).toBe('not-a-date')
    })
  })

  describe('time format', () => {
    it('formats HH:MM:SS in en-US locale (12h)', () => {
      expect(formatControlDateTime('07:30:00', 'time', 'en-US')).toBe('07:30 AM')
    })

    it('formats HH:MM (no seconds) in en-US locale', () => {
      expect(formatControlDateTime('14:05', 'time', 'en-US')).toBe('02:05 PM')
    })

    it('formats time in en-GB locale (24h)', () => {
      expect(formatControlDateTime('14:05:00', 'time', 'en-GB')).toBe('14:05')
    })

    it('returns the raw value when the time shape is invalid', () => {
      expect(formatControlDateTime('not-a-time', 'time', 'en-US')).toBe('not-a-time')
    })
  })

  describe('datetime format', () => {
    it('formats a full ISO timestamp with both date and time parts', () => {
      const out = formatControlDateTime('2026-06-07T14:05:00', 'datetime', 'en-US')
      expect(out).toContain('2026')
      expect(out).toContain('Jun')
      // 14:05 → 2:05 PM in en-US short time
      expect(out).toContain('2:05')
      expect(out).toContain('PM')
    })

    it('accepts a space-separated datetime form', () => {
      const out = formatControlDateTime('2026-06-07 14:05:00', 'datetime', 'en-US')
      expect(out).toContain('2026')
      expect(out).toContain('2:05')
    })

    it('returns the raw value when unparseable', () => {
      expect(formatControlDateTime('not-a-date', 'datetime', 'en-US')).toBe('not-a-date')
    })
  })

  it('never throws on an empty string (returns it unchanged)', () => {
    expect(formatControlDateTime('', 'date', 'en-US')).toBe('')
    expect(formatControlDateTime('', 'time', 'en-US')).toBe('')
    expect(formatControlDateTime('', 'datetime', 'en-US')).toBe('')
  })
})
