import {
  DeviceType,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
} from '@camstack/types'
import { slugifyHost } from './config.js'

/** The gateway's `CMD_BROADCAST` probe: header, command 0x12, size 3, checksum. */
const SCAN_PACKET_HEX = 'ffff120315'
const SCAN_PORT = 46_000
const CMD_BROADCAST = 0x12
const MIN_REPLY_LENGTH = 18
const MAC_START = 5
const MAC_END = 11
const SSID_LENGTH_AT = 17
const SSID_START = 18

/** How the scan engine finds a gateway: one UDP broadcast, whose replies come back as hits. */
export const ECOWITT_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  { kind: 'udp-broadcast', port: SCAN_PORT, payloadHex: SCAN_PACKET_HEX },
]

export interface EcowittDiscoveredGateway {
  readonly ip: string
  readonly mac: string
  /** The module SSID (`GW1100A-WIFIC3F6`), or the MAC when it is blank. */
  readonly name: string
  readonly model?: string
}

function checksumHolds(buf: Buffer): boolean {
  let sum = 0
  for (let i = 2; i < buf.length - 1; i += 1) sum = (sum + (buf[i] ?? 0)) & 0xff
  return sum === buf[buf.length - 1]
}

/** Read one `CMD_BROADCAST` reply; null when it is not a gateway's answer. */
export function parseEcowittReply(payloadHex: string): {
  readonly mac: string
  readonly module: string
  readonly model?: string
} | null {
  const buf = Buffer.from(payloadHex, 'hex')
  if (buf.length < MIN_REPLY_LENGTH) return null
  if (buf[0] !== 0xff || buf[1] !== 0xff || buf[2] !== CMD_BROADCAST) return null
  if (!checksumHolds(buf)) return null
  const mac = [...buf.subarray(MAC_START, MAC_END)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':')
  const ssidEnd = Math.min(SSID_START + (buf[SSID_LENGTH_AT] ?? 0), buf.length - 1)
  const ssid = buf.subarray(SSID_START, ssidEnd).toString('ascii').trim()
  const module = ssid.includes(' ') ? ssid.slice(0, ssid.indexOf(' ')) : ssid
  const wifiAt = module.indexOf('-WIFI')
  return {
    mac,
    module,
    ...(wifiAt > 0 ? { model: module.slice(0, wifiAt) } : {}),
  }
}

/** Gateways among the engine's UDP replies, one per MAC. */
export function ecowittGatewaysFromHits(
  hits: readonly DiscoveryHit[],
): readonly EcowittDiscoveredGateway[] {
  const byMac = new Map<string, EcowittDiscoveredGateway>()
  for (const hit of hits) {
    if (hit.udp === undefined) continue
    const reply = parseEcowittReply(hit.udp.payloadHex)
    if (reply === null || byMac.has(reply.mac)) continue
    byMac.set(reply.mac, {
      ip: hit.host,
      mac: reply.mac,
      name: reply.module.length > 0 ? reply.module : reply.mac,
      ...(reply.model !== undefined ? { model: reply.model } : {}),
    })
  }
  return [...byMac.values()]
}

/** The gateway key a scan hit gets: what the migration of a Hub at that host kept as its key. */
export function ecowittScanKey(host: string): string {
  return `ecowitt:${slugifyHost(host)}`
}

/**
 * A gateway is offered as an INTEGRATION to set up (a {@link DeviceType.Gateway} candidate marked
 * `setupIntegration`), never as a device to add. `known` holds the keys of integrations that
 * already exist; their gateways are not offered again.
 */
export function ecowittCandidates(
  gateways: readonly EcowittDiscoveredGateway[],
  known: ReadonlySet<string> = new Set(),
): readonly DiscoveryCandidate[] {
  return gateways.flatMap((g): DiscoveryCandidate[] => {
    const stableId = ecowittScanKey(g.ip)
    if (known.has(stableId)) return []
    const displayName = g.model ?? g.name
    return [
      {
        stableId,
        type: DeviceType.Gateway,
        suggestedName: displayName,
        prefilledConfig: { transport: 'local', host: g.ip },
        setupIntegration: true,
      },
    ]
  })
}
