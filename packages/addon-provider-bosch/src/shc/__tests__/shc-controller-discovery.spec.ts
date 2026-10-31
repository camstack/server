import { DeviceType, type DiscoveryHit } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  proposeShcControllers,
  resolveShcPairingHost,
  SHC_DISCOVERY_MODES,
  shcDiscoveryCandidates,
  shcDiscoverySummary,
  shcHostsFromHits,
} from '../shc-controller-discovery.js'

function mdnsHit(instance: string, host: string, serviceHost: string): DiscoveryHit {
  return {
    modeIndex: 0,
    host,
    port: 8446,
    mdns: { instance, host: serviceHost, port: 8446, txt: {} },
  }
}

describe('declared modes', () => {
  it('browses _http._tcp and filters on the controller instance name', () => {
    expect(SHC_DISCOVERY_MODES).toEqual([
      {
        kind: 'mdns',
        serviceType: '_http._tcp',
        instancePattern: '^Bosch SHC',
      },
    ])
  })
})

describe('shcHostsFromHits', () => {
  it('keeps a Bosch SHC hit, keyed on its SRV host, and drops other names', () => {
    expect(
      shcHostsFromHits([
        mdnsHit('Bosch SHC [lab]._http._tcp.local', '192.0.2.20', 'shc0123.local'),
        mdnsHit('Office Printer._http._tcp.local', '192.0.2.4', 'printer.local'),
        { modeIndex: 0, host: '192.0.2.5', port: 80 },
      ]),
    ).toEqual([{ host: '192.0.2.20', name: 'Bosch SHC [lab]', id: 'shc0123' }])
  })

  it('falls back to the address when no SRV host is known', () => {
    expect(shcHostsFromHits([mdnsHit('Bosch SHC', '192.0.2.21', '')])).toEqual([
      { host: '192.0.2.21', name: 'Bosch SHC', id: '192.0.2.21' },
    ])
  })
})

describe('proposeShcControllers', () => {
  const found = [
    { host: '192.0.2.20', name: 'Bosch SHC [lab]', id: 'shc0123' },
    { host: '192.0.2.21', name: 'Bosch SHC [other]', id: 'shc9999' },
  ] as const

  it('drops a controller whose host or id is already an integration', () => {
    expect(proposeShcControllers(found, ['shc0123.local'])).toEqual([found[1]])
    expect(proposeShcControllers(found, ['192.0.2.21'])).toEqual([found[0]])
    expect(proposeShcControllers(found, ['192.0.2.20', 'SHC9999.local'])).toEqual([])
  })

  it('keeps a controller that is not already added', () => {
    expect(proposeShcControllers(found, ['192.0.2.50'])).toEqual(found)
  })
})

describe('shcDiscoveryCandidates', () => {
  it('prefills the host and marks the proposal as an integration form', () => {
    const [candidate] = shcDiscoveryCandidates([
      { host: '192.0.2.20', name: 'Bosch SHC [lab]', id: 'shc0123' },
    ])
    expect(candidate?.stableId).toBe('bosch-shc:shc0123')
    expect(candidate?.suggestedName).toBe('Bosch SHC [lab]')
    expect(candidate?.prefilledConfig).toEqual({ host: '192.0.2.20' })
    expect(candidate?.setupIntegration).toBe(true)
    expect(candidate?.type).toBe(DeviceType.Gateway)
  })
})

describe('shcDiscoverySummary', () => {
  it('says when every found controller is already added', () => {
    expect(shcDiscoverySummary(0, 0)).toBe('No controller found on the network.')
    expect(shcDiscoverySummary(1, 0)).toBe('Controller already added.')
    expect(shcDiscoverySummary(2, 1)).toBe('Found 1 controller.')
  })
})

describe('resolveShcPairingHost', () => {
  it('prefers the typed host, then the discovered host', () => {
    expect(resolveShcPairingHost({ host: '10.0.0.8', hostManual: '192.0.2.20' })).toBe('192.0.2.20')
    expect(resolveShcPairingHost({ host: '10.0.0.8' })).toBe('10.0.0.8')
    expect(() => resolveShcPairingHost({})).toThrow(/host or IP address/)
  })
})
