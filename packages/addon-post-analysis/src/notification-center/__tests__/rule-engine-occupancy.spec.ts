/**
 * Rule-engine OCCUPANCY tests.
 *
 * Occupancy edges (ZoneAnalytics count crossings) ride the EXISTING
 * `device-event` delivery via an INTERNAL `NcSubjectKind` (`occupancy-event`)
 * that never leaves the engine — the audio-subject pattern with a device-event
 * landing. These specs pin:
 *  - `subjectFromOccupancyEvent` normalisation off an `OccupancyEdge`;
 *  - the `evaluateRule` occupancy branch (safety gate: `device-event` delivery
 *    + a `conditions.occupancy` present) and its `op`/`count`/`threshold`
 *    matching (each rule matches only the edge whose threshold equals its own
 *    `count`, so a ≥1 and a ≥3 rule never cross-fire);
 *  - fail-closed of the object/track/label/zone/package conditions on an
 *    occupancy subject (no bbox/label/confidence/importance/sensorKind);
 *  - a device-event rule WITHOUT occupancy is unaffected (stays a sensor rule),
 *    and an occupancy rule never fires on a non-occupancy subject.
 */

import type { NcRule, SensorEvent } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { OccupancyEdge } from '../occupancy-watcher.js'
import { evaluateRule, subjectFromOccupancyEvent, subjectFromSensorEvent } from '../rule-engine.js'

const WED_NOON = Date.UTC(2026, 6, 22, 12, 0, 0) // Wednesday noon UTC

// ── fixtures ────────────────────────────────────────────────────────

function makeRule(overrides: Record<string, unknown> = {}): NcRule {
  const input = NcRuleInputSchema.parse({
    name: 'occupancy rule',
    delivery: 'device-event',
    targets: [{ targetId: 't1' }],
    ...overrides,
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'rule-1',
    createdBy: 'admin-user',
    createdAt: 1_000,
    updatedAt: 1_000,
  })
}

function makeEdge(overrides: Partial<OccupancyEdge> = {}): OccupancyEdge {
  return {
    deviceId: 104,
    count: 2,
    previousCount: 0,
    occupied: true,
    threshold: 2,
    timestamp: WED_NOON,
    ...overrides,
  }
}

function makeSensorEvent(overrides: Partial<SensorEvent> = {}): SensorEvent {
  return {
    id: 'sensor-1',
    kind: 'doorbell',
    deviceId: 104,
    sourceDeviceId: 104,
    timestamp: WED_NOON,
    value: null,
    ...overrides,
  }
}

// ── subjectFromOccupancyEvent ───────────────────────────────────────

describe('subjectFromOccupancyEvent', () => {
  it('normalises an edge onto an occupancy-event subject', () => {
    const s = subjectFromOccupancyEvent(
      makeEdge({ zoneId: 'gate', zoneName: 'Gate', className: 'person', count: 3, threshold: 2 }),
    )
    expect(s.kind).toBe('occupancy-event')
    expect(s.deviceId).toBe(104)
    expect(s.timestamp).toBe(WED_NOON)
    expect(s.classNames).toEqual(['person'])
    // Admin-zone provenance is carried on `occupancy`, NOT `zones` (so the
    // admin `zones` condition fails closed on occupancy subjects).
    expect(s.zones).toEqual([])
    expect(s.occupancy).toMatchObject({
      zoneId: 'gate',
      zoneName: 'Gate',
      className: 'person',
      count: 3,
      previousCount: 0,
      occupied: true,
      threshold: 2,
    })
    // No object/track dimensions.
    expect(s.confidence).toBeUndefined()
    expect(s.label).toBeUndefined()
    expect(s.bbox).toBeUndefined()
  })

  it('a frame-wide, all-class edge carries the `occupancy` placeholder class', () => {
    const s = subjectFromOccupancyEvent(makeEdge())
    expect(s.classNames).toEqual(['occupancy'])
    expect(s.occupancy?.zoneId).toBeUndefined()
    expect(s.occupancy?.className).toBeUndefined()
  })
})

// ── safety gate + op matching ───────────────────────────────────────

