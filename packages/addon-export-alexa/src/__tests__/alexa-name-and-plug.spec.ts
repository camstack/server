/**
 * D875: the plug display category and the per-device Alexa name.
 *
 * Disarm notes (confirmed by reverting each fix):
 *  - without the `outlet` branch in `switchAdapter`, the SMARTPLUG test fails;
 *  - without the override in `toEndpoint`, the friendlyName test fails;
 *  - an endpoint id derived from the name breaks the no-duplicate test.
 */
import { DeviceRole } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ALEXA_NAME_MAX_LENGTH, validateAlexaName } from '../endpoints/alexa-name.js'
import { buildChildAccessoryEndpoint, classifyChildKind } from '../endpoints/builder.js'
import { buildGenericDeviceEndpoint } from '../endpoints/generic-device.js'
import { validateAlexaEndpoint } from '../endpoints/validate-endpoint.js'
import { buildEndpointsForExposedDevice } from '../handlers/discovery.js'
import { fakeBuildContext } from './helpers/fake-device-api.js'

const BASE = { deviceId: 7, stableId: 's7', name: 'Kitchen plug' }

describe('switch display category (D875)', () => {
  it('an outlet is a SMARTPLUG', () => {
    const e = buildGenericDeviceEndpoint({
      ...BASE,
      type: 'switch',
      capNames: ['switch'],
      role: DeviceRole.Outlet,
    })
    expect(e?.displayCategories).toEqual(['SMARTPLUG'])
    expect(e?.capabilities.map((c) => c.interface)).toContain('Alexa.PowerController')
  })

  it('a switch without the outlet role stays a SWITCH', () => {
    const e = buildGenericDeviceEndpoint({
      ...BASE,
      type: 'switch',
      capNames: ['switch'],
      role: null,
    })
    expect(e?.displayCategories).toEqual(['SWITCH'])
  })

  it('a dimmable outlet is a LIGHT (brightness wins)', () => {
    const e = buildGenericDeviceEndpoint({
      ...BASE,
      type: 'switch',
      capNames: ['switch', 'brightness'],
      role: DeviceRole.Outlet,
    })
    expect(e?.displayCategories).toEqual(['LIGHT'])
  })

  it('a switch-light (a relay driving a lamp) is a LIGHT, on/off only', () => {
    const e = buildGenericDeviceEndpoint({
      ...BASE,
      type: 'switch',
      capNames: ['switch'],
      role: DeviceRole.SwitchLight,
    })
    expect(e?.displayCategories).toEqual(['LIGHT'])
    expect(e?.capabilities.map((c) => c.interface)).toContain('Alexa.PowerController')
    expect(e?.capabilities.map((c) => c.interface)).not.toContain('Alexa.BrightnessController')
  })
})

// Operator decision 2026-11-12: every switch sub-role is exported as its own
// category, on the parent path and on the child path.
describe('switch sub-roles → Alexa display category', () => {
  const PARENT_CASES = [
    [DeviceRole.Outlet, 'SMARTPLUG'],
    [DeviceRole.SwitchLight, 'LIGHT'],
    [DeviceRole.SwitchFan, 'FAN'],
    // No Alexa category is a heater with power only: THERMOSTAT promises a setpoint.
    [DeviceRole.SwitchHeater, 'SWITCH'],
    // A helper boolean is not a physical thing: a plain switch.
    [DeviceRole.BinaryHelper, 'SWITCH'],
    [null, 'SWITCH'],
  ] as const

  it.each(PARENT_CASES)('a parent switch with role %s is %s, power only', (role, category) => {
    const e = buildGenericDeviceEndpoint({ ...BASE, type: 'switch', capNames: ['switch'], role })
    expect(e?.displayCategories).toEqual([category])
    expect(e?.capabilities.map((c) => c.interface)).toContain('Alexa.PowerController')
    expect(e?.capabilities.map((c) => c.interface)).not.toContain('Alexa.BrightnessController')
    expect(e?.endpointId).toBe('7__dev')
  })

  const CHILD_CASES = [
    [DeviceRole.Outlet, 'SMARTPLUG'],
    [DeviceRole.SwitchLight, 'LIGHT'],
    [DeviceRole.SwitchFan, 'FAN'],
    [DeviceRole.SwitchHeater, 'SWITCH'],
    [DeviceRole.BinaryHelper, 'SWITCH'],
    [null, 'SWITCH'],
  ] as const

  it.each(CHILD_CASES)('a child switch with role %s is %s', (role, category) => {
    const kind = classifyChildKind('switch', role)
    const e = buildChildAccessoryEndpoint({
      parentDeviceId: 3,
      parentName: 'Garage',
      childDeviceId: 9,
      childStableId: 'c9',
      childName: 'Garage relay',
      kind,
      hasBrightness: false,
    })
    expect(e.displayCategories).toEqual([category])
    expect(e.endpointId).toBe('3__9')
    expect(validateAlexaEndpoint(e)).toEqual([])
  })

  it('a child keeps the camera-accessory kinds it had', () => {
    expect(classifyChildKind('switch', 'floodlight')).toBe('light')
    expect(classifyChildKind('switch', 'siren')).toBe('siren')
    expect(classifyChildKind('light', null)).toBe('light')
    expect(classifyChildKind('siren', null)).toBe('siren')
  })
})

