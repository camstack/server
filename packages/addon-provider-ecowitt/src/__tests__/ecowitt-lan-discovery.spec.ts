import { DeviceType, type DiscoveryHit } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  ECOWITT_DISCOVERY_MODES,
  ecowittCandidates,
  ecowittGatewaysFromHits,
  parseEcowittReply,
} from '../ecowitt-lan-discovery.js'

/** A gateway's CMD_BROADCAST reply: header, command, size, MAC, ip, port, SSID, checksum. */
function reply(mac: readonly number[], ssid: string, mutate?: (buf: Buffer) => void): string {
  const body = Buffer.concat([
    Buffer.from([0xff, 0xff, 0x12, 0x00, 0x00]),
    Buffer.from(mac),
    Buffer.from([192, 0, 2, 7]),
    Buffer.from([0xaf, 0xc8]),
    Buffer.from([ssid.length]),
    Buffer.from(ssid, 'ascii'),
    Buffer.from([0]),
  ])
  let sum = 0
  for (let i = 2; i < body.length - 1; i += 1) sum = (sum + (body[i] ?? 0)) & 0xff
  body[body.length - 1] = sum
  mutate?.(body)
  return body.toString('hex')
}

function udpHit(host: string, payloadHex: string): DiscoveryHit {
  return { modeIndex: 0, host, port: 46_000, udp: { payloadHex } }
}

const GW = reply([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01], 'GW1100A-WIFIC3F6 V2.4.5')

describe('Ecowitt LAN discovery', () => {
  it('declares the CMD_BROADCAST probe on UDP 46000', () => {
    expect(ECOWITT_DISCOVERY_MODES).toEqual([
      { kind: 'udp-broadcast', port: 46000, payloadHex: 'ffff120315' },
    ])
  })

  it('reads the MAC, module and model out of a reply', () => {
    expect(parseEcowittReply(GW)).toEqual({
      mac: 'de:ad:be:ef:00:01',
      module: 'GW1100A-WIFIC3F6',
      model: 'GW1100A',
    })
  })

  it('turns a reply into a candidate keyed on the responder address', () => {
    const gateways = ecowittGatewaysFromHits([udpHit('192.0.2.7', GW), udpHit('192.0.2.7', GW)])
    expect(gateways).toHaveLength(1)
    expect(ecowittCandidates(gateways)).toEqual([
      {
        stableId: 'ecowitt:192-0-2-7',
        type: DeviceType.Hub,
        suggestedName: 'GW1100A',
        prefilledConfig: { name: 'GW1100A', connection: { transport: 'local', host: '192.0.2.7' } },
      },
    ])
  })

  it('rejects a datagram that is not a gateway reply', () => {
    const badChecksum = reply([1, 2, 3, 4, 5, 6], 'GW1000-WIFI', (buf) => {
      buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0xff
    })
    expect(parseEcowittReply('ffff1203')).toBeNull()
    expect(parseEcowittReply(badChecksum)).toBeNull()
    expect(
      ecowittGatewaysFromHits([
        udpHit('192.0.2.9', badChecksum),
        udpHit('192.0.2.10', '00'.repeat(24)),
        { modeIndex: 0, host: '192.0.2.11', port: 46_000 },
      ]),
    ).toEqual([])
  })
})
