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
export function parseEcowittReply(
  payloadHex: string,
): { readonly mac: string; readonly module: string; readonly model?: string } | null {
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
  return { mac, module, ...(wifiAt > 0 ? { model: module.slice(0, wifiAt) } : {}) }
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

export function ecowittCandidates(
  gateways: readonly EcowittDiscoveredGateway[],
): readonly DiscoveryCandidate[] {
  return gateways.map((g) => {
    const displayName = g.model ?? g.name
    return {
      // Match generateStableId (local transport → `ecowitt:<slug(host)>`) so a re-scan of an
      // already-added gateway is detected as adopted and re-adding reuses its persisted row.
      stableId: `ecowitt:${slugifyHost(g.ip)}`,
      type: DeviceType.Hub,
      suggestedName: displayName,
      prefilledConfig: {
        name: displayName,
        connection: { transport: 'local', host: g.ip },
      },
    }
  })
}
