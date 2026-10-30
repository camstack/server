import { describe, expect, it } from 'vitest'
import { collectMirrorSources, ConditionMirror, evaluateConditionTree } from '../condition-eval.js'
import type { LegacyCondition as AutomationCondition } from '../legacy-recipe.js'

const ZONE_CAP = 'zone-analytics'

const snapshot = {
  frame: { totalObjects: 1 },
  zones: [{ zoneId: 'drive', zoneName: 'Drive', trackIds: ['stationary:e1'] }],
  stationaryObjects: [{ id: 'e1', className: 'car' }],
}
const empty = { frame: { totalObjects: 0 }, zones: [] }

const present = (extra: object = {}): AutomationCondition => ({
  kind: 'stationary-present',
  deviceId: 7,
  ...extra,
})

function run(cond: AutomationCondition, slice: object | null) {
  const mirror = new ConditionMirror(collectMirrorSources(cond))
  if (slice !== null) mirror.apply(7, ZONE_CAP, slice)
  return evaluateConditionTree(cond, mirror, 0)
}

describe('the stationary-present leaf', () => {
  it('reads the zone-analytics slice of the device, through the mirror', () => {
    expect(collectMirrorSources(present())).toEqual([
      { kind: 'device', deviceId: 7, cap: ZONE_CAP },
    ])
  })

  it('passes when a parked object matches, and names it in the reason', () => {
    const r = run(present(), snapshot)
    expect(r.pass).toBe(true)
    expect(r.nodes[0]).toMatchObject({ kind: 'stationary-present', outcome: 'pass', deviceId: 7 })
    expect(r.nodes[0]?.reason).toContain('car')
  })

  it('class: a macro class matches a raw class; another class fails', () => {
    expect(run(present({ classes: ['vehicle'] }), snapshot).pass).toBe(true)
    expect(run(present({ classes: ['person'] }), snapshot).pass).toBe(false)
  })

  it('zones: the object must be in one of the wanted zones', () => {
    expect(run(present({ zones: ['drive'] }), snapshot).pass).toBe(true)
    expect(run(present({ zones: ['lawn'] }), snapshot).pass).toBe(false)
  })

  it('a snapshot with no parked objects is a definite no', () => {
    const r = run(present(), empty)
    expect(r.pass).toBe(false)
    expect(r.nodes[0]?.reason).toContain('no parked')
  })

  it('an unread slice is UNKNOWN: fail, and the reason says so (D49)', () => {
    const r = run(present(), null)
    expect(r.pass).toBe(false)
    expect(r.nodes[0]?.reason).toContain('unknown')
  })

  it('NOT inverts it', () => {
    const not: AutomationCondition = { kind: 'not', child: present() }
    expect(run(not, snapshot).pass).toBe(false)
    expect(run(not, empty).pass).toBe(true)
  })
})
