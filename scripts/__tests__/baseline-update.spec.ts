/**
 * `--update` is the ratchet's only writer, so the ratchet is only as strong as
 * what it refuses to write.
 */
import { describe, expect, it } from 'vitest'

import { planBaselineUpdate } from '../lib/baseline-update.js'

describe('planBaselineUpdate', () => {
  it('shrinks and drops fixed buckets freely', () => {
    const plan = planBaselineUpdate(
      'typecheck-specs',
      new Map([['a.spec.ts', 2]]),
      { 'a.spec.ts': 5, 'b.spec.ts': 3 },
      false,
    )
    expect(plan).toEqual({ next: { 'a.spec.ts': 2 }, refusals: [] })
  })

  it('refuses a raise and a new key without --allow-increase', () => {
    const plan = planBaselineUpdate(
      'typecheck-specs',
      new Map([
        ['a.spec.ts', 6],
        ['new.spec.ts', 1],
      ]),
      { 'a.spec.ts': 5 },
      false,
    )
    expect(plan.refusals).toEqual([
      { bucket: 'a.spec.ts', pinned: 5, actual: 6 },
      { bucket: 'new.spec.ts', pinned: null, actual: 1 },
    ])
    expect(plan.next).toEqual({})
  })

  it('accepts them when the check is named explicitly', () => {
    const plan = planBaselineUpdate('oxlint', new Map([['f » r', 2]]), {}, true)
    expect(plan).toEqual({ next: { 'f » r': 2 }, refusals: [] })
  })

  it('refuses ANY production typecheck entry, even with the flag', () => {
    const plan = planBaselineUpdate('typecheck', new Map([['@camstack/x', 1]]), {}, true)
    expect(plan.refusals).toEqual([{ bucket: '@camstack/x', pinned: null, actual: 1 }])
  })
})
