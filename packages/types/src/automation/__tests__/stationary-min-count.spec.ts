/** `minCount` on the stationary-present leaf: how many parked objects must match. */
import { describe, expect, it } from 'vitest'
import { collectWhenMirrorSources, ConditionMirror, evaluateWhenTree } from '../condition-eval.js'
import { AutomationWhenSchema, type AutomationWhen } from '../index.js'

const snapshot = {
  frame: { totalObjects: 2 },
  zones: [],
  stationaryObjects: [
    { id: 'e1', className: 'car' },
    { id: 'e2', className: 'car' },
    { id: 'e3', className: 'person' },
  ],
}

function run(when: AutomationWhen) {
  const mirror = new ConditionMirror(collectWhenMirrorSources(when))
  mirror.apply(7, 'zone-analytics', snapshot)
  return evaluateWhenTree(when, mirror, 0)
}

const leaf = (extra: object): AutomationWhen =>
  AutomationWhenSchema.parse({
    kind: 'stationary-present',
    deviceId: 7,
    ...extra,
  })

describe('stationary-present minCount', () => {
  it('requires that many MATCHING parked objects', () => {
    const cars = { subjects: [{ macro: 'vehicle' }] }
    expect(run(leaf({ ...cars, minCount: 2 })).pass).toBe(true)
    expect(run(leaf({ ...cars, minCount: 3 })).pass).toBe(false)
    expect(run(leaf({ minCount: 3 })).pass).toBe(true)
  })

  it('the reason names the count', () => {
    expect(run(leaf({ subjects: [{ macro: 'vehicle' }], minCount: 3 })).nodes[0]?.reason).toContain(
      '2 of 3',
    )
  })

  it('absent means one, as before', () => {
    expect(run(leaf({ subjects: [{ macro: 'person' }] })).pass).toBe(true)
  })

  it('refuses a non-positive or fractional count', () => {
    expect(
      AutomationWhenSchema.safeParse({
        kind: 'stationary-present',
        deviceId: 7,
        minCount: 0,
      }).success,
    ).toBe(false)
    expect(
      AutomationWhenSchema.safeParse({
        kind: 'stationary-present',
        deviceId: 7,
        minCount: 1.5,
      }).success,
    ).toBe(false)
  })
})
