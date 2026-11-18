/**
 * D1059 for an Ecowitt gateway: the MAC the LAN scan read out of the gateway's
 * `CMD_BROADCAST` reply is carried through adoption into the integration's
 * connection, and the Gateway device declares it with the host it dials. A
 * gateway set up by hand (no scan) has no MAC: `mac` is unread, so a value stored
 * earlier is kept and never replaced by "absent" (D49, D393).
 */
import {
  type DeviceIdentifiers,
  DeviceType,
  type DiscoveryHit,
  mergeIdentifiers,
  normaliseIdentifiers,
  type SetIdentifiersInput,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsToEcowittConfig } from '../config.js'
import { ecowittGatewayIdentifiers } from '../ecowitt-identifiers.js'
import { ecowittCandidates, ecowittGatewaysFromHits } from '../ecowitt-lan-discovery.js'

/** A `CMD_BROADCAST` reply carrying a MAC from the documentation block (RFC 7042). */
function reply(mac: readonly number[], ssid: string): string {
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
  return body.toString('hex')
}

const DOC_MAC = [0x00, 0x00, 0x5e, 0x00, 0x53, 0x2a] as const
const HIT: DiscoveryHit = {
  modeIndex: 0,
  host: '192.0.2.7',
  port: 46_000,
  udp: { payloadHex: reply(DOC_MAC, 'GW2000A-WIFI532A V3.1.5') },
}

describe('Ecowitt gateway identifiers (D1059)', () => {
  it('the scan candidate carries the MAC the reply announced into the integration form', () => {
    const [candidate] = ecowittCandidates(ecowittGatewaysFromHits([HIT]))
    expect(candidate).toMatchObject({
      type: DeviceType.Gateway,
      prefilledConfig: {
        transport: 'local',
        host: '192.0.2.7',
        model: 'GW2000A',
        mac: '00:00:5e:00:53:2a',
      },
    })
  })

  it('a scanned gateway declares its MAC and the address it dials', () => {
    const [candidate] = ecowittCandidates(ecowittGatewaysFromHits([HIT]))
    const connection = settingsToEcowittConfig(candidate?.prefilledConfig)
    const declaration = ecowittGatewayIdentifiers(connection)
    expect(declaration).toEqual({
      identifiers: { mac: '00:00:5e:00:53:2a', host: '192.0.2.7' },
      unread: [],
    })
    const { identifiers, rejected } = normaliseIdentifiers(declaration?.identifiers ?? {}, {
      readAt: 1,
    })
    expect(rejected).toEqual([])
    expect(identifiers.mac?.[0]?.value).toBe('00:00:5e:00:53:2a')
    expect(identifiers.ip?.value).toBe('192.0.2.7')
  })

  it('normalises a MAC stored in another spelling', () => {
    const connection = settingsToEcowittConfig({
      transport: 'local',
      host: 'weather.example',
      mac: '00-00-5E-00-53-2A',
    })
    const declaration = ecowittGatewayIdentifiers(connection)
    const { identifiers } = normaliseIdentifiers(declaration?.identifiers ?? {}, { readAt: 1 })
    expect(identifiers.mac?.[0]?.value).toBe('00:00:5e:00:53:2a')
    expect(identifiers.hostname?.value).toBe('weather')
  })

  it('a gateway set up by hand leaves the MAC unread: the stored one is kept, never blanked', () => {
    const declaration = ecowittGatewayIdentifiers(
      settingsToEcowittConfig({ transport: 'local', host: '192.0.2.7' }),
    )
    expect(declaration).toEqual({ identifiers: { mac: null, host: '192.0.2.7' }, unread: ['mac'] })

    const stored: DeviceIdentifiers = normaliseIdentifiers(
      { mac: '00:00:5e:00:53:2a', ip: '192.0.2.7' },
      { readAt: 1 },
    ).identifiers
    const input: SetIdentifiersInput = {
      deviceId: 7,
      identifiers: normaliseIdentifiers(declaration?.identifiers ?? {}, { readAt: 2 }).identifiers,
      unread: declaration?.unread ?? [],
    }
    const merged = mergeIdentifiers(stored, input.identifiers, input.unread ?? [])
    expect(merged?.mac?.[0]?.value).toBe('00:00:5e:00:53:2a')
  })

  it('a push-listener gateway, or no running connection, declares nothing', () => {
    expect(ecowittGatewayIdentifiers(settingsToEcowittConfig({ transport: 'listener' }))).toBeNull()
    expect(ecowittGatewayIdentifiers(null)).toBeNull()
  })
})
