import { describe, expect, it } from 'vitest'
import { buildAlarmPanelEndpoint } from '../endpoints/builder.js'
import { parseCameraEndpointId } from '../handlers/endpoint-id.js'

describe('parseCameraEndpointId — the alarm panel routing tag', () => {
  it('decodes the panel endpoint to the panel’s own device id', () => {
    expect(parseCameraEndpointId('102__alarm')).toEqual({ kind: 'alarm-panel', deviceId: 102 })
  })

  it('still decodes every id shape that existed before it', () => {
    expect(parseCameraEndpointId('102')).toEqual({ kind: 'camera', deviceId: 102 })
    expect(parseCameraEndpointId('102__108')).toEqual({
      kind: 'child',
      parentDeviceId: 102,
      childDeviceId: 108,
    })
    expect(parseCameraEndpointId('102__privacy')).toEqual({ kind: 'privacy', parentDeviceId: 102 })
    expect(parseCameraEndpointId('102__autotrack')).toEqual({
      kind: 'autotrack',
      parentDeviceId: 102,
    })
  })

  it('rejects a tag it does not know, naming what it saw', () => {
    const parsed = parseCameraEndpointId('102__sprinkler')
    expect(parsed.kind).toBe('invalid')
  })
})

describe('buildAlarmPanelEndpoint — what Alexa is told a panel can do', () => {
  it('declares SecurityPanelController with the states the panel accepts', () => {
    const endpoint = buildAlarmPanelEndpoint({
      deviceId: 102,
      stableId: 'stable-102',
      friendlyName: 'Casa',
      availableModes: ['home', 'away'],
      requiresCode: false,
    })
    expect(endpoint.endpointId).toBe('102__alarm')
    expect(endpoint.displayCategories).toEqual(['SECURITY_PANEL'])
    const panel = endpoint.capabilities.find((c) => c.interface === 'Alexa.SecurityPanelController')
    expect(panel?.configuration?.supportedArmStates).toEqual([
      { value: 'ARMED_STAY' },
      { value: 'ARMED_AWAY' },
      { value: 'DISARMED' },
    ])
    expect(panel?.properties?.supported).toEqual([{ name: 'armState' }, { name: 'burglaryAlarm' }])
  })

  it('declares a PIN authorization type only when the panel actually needs one', () => {
    const without = buildAlarmPanelEndpoint({
      deviceId: 1,
      stableId: 's',
      friendlyName: 'A',
      availableModes: ['away'],
      requiresCode: false,
    })
    const panelWithout = without.capabilities.find(
      (c) => c.interface === 'Alexa.SecurityPanelController',
    )
    expect(panelWithout?.configuration?.supportedAuthorizationTypes).toBeUndefined()

    const withPin = buildAlarmPanelEndpoint({
      deviceId: 1,
      stableId: 's',
      friendlyName: 'A',
      availableModes: ['away'],
      requiresCode: true,
    })
    const panelWith = withPin.capabilities.find(
      (c) => c.interface === 'Alexa.SecurityPanelController',
    )
    // Alexa's Disarm directive can carry a PIN; its Arm directive cannot.
    // Declaring the type is what makes the app prompt for one on disarm.
    expect(panelWith?.configuration?.supportedAuthorizationTypes).toEqual([
      { type: 'FOUR_DIGIT_PIN' },
    ])
  })

  it('promises proactive reports — `StateChangeReporter` sends them (R3, D776)', () => {
    const endpoint = buildAlarmPanelEndpoint({
      deviceId: 1,
      stableId: 's',
      friendlyName: 'A',
      availableModes: [],
      requiresCode: false,
    })
    const panel = endpoint.capabilities.find((c) => c.interface === 'Alexa.SecurityPanelController')
    expect(panel?.properties?.proactivelyReported).toBe(true)
    expect(panel?.properties?.retrievable).toBe(true)
  })

  it('falls back to a device-derived name when the panel has none', () => {
    const endpoint = buildAlarmPanelEndpoint({
      deviceId: 42,
      stableId: 's',
      friendlyName: '',
      availableModes: [],
      requiresCode: false,
    })
    expect(endpoint.friendlyName).toBe('Alarm 42')
  })
})
