/**
 * A rule whose source is an EVENT DEVICE itself — a button, one key of a
 * remote — and one of the events it declares (camstack/planning#503 phase 5).
 * No camera links the device: the fire is evaluated on the device alone.
 */
import { NcRuleInputSchema, type SensorEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, subjectFromUnownedSensorEvent } from '../rule-engine.js'

const BUTTON_ONE = 7001
const BUTTON_TWO = 7002

function rule(conditions: Record<string, unknown>) {
  return NcRuleInputSchema.parse({
    name: 'Hall button, long press',
    delivery: 'device-event',
    targets: [{ targetId: 't' }],
    conditions,
  })
}

/** One fire, as the sensor ingest persists the device's `event-emitter` slice. */
function fire(deviceId: number, eventType: string): SensorEvent {
  return {
    id: 'se-1',
    deviceId,
    sourceDeviceId: deviceId,
    kind: 'device-event',
    value: { lastEvent: { deviceId, eventType, data: null, timestamp: 1, seq: 1 } },
    timestamp: Date.UTC(2026, 10, 11, 12, 0, 0),
  }
}

describe('a rule on an event device and one of its declared events', () => {
  const longPressOfOne = rule({ devices: [BUTTON_ONE], eventTypeTokens: ['PRESS_LONG'] })

  it('fires on that event of that device, with no camera linked', () => {
    const subject = subjectFromUnownedSensorEvent(fire(BUTTON_ONE, 'PRESS_LONG'), [])
    expect(evaluateRule(longPressOfOne, subject).matched).toBe(true)
  })

  it('does not fire on another event of the device', () => {
    const subject = subjectFromUnownedSensorEvent(fire(BUTTON_ONE, 'PRESS_SHORT'), [])
    expect(evaluateRule(longPressOfOne, subject).failedCondition).toBe('eventTypeTokens')
  })

  it('does not fire on the same event of another event device', () => {
    const subject = subjectFromUnownedSensorEvent(fire(BUTTON_TWO, 'PRESS_LONG'), [])
    expect(evaluateRule(longPressOfOne, subject).failedCondition).toBe('devices')
  })
})
