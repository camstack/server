import {
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
  DeviceType,
} from '@camstack/types'

export interface VeluxDiscoveredGateway {
  readonly host: string
  readonly name: string
  /** Stable identity (SRV hostname without `.local`, else a serial, else the IP). */
  readonly id: string
}

/** The KLF-200 announces itself as an `_http._tcp` service named `VELUX_KLF_<id>`. */
export const VELUX_MDNS_SERVICE = '_http._tcp'
export const VELUX_GATEWAY_NAME_PREFIX = 'VELUX_KLF'

/** How the scan engine finds a KLF-200: one mDNS browse, filtered on the instance name. */
export const VELUX_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  {
    kind: 'mdns',
    serviceType: VELUX_MDNS_SERVICE,
    instancePattern: `^${VELUX_GATEWAY_NAME_PREFIX}`,
  },
]

export function isVeluxGatewayName(name: string): boolean {
  const instance = name.split('._')[0] ?? name
  return instance.toLowerCase().startsWith(VELUX_GATEWAY_NAME_PREFIX.toLowerCase())
}

/** Identity used to recognise a gateway already stored on an integration. */
export function veluxGatewayId(input: {
  readonly name: string
  readonly host: string
  readonly serviceHost?: string
}): string {
  const service = input.serviceHost?.trim().toLowerCase() ?? ''
  if (service.length > 0) {
    return service.endsWith('.local') ? service.slice(0, -'.local'.length) : service
  }
  const serial = /\[([^\]]+)\]/.exec(input.name)?.[1]?.trim().toLowerCase() ?? ''
  if (serial.length > 0) return serial
  return input.host
}

/** Gateways among the engine's mDNS hits (a `VELUX_KLF…` instance), one per host. */
export function veluxGatewaysFromHits(
  hits: readonly DiscoveryHit[],
): readonly VeluxDiscoveredGateway[] {
  const out: VeluxDiscoveredGateway[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const mdns = hit.mdns
    if (mdns === undefined || !isVeluxGatewayName(mdns.instance)) continue
    if (hit.host.length === 0 || seen.has(hit.host)) continue
    seen.add(hit.host)
    const name = mdns.instance.split('._')[0] ?? mdns.instance
    out.push({
      host: hit.host,
      name,
      id: veluxGatewayId({ name, host: hit.host, serviceHost: mdns.host }),
    })
  }
  return out
}

function identityKeys(found: VeluxDiscoveredGateway): readonly string[] {
  const host = found.host.trim().toLowerCase()
  const id = found.id.trim().toLowerCase()
  const keys = [host, id]
  if (id.length > 0 && !id.endsWith('.local')) keys.push(`${id}.local`)
  return keys
}

/** Gateways whose host or id is already stored on an integration are not proposed again. */
export function proposeVeluxGateways(
  found: readonly VeluxDiscoveredGateway[],
  existingHosts: readonly string[],
): readonly VeluxDiscoveredGateway[] {
  const known = new Set(
    existingHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0),
  )
  return found.filter((item) => !identityKeys(item).some((key) => known.has(key)))
}

export function veluxDiscoveryCandidates(
  proposals: readonly VeluxDiscoveredGateway[],
): readonly DiscoveryCandidate[] {
  return proposals.map((found) => ({
    stableId: `velux:${found.id}`,
    type: DeviceType.Gateway,
    suggestedName: found.name,
    prefilledConfig: { host: found.host },
    setupIntegration: true,
  }))
}

export function veluxDiscoverySummary(foundCount: number, proposedCount: number): string {
  if (proposedCount === 0 && foundCount > 0) return 'Gateway already added.'
  if (proposedCount === 0) return 'No gateway found on the network.'
  const noun = proposedCount === 1 ? 'gateway' : 'gateways'
  return `Found ${proposedCount} ${noun}.`
}
