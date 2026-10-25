import { describe, expect, it } from 'vitest'
import { compareSemver } from '../semver-compare.js'

describe('compareSemver', () => {
  it('orders plain versions numerically per segment', () => {
    expect(compareSemver('1.1.42', '1.1.43')).toBe(-1)
    expect(compareSemver('1.1.43', '1.1.42')).toBe(1)
    expect(compareSemver('1.1.42', '1.1.42')).toBe(0)
  })

  it('compares numerically, not lexically', () => {
    expect(compareSemver('1.1.9', '1.1.10')).toBe(-1)
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1)
  })

  it('treats missing segments as zero', () => {
    expect(compareSemver('1.1', '1.1.0')).toBe(0)
    expect(compareSemver('1.1', '1.1.1')).toBe(-1)
  })

  it('ranks a prerelease below its release', () => {
    expect(compareSemver('1.2.0-beta.1', '1.2.0')).toBe(-1)
    expect(compareSemver('1.2.0', '1.2.0-beta.1')).toBe(1)
  })

  it('orders prereleases of the same base lexically', () => {
    expect(compareSemver('1.2.0-alpha', '1.2.0-beta')).toBe(-1)
    expect(compareSemver('1.2.0-beta', '1.2.0-beta')).toBe(0)
  })

  it('handles malformed input by comparing what it can', () => {
    expect(compareSemver('abc', '1.0.0')).toBe(-1)
    expect(compareSemver('abc', 'abc')).toBe(0)
  })
})
