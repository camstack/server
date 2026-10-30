import { describe, expect, it } from 'vitest'
import {
  browseVeluxGateways,
  isVeluxGatewayName,
  mdnsPtrQuery,
  proposeVeluxGateways,
  VELUX_SETUP_INTEGRATION_KEY,
  veluxDiscoveryCandidates,
  veluxDiscoverySummary,
  veluxGatewaysFromDnsMessage,
} from '../velux-gateway-discovery.js'

const PTR = 12
const A = 1
const TXT = 16
const SRV = 33

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
  head.writeUInt16BE(0x8001, 2)
  head.writeUInt32BE(120, 4)
  head.writeUInt16BE(data.length, 8)
  return Buffer.concat([encodeName(name), head, data])
}

function srvData(target: string): Buffer {
  const head = Buffer.alloc(6)
  head.writeUInt16BE(0, 0)
  head.writeUInt16BE(0, 2)
  head.writeUInt16BE(80, 4)
  return Buffer.concat([head, encodeName(target)])
}

/** An mDNS response: answers in the answer section, the rest as additionals (as a responder sends them). */
function response(answers: readonly Buffer[], additionals: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(answers.length, 6)
  header.writeUInt16BE(additionals.length, 10)
  return Buffer.concat([header, ...answers, ...additionals])
}

const INSTANCE = 'VELUX_KLF_1A2B._http._tcp.local'

/** What a KLF-200 answers to a `_http._tcp.local` PTR query. */
function klfAnswer(ip: readonly number[]): Buffer {
  return response(
    [record('_http._tcp.local', PTR, encodeName(INSTANCE))],
    [
      record(INSTANCE, SRV, srvData('VELUX_KLF_1A2B.local')),
      record(INSTANCE, TXT, Buffer.from([0])),
      record('VELUX_KLF_1A2B.local', A, Buffer.from(ip)),
    ],
  )
}

describe('veluxGatewaysFromDnsMessage', () => {
  it('reads a KLF-200 answer: its address from the A record behind the SRV target', () => {
    expect(veluxGatewaysFromDnsMessage(klfAnswer([192, 168, 20, 65]))).toEqual([
      { host: '192.168.20.65', name: 'VELUX_KLF_1A2B', id: 'velux_klf_1a2b' },
    ])
  })

  it('drops other _http._tcp services on the network', () => {
    const packet = response(
      [
        record('_http._tcp.local', PTR, encodeName('Office Printer._http._tcp.local')),
        record('_http._tcp.local', PTR, encodeName('Bosch SHC._http._tcp.local')),
      ],
      [
        record('Office Printer._http._tcp.local', A, Buffer.from([10, 0, 0, 4])),
        record('Bosch SHC._http._tcp.local', A, Buffer.from([10, 0, 0, 5])),
      ],
    )
    expect(veluxGatewaysFromDnsMessage(packet)).toEqual([])
  })

  it('answers nothing for a truncated packet', () => {
    expect(veluxGatewaysFromDnsMessage(klfAnswer([10, 0, 0, 9]).subarray(0, 40))).toEqual([])
    expect(veluxGatewaysFromDnsMessage(Buffer.alloc(3))).toEqual([])
  })
})

describe('isVeluxGatewayName', () => {
  it('matches the VELUX_KLF instance prefix, in any case', () => {
    expect(isVeluxGatewayName('VELUX_KLF_1A2B._http._tcp.local')).toBe(true)
    expect(isVeluxGatewayName('velux_klf_ffff._http._tcp.local')).toBe(true)
    expect(isVeluxGatewayName('VELUX Window._http._tcp.local')).toBe(false)
  })
})

describe('browseVeluxGateways', () => {
  it('asks for _http._tcp and returns each gateway once', async () => {
    const queries: Buffer[] = []
    const packet = klfAnswer([10, 0, 0, 8])
    const hosts = await browseVeluxGateways(async (query) => {
      queries.push(query)
      return [packet, packet]
    })
    expect(hosts).toEqual([{ host: '10.0.0.8', name: 'VELUX_KLF_1A2B', id: 'velux_klf_1a2b' }])
    expect(queries[0]).toEqual(mdnsPtrQuery('_http._tcp.local'))
  })

  it('finds nothing, without throwing, when the exchange fails', async () => {
    expect(
      await browseVeluxGateways(async () => {
        throw new Error('socket closed')
      }),
    ).toEqual([])
  })
})

describe('proposals', () => {
  const found = [{ host: '10.0.0.8', name: 'VELUX_KLF_1A2B', id: 'velux_klf_1a2b' }]

  it('skips a gateway whose host or id an integration already stores', () => {
    expect(proposeVeluxGateways(found, ['10.0.0.8'])).toEqual([])
    expect(proposeVeluxGateways(found, ['velux_klf_1a2b.local'])).toEqual([])
    expect(proposeVeluxGateways(found, ['10.0.0.9'])).toEqual(found)
  })

  it('opens the integration form with the host pre-filled', () => {
    expect(veluxDiscoveryCandidates(found)).toEqual([
      {
        stableId: 'velux:velux_klf_1a2b',
        suggestedName: 'VELUX_KLF_1A2B',
        prefilledConfig: { host: '10.0.0.8', [VELUX_SETUP_INTEGRATION_KEY]: true },
      },
    ])
    expect(VELUX_SETUP_INTEGRATION_KEY).toBe('setupIntegration')
  })

  it('summarises what was found', () => {
    expect(veluxDiscoverySummary(0, 0)).toBe('No gateway found on the network.')
    expect(veluxDiscoverySummary(1, 0)).toBe('Gateway already added.')
    expect(veluxDiscoverySummary(2, 2)).toBe('Found 2 gateways.')
  })
})
