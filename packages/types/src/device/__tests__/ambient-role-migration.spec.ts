import { describe, expect, it } from 'vitest'
import { ambientRoleVerdict } from '../ambient-role-migration.js'
import { DeviceRole } from '../device-type.js'

const base = {
  current: null,
  wanted: DeviceRole.AmbientMonitor,
  replaces: DeviceRole.MotionSensor,
  reviewed: false,
}

describe('ambientRoleVerdict', () => {
  it('fills a role that is not there yet', () => {
    expect(ambientRoleVerdict(base)).toEqual({ action: 'set', markReviewed: false })
  })

  it('replaces the role the provider used to set, once', () => {
    expect(ambientRoleVerdict({ ...base, current: DeviceRole.MotionSensor })).toEqual({
      action: 'set',
      markReviewed: true,
    })
  })

  it("keeps any other role: it is the operator's", () => {
    expect(ambientRoleVerdict({ ...base, current: DeviceRole.GenericSensor })).toEqual({
      action: 'kept',
      markReviewed: true,
    })
  })

  it('does not take the decision twice', () => {
    expect(
      ambientRoleVerdict({ ...base, current: DeviceRole.MotionSensor, reviewed: true }),
    ).toEqual({ action: 'skip', markReviewed: false })
  })

  it('does nothing when the role already is the proposal or the provider names none', () => {
    expect(ambientRoleVerdict({ ...base, current: DeviceRole.AmbientMonitor }).action).toBe('skip')
    expect(ambientRoleVerdict({ ...base, wanted: null, current: 'x' }).action).toBe('skip')
  })
})