describe('Alexa name override (D875)', () => {
  const plug = { ...BASE, type: 'switch', capNames: ['switch'] }

  it('is the friendlyName, and the endpoint id does not change (no duplicate on rename)', () => {
    const before = buildGenericDeviceEndpoint(plug)
    const after = buildGenericDeviceEndpoint({ ...plug, alexaName: 'Coffee machine' })
    expect(before?.friendlyName).toBe('Kitchen plug')
    expect(after?.friendlyName).toBe('Coffee machine')
    expect(after?.endpointId).toBe(before?.endpointId)
    expect(after?.endpointId).toBe('7__dev')
  })

  it('a blank or absent override falls back to the device name', () => {
    expect(buildGenericDeviceEndpoint({ ...plug, alexaName: '   ' })?.friendlyName).toBe(
      'Kitchen plug',
    )
    expect(buildGenericDeviceEndpoint({ ...plug, alexaName: null })?.friendlyName).toBe(
      'Kitchen plug',
    )
  })

  it('an overridden endpoint still passes the endpoint validator', () => {
    const e = buildGenericDeviceEndpoint({ ...plug, alexaName: 'Lampada di mamma 2' })
    expect(e).not.toBeNull()
    if (e) expect(validateAlexaEndpoint(e)).toEqual([])
  })
})

describe('validateAlexaName (Amazon friendlyName rules)', () => {
  it('accepts letters, digits, spaces and accents, trimmed', () => {
    expect(validateAlexaName('  Lampada   del salotto ')).toEqual({
      ok: true,
      name: 'Lampada del salotto',
    })
    expect(validateAlexaName('Lamp 2 hall')).toEqual({ ok: true, name: 'Lamp 2 hall' })
    expect(validateAlexaName('Caffè')).toEqual({ ok: true, name: 'Caffè' })
  })

  it('blank clears the override', () => {
    expect(validateAlexaName('')).toEqual({ ok: true, name: null })
    expect(validateAlexaName('   ')).toEqual({ ok: true, name: null })
    expect(validateAlexaName(null)).toEqual({ ok: true, name: null })
  })

  it('refuses special characters and punctuation', () => {
    for (const bad of [
      'Lamp #1',
      'Lamp!',
      'a/b',
      'a_b',
      '<b>',
      'Lamp (hall)',
      "Mum's lamp",
      'Lamp - hall',
    ]) {
      expect(validateAlexaName(bad).ok, bad).toBe(false)
    }
  })

  it('refuses a name over 256 characters, and a non-string', () => {
    expect(validateAlexaName('a'.repeat(ALEXA_NAME_MAX_LENGTH)).ok).toBe(true)
    expect(validateAlexaName('a'.repeat(ALEXA_NAME_MAX_LENGTH + 1)).ok).toBe(false)
    expect(validateAlexaName(42).ok).toBe(false)
  })
})

describe('discovery (D875)', () => {
  const devices = [
    { id: 7, name: 'Kitchen plug', type: 'switch', capNames: ['switch'], role: 'outlet' },
    { id: 9, name: 'Front door', type: 'camera', capNames: ['video'] },
  ]

  it('an outlet is discovered as a SMARTPLUG under its Alexa name, same endpoint id', async () => {
    const base = fakeBuildContext(devices)
    const [plain] = await buildEndpointsForExposedDevice(7, base)
    const [renamed] = await buildEndpointsForExposedDevice(7, {
      ...base,
      alexaName: async () => 'Coffee machine',
    })
    expect(plain?.friendlyName).toBe('Kitchen plug')
    expect(renamed?.friendlyName).toBe('Coffee machine')
    expect(renamed?.endpointId).toBe(plain?.endpointId)
    expect(renamed?.displayCategories).toEqual(['SMARTPLUG'])
    expect(renamed?.capabilities).toEqual(plain?.capabilities)
  })

  it('a camera takes its Alexa name too, endpoint id unchanged', async () => {
    const base = fakeBuildContext(devices)
    const [plain] = await buildEndpointsForExposedDevice(9, base)
    const [renamed] = await buildEndpointsForExposedDevice(9, {
      ...base,
      alexaName: async () => 'Porch',
    })
    expect(renamed?.friendlyName).toBe('Porch')
    expect(renamed?.endpointId).toBe(plain?.endpointId)
  })
})