describe('occupancy safety gate + op matching', () => {
  it('(a) a device-event rule with occupancy became-occupied count 2 FIRES on the matching edge', () => {
    const rule = makeRule({ conditions: { occupancy: { op: 'became-occupied', count: 2 } } })
    const ev = evaluateRule(rule, subjectFromOccupancyEvent(makeEdge({ count: 2, threshold: 2 })))
    expect(ev.matched).toBe(true)
    expect(ev.matchedOn).toContain('occupancy')
  })

  it('(a) it matches the zoneId + className scope', () => {
    const rule = makeRule({
      conditions: {
        occupancy: { op: 'became-occupied', count: 1, zoneId: 'gate', className: 'person' },
      },
    })
    const match = subjectFromOccupancyEvent(
      makeEdge({ zoneId: 'gate', className: 'person', count: 1, threshold: 1 }),
    )
    expect(evaluateRule(rule, match).matched).toBe(true)
    // Wrong zone → fail closed.
    const wrongZone = subjectFromOccupancyEvent(
      makeEdge({ zoneId: 'drive', className: 'person', count: 1, threshold: 1 }),
    )
    expect(evaluateRule(rule, wrongZone).failedCondition).toBe('occupancy')
    // Wrong class → fail closed.
    const wrongClass = subjectFromOccupancyEvent(
      makeEdge({ zoneId: 'gate', className: 'car', count: 1, threshold: 1 }),
    )
    expect(evaluateRule(rule, wrongClass).failedCondition).toBe('occupancy')
  })

  it('a ≥1 rule does NOT fire on the ≥3 threshold edge (no cross-threshold firing)', () => {
    const ruleGe1 = makeRule({ conditions: { occupancy: { op: 'became-occupied', count: 1 } } })
    const ruleGe3 = makeRule({ conditions: { occupancy: { op: 'became-occupied', count: 3 } } })
    const edge1 = subjectFromOccupancyEvent(makeEdge({ count: 1, threshold: 1 }))
    const edge3 = subjectFromOccupancyEvent(makeEdge({ count: 3, threshold: 3 }))
    // Each rule matches ONLY the edge for its own threshold.
    expect(evaluateRule(ruleGe1, edge1).matched).toBe(true)
    expect(evaluateRule(ruleGe3, edge1).failedCondition).toBe('occupancy')
    expect(evaluateRule(ruleGe1, edge3).failedCondition).toBe('occupancy')
    expect(evaluateRule(ruleGe3, edge3).matched).toBe(true)
  })

  it('became-free fires on the un-occupied edge for its threshold', () => {
    const rule = makeRule({ conditions: { occupancy: { op: 'became-free', count: 2 } } })
    const freed = subjectFromOccupancyEvent(
      makeEdge({ count: 0, previousCount: 3, occupied: false, threshold: 2 }),
    )
    expect(evaluateRule(rule, freed).matched).toBe(true)
    // The became-occupied edge for the same threshold must NOT satisfy became-free.
    const occ = subjectFromOccupancyEvent(makeEdge({ count: 2, occupied: true, threshold: 2 }))
    expect(evaluateRule(rule, occ).failedCondition).toBe('occupancy')
  })

  it('>= fires on the occupied edge; <= fires on the un-occupied edge (threshold+1 key)', () => {
    const ge = makeRule({ conditions: { occupancy: { op: '>=', count: 2 } } })
    expect(
      evaluateRule(
        ge,
        subjectFromOccupancyEvent(makeEdge({ count: 2, occupied: true, threshold: 2 })),
      ).matched,
    ).toBe(true)
    const le = makeRule({ conditions: { occupancy: { op: '<=', count: 2 } } })
    // `<=2` maps onto the false edge of the threshold-3 key (count dropped to ≤2).
    expect(
      evaluateRule(
        le,
        subjectFromOccupancyEvent(
          makeEdge({ count: 2, previousCount: 4, occupied: false, threshold: 3 }),
        ),
      ).matched,
    ).toBe(true)
  })

  it('(b) a device-event rule WITHOUT occupancy never fires on an occupancy subject (stays a sensor rule)', () => {
    const rule = makeRule({ conditions: { sensorKinds: ['doorbell'] } })
    const ev = evaluateRule(rule, subjectFromOccupancyEvent(makeEdge()))
    expect(ev.matched).toBe(false)
    expect(ev.failedCondition).toBe('occupancy')
  })

  it('an occupancy rule never fires on a (non-occupancy) sensor subject', () => {
    const rule = makeRule({ conditions: { occupancy: { op: 'became-occupied', count: 1 } } })
    const ev = evaluateRule(rule, subjectFromSensorEvent(makeSensorEvent()))
    expect(ev.matched).toBe(false)
    expect(ev.failedCondition).toBe('occupancy')
  })

  it('a non-device-event delivery never targets an occupancy subject', () => {
    const rule = makeRule({
      delivery: 'immediate',
      conditions: { occupancy: { op: 'became-occupied', count: 1 } },
    })
    const ev = evaluateRule(rule, subjectFromOccupancyEvent(makeEdge({ count: 1, threshold: 1 })))
    expect(ev.matched).toBe(false)
    expect(ev.failedCondition).toBe('delivery')
  })
})

