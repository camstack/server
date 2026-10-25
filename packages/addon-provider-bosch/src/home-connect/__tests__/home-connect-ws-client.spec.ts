import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import { buildHomeConnectCandidates } from '../home-connect-discovery.js'

const HC_FEATURE_ENERGY_FORECAST = 'BSH.Common.Option.EnergyForecast'
const HC_FEATURE_OPERATION_STATE = 'BSH.Common.Status.OperationState'
const COMMAND = 'BSH.Common.Command.PauseProgram'
import { createScriptedHomeConnectWire } from '../home-connect-fake-wire.js'
import {
  createHomeConnectWsClient,
  createInMemoryHomeConnectClient,
} from '../home-connect-ws-client.js'

describe('createInMemoryHomeConnectClient', () => {
  it('setFeature posts WS-style commands when connected', async () => {
    const client = createInMemoryHomeConnectClient({
      appliances: [
        { haId: 'HAI-DW-1', name: 'Kitchen DW', type: 'Dishwasher', availablePrograms: [] },
      ],
    })
    await client.connect()
    await client.setFeature('HAI-DW-1', COMMAND, true)
    expect(client.getFeatures('HAI-DW-1').get(COMMAND)).toBe(true)
  })

  it('refuses setFeature before connect', async () => {
    const client = createInMemoryHomeConnectClient({ appliances: [] })
    await expect(client.setFeature('x', 'key', 1)).rejects.toThrow(/not connected/)
  })
})

describe('createHomeConnectWsClient TLS protocol', () => {
  it('maps mandatory uid values to BSH feature names after handshake', async () => {
    const deviceDescription = {
      info: { deviceID: 'HAI-DW-1', deviceType: 'Dishwasher', model: 'SMS' },
      program: [],
      entities: {
        '552': {
          uid: 552,
          name: HC_FEATURE_OPERATION_STATE,
          enumeration: { '1': 'Ready' },
        },
        '561': { uid: 561, name: HC_FEATURE_ENERGY_FORECAST },
      },
    }
    const client = createHomeConnectWsClient(
      {
        host: 'BOSCH-Dishwasher-HAI-DW-1',
        psk: 'dummy-psk',
        mode: 'TLS',
        deviceDescription,
      },
      {
        wireFactory: () =>
          createScriptedHomeConnectWire({
            mandatoryValues: [
              { uid: 552, value: 1 },
              { uid: 561, value: 69 },
            ],
          }),
      },
    )
    await client.connect()
    expect(client.getFeatures('HAI-DW-1').get(HC_FEATURE_OPERATION_STATE)).toBe('Ready')
    expect(client.getFeatures('HAI-DW-1').get(HC_FEATURE_ENERGY_FORECAST)).toBe(69)
  })
})

describe('createHomeConnectWsClient deviceDescription', () => {
  const baseConfig = {
    host: '192.168.0.10',
    psk: 'pairing-key',
    mode: 'AES' as const,
  }

  it('parses HA DeviceDescription (info + program[]) into one appliance', () => {
    const deviceDescription = JSON.stringify({
      info: {
        deviceID: 'HAI-DW-HA-1',
        deviceType: 'Dishwasher',
        model: 'SMS6ZCI45E',
        brand: 'BOSCH',
      },
      program: [
        { name: 'Eco50', uid: 'BSH.Common.Program.Eco50', available: true },
        { name: 'Intensive', uid: 'BSH.Common.Program.Intensive', available: true },
      ],
    })
    const client = createHomeConnectWsClient({ ...baseConfig, deviceDescription })
    expect(client.getAppliances()).toEqual([
      {
        haId: 'HAI-DW-HA-1',
        name: 'SMS6ZCI45E',
        type: 'Dishwasher',
        availablePrograms: ['Eco50', 'Intensive'],
      },
    ])
    const [candidate] = buildHomeConnectCandidates({
      appliances: client.getAppliances(),
      adopted: new Map(),
    })
    expect(candidate?.type).toBe(DeviceType.Container)
    expect(candidate?.children?.some((c) => c.type === DeviceType.Dishwasher)).toBe(true)
  })

  it('parses deviceDescription passed as object (integration settings json valueType)', () => {
    const client = createHomeConnectWsClient({
      ...baseConfig,
      deviceDescription: {
        info: {
          deviceID: 'HAI-DW-OBJ-1',
          deviceType: 'Dishwasher',
          model: 'SMS6ZCI45E',
        },
        program: [{ name: 'Eco50', uid: 'BSH.Common.Program.Eco50', available: true }],
      },
    })
    expect(client.getAppliances()).toHaveLength(1)
    expect(client.getAppliances()[0]?.haId).toBe('HAI-DW-OBJ-1')
  })

  it('fails soft when deviceDescription is corrupted [object Object] string', () => {
    const client = createHomeConnectWsClient({
      ...baseConfig,
      deviceDescription: '[object Object]',
    })
    expect(client.getAppliances()).toEqual([])
  })

  it('warns but does not throw when AES mode has entities (falls back to legacy client)', () => {
    const warned: string[] = []
    const deviceDescription = {
      info: { deviceID: 'HAI-DW-AES-1', deviceType: 'Dishwasher', model: 'SMS' },
      program: [],
      entities: {
        '552': { uid: 552, name: HC_FEATURE_OPERATION_STATE },
      },
    }
    const client = createHomeConnectWsClient(
      { ...baseConfig, mode: 'AES', deviceDescription },
      { onProtocolWarn: (code) => warned.push(code) },
    )
    expect(warned).toContain('aes-legacy-fallback-with-entities')
    expect(client.getAppliances()).toHaveLength(1)
    expect(client.getAppliances()[0]?.haId).toBe('HAI-DW-AES-1')
  })

  it('still parses legacy { appliances: [...] } shape', () => {
    const deviceDescription = JSON.stringify({
      appliances: [
        {
          haId: 'HAI-LEG-1',
          name: 'Kitchen DW',
          type: 'Dishwasher',
          programs: ['Quick45'],
        },
      ],
    })
    const client = createHomeConnectWsClient({ ...baseConfig, deviceDescription })
    expect(client.getAppliances()).toEqual([
      {
        haId: 'HAI-LEG-1',
        name: 'Kitchen DW',
        type: 'Dishwasher',
        availablePrograms: ['Quick45'],
      },
    ])
  })
})
