import { NcRuleInputSchema, type SensorEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, presentConditionIds, subjectFromSensorEvent } from '../rule-engine.js'

// The live "Allagamento" rule (D640): flood sensors, water detected vs back to dry.
const FLOOD_SENSOR = 3223
const CAMERA = 101

function event(kind: string, value: Record<string, unknown> | null): SensorEvent {
  return {
    id: '7',
    deviceId: CAMERA,
    sourceDeviceId: FLOOD_SENSOR,
    kind,
    value,
    timestamp: 1000,
  }
}

function rule(conditions: Record<string, unknown>) {
  return NcRuleInputSchema.parse({
    name: 'Allagamento',
    delivery: 'device-event',
    targets: [{ targetId: 't' }],
    conditions,
  })
}

const judge = (r: ReturnType<typeof rule>, ev: SensorEvent) =>
  evaluateRule(r, subjectFromSensorEvent(ev))

const WET = event('flood', { flooded: true, lastChangedAt: 900 })
const DRY = event('flood', { flooded: false, lastChangedAt: 900 })

describe('the subject carries which way a boolean sensor moved', () => {
  it('raised on water, cleared on dry, absent when the slice cannot say', () => {
    expect(subjectFromSensorEvent(WET).sensorRaised).toBe(true)
    expect(subjectFromSensorEvent(DRY).sensorRaised).toBe(false)
    expect(subjectFromSensorEvent(event('flood', null)).sensorRaised).toBeUndefined()
    expect(subjectFromSensorEvent(event('doorbell', {})).sensorRaised).toBeUndefined()
  })
})

describe('sensorTransition (D640)', () => {
  it('absent = both edges, exactly as before', () => {
    const r = rule({ sensorKinds: ['flood'] })
    expect(judge(r, WET).matched).toBe(true)
    expect(judge(r, DRY).matched).toBe(true)
  })

  it('raised fires on water detected and refuses back-to-dry, by name', () => {
    const r = rule({ sensorKinds: ['flood'], sensorTransition: 'raised' })
    expect(judge(r, WET).matched).toBe(true)
    const dry = judge(r, DRY)
    expect(dry.matched).toBe(false)
    expect(dry.failedCondition).toBe('sensorTransition')
  })

  it('cleared is the mirror', () => {
    const r = rule({ sensorKinds: ['flood'], sensorTransition: 'cleared' })
    expect(judge(r, DRY).matched).toBe(true)
    expect(judge(r, WET).failedCondition).toBe('sensorTransition')
  })

  it('an UNREADABLE reading passes — a flood alert never goes silent on a bad read', () => {
    const r = rule({ sensorKinds: ['flood'], sensorTransition: 'raised' })
    expect(judge(r, event('flood', null)).matched).toBe(true)
    expect(judge(r, event('flood', { flooded: 'unknown' })).matched).toBe(true)
  })

  it('an UNKNOWN kind passes — there is no raise to compare', () => {
    const r = rule({ sensorTransition: 'cleared' })
    expect(judge(r, event('doorbell', { lastEvent: null })).matched).toBe(true)
  })

  it('is named in the "why it fired" summary', () => {
    expect(presentConditionIds({ sensorTransition: 'raised' })).toContain('sensorTransition')
    expect(presentConditionIds({})).not.toContain('sensorTransition')
    expect(judge(rule({ sensorTransition: 'raised' }), WET).matchedOn).toContain('sensorTransition')
  })
})
