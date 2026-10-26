import { describe, expect, it } from 'vitest'
import {
  browseShcControllers,
  mdnsPtrQuery,
  proposeShcControllers,
  resolveShcPairingHost,
  SHC_SETUP_INTEGRATION_KEY,
  shcDiscoveryCandidates,
  shcDiscoverySummary,
  shcHostsFromDnsMessage,
} from '../shc-controller-discovery.js'

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter((part) => part.length > 0)
  return Buffer.concat([
    ...parts.map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])),
    Buffer.from([0]),
  ])
}

function record(name: string, type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2)
  head.writeUInt32BE(120, 4)
  head.writeUInt16BE(data.length, 8)
  return Buffer.concat([encodeName(name), head, data])
}

function message(answers: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(answers.length, 6)
  return Buffer.concat([header, ...answers])
}

describe('shcHostsFromDnsMessage', () => {
  it('keeps a Bosch SHC answer and drops other names', () => {
    const ptr = 12
    const a = 1
    const packet = message([
      record('_http._tcp.local', ptr, encodeName('Bosch SHC._http._tcp.local')),
      record('_http._tcp.local', ptr, encodeName('Other Printer._http._tcp.local')),
      record('Bosch SHC._http._tcp.local', a, Buffer.from([192, 168, 1, 20])),
      record('Other Printer._http._tcp.local', a, Buffer.from([192, 168, 1, 21])),
    ])
    expect(shcHostsFromDnsMessage(packet)).toEqual([
      { host: '192.168.1.20', name: 'Bosch SHC', id: '192.168.1.20' },
    ])
  })
})

describe('browseShcControllers', () => {
  it('returns the hosts from the exchanged packets', async () => {
    const packet = message([
      record('_http._tcp.local', 12, encodeName('Bosch SHC._http._tcp.local')),
      record('Bosch SHC._http._tcp.local', 1, Buffer.from([10, 0, 0, 8])),
    ])
    const hosts = await browseShcControllers(async () => [packet])
    expect(hosts).toEqual([{ host: '10.0.0.8', name: 'Bosch SHC', id: '10.0.0.8' }])
  })
})

function srvTarget(target: string, port = 8443): Buffer {
  const head = Buffer.alloc(6)
  head.writeUInt16BE(0, 0)
  head.writeUInt16BE(0, 2)
  head.writeUInt16BE(port, 4)
  return Buffer.concat([head, encodeName(target)])
}

describe('shcHostsFromDnsMessage proposal', () => {
  it('maps an mDNS answer to host, name and a stable id', () => {
    const packet = message([
      record('_http._tcp.local', 12, encodeName('Bosch SHC [lab]._http._tcp.local')),
      record('Bosch SHC [lab]._http._tcp.local', 33, srvTarget('shc0123.local')),
      record('shc0123.local', 1, Buffer.from([192, 0, 2, 20])),
    ])
    expect(shcHostsFromDnsMessage(packet)).toEqual([
      { host: '192.0.2.20', name: 'Bosch SHC [lab]', id: 'shc0123' },
    ])
  })

  it('asks for a unicast reply so the probe does not bind port 5353', () => {
    const query = mdnsPtrQuery('_http._tcp.local')
    expect(query.readUInt16BE(query.length - 2)).toBe(0x8001)
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
    expect(candidate?.prefilledConfig).toEqual({
      host: '192.0.2.20',
      [SHC_SETUP_INTEGRATION_KEY]: true,
    })
    expect(candidate?.prefilledConfig).not.toHaveProperty('port')
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
