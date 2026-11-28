import { consumablesCapability, locationCapability, vehicleCapability } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { consumablesStatusOf, locationStatusOf, vehicleStatusOf } from '../kia-domain-mapping.js'
import { silentState, sportageState } from './kia-fixtures.js'

/**
 * The slices the vehicle device writes must satisfy each cap's RUNTIME schema (status plus
 * `lastFetchedAt`), not just the status schema: a write that fails the schema throws at
 * activation and the caps are never registered. A car that reports nothing must satisfy it too.
 */
describe('the vehicle slices satisfy the cap runtime schemas', () => {
  for (const [label, state] of [
    ['a car that reports everything', sportageState()],
    ['a car that reports nothing', silentState()],
  ] as const) {
    it(`parses for ${label}`, () => {
      const now = 1_795_340_000_000
      expect(
        vehicleCapability.runtimeState.safeParse({
          ...vehicleStatusOf(state, now),
          lastFetchedAt: now,
        }).success,
      ).toBe(true)
      expect(
        locationCapability.runtimeState.safeParse({
          ...locationStatusOf(state, now),
          lastFetchedAt: now,
        }).success,
      ).toBe(true)
      expect(
        consumablesCapability.runtimeState.safeParse({
          ...consumablesStatusOf(state, now),
          lastFetchedAt: now,
        }).success,
      ).toBe(true)
    })
  }
})
