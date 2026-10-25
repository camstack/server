import { type OsdSlotBinding, OsdSlotBindingSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  applyTemplate,
  displayValue,
  formatClock,
  formatSlotText,
  limitText,
  truncateDecimals,
} from '../format.js'

function binding(patch: Partial<OsdSlotBinding> = {}): OsdSlotBinding {
  return OsdSlotBindingSchema.parse({
    source: { kind: 'static', text: 'x' },
    ...patch,
  })
}

describe('formatClock', () => {
  // 2026-08-07T09:05:03Z
  const AT = Date.UTC(2026, 7, 7, 9, 5, 3)

  it('renders every token in a fixed zone', () => {
    expect(formatClock(AT, 'YYYY-MM-DD HH:mm:ss', 'UTC')).toBe('2026-08-07 09:05:03')
  })

  it('keeps non-token characters literal', () => {
    expect(formatClock(AT, 'Gate HH:mm', 'UTC')).toBe('Gate 09:05')
  })

  it('does not re-consume text a previous substitution produced', () => {
    // `MM` (month, 08) must not be re-read as minutes, and the `mm` that
    // follows must still resolve to minutes.
    expect(formatClock(AT, 'MM/mm', 'UTC')).toBe('08/05')
  })

  it('honours the timezone rather than the host', () => {
    expect(formatClock(AT, 'HH', 'UTC')).toBe('09')
    expect(formatClock(AT, 'HH', 'Asia/Tokyo')).toBe('18')
  })

  it('falls back to server time on an unknown zone instead of rendering nothing', () => {
    expect(formatClock(AT, 'HH:mm', 'Not/AZone')).toMatch(/^\d{2}:\d{2}$/)
  })

  it('renders midnight as 00, never 24', () => {
    expect(formatClock(Date.UTC(2026, 7, 7, 0, 30, 0), 'HH:mm', 'UTC')).toBe('00:30')
  })
})

describe('truncateDecimals', () => {
  it('truncates rather than rounds', () => {
    expect(truncateDecimals(19.99, 1)).toBe('19.9')
    expect(truncateDecimals(19.99, 0)).toBe('19')
  })

  it('yields an integer at 0 — the workaround for firmwares that reject a dot', () => {
    expect(truncateDecimals(21.7, 0)).not.toContain('.')
  })

  it('handles negatives without flipping toward zero incorrectly', () => {
    expect(truncateDecimals(-3.75, 1)).toBe('-3.7')
  })
})

describe('limitText', () => {
  it('leaves short text alone', () => {
    expect(limitText('abc', 10)).toBe('abc')
  })

  it('spends the last three characters on an ellipsis', () => {
    expect(limitText('abcdefghij', 6)).toBe('abc...')
    expect(limitText('abcdefghij', 6)).toHaveLength(6)
  })

  it('does not produce garbage below the ellipsis budget', () => {
    expect(limitText('abcdef', 2)).toBe('ab')
  })

  it('is a no-op with no limit', () => {
    expect(limitText('abcdef', undefined)).toBe('abcdef')
  })
})

describe('applyTemplate', () => {
  it('substitutes EVERY occurrence, not just the first', () => {
    expect(applyTemplate('${value}/${value}', '7', '')).toBe('7/7')
  })

  it('substitutes the unit', () => {
    expect(applyTemplate('${value}${unit}', '21', 'C')).toBe('21C')
  })
})

describe('displayValue', () => {
  it('prefers an explicit value map over the type default', () => {
    const b = binding({ valueMap: { true: 'MOTION', false: '' } })
    expect(displayValue(true, b)).toBe('MOTION')
    expect(displayValue(false, b)).toBe('')
  })

  it('renders an unmapped boolean as ON/OFF', () => {
    expect(displayValue(true, binding())).toBe('ON')
    expect(displayValue(false, binding())).toBe('OFF')
  })

  it('applies maxDecimals to a number', () => {
    expect(displayValue(21.789, binding({ maxDecimals: 2 }))).toBe('21.78')
  })
})

describe('formatSlotText', () => {
  it('runs the whole chain: map → template → limit', () => {
    const b = binding({
      template: 'T ${value}${unit}',
      maxDecimals: 1,
    })
    expect(formatSlotText(21.789, b, { unit: 'C', maxCharacters: 8 })).toBe(
      'T 21.8C'.replace('21.8', '21.7'),
    )
  })

  it('collapses to empty when the value maps to nothing', () => {
    const b = binding({ template: '${value}', valueMap: { false: '' } })
    expect(formatSlotText(false, b)).toBe('')
  })
})
