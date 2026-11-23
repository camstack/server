import { describe, expect, it } from 'vitest'
import { timedRunLimitOf } from '../../capabilities/timed-run.cap.js'
import { DeviceRole, DeviceType } from '../device-type.js'
import { switchRunLimitOf } from '../switch-run-limits.js'

describe('switchRunLimitOf', () => {
  it('has one number per type and role', () => {
    expect(switchRunLimitOf(DeviceType.Switch, DeviceRole.SwitchHeater)).toEqual({
      maxSeconds: 10_800,
      quickRunSeconds: 1_800,
    })
    expect(switchRunLimitOf(DeviceType.PetFountain, null).maxSeconds).toBe(300)
    expect(switchRunLimitOf(DeviceType.Switch, DeviceRole.Siren)).toEqual({
      maxSeconds: 600,
      quickRunSeconds: 60,
    })
    expect(switchRunLimitOf(DeviceType.Switch, null)).toEqual({
      maxSeconds: 86_400,
      quickRunSeconds: 900,
    })
  })

  it('feeds timedRunLimitOf, which stays null where timed run is not offered', () => {
    expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.SwitchHeater)?.maxSeconds).toBe(
      switchRunLimitOf(DeviceType.Switch, DeviceRole.SwitchHeater).maxSeconds,
    )
    expect(timedRunLimitOf(DeviceType.PetFountain, null)?.maxSeconds).toBe(300)
    expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.Siren)).toBeNull()
  })
})
