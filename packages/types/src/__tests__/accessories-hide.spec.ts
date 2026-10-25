import { describe, it, expect } from 'vitest'
import { accessoriesCapability, AccessoriesStatusSchema } from '../index.js'
import { DeviceType } from '../device/device-type.js'

describe('accessories cap — hide-child extension (Phase E1)', () => {
  describe('status schema', () => {
    it('accepts a fully-populated sample with both arrays', () => {
      const sample = {
        childDeviceIds: [10, 11, 12, 13],
        hiddenChildIds: [12],
      }
      expect(AccessoriesStatusSchema.parse(sample)).toEqual(sample)
    })

    it('accepts a sample with empty hiddenChildIds', () => {
      const sample = {
        childDeviceIds: [1, 2, 3],
        hiddenChildIds: [],
      }
      expect(AccessoriesStatusSchema.parse(sample)).toEqual(sample)
    })

    it('rejects missing childDeviceIds', () => {
      expect(() => AccessoriesStatusSchema.parse({ hiddenChildIds: [] })).toThrow()
    })

    it('rejects missing hiddenChildIds (must be explicit, no implicit default)', () => {
      expect(() => AccessoriesStatusSchema.parse({ childDeviceIds: [1] })).toThrow()
    })

    it('rejects non-numeric ids', () => {
      expect(() =>
        AccessoriesStatusSchema.parse({
          childDeviceIds: ['ten' as unknown as number],
          hiddenChildIds: [],
        }),
      ).toThrow()
    })
  })

  describe('cap definition', () => {
    it('declares setChildHidden as an admin mutation', () => {
      const m = accessoriesCapability.methods.setChildHidden
      expect(m.kind).toBe('mutation')
      expect(m.auth).toBe('admin')
    })

    it('setChildHidden input requires deviceId + childDeviceId + hidden', () => {
      const input = { deviceId: 5, childDeviceId: 7, hidden: true }
      expect(accessoriesCapability.methods.setChildHidden.input.parse(input)).toEqual(input)
    })

    it('setChildHidden rejects missing hidden flag', () => {
      expect(() =>
        accessoriesCapability.methods.setChildHidden.input.parse({
          deviceId: 5,
          childDeviceId: 7,
        }),
      ).toThrow()
    })

    it('setChildHidden rejects negative ids', () => {
      expect(() =>
        accessoriesCapability.methods.setChildHidden.input.parse({
          deviceId: -1,
          childDeviceId: 7,
          hidden: true,
        }),
      ).toThrow()
    })

    it('declares onChildVisibilityChanged event', () => {
      expect(accessoriesCapability.events.onChildVisibilityChanged).toBeDefined()
    })

    it('onAccessoriesChanged event carries hiddenChildIds in payload', () => {
      const schema = accessoriesCapability.events.onAccessoriesChanged.data
      expect(
        schema.parse({
          deviceId: 1,
          childDeviceIds: [10, 11],
          hiddenChildIds: [11],
        }),
      ).toMatchObject({ hiddenChildIds: [11] })
    })
  })

  describe('deviceTypes — broadened to HA-targeted parents', () => {
    it('keeps the historical camera + hub registrability', () => {
      expect(accessoriesCapability.deviceTypes).toContain(DeviceType.Camera)
      expect(accessoriesCapability.deviceTypes).toContain(DeviceType.Hub)
    })

    it('includes HA-targeted actuator types as valid parents', () => {
      const expected = [
        DeviceType.Switch,
        DeviceType.Light,
        DeviceType.Sensor,
        DeviceType.Thermostat,
        DeviceType.Cover,
        DeviceType.Lock,
        DeviceType.Fan,
        DeviceType.MediaPlayer,
        DeviceType.AlarmPanel,
        DeviceType.Generic,
      ]
      for (const dt of expected) {
        expect(accessoriesCapability.deviceTypes).toContain(dt)
      }
    })
  })
})
