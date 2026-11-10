import { describe, expect, it } from 'vitest'
import { heroUtilityLayout } from '../hero-utility-layout'

describe('heroUtilityLayout', () => {
  it.each([
    [0, []],
    [1, [2]],
    [2, [1, 1]],
    [3, [1, 1, 2]],
    [4, [1, 1, 1, 1]],
    [5, [1, 1, 1, 1, 2]],
  ])('lays %i utilities out as %j', (count, spans) => {
    expect(heroUtilityLayout(count)).toEqual(spans)
  })

  it('treats a negative or non-finite count as none', () => {
    expect(heroUtilityLayout(-2)).toEqual([])
    expect(heroUtilityLayout(Number.NaN)).toEqual([])
  })
})
