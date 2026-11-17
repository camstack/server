import {
  DeviceType,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
} from '@camstack/types'

/**
 * LAN discovery of an Unraid server: its GraphQL endpoint answers the introspection question
 * `{__typename}` without credentials (`{"data":{"__typename":"Query"}}`). The scan engine sends it
 * to every host on port 80, and on 443 over TLS for a server that serves only https; this module
 * reads the answers. The API key is still asked when the integration is set up.
 */
const GRAPHQL_PATH = '/graphql'
const PLAIN_PORT = 80
const TLS_PORT = 443
const PROBE_BODY = JSON.stringify({ query: '{__typename}' })

function graphqlProbe(port: number, tls: boolean): DiscoveryMode {
  return {
    kind: 'http-probe',
    port,
    path: GRAPHQL_PATH,
    method: 'POST',
    bodyText: PROBE_BODY,
    contentType: 'application/json',
    tls,
    acceptStatus: [200],
  }
}

/** The question the engine asks every host: plain on 80, TLS on 443. */
export const UNRAID_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  graphqlProbe(PLAIN_PORT, false),
  graphqlProbe(TLS_PORT, true),
]

/** Whether a body is the GraphQL answer `{"data":{"__typename":"Query"}}`. */
export function isUnraidGraphqlAnswer(status: number, text: string): boolean {
  if (status !== 200) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const data: unknown = Reflect.get(parsed, 'data')
  if (typeof data !== 'object' || data === null) return false
  return Reflect.get(data, '__typename') === 'Query'
}

/** One Unraid server found on the LAN, with the way it answered. */
export interface UnraidDiscoveredServer {
  readonly host: string
  readonly port: number
  readonly https: boolean
}

/** A hit, or a server, the classification left out — and why (D391). */
export interface UnraidDroppedHit {
  readonly host: string
  readonly port: number
  readonly reason: 'not-graphql' | 'already-added'
}

export interface UnraidServerScan {
  readonly servers: readonly UnraidDiscoveredServer[]
  readonly dropped: readonly UnraidDroppedHit[]
}

/**
 * Servers among the engine's http-probe hits, one per host. A server answering on both ports is
 * proposed on plain http (80), the way the server answered without a certificate to accept.
 */
export function unraidServersFromHits(hits: readonly DiscoveryHit[]): UnraidServerScan {
  const byHost = new Map<string, UnraidDiscoveredServer>()
  const dropped: UnraidDroppedHit[] = []
  for (const hit of hits) {
    if (hit.http === undefined) continue
    if (!isUnraidGraphqlAnswer(hit.http.status, hit.http.bodyText)) {
      dropped.push({ host: hit.host, port: hit.port, reason: 'not-graphql' })
      continue
    }
    const server = {
      host: hit.host,
      port: hit.port,
      https: hit.port !== PLAIN_PORT,
    }
    const seen = byHost.get(hit.host)
    if (seen === undefined || (seen.https && !server.https)) byHost.set(hit.host, server)
  }
  const servers = [...byHost.values()].toSorted((a, b) =>
    a.host.localeCompare(b.host, undefined, { numeric: true }),
  )
  return { servers, dropped }
}

/** The key a scanned server gets, by the host it answered from. */
export function unraidScanKey(host: string): string {
  return `unraid-server:${host.trim().toLowerCase()}`
}

export interface UnraidServerProposal {
  readonly candidates: readonly DiscoveryCandidate[]
  readonly dropped: readonly UnraidDroppedHit[]
}

/**
 * A server is offered as an INTEGRATION to set up (a {@link DeviceType.Gateway} candidate marked
 * `setupIntegration`), named after its host, with host, port and scheme prefilled. A server whose
 * host an integration already dials is left out and reported as dropped.
 */
export function unraidServerCandidates(
  servers: readonly UnraidDiscoveredServer[],
  existingHosts: readonly string[],
): UnraidServerProposal {
  const known = new Set(
    existingHosts.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0),
  )
  const candidates: DiscoveryCandidate[] = []
  const dropped: UnraidDroppedHit[] = []
  for (const server of servers) {
    if (known.has(server.host.trim().toLowerCase())) {
      dropped.push({
        host: server.host,
        port: server.port,
        reason: 'already-added',
      })
      continue
    }
    candidates.push({
      stableId: unraidScanKey(server.host),
      type: DeviceType.Gateway,
      suggestedName: `Unraid - ${server.host}`,
      prefilledConfig: {
        host: server.host,
        port: server.port,
        https: server.https,
      },
      setupIntegration: true,
    })
  }
  return { candidates, dropped }
}
