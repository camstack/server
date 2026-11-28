import { DeviceType, type DiscoveryHit } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  isUnifiConsoleReply,
  parseUbntReply,
  UNIFI_DISCOVERY_MODES,
  unifiConsoleCandidates,
  unifiConsolesFromHits,
} from '../unifi-lan-discovery.js'

/** One TLV record: type, 16-bit big-endian length, value. */
function tlv(type: number, value: Buffer | string): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const head = Buffer.alloc(3)
  head.writeUInt8(type, 0)
  head.writeUInt16BE(body.length, 1)
  return Buffer.concat([head, body])
}

/** A full reply: version, command 0, 16-bit big-endian length, then the records. */
function reply(version: number, ...records: Buffer[]): string {
  const body = Buffer.concat(records)
  const head = Buffer.alloc(4)
  head.writeUInt8(version, 0)
  head.writeUInt8(0, 1)
  head.writeUInt16BE(body.length, 2)
  return Buffer.concat([head, body]).toString('hex')
}

const mac = (last: number): Buffer => Buffer.from([0x02, 0x00, 0x5e, 0x10, 0x00, last])
const macIp = (last: number, ip: readonly number[]): Buffer =>
  Buffer.concat([mac(last), Buffer.from(ip)])

/** The console's device reply: MAC, several MAC+IP records, firmware, hostname, model. */
const CONSOLE_DEVICE_REPLY = reply(
  1,
  tlv(0x01, mac(1)),
  tlv(0x02, macIp(1, [192, 0, 2, 1])),
  tlv(0x02, macIp(1, [198, 51, 100, 1])),
  tlv(0x03, 'UDMPRO.al324.v4.3.6.example'),
  tlv(0x0b, 'console-example'),
  tlv(0x0c, 'UDMPRO'),
  tlv(0x14, 'UDM-Pro'),
)

/** The console's second reply: version 0, the controller announcement. */
const CONSOLE_CONTROLLER_REPLY = reply(
  0,
  tlv(0x20, 'uum_controller'),
  tlv(0x21, 'tls://192.0.2.1:12812'),
  tlv(0x22, 'v4.3.25+example'),
)

/** An access point: MAC, MAC+IP and a firmware string, no console model. */
const AP_REPLY = reply(
  1,
  tlv(0x01, mac(52)),
  tlv(0x02, macIp(52, [192, 0, 2, 52])),
  tlv(0x03, 'UFP-UAP-B.Maple.v1.1.0.4.example'),
)

const hit = (host: string, payloadHex: string): DiscoveryHit => ({
  modeIndex: 0,
  host,
  port: 10_001,
  udp: { payloadHex },
})

describe('UNIFI_DISCOVERY_MODES', () => {
  it('broadcasts the Ubiquiti v1 probe to port 10001', () => {
    expect(UNIFI_DISCOVERY_MODES).toEqual([
      { kind: 'udp-broadcast', port: 10_001, payloadHex: '01000000' },
    ])
  })
})

describe('parseUbntReply', () => {
  it('decodes the TLV records of a console reply', () => {
    expect(parseUbntReply(CONSOLE_DEVICE_REPLY)).toEqual({
      version: 1,
      macs: ['02:00:5e:10:00:01'],
      ips: ['192.0.2.1', '198.51.100.1'],
      firmware: 'UDMPRO.al324.v4.3.6.example',
      hostname: 'console-example',
      product: 'UDMPRO',
      model: 'UDM-Pro',
      controller: false,
    })
  })

  it('reads the controller announcement of a version-0 reply', () => {
    expect(parseUbntReply(CONSOLE_CONTROLLER_REPLY)?.controller).toBe(true)
  })

  it('refuses a reply whose length does not match, a truncated record, or the bare probe', () => {
    expect(parseUbntReply(CONSOLE_DEVICE_REPLY.slice(0, -2))).toBeNull()
    expect(parseUbntReply('0100000301ff00')).toBeNull()
    expect(parseUbntReply('01000000')).toBeNull()
    expect(parseUbntReply('ffff120315')).toBeNull()
  })
})

describe('isUnifiConsoleReply', () => {
  it('knows a console by its model, its platform or the controller announcement', () => {
    const parsed = (hex: string) => {
      const r = parseUbntReply(hex)
      if (r === null) throw new Error('fixture does not parse')
      return r
    }
    expect(isUnifiConsoleReply(parsed(CONSOLE_DEVICE_REPLY))).toBe(true)
    expect(isUnifiConsoleReply(parsed(CONSOLE_CONTROLLER_REPLY))).toBe(true)
    expect(isUnifiConsoleReply(parsed(reply(1, tlv(0x15, 'UCG-Ultra'))))).toBe(true)
    expect(isUnifiConsoleReply(parsed(reply(1, tlv(0x0c, 'UX'))))).toBe(true)
    expect(isUnifiConsoleReply(parsed(AP_REPLY))).toBe(false)
    expect(isUnifiConsoleReply(parsed(reply(1, tlv(0x0c, 'UXGPRO'))))).toBe(false)
  })
})

describe('unifiConsolesFromHits', () => {
  it('proposes the console once from its two replies and drops the access point', () => {
    const scan = unifiConsolesFromHits([
      hit('192.0.2.1', CONSOLE_DEVICE_REPLY),
      hit('192.0.2.1', CONSOLE_CONTROLLER_REPLY),
      hit('192.0.2.52', AP_REPLY),
      hit('192.0.2.99', 'ffff120315'),
    ])
    expect(scan.consoles).toEqual([
      { host: '192.0.2.1', name: 'console-example', model: 'UDM-Pro' },
    ])
    expect(scan.dropped).toEqual([
      {
        host: '192.0.2.52',
        reason: 'not-a-console',
        detail: 'UFP-UAP-B.Maple.v1.1.0.4.example',
      },
      { host: '192.0.2.99', reason: 'not-ubiquiti' },
    ])
  })

  it('proposes a console that sent only its controller announcement, named by its address', () => {
    expect(unifiConsolesFromHits([hit('192.0.2.7', CONSOLE_CONTROLLER_REPLY)]).consoles).toEqual([
      { host: '192.0.2.7', name: '192.0.2.7' },
    ])
  })
})

describe('unifiConsoleCandidates', () => {
  const consoles = [
    { host: '192.0.2.1', name: 'console-example', model: 'UDM-Pro' },
    { host: '192.0.2.2', name: '192.0.2.2' },
  ]

  it('offers a console as an integration to set up, host prefilled, no credential', () => {
    expect(unifiConsoleCandidates(consoles, []).candidates).toEqual([
      {
        stableId: 'unifi-console:192.0.2.1',
        type: DeviceType.Workload,
        suggestedName: 'UniFi - console-example',
        prefilledConfig: { host: '192.0.2.1' },
        setupIntegration: true,
      },
      {
        stableId: 'unifi-console:192.0.2.2',
        type: DeviceType.Workload,
        suggestedName: 'UniFi - 192.0.2.2',
        prefilledConfig: { host: '192.0.2.2' },
        setupIntegration: true,
      },
    ])
  })

  it('leaves out a console an integration already dials, and says so', () => {
    const result = unifiConsoleCandidates(consoles, [' 192.0.2.1 '])
    expect(result.candidates.map((c) => c.stableId)).toEqual(['unifi-console:192.0.2.2'])
    expect(result.dropped).toEqual([{ host: '192.0.2.1', reason: 'already-added' }])
  })
})
