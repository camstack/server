import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { mapAlexaCapabilitiesToCamStack } from '../alexa-domain-mapping.js'
import { buildAlexaApplianceCandidate, mappableAppliance } from '../alexa-discovery.js'
import { settingsToAlexaConnection, connectionToCredentials } from '../config.js'
import {
  decodeEntityGroupNames,
  decodeSmarthomeDevices,
  decodeSmarthomeStates,
} from '../alexa-remote-decode.js'
import {
  decodeDetectionState,
  decodeHumidityPercent,
  decodeLockState,
  decodePercentage,
  decodePowerState,
  decodeTemperatureCelsius,
  mergeAlexaMotionStatus,
} from '../alexa-state-to-cap.js'
import { mapCommandToAlexaAction } from '../alexa-command-map.js'
import { StubAlexaClient } from '../alexa-client.js'
import type { AlexaCommand } from '../alexa-client.js'

describe('mapAlexaCapabilitiesToCamStack', () => {
  it('maps single Alexa interfaces to their caps + device type', () => {
    expect(mapAlexaCapabilitiesToCamStack(['Alexa.PowerController'])).toEqual({
      deviceType: DeviceType.Switch,
      capabilities: ['switch'],
    })
    expect(mapAlexaCapabilitiesToCamStack(['Alexa.LockController'])).toEqual({
      deviceType: DeviceType.Lock,
      capabilities: ['lock-control'],
    })
    expect(mapAlexaCapabilitiesToCamStack(['Alexa.ThermostatController'])).toEqual({
      deviceType: DeviceType.Thermostat,
      capabilities: ['climate-control'],
    })
    expect(mapAlexaCapabilitiesToCamStack(['Alexa.ContactSensor'])).toEqual({
      deviceType: DeviceType.Sensor,
      capabilities: ['contact'],
    })
  })

  it('unions a multi-interface colour bulb into several caps', () => {
    const mapping = mapAlexaCapabilitiesToCamStack([
      'Alexa.PowerController',
      'Alexa.BrightnessController',
      'Alexa.ColorController',
    ])
    expect(mapping.deviceType).toBe(DeviceType.Light)
    expect(mapping.capabilities).toEqual(['switch', 'brightness', 'color'])
  })

  it('dedupes Color + ColorTemperature to a single color cap', () => {
    const mapping = mapAlexaCapabilitiesToCamStack([
      'Alexa.ColorController',
      'Alexa.ColorTemperatureController',
    ])
    expect(mapping.capabilities).toEqual(['color'])
  })

  it('returns an empty mapping for unrecognised interfaces', () => {
    const mapping = mapAlexaCapabilitiesToCamStack(['Alexa.Speaker', 'Alexa.Unknown'])
    expect(mapping.capabilities).toEqual([])
    expect(mapping.deviceType).toBe(DeviceType.Generic)
  })

  it('is order-independent in cap output', () => {
    const a = mapAlexaCapabilitiesToCamStack(['Alexa.ColorController', 'Alexa.PowerController'])
    const b = mapAlexaCapabilitiesToCamStack(['Alexa.PowerController', 'Alexa.ColorController'])
    expect(a.capabilities).toEqual(b.capabilities)
  })
})

describe('mappableAppliance', () => {
  it('is true only when at least one interface maps', () => {
    expect(
      mappableAppliance({ applianceId: 'a1', name: 'Lamp', interfaces: ['Alexa.PowerController'] }),
    ).toBe(true)
    expect(
      mappableAppliance({ applianceId: 'a2', name: 'Echo', interfaces: ['Alexa.Speaker'] }),
    ).toBe(false)
  })
})

