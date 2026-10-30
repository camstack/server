import { describe, expect, it } from 'vitest'
import type { AutomationRecipe, AutomationWhen } from '../index.js'
import {
  AutomationRecipeSchema,
  AutomationWhenSchema,
  countWhenLeaves,
  MAX_WHEN_LEAVES,
  validateRecipeBounds,
  whenDepth,
} from '../index.js'

describe('stationary leaf', () => {
  const ok = { kind: 'stationary', deviceIds: [7], phase: 'appeared' }
  const parses = (leaf: object): boolean => AutomationWhenSchema.safeParse(leaf).success

  it('accepts the leaf and refuses no device, an unknown phase and empty filters', () => {
    expect(parses(ok)).toBe(true)
    expect(
      parses({
        ...ok,
        phase: 'departed',
        subjects: [{ macro: 'vehicle' }],
        zones: ['drive'],
      }),
    ).toBe(true)
    expect(parses({ ...ok, deviceIds: [] })).toBe(false)
    expect(parses({ ...ok, phase: 'moved' })).toBe(false)
    expect(parses({ ...ok, phase: undefined })).toBe(false)
    expect(parses({ ...ok, subjects: [] })).toBe(false)
    expect(parses({ ...ok, zones: [] })).toBe(false)
  })

  it('refuses a face or plate label: a parked object carries neither', () => {
    expect(
      parses({
        ...ok,
        subjects: [{ macro: 'vehicle', label: { kind: 'plate', text: 'AB123CD' } }],
      }),
    ).toBe(false)
    expect(
      parses({
        ...ok,
        subjects: [{ macro: 'person', label: { kind: 'identity', identityId: 'i1', name: 'Ann' } }],
      }),
    ).toBe(false)
    expect(
      parses({
        ...ok,
        subjects: [{ macro: 'vehicle', label: { kind: 'sub-class', className: 'truck' } }],
      }),
    ).toBe(true)
  })
})

describe('stationary-present leaf', () => {
  const present: AutomationWhen = {
    kind: 'stationary-present',
    deviceId: 7,
    subjects: [{ macro: 'vehicle' }],
    zones: ['drive'],
  }
  const wrap = (when: AutomationWhen): AutomationRecipe => ({
    when,
    actions: [{ kind: 'wait', seconds: 1 }],
  })

  it('is accepted by the recipe schema, counted as one leaf and one level', () => {
    const recipe = wrap({ kind: 'all', children: [present, present] })
    expect(AutomationRecipeSchema.safeParse(recipe).success).toBe(true)
    expect(countWhenLeaves(present)).toBe(1)
    expect(countWhenLeaves({ kind: 'all', children: [present, present] })).toBe(2)
    expect(whenDepth(present)).toBe(1)
    expect(whenDepth({ kind: 'not', child: present })).toBe(2)
    expect(validateRecipeBounds(recipe)).toBeNull()
  })

  it('shares the leaf budget with the other leaves', () => {
    const many: AutomationWhen = {
      kind: 'all',
      children: Array.from({ length: MAX_WHEN_LEAVES + 1 }, () => present),
    }
    expect(validateRecipeBounds(wrap(many))).toContain('rows')
  })

  it('refuses a leaf with no device or an empty filter', () => {
    const parses = (leaf: object): boolean =>
      AutomationRecipeSchema.safeParse({
        when: { kind: 'stationary-present', ...leaf },
        actions: [{ kind: 'wait', seconds: 1 }],
      }).success
    expect(parses({ deviceId: 7 })).toBe(true)
    expect(parses({})).toBe(false)
    expect(parses({ deviceId: 7, subjects: [] })).toBe(false)
    expect(parses({ deviceId: 7, zones: [] })).toBe(false)
  })
})
