import { describe, expect, it } from 'vitest'
import { formatCustomizeSeconds } from '../format-customize-duration'

describe('formatCustomizeSeconds', () => {
  it('a short span is a plural second count', () => {
    expect(formatCustomizeSeconds(1)).toBe('1 second')
    expect(formatCustomizeSeconds(12)).toBe('12 seconds')
  })
  it('a long span is days and hours, not the raw second count', () => {
    const text = formatCustomizeSeconds(91_538_272)
    expect(text).not.toContain('91538272')
    expect(text).toMatch(/^\d+ d \d+ h$/)
  })
})
