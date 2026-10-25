import { describe, it, expect } from 'vitest'
import { formatNumeric } from '../format-numeric'

describe('formatNumeric', () => {
  it('applies toFixed(precision) when precision is defined', () => {
    expect(formatNumeric(24.567, 1)).toBe('24.6')
    expect(formatNumeric(24.567, 2)).toBe('24.57')
    expect(formatNumeric(24.567, 0)).toBe('25')
    expect(formatNumeric(24.0, 1)).toBe('24.0')
  })

  it('returns integer string when precision is undefined and value is integer', () => {
    expect(formatNumeric(21, undefined)).toBe('21')
    expect(formatNumeric(0, undefined)).toBe('0')
    expect(formatNumeric(1200, undefined)).toBe('1200')
  })

  it('returns toFixed(1) when precision is undefined and value is not integer', () => {
    expect(formatNumeric(21.5, undefined)).toBe('21.5')
    expect(formatNumeric(24.567, undefined)).toBe('24.6')
    expect(formatNumeric(0.1, undefined)).toBe('0.1')
  })
})
