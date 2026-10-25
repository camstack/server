/**
 * Unit tests for pickHmChildClass — the restore-dispatcher's class selection.
 * Asserts the priority order and the diagnostic-vs-sensor disambiguation by the
 * MAINTENANCE-provenance flag.
 */

import { describe, it, expect } from 'vitest'
import { pickHmChildClass } from '../devices/hm-child-class-factory.js'
import { HmActuatorDevice } from '../devices/hm-actuator-device.js'
import { HmSensorDevice } from '../devices/hm-sensor-device.js'
import { HmEventEmitterDevice } from '../devices/hm-event-emitter-device.js'
import { HmDiagnosticDevice } from '../devices/hm-diagnostic-device.js'
import { HmUpdateDevice } from '../devices/hm-update-device.js'

describe('pickHmChildClass', () => {
  it('routes actuator caps to HmActuatorDevice', () => {
    expect(pickHmChildClass(['switch'], false)).toBe(HmActuatorDevice)
    expect(pickHmChildClass(['cover'], false)).toBe(HmActuatorDevice)
    expect(pickHmChildClass(['lock-control'], false)).toBe(HmActuatorDevice)
    expect(pickHmChildClass(['climate-control', 'temperature-sensor'], false)).toBe(
      HmActuatorDevice,
    )
  })

  it('routes event-emitter to HmEventEmitterDevice', () => {
    expect(pickHmChildClass(['event-emitter'], false)).toBe(HmEventEmitterDevice)
  })

  it('routes update to HmUpdateDevice', () => {
    expect(pickHmChildClass(['update'], false)).toBe(HmUpdateDevice)
  })

  it('routes a MAINTENANCE-provenance numeric/binary cap to HmDiagnosticDevice', () => {
    expect(pickHmChildClass(['numeric-sensor'], true)).toBe(HmDiagnosticDevice)
    expect(pickHmChildClass(['binary'], true)).toBe(HmDiagnosticDevice)
    expect(pickHmChildClass(['temperature-sensor'], true)).toBe(HmDiagnosticDevice)
  })

  it('routes a non-provenance sensor cap to HmSensorDevice', () => {
    expect(pickHmChildClass(['temperature-sensor', 'humidity-sensor'], false)).toBe(HmSensorDevice)
    expect(pickHmChildClass(['power-meter'], false)).toBe(HmSensorDevice)
    expect(pickHmChildClass(['motion', 'ambient-light-sensor'], false)).toBe(HmSensorDevice)
  })

  it('prefers actuator over a co-located sensor cap', () => {
    // A thermostat actuator child carries climate-control + temp/humidity.
    expect(
      pickHmChildClass(['climate-control', 'temperature-sensor', 'humidity-sensor'], false),
    ).toBe(HmActuatorDevice)
  })
})
