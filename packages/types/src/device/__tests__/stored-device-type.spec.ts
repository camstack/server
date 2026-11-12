import { describe, expect, it } from 'vitest'
import { ActionTargetSchema } from '../../automation/action-target.js'
import { CompositionNewTargetSchema } from '../../composition/composition.js'
import { DeviceSelectorSchema } from '../../schemas/auth-records.js'
import { StoredDeviceTypeSchema } from '../device-kind.js'
import { DeviceType } from '../device-type.js'

// D1033 retired `thermostat`. A record written before that must still parse:
// a retired type in storage never drops the record that carries it.
describe('StoredDeviceTypeSchema', () => {
  it('reads a retired type as its live type', () => {
    expect(StoredDeviceTypeSchema.parse('thermostat')).toBe(DeviceType.Climate)
  })

  it('keeps a live type and still refuses an unknown one', () => {
    expect(StoredDeviceTypeSchema.parse(DeviceType.Sensor)).toBe(DeviceType.Sensor)
    expect(StoredDeviceTypeSchema.safeParse('not-a-type').success).toBe(false)
  })

  it('a stored grant, recipe target and composition target with the retired type parse', () => {
    expect(DeviceSelectorSchema.parse({ kind: 'types', types: ['thermostat'] })).toEqual({
      kind: 'types',
      types: [DeviceType.Climate],
    })
    expect(ActionTargetSchema.parse({ kind: 'domain', deviceType: 'thermostat' })).toEqual(
      expect.objectContaining({ kind: 'domain', deviceType: DeviceType.Climate }),
    )
    expect(CompositionNewTargetSchema.parse({ kind: 'new', type: 'thermostat' })).toEqual({
      kind: 'new',
      type: DeviceType.Climate,
    })
  })
})
