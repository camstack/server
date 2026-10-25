/**
 * Freezing the confirm policy onto the row, and the occupancy derivation.
 *
 * The derivation exists so an occupancy rule states its threshold ONCE. Two
 * numbers that must agree is a defect waiting for the day they do not.
 */
import { describe, expect, it } from 'vitest'
import type { NcRule } from '@camstack/types'
import {
  confirmExpectFromOccupancy,
  frozenConfirmPolicy,
  shouldReleaseCooldown,
} from '../confirm-policy.js'
import { makeTestNcConfirm } from './support/nc-test-deps.js'

function rule(over: Partial<NcRule> = {}): NcRule {
  return {
    id: 'r1',
    name: 'Parking',
    enabled: true,
    delivery: 'immediate',
    conditions: {},
    targets: [{ targetId: 't1' }],
    media: { attach: 'best' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    disabledTargetIds: [],
    createdBy: 'admin',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('confirmExpectFromOccupancy', () => {
  it('reads became-occupied as "at least the configured count"', () => {
    expect(
      confirmExpectFromOccupancy({ op: 'became-occupied', count: 2, sustainSeconds: 15 }),
    ).toEqual({ op: '>=', count: 2 })
  })

  it('reads became-free as "fewer than the configured count"', () => {
    expect(confirmExpectFromOccupancy({ op: 'became-free', count: 1, sustainSeconds: 15 })).toEqual(
      {
        op: '<',
        count: 1,
      },
    )
  })

  it('carries an explicit comparison straight over', () => {
    expect(confirmExpectFromOccupancy({ op: '>=', count: 3, sustainSeconds: 15 })).toEqual({
      op: '>=',
      count: 3,
    })
    expect(confirmExpectFromOccupancy({ op: '<=', count: 0, sustainSeconds: 15 })).toEqual({
      op: '<=',
      count: 0,
    })
  })

  it('never derives a zero-count occupancy expectation from an edge', () => {
    // `became-occupied, count: 0` is a misconfigured rule; deriving `>= 0`
    // would confirm an empty frame forever.
    expect(
      confirmExpectFromOccupancy({ op: 'became-occupied', count: 0, sustainSeconds: 15 }),
    ).toEqual({ op: '>=', count: 1 })
  })
})

describe('shouldReleaseCooldown', () => {
  it('releases the window this fire opened', () => {
    expect(shouldReleaseCooldown(1_000, 1_000)).toBe(true)
  })

  it('refuses when a LATER fire has since opened the same window', () => {
    // Releasing here would hand away the later fire's cooldown too — the next
    // event would arrive as if nothing had ever fired, which defeats the
    // cooldown rather than rolling one back.
    expect(shouldReleaseCooldown(2_000, 1_000)).toBe(false)
  })

  it('refuses when the window is already gone', () => {
    expect(shouldReleaseCooldown(undefined, 1_000)).toBe(false)
  })
})

describe('frozenConfirmPolicy', () => {
  it('freezes nothing when the rule has no gate', () => {
    expect(frozenConfirmPolicy(rule(), false)).toBeUndefined()
  })

  it('freezes nothing when the gate is switched off', () => {
    expect(
      frozenConfirmPolicy(rule({ confirm: makeTestNcConfirm({ enabled: false }) }), false),
    ).toBeUndefined()
  })

  it('freezes nothing for a system event — there is no frame to judge', () => {
    expect(
      frozenConfirmPolicy(rule({ confirm: makeTestNcConfirm({ enabled: true }) }), true),
    ).toBeUndefined()
  })

  it('carries only the knobs the operator actually set', () => {
    const frozen = frozenConfirmPolicy(
      rule({ confirm: makeTestNcConfirm({ enabled: true, profileId: 'p1', timeoutMs: 5000 }) }),
      false,
    )
    expect(frozen).toEqual({ profileId: 'p1', timeoutMs: 5000 })
    expect(frozen).not.toHaveProperty('maxImagePx')
  })

  it('derives the expectation from an occupancy condition', () => {
    const frozen = frozenConfirmPolicy(
      rule({
        confirm: makeTestNcConfirm({ enabled: true }),
        conditions: { occupancy: { op: 'became-occupied', count: 2, sustainSeconds: 15 } },
      }),
      false,
    )
    expect(frozen?.expect).toEqual({ op: '>=', count: 2 })
  })

  it('lets an explicit expect win over the occupancy condition', () => {
    const frozen = frozenConfirmPolicy(
      rule({
        confirm: makeTestNcConfirm({ enabled: true, expect: { op: '==', count: 4 } }),
        conditions: { occupancy: { op: 'became-occupied', count: 2, sustainSeconds: 15 } },
      }),
      false,
    )
    expect(frozen?.expect).toEqual({ op: '==', count: 4 })
  })
})
