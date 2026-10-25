/**
 * D641: `devicesExclude` — "every device except these". The exclusion is
 * judged on the SAME subject ids `devices` is judged on, at the same place,
 * so a sensor event fanned out per linked camera is excluded exactly where an
 * include would have tested it.
 */
import { NcRuleInputSchema, type ObjectEvent, type SensorEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  deviceEventRuleMayFireOnKind,
  deviceScopeExcludes,
  evaluateRule,
  presentConditionIds,
  subjectFromObjectEvent,
  subjectFromSensorEvent,
  subjectFromUnownedSensorEvent,
} from '../rule-engine.js'

const GARAGE = 104
const DRIVEWAY = 101
const PORCH = 102
const CONTACT = 3223

function rule(delivery: string, conditions: Record<string, unknown>) {
  return NcRuleInputSchema.parse({
    name: 'Everything but the garage',
    delivery,
    targets: [{ targetId: 't' }],
    conditions,
  })
}

function objectEvent(deviceId: number): ObjectEvent {
  return {
    id: 100_001,
    kind: 'object',
    deviceId,
    timestamp: 111,
    trackId: 'trk-1',
    className: 'person',
    confidence: 0.9,
    zones: [],
  }
}

function sensorRow(cameraId: number): SensorEvent {
  return {
    id: '7',
    deviceId: cameraId,
    sourceDeviceId: CONTACT,
    kind: 'contact',
    value: { entryOpen: true, lastChangedAt: 900 },
    timestamp: 1000,
  }
}

describe('the schema', () => {
  it('accepts a non-empty list and refuses an empty one', () => {
    expect(rule('immediate', { devicesExclude: [GARAGE] }).conditions.devicesExclude).toEqual([
      GARAGE,
    ])
    expect(() => rule('immediate', { devicesExclude: [] })).toThrow()
  })
})

describe('devicesExclude on a detection', () => {
  const r = rule('immediate', { devicesExclude: [GARAGE] })

  it('an excluded device fails, by name', () => {
    const verdict = evaluateRule(r, subjectFromObjectEvent(objectEvent(GARAGE)))
    expect(verdict.matched).toBe(false)
    expect(verdict.failedCondition).toBe('devicesExclude')
  })

  it('every other device passes, and the summary names the exclusion', () => {
    const verdict = evaluateRule(r, subjectFromObjectEvent(objectEvent(DRIVEWAY)))
    expect(verdict.matched).toBe(true)
    expect(verdict.matchedOn).toContain('devicesExclude')
    expect(presentConditionIds(r.conditions)).toContain('devicesExclude')
  })

  it('absent excludes nothing', () => {
    expect(presentConditionIds(rule('immediate', {}).conditions)).not.toContain('devicesExclude')
  })
})

describe('the same subject ids as `devices`', () => {
  it('a per-camera sensor row is excluded by its CAMERA or by its SENSOR', () => {
    const byCamera = rule('device-event', { devicesExclude: [DRIVEWAY] })
    expect(
      evaluateRule(byCamera, subjectFromSensorEvent(sensorRow(DRIVEWAY))).failedCondition,
    ).toBe('devicesExclude')
    expect(evaluateRule(byCamera, subjectFromSensorEvent(sensorRow(PORCH))).matched).toBe(true)

    const bySensor = rule('device-event', { devicesExclude: [CONTACT] })
    expect(
      evaluateRule(bySensor, subjectFromSensorEvent(sensorRow(DRIVEWAY))).failedCondition,
    ).toBe('devicesExclude')
    expect(evaluateRule(bySensor, subjectFromSensorEvent(sensorRow(PORCH))).failedCondition).toBe(
      'devicesExclude',
    )
  })

  it('the unowned sensor is its own device', () => {
    const r = rule('device-event', { devicesExclude: [CONTACT] })
    const own: SensorEvent = { ...sensorRow(CONTACT), deviceId: CONTACT }
    const subject = subjectFromUnownedSensorEvent(own, [DRIVEWAY])
    expect(evaluateRule(r, subject).failedCondition).toBe('devicesExclude')
    // A camera that only LINKS the sensor never narrows it (ADR 0632): the
    // include does not match through `linkedCameraIds`, so neither does this.
    expect(
      evaluateRule(rule('device-event', { devicesExclude: [DRIVEWAY] }), subject).matched,
    ).toBe(true)
  })

  it('agrees with `devices` on every per-camera row: included ⇔ not excluded', () => {
    for (const cameraId of [GARAGE, DRIVEWAY, PORCH]) {
      const subject = subjectFromSensorEvent(sensorRow(cameraId))
      for (const id of [GARAGE, DRIVEWAY, PORCH, CONTACT]) {
        const included = evaluateRule(rule('device-event', { devices: [id] }), subject).matched
        const excluded = !evaluateRule(rule('device-event', { devicesExclude: [id] }), subject)
          .matched
        expect(excluded).toBe(included)
      }
    }
  })
})

describe('a sensor fan-out evaluated ONCE (the linked set, ADR 0632)', () => {
  const linked = (rowCameraIds: readonly number[]) =>
    subjectFromSensorEvent(sensorRow(DRIVEWAY), undefined, {
      linkedCameraIds: [DRIVEWAY, PORCH, GARAGE],
      rowCameraIds,
      mutedRowCameraIds: [],
    })

  it('the SENSOR excluded drops the whole set', () => {
    const r = rule('device-event', { devicesExclude: [CONTACT] })
    expect(evaluateRule(r, linked([DRIVEWAY, PORCH])).failedCondition).toBe('devicesExclude')
  })

  it('one row camera excluded: the other row still fires, as its own row would have', () => {
    const r = rule('device-event', { devicesExclude: [DRIVEWAY] })
    expect(evaluateRule(r, linked([DRIVEWAY, PORCH])).matched).toBe(true)
  })

  it('every row camera excluded: nothing fires, as no row would have', () => {
    const r = rule('device-event', { devicesExclude: [DRIVEWAY, PORCH] })
    expect(evaluateRule(r, linked([DRIVEWAY, PORCH])).failedCondition).toBe('devicesExclude')
  })

  it('a camera that only links the sensor excludes nothing', () => {
    const r = rule('device-event', { devicesExclude: [GARAGE] })
    expect(evaluateRule(r, linked([DRIVEWAY])).matched).toBe(true)
    expect(evaluateRule(r, linked([])).matched).toBe(true)
  })
})

describe('deviceScopeExcludes', () => {
  it('an empty list excludes nothing', () => {
    expect(deviceScopeExcludes([], subjectFromObjectEvent(objectEvent(GARAGE)))).toBe(false)
  })
})

describe('deviceEventRuleMayFireOnKind stays coarse', () => {
  it('the kind gate does not read the exclusion (the evaluation does)', () => {
    expect(
      deviceEventRuleMayFireOnKind(rule('device-event', { devicesExclude: [CONTACT] }), 'contact'),
    ).toBe(true)
  })
})
