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

  it('keeps at most two decimals, trailing zeros trimmed, when precision is undefined', () => {
    expect(formatNumeric(21.5, undefined)).toBe('21.5')
    expect(formatNumeric(21.47, undefined)).toBe('21.47')
    expect(formatNumeric(24.567, undefined)).toBe('24.57')
    expect(formatNumeric(1.2, undefined)).toBe('1.2')
    expect(formatNumeric(1.2000001, undefined)).toBe('1.2')
    expect(formatNumeric(0.1, undefined)).toBe('0.1')
    expect(formatNumeric(-3.456, undefined)).toBe('-3.46')
  })

  it('reads a non-zero value that rounds to nothing as below the last decimal', () => {
    expect(formatNumeric(0.001, undefined)).toBe('<0.01')
    expect(formatNumeric(-0.001, undefined)).toBe('-<0.01')
  })

  it('lets the operator precision win over the default', () => {
    expect(formatNumeric(21.4712, 3)).toBe('21.471')
    expect(formatNumeric(1.2, 2)).toBe('1.20')
  })

  it('reads a non-finite value as a dash, with or without a precision', () => {
    expect(formatNumeric(Number.NaN, undefined)).toBe('—')
    expect(formatNumeric(Number.POSITIVE_INFINITY, 2)).toBe('—')
    expect(formatNumeric(Number.NEGATIVE_INFINITY, undefined)).toBe('—')
  })
})
