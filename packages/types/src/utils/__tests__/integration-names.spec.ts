import { describe, expect, it } from 'vitest'
import {
  defaultIntegrationName,
  gatewayDeviceName,
  mqttBrokerIntegrationName,
  prefilledIntegrationName,
} from '../integration-names.js'

describe('defaultIntegrationName', () => {
  it('prefills "<provider> - Home"', () => {
    expect(defaultIntegrationName('Reolink')).toBe('Reolink - Home')
    expect(defaultIntegrationName('Bosch SHC')).toBe('Bosch SHC - Home')
    expect(defaultIntegrationName('Bosch HomeCom')).toBe('Bosch HomeCom - Home')
    expect(defaultIntegrationName('Bosch Home Connect')).toBe('Bosch Home Connect - Home')
    expect(defaultIntegrationName('Home Assistant')).toBe('Home Assistant - Home')
    expect(defaultIntegrationName('Alexa')).toBe('Alexa - Home')
    expect(defaultIntegrationName('Matter')).toBe('Matter - Home')
    expect(defaultIntegrationName('  Velux  ')).toBe('Velux - Home')
  })
})

describe('prefilledIntegrationName', () => {
  it('names an MQTT broker after the product on it', () => {
    expect(mqttBrokerIntegrationName('Zigbee2MQTT')).toBe('MQTT - Zigbee2MQTT')
    expect(
      prefilledIntegrationName({
        providerLabel: 'MQTT',
        mode: 'broker',
        brokerKind: 'Zigbee2MQTT',
      }),
    ).toBe('MQTT - Zigbee2MQTT')
  })

  it('keeps Home Assistant, Alexa and Matter on the Home suffix', () => {
    expect(
      prefilledIntegrationName({
        providerLabel: 'Home Assistant',
        mode: 'broker',
        brokerKind: 'home-assistant',
      }),
    ).toBe('Home Assistant - Home')
    expect(
      prefilledIntegrationName({ providerLabel: 'Alexa', mode: 'broker', brokerKind: 'alexa' }),
    ).toBe('Alexa - Home')
    expect(
      prefilledIntegrationName({ providerLabel: 'Matter', mode: 'broker', brokerKind: 'matter' }),
    ).toBe('Matter - Home')
  })
})

describe('gatewayDeviceName', () => {
  it('joins brand and model, and compacts a letter-digit hyphen', () => {
    expect(gatewayDeviceName('Velux', 'KLF-200')).toBe('Velux KLF200')
    expect(gatewayDeviceName('Velux', 'KLF200')).toBe('Velux KLF200')
    expect(gatewayDeviceName('Velux KLF-200')).toBe('Velux KLF200')
    expect(gatewayDeviceName('Bosch', 'SHC')).toBe('Bosch SHC')
    expect(gatewayDeviceName('Bosch HomeCom', 'k40')).toBe('Bosch HomeCom k40')
    expect(gatewayDeviceName('Reolink', 'Home Hub')).toBe('Reolink Home Hub')
    expect(gatewayDeviceName('Reolink', 'Reolink Home Hub')).toBe('Reolink Home Hub')
    expect(gatewayDeviceName('Ecowitt', 'GW1100')).toBe('Ecowitt GW1100')
    expect(gatewayDeviceName('Homematic', 'CCU3')).toBe('Homematic CCU3')
    expect(gatewayDeviceName('Rademacher', 'HomePilot')).toBe('Rademacher HomePilot')
    expect(gatewayDeviceName('UniFi', 'UDM-SE')).toBe('UniFi UDM-SE')
    expect(gatewayDeviceName('Unraid', 'tower')).toBe('Unraid tower')
    expect(gatewayDeviceName('Enpal', 'Box')).toBe('Enpal Box')
  })

  it('uses the brand alone when the model is unknown', () => {
    expect(gatewayDeviceName('VeSync')).toBe('VeSync')
    expect(gatewayDeviceName('UniFi', '  ')).toBe('UniFi')
    expect(gatewayDeviceName('Ecowitt', null)).toBe('Ecowitt')
  })
})