describe('buildAlexaApplianceCandidate', () => {
  it('builds a flat device candidate with the mapped caps', () => {
    const candidate = buildAlexaApplianceCandidate({
      appliance: {
        applianceId: 'a-bulb',
        name: 'Kitchen bulb',
        interfaces: ['Alexa.PowerController', 'Alexa.BrightnessController'],
        groupName: 'Kitchen',
        manufacturer: 'Acme',
      },
      adoptedDeviceId: null,
    })
    expect(candidate.type).toBe(DeviceType.Light)
    expect(candidate.childNativeId).toBe('a-bulb')
    expect(candidate.capabilities).toEqual(['switch', 'brightness'])
    expect(candidate.metadata.externalLocation).toBe('Kitchen')
    expect(candidate.metadata.manufacturer).toBe('Acme')
    expect(candidate.children).toBeUndefined()
  })

  it('reports adopted when an id is provided', () => {
    const candidate = buildAlexaApplianceCandidate({
      appliance: { applianceId: 'a2', name: 'Lock', interfaces: ['Alexa.LockController'] },
      adoptedDeviceId: 11,
    })
    expect(candidate.alreadyAdopted).toBe(true)
    expect(candidate.adoptedDeviceId).toBe(11)
  })
})

describe('settingsToAlexaConnection + connectionToCredentials', () => {
  it('applies defaults to an empty blob', () => {
    const cfg = settingsToAlexaConnection({})
    expect(cfg.amazonDomain).toBe('amazon.com')
    expect(cfg.pollIntervalMs).toBe(60_000)
  })
  it('omits absent secrets from the credential shape', () => {
    const creds = connectionToCredentials(settingsToAlexaConnection({ amazonDomain: 'amazon.de' }))
    expect(creds.amazonDomain).toBe('amazon.de')
    expect(creds.cookie).toBeUndefined()
    expect(creds.refreshToken).toBeUndefined()
  })
  it('carries a supplied cookie through to the credentials', () => {
    const creds = connectionToCredentials(
      settingsToAlexaConnection({ cookie: 'session=abc', refreshToken: 'rt' }),
    )
    expect(creds.cookie).toBe('session=abc')
    expect(creds.refreshToken).toBe('rt')
  })
})

// ── alexa-remote2 response-body decoders ─────────────────────────────────────

describe('decodeSmarthomeDevices', () => {
  // Shape mirrors getSmarthomeDevicesV2().items[] (flat endpoints w/ legacyAppliance).
  const body = [
    {
      id: 'endpoint-1',
      friendlyName: 'Endpoint One',
      legacyAppliance: {
        applianceId: 'appl-1',
        friendlyName: 'Kitchen Bulb',
        manufacturerName: 'Acme',
        capabilities: [
          { interfaceName: 'Alexa.PowerController' },
          { interfaceName: 'Alexa.BrightnessController' },
        ],
      },
    },
    {
      id: 'endpoint-2',
      legacyAppliance: {
        applianceId: 'appl-2',
        friendlyName: 'Front Lock',
        capabilities: ['Alexa.LockController'],
      },
    },
    // No applianceId / entityId → skipped.
    { id: 'endpoint-3', legacyAppliance: { friendlyName: 'Orphan' } },
    // No legacyAppliance → skipped.
    { id: 'endpoint-4' },
  ]

  it('decodes endpoints into appliances with interfaces + friendly names', () => {
    const appliances = decodeSmarthomeDevices(body)
    expect(appliances).toHaveLength(2)
    expect(appliances[0]).toMatchObject({
      applianceId: 'appl-1',
      name: 'Kitchen Bulb',
      manufacturer: 'Acme',
      interfaces: ['Alexa.PowerController', 'Alexa.BrightnessController'],
    })
    expect(appliances[1]).toMatchObject({
      applianceId: 'appl-2',
      name: 'Front Lock',
      interfaces: ['Alexa.LockController'],
    })
  })

  it('maps onto camstack caps end-to-end via the domain mapping', () => {
    const [bulb, lock] = decodeSmarthomeDevices(body)
    expect(mapAlexaCapabilitiesToCamStack(bulb!.interfaces)).toEqual({
      deviceType: DeviceType.Light,
      capabilities: ['switch', 'brightness'],
    })
    expect(mapAlexaCapabilitiesToCamStack(lock!.interfaces)).toEqual({
      deviceType: DeviceType.Lock,
      capabilities: ['lock-control'],
    })
  })

  it('attaches a group/room name from the entities map when ids line up', () => {
    const groups = new Map([['appl-1', 'Kitchen']])
    const [bulb] = decodeSmarthomeDevices(body, groups)
    expect(bulb!.groupName).toBe('Kitchen')
  })

  it('degrades to [] on a malformed body', () => {
    expect(decodeSmarthomeDevices(null)).toEqual([])
    expect(decodeSmarthomeDevices({ not: 'an array' })).toEqual([])
  })
})

