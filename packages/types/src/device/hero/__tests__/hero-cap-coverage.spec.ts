import { describe, expect, it } from 'vitest'
import { HERO_CAP_CONTRIBUTIONS } from '../hero-contributions.js'
import { HERO_CAP_COVERAGE } from '../hero-cap-coverage.js'

describe('hero cap coverage', () => {
  it('every contribution is declared as contributing, and every contributing entry has one', () => {
    const contributing = Object.entries(HERO_CAP_COVERAGE)
      .filter(([, v]) => v === 'contributes')
      .map(([k]) => k)
      .sort()
    expect(HERO_CAP_CONTRIBUTIONS.map((c) => c.cap).sort()).toEqual(contributing)
  })

  it('every exclusion says why', () => {
    for (const [cap, v] of Object.entries(HERO_CAP_COVERAGE)) {
      if (v !== 'contributes') expect(v.none.length, cap).toBeGreaterThan(10)
    }
  })
})
