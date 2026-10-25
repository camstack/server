/**
 * Reading HomeKit's own recording switch — and refusing to guess when the
 * accessory never offered one.
 */
import { Accessory, Characteristic, Service, uuid } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import { readHomekitRecordingActive } from '../recording-active.js'

function accessoryWith(active: number | null): Accessory {
  const accessory = new Accessory('Cam 101', uuid.generate('cam-101'))
  if (active !== null) {
    const service = accessory.addService(Service.CameraRecordingManagement)
    service.setCharacteristic(Characteristic.Active, active)
  }
  return accessory
}

describe('readHomekitRecordingActive', () => {
  it('reads the characteristic HomeKit wrote', () => {
    expect(readHomekitRecordingActive([accessoryWith(1)])).toBe(true)
    expect(readHomekitRecordingActive([accessoryWith(0)])).toBe(false)
  })

  it('is NULL when the accessory offers no recording service', () => {
    // Never offered and declined in Home are different facts. A camera we
    // refused must not read as a camera the operator refused.
    expect(readHomekitRecordingActive([accessoryWith(null)])).toBeNull()
    expect(readHomekitRecordingActive([])).toBeNull()
  })

  it('finds the service on whichever accessory carries it', () => {
    // A bridged camera publishes more than one accessory object.
    expect(readHomekitRecordingActive([accessoryWith(null), accessoryWith(1)])).toBe(true)
  })
})
