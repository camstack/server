import { describe, expect, it } from 'vitest'
import {
  phoneColumnVisible,
  reconcileSingleStep,
  stepAfterBack,
  stepAfterDevicePick,
  stepAfterDone,
} from './source-selector-steps'

describe('source selector steps', () => {
  it('opens the values after a single pick and stays on the list for members', () => {
    expect(stepAfterDevicePick('single')).toBe('values')
    expect(stepAfterDevicePick('members')).toBe('devices')
  })

  it('opens the values from Done only when a member is picked', () => {
    expect(stepAfterDone(0)).toBeNull()
    expect(stepAfterDone(2)).toBe('values')
  })

  it('returns to the device list without dropping the choice', () => {
    expect(stepAfterBack()).toBe('devices')
  })

  it('opens the values the first time a device is present, and keeps a back step', () => {
    expect(reconcileSingleStep(true, { seenDevice: false, step: 'devices' })).toEqual({
      seenDevice: true,
      step: 'values',
    })
    expect(reconcileSingleStep(true, { seenDevice: true, step: 'devices' })).toBeNull()
    expect(reconcileSingleStep(false, { seenDevice: true, step: 'values' })).toEqual({
      seenDevice: false,
      step: 'devices',
    })
    expect(reconcileSingleStep(false, { seenDevice: false, step: 'devices' })).toBeNull()
  })

  it('shows one column on a phone', () => {
    expect(phoneColumnVisible('devices', 'devices')).toBe(true)
    expect(phoneColumnVisible('devices', 'values')).toBe(false)
    expect(phoneColumnVisible('values', 'devices')).toBe(false)
    expect(phoneColumnVisible('values', 'values')).toBe(true)
  })
})
