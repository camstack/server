import { describe, expect, it } from 'vitest'
import { ALLOWLIST, violations } from '../check-no-adhoc-number-format'

describe('check-no-adhoc-number-format', () => {
  it('flags a file that is not allowlisted', () => {
    const counts = new Map(ALLOWLIST.map((e) => [e.file, e.uses]))
    counts.set('packages/ui-library/src/composites/new-card.tsx', 1)
    const found = violations(counts)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('formatNumeric')
  })

  it('flags a new use in an allowlisted file beyond its count', () => {
    const entry = ALLOWLIST[0]
    if (!entry) throw new Error('allowlist is empty')
    const counts = new Map(ALLOWLIST.map((e) => [e.file, e.uses]))
    counts.set(entry.file, entry.uses + 1)
    expect(violations(counts)).toHaveLength(1)
  })

  it('flags an allowlist entry that no longer matches', () => {
    const counts = new Map(ALLOWLIST.map((e) => [e.file, e.uses]))
    const entry = ALLOWLIST[0]
    if (!entry) throw new Error('allowlist is empty')
    counts.delete(entry.file)
    expect(violations(counts)[0]).toContain('shrink')
  })

  it('passes when every use is allowlisted', () => {
    expect(violations(new Map(ALLOWLIST.map((e) => [e.file, e.uses])))).toEqual([])
  })
})
