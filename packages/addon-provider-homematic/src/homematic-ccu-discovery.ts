import {
  DeviceType,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
} from '@camstack/types'

/** One CCU found on the LAN. */
export interface HomematicDiscoveredCcu {
  readonly host: string
  readonly name: string
  /** Stable identity: the host slug (a CCU announces no serial before login). */
  readonly id: string
  /** Whether the WebUI asks for a login (names and rooms need credentials then). */
  readonly authEnabled: boolean
}

const JSON_RPC_PATH = '/api/homematic.cgi'

/** The question the WebUI asks before it shows a login; the engine sends it to every host once. */
export const HOMEMATIC_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  {
    kind: 'http-probe',
    port: 80,
    path: JSON_RPC_PATH,
    method: 'POST',
    bodyText: JSON.stringify({ method: 'CCU.getAuthEnabled', params: {}, jsonrpc: '1.1', id: 0 }),
    contentType: 'application/json',
    tls: false,
    acceptStatus: [200],
  },
]

/** A JSON-RPC reply: it echoes `version` or `id`, and carries a `result` and an `error` member. */
function isJsonRpcEnvelope(parsed: object): boolean {
  const echoes = Reflect.has(parsed, 'version') || Reflect.has(parsed, 'id')
  return echoes && Reflect.has(parsed, 'result') && Reflect.has(parsed, 'error')
}

/**
 * Read the answer of `CCU.getAuthEnabled`, the question the WebUI asks before
 * it shows a login. A CCU answers a boolean; one that already requires a login
 * answers "access denied", which proves it just as well. Anything else is not a CCU.
 */
export function parseAuthEnabledAnswer(
  status: number,
  text: string,
): { readonly authEnabled: boolean } | null {
  if (status !== 200) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const error: unknown = Reflect.get(parsed, 'error')
  if (error !== null && error !== undefined && error !== false) {
    if (typeof error !== 'object') return null
    const message = Reflect.get(error, 'message')
    const code = Reflect.get(error, 'code')
    const denied =
      (typeof message === 'string' && message.toLowerCase().startsWith('access denied')) ||
      code === 401 ||
      code === -32001
    // A CCU that wants a session answers the unauthenticated probe with an
    // error of its own ("can't read args(_session_id_)", code 200). Any
    // well-formed JSON-RPC envelope from this endpoint proves a CCU, and one
    // that errors without a session is one that asks for a login.
    return denied || isJsonRpcEnvelope(parsed) ? { authEnabled: true } : null
  }
  const result: unknown = Reflect.get(parsed, 'result')
  if (result === true || result === 'true') return { authEnabled: true }
  if (result === false || result === 'false') return { authEnabled: false }
  return null
}

/** Slugify a host into a readable, stable id fragment. */
function slugifyHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** CCUs among the engine's http-probe hits: the hosts whose answer is the JSON-RPC one. */
export function ccusFromHits(hits: readonly DiscoveryHit[]): readonly HomematicDiscoveredCcu[] {
  const found: HomematicDiscoveredCcu[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (hit.http === undefined || seen.has(hit.host)) continue
    const answer = parseAuthEnabledAnswer(hit.http.status, hit.http.bodyText)
    if (answer === null) continue
    seen.add(hit.host)
    found.push({
      host: hit.host,
      name: `Homematic CCU (${hit.host})`,
      id: slugifyHost(hit.host),
      authEnabled: answer.authEnabled,
    })
  }
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }))
}

/** CCUs whose host is already stored on an integration are not proposed again. */
export function proposeHomematicCcus(
  found: readonly HomematicDiscoveredCcu[],
  existingHosts: readonly string[],
): readonly HomematicDiscoveredCcu[] {
  const known = new Set(
    existingHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0),
  )
  return found.filter((item) => !known.has(item.host.trim().toLowerCase()))
}

export function homematicDiscoveryCandidates(
  proposals: readonly HomematicDiscoveredCcu[],
): readonly DiscoveryCandidate[] {
  return proposals.map((found) => ({
    stableId: `homematic:${found.id}`,
    type: DeviceType.Gateway,
    suggestedName: found.name,
    prefilledConfig: { host: found.host },
    setupIntegration: true,
  }))
}

export function homematicDiscoverySummary(foundCount: number, proposedCount: number): string {
  if (proposedCount === 0 && foundCount > 0) return 'CCU already added.'
  if (proposedCount === 0) return 'No CCU found on the network.'
  return `Found ${proposedCount} ${proposedCount === 1 ? 'CCU' : 'CCUs'}.`
}
