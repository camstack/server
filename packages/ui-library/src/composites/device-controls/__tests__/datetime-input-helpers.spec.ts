import { describe, it, expect } from 'vitest'
import { toDateInput, toTimeInput, toDateTimeInput } from '../control-panel.js'

describe('control-panel datetime input helpers', () => {
  describe('toDateInput', () => {
    it('keeps an already date-only value', () => {
      expect(toDateInput('2026-06-06')).toBe('2026-06-06')
    })
    it('trims a full ISO datetime to the date portion', () => {
      expect(toDateInput('2026-06-06T10:30:00')).toBe('2026-06-06')
    })
  })

  describe('toTimeInput', () => {
    it("strips seconds from 'HH:MM:SS'", () => {
      expect(toTimeInput('07:30:45')).toBe('07:30')
    })
    it("keeps 'HH:MM' unchanged", () => {
      expect(toTimeInput('07:30')).toBe('07:30')
    })
  })

  describe('toDateTimeInput', () => {
    it('trims a full ISO with seconds to minute precision', () => {
      expect(toDateTimeInput('2026-06-06T10:30:45')).toBe('2026-06-06T10:30')
    })
    it('trims a zoned ISO to minute precision', () => {
      expect(toDateTimeInput('2026-06-06T10:30:45.123+02:00')).toBe('2026-06-06T10:30')
    })
    it("normalizes a space-separated form to 'T'", () => {
      expect(toDateTimeInput('2026-06-06 10:30:00')).toBe('2026-06-06T10:30')
    })
    it('keeps an already minute-precision value', () => {
      expect(toDateTimeInput('2026-06-06T10:30')).toBe('2026-06-06T10:30')
    })
  })
})
