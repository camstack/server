import {
  DeviceType,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
} from '@camstack/types'

export interface ShcDiscoveredHost {
  readonly host: string
  readonly name: string
  /** Stable identity (SRV hostname without `.local`, else a serial, else the IP). */
  readonly id: string
}

/** The controller announces itself as an `_http._tcp` service named `Bosch SHC`. */
export const SHC_MDNS_SERVICE = '_http._tcp'
export const SHC_CONTROLLER_NAME_PREFIX = 'Bosch SHC'

/** How the scan engine finds a controller: one mDNS browse, filtered on the instance name. */
export const SHC_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  {
    kind: 'mdns',
    serviceType: SHC_MDNS_SERVICE,
    instancePattern: `^${SHC_CONTROLLER_NAME_PREFIX}`,
  },
]

export function isShcControllerName(name: string): boolean {
  const instance = name.split('._')[0] ?? name
  return instance.toLowerCase().startsWith(SHC_CONTROLLER_NAME_PREFIX.toLowerCase())
}

/** Identity used to recognise a controller already stored on an integration. */
export function shcControllerId(input: {
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

/** Controllers among the engine's mDNS hits (a `Bosch SHC…` instance), one per host. */
export function shcHostsFromHits(hits: readonly DiscoveryHit[]): readonly ShcDiscoveredHost[] {
  const out: ShcDiscoveredHost[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const mdns = hit.mdns
    if (mdns === undefined || !isShcControllerName(mdns.instance)) continue
    if (hit.host.length === 0 || seen.has(hit.host)) continue
    seen.add(hit.host)
    const name = mdns.instance.split('._')[0] ?? mdns.instance
    out.push({
      host: hit.host,
      name,
      id: shcControllerId({ name, host: hit.host, serviceHost: mdns.host }),
    })
  }
  return out
}

function identityKeys(found: ShcDiscoveredHost): readonly string[] {
  const host = found.host.trim().toLowerCase()
  const id = found.id.trim().toLowerCase()
  const keys = [host, id]
  if (id.length > 0 && !id.endsWith('.local')) keys.push(`${id}.local`)
  return keys
}

/** Controllers whose host or id is already stored on an integration are not proposed again. */
export function proposeShcControllers(
  found: readonly ShcDiscoveredHost[],
  existingHosts: readonly string[],
): readonly ShcDiscoveredHost[] {
  const known = new Set(
    existingHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0),
  )
  return found.filter((item) => !identityKeys(item).some((key) => known.has(key)))
}

export function shcDiscoveryCandidates(
  proposals: readonly ShcDiscoveredHost[],
): readonly DiscoveryCandidate[] {
  return proposals.map((found) => ({
    stableId: `bosch-shc:${found.id}`,
    type: DeviceType.Gateway,
    suggestedName: found.name,
    prefilledConfig: { host: found.host },
    setupIntegration: true,
  }))
}

export function shcDiscoverySummary(foundCount: number, proposedCount: number): string {
  if (proposedCount === 0 && foundCount > 0) return 'Controller already added.'
  if (proposedCount === 0) return 'No controller found on the network.'
  const noun = proposedCount === 1 ? 'controller' : 'controllers'
  return `Found ${proposedCount} ${noun}.`
}

/** Manual host wins. Otherwise the address discovery filled in. */
export function resolveShcPairingHost(input: {
  readonly host?: string
  readonly hostManual?: string
}): string {
  const manual = input.hostManual?.trim() ?? ''
  if (manual.length > 0) return manual
  const host = input.host?.trim() ?? ''
  if (host.length > 0) return host
  throw new Error('Enter the controller host or IP address.')
}
