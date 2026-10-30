import type { HubIdentity } from '@apocaliss92/noderademacher'
import { Rademacher } from '@apocaliss92/noderademacher'
import { slugifyHost } from './rademacher-slug.js'

/** One hub found on the LAN. */
export interface RademacherDiscoveredHub {
  readonly host: string
  readonly name: string
  /** Stable identity: the MAC when the hub reported one, else the host slug. */
  readonly id: string
  readonly model: string
  /** The api base path the hub answered on (`''` or `/hp`). */
  readonly basePath: string
}

/** `prefilledConfig` flag: the scan opens the integration form instead of adopting a device. */
export const RADEMACHER_SETUP_INTEGRATION_KEY = 'setupIntegration'

/** Project the library's probe result onto the shape the form and the candidates share. */
export function hubFromIdentity(identity: Readonly<HubIdentity>): RademacherDiscoveredHub {
  const uid = identity.uid?.trim().toLowerCase() ?? ''
  const name = identity.name.trim().length > 0 ? identity.name.trim() : identity.model
  return {
    host: identity.host,
    name,
    id: uid.length > 0 ? uid : slugifyHost(identity.host),
    model: identity.model,
    basePath: identity.basePath,
  }
}

/** Sweep the local /24 networks for HomePilot / Start2Smart hubs (the library's HTTP probe). */
export async function browseRademacherHubs(
  discover: () => Promise<readonly HubIdentity[]> = () => Rademacher.discover(),
): Promise<readonly RademacherDiscoveredHub[]> {
  const seen = new Set<string>()
  const out: RademacherDiscoveredHub[] = []
  for (const identity of await discover()) {
    if (seen.has(identity.host)) continue
    seen.add(identity.host)
    out.push(hubFromIdentity(identity))
  }
  return out
}

function identityKeys(found: RademacherDiscoveredHub): readonly string[] {
  return [found.host.trim().toLowerCase(), found.id.trim().toLowerCase()]
}

/** Hubs whose host is already stored on an integration are not proposed again. */
export function proposeRademacherHubs(
  found: readonly RademacherDiscoveredHub[],
  existingHosts: readonly string[],
): readonly RademacherDiscoveredHub[] {
  const known = new Set(
    existingHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0),
  )
  return found.filter((item) => !identityKeys(item).some((key) => known.has(key)))
}

export interface RademacherDiscoveryCandidateShape {
  readonly stableId: string
  readonly suggestedName: string
  readonly prefilledConfig: Readonly<Record<string, unknown>>
}

export function rademacherDiscoveryCandidates(
  proposals: readonly RademacherDiscoveredHub[],
): readonly RademacherDiscoveryCandidateShape[] {
  return proposals.map((found) => ({
    stableId: `rademacher:${found.id}`,
    suggestedName: found.name,
    prefilledConfig: {
      host: found.host,
      ...(found.basePath.length > 0 ? { basePath: found.basePath } : {}),
      [RADEMACHER_SETUP_INTEGRATION_KEY]: true,
    },
  }))
}

export function rademacherDiscoverySummary(foundCount: number, proposedCount: number): string {
  if (proposedCount === 0 && foundCount > 0) return 'Hub already added.'
  if (proposedCount === 0) return 'No hub found on the network.'
  const noun = proposedCount === 1 ? 'hub' : 'hubs'
  return `Found ${proposedCount} ${noun}.`
}