describe('decodeEntityGroupNames', () => {
  it('maps GROUP-typed entity ids to their display names', () => {
    const map = decodeEntityGroupNames([
      { id: 'g1', displayName: 'Living Room', entityType: 'GROUP' },
      { id: 'a1', displayName: 'A Light', entityType: 'APPLIANCE' },
    ])
    expect(map.get('g1')).toBe('Living Room')
    expect(map.has('a1')).toBe(false)
  })

  it('degrades to an empty map on a malformed body', () => {
    expect(decodeEntityGroupNames('nope').size).toBe(0)
  })
})

describe('decodeSmarthomeStates', () => {
  // capabilityStates are JSON-encoded {namespace,name,value} strings.
  const body = {
    deviceStates: [
      {
        entity: { entityId: 'appl-1' },
        capabilityStates: [
          JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON' }),
          JSON.stringify({
            namespace: 'Alexa.BrightnessController',
            name: 'brightness',
            value: 73,
          }),
          'not-json', // dropped
        ],
      },
      { entity: {}, capabilityStates: ['{}'] }, // no entityId → dropped
    ],
  }

  it('flattens device capabilityStates into (appliance,interface,property,value)', () => {
    const values = decodeSmarthomeStates(body)
    expect(values).toEqual([
      {
        applianceId: 'appl-1',
        interfaceName: 'Alexa.PowerController',
        property: 'powerState',
        value: 'ON',
      },
      {
        applianceId: 'appl-1',
        interfaceName: 'Alexa.BrightnessController',
        property: 'brightness',
        value: 73,
      },
    ])
  })

  it('degrades to [] on a malformed body', () => {
    expect(decodeSmarthomeStates(undefined)).toEqual([])
    expect(decodeSmarthomeStates({ deviceStates: 'x' })).toEqual([])
  })
})

// ── Alexa property value → cap status field ──────────────────────────────────

describe('alexa-state-to-cap decoders', () => {
  it('decodes powerState', () => {
    expect(decodePowerState('ON')).toBe(true)
    expect(decodePowerState('OFF')).toBe(false)
    expect(decodePowerState('weird')).toBeNull()
  })

  it('decodes + clamps percentage', () => {
    expect(decodePercentage(50)).toBe(50)
    expect(decodePercentage('120')).toBe(100)
    expect(decodePercentage(-5)).toBe(0)
    expect(decodePercentage('nope')).toBeNull()
  })

  it('decodes lockState', () => {
    expect(decodeLockState('LOCKED')).toBe('locked')
    expect(decodeLockState('UNLOCKED')).toBe('unlocked')
    expect(decodeLockState('JAMMED')).toBeNull()
  })

  it('decodes detectionState', () => {
    expect(decodeDetectionState('DETECTED')).toBe(true)
    expect(decodeDetectionState('NOT_DETECTED')).toBe(false)
    expect(decodeDetectionState(null)).toBeNull()
  })

  it('stamps lastDetectedAt on a motion rise and keeps it across a fall', () => {
    const cold = { detected: false, lastDetectedAt: null, autoClearAfterMs: null }
    const rise = mergeAlexaMotionStatus(cold, true, 1_000)
    expect(rise).toEqual({ detected: true, lastDetectedAt: 1_000, autoClearAfterMs: null })
    const sustained = mergeAlexaMotionStatus(rise, true, 2_000)
    expect(sustained).toEqual({ detected: true, lastDetectedAt: 1_000, autoClearAfterMs: null })
    const fall = mergeAlexaMotionStatus(sustained, false, 3_000)
    expect(fall).toEqual({ detected: false, lastDetectedAt: 1_000, autoClearAfterMs: null })
    const nextRise = mergeAlexaMotionStatus(fall, true, 4_000)
    expect(nextRise).toEqual({ detected: true, lastDetectedAt: 4_000, autoClearAfterMs: null })
  })

  it('stamps lastDetectedAt when already detected but the stamp is missing', () => {
    const missing = { detected: true, lastDetectedAt: null, autoClearAfterMs: null }
    expect(mergeAlexaMotionStatus(missing, true, 9_000)).toEqual({
      detected: true,
      lastDetectedAt: 9_000,
      autoClearAfterMs: null,
    })
  })

  it('leaves the cached motion slice alone when live is unknown', () => {
    const cached = { detected: true, lastDetectedAt: 5_000, autoClearAfterMs: null }
    expect(mergeAlexaMotionStatus(cached, null, 6_000)).toBe(cached)
  })

  it('decodes temperature with scale conversion', () => {
    expect(decodeTemperatureCelsius(21)).toBe(21)
    expect(decodeTemperatureCelsius({ value: 20, scale: 'CELSIUS' })).toBe(20)
    expect(decodeTemperatureCelsius({ value: 212, scale: 'FAHRENHEIT' })).toBe(100)
    expect(decodeTemperatureCelsius('x')).toBeNull()
  })

  it('decodes humidity (bare + enveloped)', () => {
    expect(decodeHumidityPercent(40)).toBe(40)
    expect(decodeHumidityPercent({ value: 55 })).toBe(55)
    expect(decodeHumidityPercent('x')).toBeNull()
  })
})

