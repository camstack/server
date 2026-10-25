import { describe, expect, it } from 'vitest'
import { classTokens, hasUnconditionalClass, hasVariantClass } from '../tailwind-variants'

describe('classTokens', () => {
  it('splits on any run of whitespace and drops empties', () => {
    expect(classTokens('  a   b\nc ')).toEqual(['a', 'b', 'c'])
  })

  it('returns nothing for an empty or undefined class string', () => {
    expect(classTokens('')).toEqual([])
    expect(classTokens(undefined)).toEqual([])
  })
})

describe('hasUnconditionalClass', () => {
  it('is true when the bare utility is present', () => {
    expect(hasUnconditionalClass('px-2 sticky left-0', 'sticky')).toBe(true)
  })

  it('is FALSE when the utility only appears behind a breakpoint variant', () => {
    expect(hasUnconditionalClass('px-2 md:sticky md:left-0', 'sticky')).toBe(false)
  })

  it('is false when the utility only appears behind a state variant', () => {
    expect(hasUnconditionalClass('hover:truncate', 'truncate')).toBe(false)
  })

  it('does not match a utility that merely starts with the same text', () => {
    expect(hasUnconditionalClass('w-64 w-6', 'w-6')).toBe(true)
    expect(hasUnconditionalClass('w-64', 'w-6')).toBe(false)
  })

  it('ignores an important marker so `!truncate` still counts', () => {
    expect(hasUnconditionalClass('!truncate', 'truncate')).toBe(true)
  })
})

describe('hasVariantClass', () => {
  it('is true only for the exact variant asked for', () => {
    expect(hasVariantClass('md:sticky', 'md', 'sticky')).toBe(true)
    expect(hasVariantClass('md:sticky', 'lg', 'sticky')).toBe(false)
    expect(hasVariantClass('sticky', 'md', 'sticky')).toBe(false)
  })

  it('matches a stacked variant whose LAST segment is the utility', () => {
    expect(hasVariantClass('md:hover:sticky', 'hover', 'sticky')).toBe(true)
  })
})
