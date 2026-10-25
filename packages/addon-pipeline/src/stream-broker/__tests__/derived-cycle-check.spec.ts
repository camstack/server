import { describe, expect, it } from 'vitest'
import { type DerivedGraph, wouldCycle } from '../derived/cycle-check.js'

const base: DerivedGraph = {
  assignments: { high: null, mid: 'native:mid', low: null },
  derived: {},
}

describe('wouldCycle', () => {
  it('rejects assigning a derived to the SAME profile it sources from', () => {
    // D sources from profile mid; assigning D to mid → mid→D→mid.
    const g: DerivedGraph = {
      ...base,
      derived: { 'derived:d': { kind: 'profile', profile: 'mid' } },
    }
    expect(wouldCycle(g, 'derived:d', 'mid')).toBe(true)
  })
  it('allows assigning that derived to a DIFFERENT profile (mid→low)', () => {
    const g: DerivedGraph = {
      ...base,
      derived: { 'derived:d': { kind: 'profile', profile: 'mid' } },
    }
    expect(wouldCycle(g, 'derived:d', 'low')).toBe(false)
  })
  it('a physical-sourced derived never cycles (assignable to any profile incl. its stream profile)', () => {
    const g: DerivedGraph = {
      ...base,
      derived: { 'derived:d': { kind: 'camStream', camStreamId: 'native:mid' } },
    }
    expect(wouldCycle(g, 'derived:d', 'mid')).toBe(false)
  })
  it('detects a 2-hop cycle: D1 from mid, mid assigned to D2, D2 from low, assigning D1 to low', () => {
    const g: DerivedGraph = {
      assignments: { high: null, mid: 'derived:d2', low: null },
      derived: {
        'derived:d1': { kind: 'profile', profile: 'mid' },
        'derived:d2': { kind: 'profile', profile: 'low' },
      },
    }
    // low→D1→mid→D2→low.
    expect(wouldCycle(g, 'derived:d1', 'low')).toBe(true)
  })
})
