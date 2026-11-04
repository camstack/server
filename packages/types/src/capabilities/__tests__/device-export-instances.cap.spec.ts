/**
 * `device-export` instances: a write names its target, a read may omit it, and a
 * provider refuses an instance it does not serve by name.
 *
 * Disarm: make `instanceId` optional on `ExposeInputSchema` - the "write without a target" test
 * fails; drop the check in `assertOwnExportInstance` - the "unknown instance" test fails.
 */
import { describe, expect, it } from 'vitest'
import {
  assertOwnExportInstance,
  deviceExportCapability,
  EXPORT_INSTANCE_UNKNOWN,
  ExportInstanceUnknownError,
  statusInstanceOf,
} from '../device-export.cap.js'

const { methods } = deviceExportCapability

describe('device-export writes require an instanceId', () => {
  it('refuses a device write and an entity write that name no instance', () => {
    expect(methods.exposeDevice.input.safeParse({ deviceId: '7' }).success).toBe(false)
    expect(methods.unexposeDevice.input.safeParse({ deviceId: '7' }).success).toBe(false)
    const entity = { kind: 'device', deviceId: '7' }
    expect(methods.exposeEntity.input.safeParse({ entity }).success).toBe(false)
    expect(methods.unexposeEntity.input.safeParse({ entity }).success).toBe(false)
  })

  it('accepts a write that names its instance', () => {
    expect(
      methods.exposeDevice.input.safeParse({ instanceId: 'ha_001', deviceId: '7' }).success,
    ).toBe(true)
  })
})

describe('device-export reads take an optional instanceId', () => {
  it('answers with or without one', () => {
    for (const read of [
      methods.getStatus,
      methods.listExposedDevices,
      methods.listSupportedDeviceKinds,
    ]) {
      expect(read.input.safeParse({}).success).toBe(true)
      expect(read.input.safeParse({ instanceId: 'export-hap' }).success).toBe(true)
    }
  })

  it('lists instances', () => {
    expect(
      methods.listInstances.output.safeParse([
        { instanceId: 'export-hap', name: 'HomeKit', enabled: true },
      ]).success,
    ).toBe(true)
  })

  it('reads the instance out of a getStatus input of either shape', () => {
    expect(statusInstanceOf({ instanceId: 'a' })).toBe('a')
    expect(statusInstanceOf({ deviceId: 3 })).toBeUndefined()
  })
})

describe('a single-instance provider', () => {
  it('accepts an absent id or its own', () => {
    expect(() => assertOwnExportInstance('export-hap', 'export-hap', undefined)).not.toThrow()
    expect(() => assertOwnExportInstance('export-hap', 'export-hap', 'export-hap')).not.toThrow()
  })

  it('refuses any other id with the typed error', () => {
    const attempt = (): void => assertOwnExportInstance('export-hap', 'export-hap', 'export-alexa')
    expect(attempt).toThrow(ExportInstanceUnknownError)
    expect(attempt).toThrow(new RegExp(`^${EXPORT_INSTANCE_UNKNOWN}:`))
  })
})
