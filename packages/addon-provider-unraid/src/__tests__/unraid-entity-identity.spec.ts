import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { UnraidEntityIdentitySchema } from '../unraid-mapping.js'

/**
 * The instance device persists its entities' identities. A type D1033 retired
 * (`thermostat`) in such a row must be read as its live type, never fail the
 * parse and drop the instance with every child.
 */
const identity = (deviceType: string): Record<string, unknown> => ({
  key: 'cpu-temp',
  kind: 'temperature',
  capName: 'numeric-sensor',
  deviceType,
  name: 'CPU temperature',
})

describe('UnraidEntityIdentitySchema reads a stored device type', () => {
  it('a retired type is read as its live type', () => {
    expect(UnraidEntityIdentitySchema.parse(identity('thermostat')).deviceType).toBe(
      DeviceType.Climate,
    )
  })

  it('a live type is kept and an unknown one is still refused', () => {
    expect(UnraidEntityIdentitySchema.parse(identity(DeviceType.Sensor)).deviceType).toBe(
      DeviceType.Sensor,
    )
    expect(UnraidEntityIdentitySchema.safeParse(identity('not-a-type')).success).toBe(false)
  })
})
