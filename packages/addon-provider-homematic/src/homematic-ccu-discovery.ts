import { networkInterfaces } from 'node:os'

/** One CCU found on the LAN. */
export interface HomematicDiscoveredCcu {
  readonly host: string
  readonly name: string
  /** Stable identity: the host slug (a CCU announces no serial before login). */
  readonly id: string
  /** Whether the WebUI asks for a login (names and rooms need credentials then). */
  readonly authEnabled: boolean
}

/** `prefilledConfig` flag: the scan opens the integration form instead of adopting a device. */
export const HOMEMATIC_SETUP_INTEGRATION_KEY = 'setupIntegration'

const JSON_RPC_PATH = '/api/homematic.cgi'
/** How long one host gets to answer before the sweep moves on. */
export const HOMEMATIC_DISCOVERY_TIMEOUT_MS = 1_200
export const HOMEMATIC_DISCOVERY_CONCURRENCY = 64
/** Upper bound on the hosts one scan probes, so a wide interface list cannot flood the LAN. */
const MAX_HOSTS = 1_024

/** A network interface address, narrowed to what the sweep needs (testable without `os`). */
export interface LanAddress {
  readonly family: string
  readonly address: string
  readonly internal: boolean
}

/** One bounded HTTP POST; resolves with whatever answered, rejects on silence or a refusal. */
export type DiscoveryPost = (
  url: string,
  body: string,
  timeoutMs: number,
) => Promise<{ readonly status: number; readonly text: string }>

const fetchPost: DiscoveryPost = async (url, body, timeoutMs) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: response.status, text: await response.text() }
}

function osAddresses(): readonly LanAddress[] {
  const out: LanAddress[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      out.push({ family: String(a.family), address: a.address, internal: a.internal })
    }
  }
  return out
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
    return denied ? { authEnabled: true } : null
  }
  const result: unknown = Reflect.get(parsed, 'result')
  if (result === true || result === 'true') return { authEnabled: true }
  if (result === false || result === 'false') return { authEnabled: false }
  return null
}

/**
 * The hosts to ask: every address of the /24 of each external IPv4 address of
 * this machine, minus the network and broadcast addresses and this machine itself.
 */
export function lanHostsToProbe(addresses: readonly LanAddress[]): readonly string[] {
  const own = new Set<string>()
  const subnets: string[] = []
  for (const a of addresses) {
    if (a.internal || (a.family !== 'IPv4' && a.family !== '4')) continue
    own.add(a.address)
    const prefix = a.address.split('.').slice(0, 3).join('.')
    if (prefix.split('.').length === 3 && !subnets.includes(prefix)) subnets.push(prefix)
  }
  const hosts: string[] = []
  for (const prefix of subnets) {
    for (let last = 1; last <= 254; last++) {
      const host = `${prefix}.${last}`
      if (!own.has(host)) hosts.push(host)
    }
  }
  return hosts.slice(0, MAX_HOSTS)
}

/** Slugify a host into a readable, stable id fragment. */
function slugifyHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface BrowseOptions {
  readonly addresses?: () => readonly LanAddress[]
  readonly post?: DiscoveryPost
  readonly concurrency?: number
  readonly timeoutMs?: number
}

/**
 * Sweep the local /24 networks for CCU3 / RaspberryMatic WebUIs: each host is
 * asked `CCU.getAuthEnabled` on the JSON-RPC endpoint, with a short timeout and
 * a bounded number of probes in flight.
 */
export async function browseHomematicCcus(
  options: BrowseOptions = {},
): Promise<readonly HomematicDiscoveredCcu[]> {
  const {
    addresses = osAddresses,
    post = fetchPost,
    concurrency = HOMEMATIC_DISCOVERY_CONCURRENCY,
    timeoutMs = HOMEMATIC_DISCOVERY_TIMEOUT_MS,
  } = options
  const hosts = lanHostsToProbe(addresses())
  const body = JSON.stringify({ method: 'CCU.getAuthEnabled', params: {}, jsonrpc: '1.1', id: 0 })
  const found: HomematicDiscoveredCcu[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const host = hosts[next++]
      if (host === undefined) return
      try {
        const reply = await post(`http://${host}${JSON_RPC_PATH}`, body, timeoutMs)
        const answer = parseAuthEnabledAnswer(reply.status, reply.text)
        if (answer !== null) {
          found.push({
            host,
            name: `Homematic CCU (${host})`,
            id: slugifyHost(host),
            authEnabled: answer.authEnabled,
          })
        }
      } catch {
        // A silent or refusing host is the normal case on a /24 sweep (252 of
        // 253 are); the caller logs how many hosts were asked and how many answered.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
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

export interface HomematicDiscoveryCandidateShape {
  readonly stableId: string
  readonly suggestedName: string
  readonly prefilledConfig: Readonly<Record<string, unknown>>
}

export function homematicDiscoveryCandidates(
  proposals: readonly HomematicDiscoveredCcu[],
): readonly HomematicDiscoveryCandidateShape[] {
  return proposals.map((found) => ({
    stableId: `homematic:${found.id}`,
    suggestedName: found.name,
    prefilledConfig: { host: found.host, [HOMEMATIC_SETUP_INTEGRATION_KEY]: true },
  }))
}

export function homematicDiscoverySummary(foundCount: number, proposedCount: number): string {
  if (proposedCount === 0 && foundCount > 0) return 'CCU already added.'
  if (proposedCount === 0) return 'No CCU found on the network.'
  return `Found ${proposedCount} ${proposedCount === 1 ? 'CCU' : 'CCUs'}.`
}
