import { DeviceType, type DiscoveryHit } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  isVeluxGatewayName,
  proposeVeluxGateways,
  VELUX_DISCOVERY_MODES,
  veluxDiscoveryCandidates,
  veluxDiscoverySummary,
  veluxGatewaysFromHits,
} from '../velux-gateway-discovery.js'

function mdnsHit(instance: string, host: string, serviceHost: string): DiscoveryHit {
  return {
    modeIndex: 0,
    host,
    port: 80,
    mdns: { instance, host: serviceHost, port: 80, txt: {} },
  }
}

const KLF = mdnsHit('VELUX_KLF_1A2B._http._tcp.local', '192.0.2.8', 'VELUX_KLF_1A2B.local')

describe('declared modes', () => {
  it('browses _http._tcp and filters on the KLF instance name', () => {
    expect(VELUX_DISCOVERY_MODES).toEqual([
      {
        kind: 'mdns',
        serviceType: '_http._tcp',
        instancePattern: '^VELUX_KLF',
      },
    ])
  })
})

describe('veluxGatewaysFromHits', () => {
  it('turns a KLF-200 mDNS hit into a gateway keyed on its SRV host', () => {
    expect(veluxGatewaysFromHits([KLF])).toEqual([
      { host: '192.0.2.8', name: 'VELUX_KLF_1A2B', id: 'velux_klf_1a2b' },
    ])
  })

  it('drops other _http._tcp services and a hit without an mDNS record', () => {
    expect(
      veluxGatewaysFromHits([
        mdnsHit('Office Printer._http._tcp.local', '192.0.2.4', 'printer.local'),
        { modeIndex: 0, host: '192.0.2.5', port: 80 },
      ]),
    ).toEqual([])
  })

  it('lists each host once', () => {
    expect(veluxGatewaysFromHits([KLF, KLF])).toHaveLength(1)
  })
})

describe('isVeluxGatewayName', () => {
  it('matches the VELUX_KLF instance prefix, in any case', () => {
    expect(isVeluxGatewayName('VELUX_KLF_1A2B._http._tcp.local')).toBe(true)
    expect(isVeluxGatewayName('velux_klf_ffff._http._tcp.local')).toBe(true)
    expect(isVeluxGatewayName('VELUX Window._http._tcp.local')).toBe(false)
  })
})

describe('proposals', () => {
  const found = [{ host: '192.0.2.8', name: 'VELUX_KLF_1A2B', id: 'velux_klf_1a2b' }]

  it('skips a gateway whose host or id an integration already stores', () => {
    expect(proposeVeluxGateways(found, ['192.0.2.8'])).toEqual([])
    expect(proposeVeluxGateways(found, ['velux_klf_1a2b.local'])).toEqual([])
    expect(proposeVeluxGateways(found, ['192.0.2.9'])).toEqual(found)
  })

  it('offers an integration to set up with the host pre-filled', () => {
    expect(veluxDiscoveryCandidates(found)).toEqual([
      {
        stableId: 'velux:velux_klf_1a2b',
        type: DeviceType.Gateway,
        suggestedName: 'VELUX_KLF_1A2B',
        prefilledConfig: { host: '192.0.2.8' },
        setupIntegration: true,
      },
    ])
  })

  it('summarises the outcome', () => {
    expect(veluxDiscoverySummary(0, 0)).toBe('No gateway found on the network.')
    expect(veluxDiscoverySummary(1, 0)).toBe('Gateway already added.')
    expect(veluxDiscoverySummary(2, 2)).toBe('Found 2 gateways.')
  })
})
