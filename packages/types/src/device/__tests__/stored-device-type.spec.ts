import { describe, expect, it } from 'vitest'
import { ActionTargetSchema } from '../../automation/action-target.js'
import { CompositionNewTargetSchema } from '../../composition/composition.js'
import {
  DeviceSelectorSchema,
  ScopedTokenSchema,
  UserRecordSchema,
} from '../../schemas/auth-records.js'
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
})

describe('the wire schemas stay strict', () => {
  // The retired name is rewritten where a store READS its rows back, never on
  // the wire: a client still cannot send a type that no longer exists.
  it('a selector, an action target and a composition target refuse the retired type', () => {
    expect(DeviceSelectorSchema.safeParse({ kind: 'types', types: ['thermostat'] }).success).toBe(
      false,
    )
    expect(ActionTargetSchema.safeParse({ kind: 'domain', deviceType: 'thermostat' }).success).toBe(
      false,
    )
    expect(CompositionNewTargetSchema.safeParse({ kind: 'new', type: 'thermostat' }).success).toBe(
      false,
    )
  })
})

describe('a stored grant', () => {
  const thermostatGrant = {
    type: 'device',
    selector: { kind: 'types', types: ['thermostat', 'camera'] },
    access: ['view'],
  }
  const climateGrant = {
    type: 'device',
    selector: { kind: 'types', types: [DeviceType.Climate, DeviceType.Camera] },
    access: ['view'],
  }

  it('a user record whose grant names the retired type loads it as climate', () => {
    const user = UserRecordSchema.parse({
      id: 'u1',
      username: 'guest',
      passwordHash: 'x',
      allowedProviders: '*',
      allowedDevices: {},
      scopes: [thermostatGrant],
      createdAt: 1,
      updatedAt: 1,
    })
    expect(user.scopes).toEqual([climateGrant])
  })

  it('a scoped token whose grant names the retired type loads it as climate', () => {
    const token = ScopedTokenSchema.parse({
      id: 't1',
      userId: 'u1',
      name: 'panel',
      tokenHash: 'h',
      tokenPrefix: 'p',
      scopes: [thermostatGrant],
      createdAt: 1,
    })
    expect(token.scopes).toEqual([climateGrant])
  })
})
