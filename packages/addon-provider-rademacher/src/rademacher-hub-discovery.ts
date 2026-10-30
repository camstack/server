import type { HubIdentity } from '@apocaliss92/noderademacher'
import { probeHub } from '@apocaliss92/noderademacher'
import {
  DeviceType,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
} from '@camstack/types'
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

/**
 * The request the library's probe opens with: a POST on the password-salt
 * endpoint, which a HomePilot / Start2Smart hub answers 200 (protected) or 500
 * (open). The api base path is `''` on v1 and `/hp` on v2, so there are two modes.
 */
const SALT_PATH = '/authentication/password_salt'
const SALT_STATUSES: readonly number[] = [200, 500]

export const RADEMACHER_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  {
    kind: 'http-probe',
    port: 80,
    path: SALT_PATH,
    method: 'POST',
    tls: false,
    acceptStatus: [...SALT_STATUSES],
  },
  {
    kind: 'http-probe',
    port: 80,
    path: `/hp${SALT_PATH}`,
    method: 'POST',
    tls: false,
    acceptStatus: [...SALT_STATUSES],
  },
]

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

/** The library's identity probe for one host; the fetch seam is the library's own. */
export type RademacherProbe = (host: string) => Promise<Readonly<HubIdentity> | null>

type ProbeFetch = Parameters<typeof probeHub>[0]

const probeFetch: ProbeFetch = async (url, options) => {
  const res = await fetch(url, {
    method: options?.method ?? 'GET',
    ...(options?.body !== undefined ? { body: options.body } : {}),
    ...(options?.headers !== undefined ? { headers: { ...options.headers } } : {}),
    signal: AbortSignal.timeout(options?.timeoutMs ?? 1_500),
  })
  return {
    statusCode: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    json: () => res.json(),
    text: () => res.text(),
  }
}

export const probeRademacherHost: RademacherProbe = (host) => probeHub(probeFetch, host)

/**
 * Hubs among the engine's http-probe hits. A hit only says the salt endpoint
 * answered; the library's identity check (a unicast follow-up to that host)
 * decides whether it really is a hub and reads its name, model and MAC.
 */
export async function hubsFromHits(
  hits: readonly DiscoveryHit[],
  probe: RademacherProbe = probeRademacherHost,
): Promise<readonly RademacherDiscoveredHub[]> {
  const out: RademacherDiscoveredHub[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (hit.http === undefined || !SALT_STATUSES.includes(hit.http.status)) continue
    if (seen.has(hit.host)) continue
    seen.add(hit.host)
    const identity = await probe(hit.host).catch(() => null)
    if (identity !== null) out.push(hubFromIdentity(identity))
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

export function rademacherDiscoveryCandidates(
  proposals: readonly RademacherDiscoveredHub[],
): readonly DiscoveryCandidate[] {
  return proposals.map((found) => ({
    stableId: `rademacher:${found.id}`,
    type: DeviceType.Gateway,
    suggestedName: found.name,
    prefilledConfig: {
      host: found.host,
      ...(found.basePath.length > 0 ? { basePath: found.basePath } : {}),
    },
    setupIntegration: true,
  }))
}

export function rademacherDiscoverySummary(foundCount: number, proposedCount: number): string {
  if (proposedCount === 0 && foundCount > 0) return 'Hub already added.'
  if (proposedCount === 0) return 'No hub found on the network.'
  const noun = proposedCount === 1 ? 'hub' : 'hubs'
  return `Found ${proposedCount} ${noun}.`
}
