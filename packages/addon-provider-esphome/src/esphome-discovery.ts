import {
  DeviceType,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
} from '@camstack/types'
import { ESPHOME_DEFAULT_PORT } from './config.js'

/** A board that announced itself on the LAN. Nothing is contacted beyond the mDNS question. */
export interface EspDiscoveredBoard {
  readonly host: string
  readonly port: number
  readonly name: string
  /** Stable identity: the board's mDNS hostname without `.local`, else the IP. */
  readonly id: string
}

export const ESPHOME_MDNS_SERVICE = '_esphomelib._tcp'

/** How the scan engine finds a board: one mDNS browse for the ESPHome native API service. */
export const ESPHOME_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  { kind: 'mdns', serviceType: ESPHOME_MDNS_SERVICE },
]

function stripLocal(host: string): string {
  const lower = host.trim().toLowerCase()
  return lower.endsWith('.local') ? lower.slice(0, -'.local'.length) : lower
}

/** Boards among the engine's mDNS hits, one per host. */
export function boardsFromHits(hits: readonly DiscoveryHit[]): readonly EspDiscoveredBoard[] {
  const out: EspDiscoveredBoard[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const mdns = hit.mdns
    if (mdns === undefined || hit.host.length === 0 || seen.has(hit.host)) continue
    seen.add(hit.host)
    const port = mdns.port > 0 ? mdns.port : hit.port > 0 ? hit.port : ESPHOME_DEFAULT_PORT
    out.push({
      host: hit.host,
      port,
      name: mdns.instance.split('._')[0] ?? mdns.instance,
      id: mdns.host.length > 0 ? stripLocal(mdns.host) : hit.host,
    })
  }
  return out
}

/** Boards whose host or identity is already configured are not proposed again. */
export function proposeBoards(
  found: readonly EspDiscoveredBoard[],
  existingHosts: readonly string[],
): readonly EspDiscoveredBoard[] {
  const known = new Set(
    existingHosts.map((host) => stripLocal(host)).filter((host) => host.length > 0),
  )
  return found.filter((board) => !known.has(stripLocal(board.host)) && !known.has(board.id))
}

/** Candidates for the boards in `hits` that no integration holds yet; each is pickable. */
export function boardCandidates(
  hits: readonly DiscoveryHit[],
  existingHosts: readonly string[],
): readonly DiscoveryCandidate[] {
  return proposeBoards(boardsFromHits(hits), existingHosts).map((board) => ({
    stableId: `esphome:${board.id}`,
    type: DeviceType.Hub,
    suggestedName: board.name,
    prefilledConfig: { host: board.host, port: board.port || ESPHOME_DEFAULT_PORT },
    selectable: true,
  }))
}
