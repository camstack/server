import { describe, expect, it } from 'vitest'
import { CUSTOMIZE_REGISTRY, customizeSpecs } from '../customize-registry'
import { CUSTOMIZE_KINDS, gapsOf, implsOf } from '../customize-spec'

describe('Customize registry (D1098 phase 1)', () => {
  it('has exactly one entry per listed kind, under its own name', () => {
    expect(Object.keys(CUSTOMIZE_REGISTRY).toSorted()).toEqual([...CUSTOMIZE_KINDS].toSorted())
    for (const kind of CUSTOMIZE_KINDS) {
      expect(CUSTOMIZE_REGISTRY[kind]?.kind).toBe(kind)
    }
  })

  it.each(CUSTOMIZE_KINDS)('%s: every wired piece resolves to an implementation', (kind) => {
    const spec = CUSTOMIZE_REGISTRY[kind]
    expect(spec).toBeDefined()
    for (const impl of implsOf(spec)) expect(typeof impl).toBe('function')
    expect(spec.storage.shape).toBeTruthy()
  })

  it('declares every gap with a named piece and a phase 2 or 3', () => {
    for (const spec of customizeSpecs()) {
      for (const g of gapsOf(spec)) expect([2, 3]).toContain(g.phase)
    }
  })
})
