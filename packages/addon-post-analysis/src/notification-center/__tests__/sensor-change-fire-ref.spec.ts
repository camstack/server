/**
 * What a sensor DID rides the fire ref (planning#397): the combined alarm body tells
 * "Laundry — Laundry lock unlocked", so the match freezes the sensor's kind, the word
 * it moved to and its name — read off the same slice the edge is.
 */
import { NcRuleSchema, type SensorEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { fireRefFor } from '../rule-action-dispatch.js'
import { subjectFromSensorEvent } from '../rule-engine.js'

const LOCK = 1864
const CAMERA = 102

function lockEvent(state: string): SensorEvent {
  return {
    id: '9',
    deviceId: CAMERA,
    sourceDeviceId: LOCK,
    kind: 'lock',
    value: { state, lastChangedAt: 1_753_000_000_000 },
    timestamp: 1_753_000_000_000,
  }
}

const RULE = NcRuleSchema.parse({
  id: 'rule-1',
  createdBy: 'admin',
  name: 'Allarme notte',
  delivery: 'device-event',
  targets: [{ targetId: 't' }],
  conditions: {},
  createdAt: 1,
  updatedAt: 1,
})

describe('the sensor change on a fire ref', () => {
  it('reads the state word a lock moved to', () => {
    expect(subjectFromSensorEvent(lockEvent('unlocked')).sensorState).toBe('unlocked')
    expect(subjectFromSensorEvent(lockEvent('locked')).sensorState).toBe('locked')
  })

  it('freezes kind, state and the sensor name on the ref', () => {
    const subject = subjectFromSensorEvent(lockEvent('unlocked'))
    expect(fireRefFor(RULE, subject, 'device-event', 'Laundry lock').sensorChange).toEqual({
      name: 'Laundry lock',
      kind: 'lock',
      state: 'unlocked',
    })
  })

  it('freezes nothing when the sensor cannot be named', () => {
    const subject = subjectFromSensorEvent(lockEvent('unlocked'))
    expect(fireRefFor(RULE, subject, 'device-event', undefined).sensorChange).toBeUndefined()
  })
})