// ── conditions compose / fail-closed on occupancy ───────────────────

describe('conditions compose / fail-closed on occupancy', () => {
  function occRule(extra: Record<string, unknown>): NcRule {
    return makeRule({
      conditions: { occupancy: { op: 'became-occupied', count: 2 }, ...extra },
    })
  }
  const subject = () => subjectFromOccupancyEvent(makeEdge({ count: 2, threshold: 2 }))

  it('devices composes (a non-listed device fails devices)', () => {
    expect(evaluateRule(occRule({ devices: [999] }), subject()).failedCondition).toBe('devices')
  })

  it('schedule composes at the occupancy timestamp', () => {
    const rule = makeRule({
      conditions: { occupancy: { op: 'became-occupied', count: 2 } },
      schedule: {
        timezone: 'UTC',
        windows: [{ days: [3], startMinute: 13 * 60, endMinute: 14 * 60 }],
      },
    })
    // Edge is Wed 12:00 UTC — outside the 13:00-14:00 window.
    expect(evaluateRule(rule, subject()).failedCondition).toBe('schedule')
  })

  it('(c) minConfidence FAILS CLOSED (occupancy has no detection confidence)', () => {
    expect(evaluateRule(occRule({ minConfidence: 0.5 }), subject()).failedCondition).toBe(
      'minConfidence',
    )
  })

  it('(c) minImportance FAILS CLOSED', () => {
    expect(evaluateRule(occRule({ minImportance: 0.1 }), subject()).failedCondition).toBe(
      'minImportance',
    )
  })

  it('(c) minDwellSeconds FAILS CLOSED (no closed lifespan)', () => {
    expect(evaluateRule(occRule({ minDwellSeconds: 1 }), subject()).failedCondition).toBe(
      'minDwellSeconds',
    )
  })

  it('(c) admin zones FAIL CLOSED (occupancy carries no zones[] provenance)', () => {
    expect(
      evaluateRule(occRule({ zones: { match: 'any', ids: ['gate'] } }), subject()).failedCondition,
    ).toBe('zones')
  })

  it('(c) identities FAIL CLOSED (no label)', () => {
    expect(evaluateRule(occRule({ identities: ['john'] }), subject()).failedCondition).toBe(
      'identities',
    )
  })

  it('(c) customZones FAIL CLOSED (no bbox)', () => {
    const rule = occRule({
      customZones: [
        {
          kind: 'polygon',
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      ],
    })
    expect(evaluateRule(rule, subject()).failedCondition).toBe('customZones')
  })

  it('(c) sensorKinds FAIL CLOSED (occupancy is not a sensor slice)', () => {
    expect(evaluateRule(occRule({ sensorKinds: ['doorbell'] }), subject()).failedCondition).toBe(
      'sensorKinds',
    )
  })

  it('(c) packagePhase FAILS CLOSED', () => {
    expect(evaluateRule(occRule({ packagePhase: 'delivered' }), subject()).failedCondition).toBe(
      'packagePhase',
    )
  })
})