// ── Outbound command → Alexa control parameters ──────────────────────────────

describe('mapCommandToAlexaAction', () => {
  function cmd(
    interfaceName: string,
    action: string,
    args?: Record<string, unknown>,
  ): AlexaCommand {
    return { applianceId: 'a1', interfaceName, action, ...(args !== undefined ? { args } : {}) }
  }

  it('maps power, lock and scene directives', () => {
    expect(mapCommandToAlexaAction(cmd('Alexa.PowerController', 'TurnOn'))).toEqual({
      action: 'turnOn',
    })
    expect(mapCommandToAlexaAction(cmd('Alexa.PowerController', 'TurnOff'))).toEqual({
      action: 'turnOff',
    })
    expect(mapCommandToAlexaAction(cmd('Alexa.LockController', 'Lock'))).toEqual({ action: 'lock' })
    expect(mapCommandToAlexaAction(cmd('Alexa.SceneController', 'Activate'))).toEqual({
      action: 'activate',
    })
  })

  it('maps + clamps brightness / percentage parameters', () => {
    expect(
      mapCommandToAlexaAction(
        cmd('Alexa.BrightnessController', 'SetBrightness', { brightness: 150 }),
      ),
    ).toEqual({ action: 'setBrightness', brightness: 100 })
    expect(
      mapCommandToAlexaAction(
        cmd('Alexa.PercentageController', 'SetPercentage', { percentage: 30 }),
      ),
    ).toEqual({ action: 'setPercentage', percentage: 30 })
  })

  it('returns null for unsupported pairs and missing color args', () => {
    expect(mapCommandToAlexaAction(cmd('Alexa.PowerController', 'Toggle'))).toBeNull()
    expect(mapCommandToAlexaAction(cmd('Alexa.ColorController', 'SetColor'))).toBeNull()
  })
})

// ── StubAlexaClient remains a usable test double ─────────────────────────────

describe('StubAlexaClient', () => {
  it('connects to an empty inventory and reports connected', async () => {
    const stub = new StubAlexaClient({
      brokerId: 'b1',
      credentials: { amazonDomain: 'amazon.com', cookie: 'x' },
    })
    await stub.connect()
    expect(stub.isConnected()).toBe(true)
    expect(await stub.listAppliances()).toEqual([])
    expect(await stub.pollStates(['a1'])).toEqual([])
    await stub.disconnect()
    expect(stub.isConnected()).toBe(false)
  })
})
