/**
 * "Test each endpoint" and the NAT mapping check — the orchestration around
 * the browser probes, with the row derivation kept pure so it is tested
 * without a browser.
 */
import {
  type GatherResult,
  gatherCandidates,
  type IceServerConfig,
  type RelayLoopbackResult,
  relayLoopback,
} from './endpoint-probe'
import {
  compareSrflxMappings,
  distinctStunDestinations,
  type NatMappingVerdict,
  type SrflxObservation,
} from './nat-mapping'
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text'

export type IceEndpointScheme = 'stun' | 'turn' | 'turns' | 'other'

export interface IceEndpoint extends IceServerConfig {
  /** Stable key: the URL is unique within the flattened list. */
  readonly id: string
  readonly scheme: IceEndpointScheme
  /** `?transport=` of the URL, lower-case; null when the URL names none. */
  readonly transport: string | null
  readonly hasCredentials: boolean
}

/** The shape `turnProvider.getTurnServers` answers. */
export interface IceServerEntry {
  readonly urls: string | readonly string[]
  readonly username?: string
  readonly credential?: string
}

export interface EndpointTestRow {
  readonly id: string
  readonly url: string
  readonly scheme: IceEndpointScheme
  readonly transport: string | null
  /** The public mapping a STUN answer gave this browser, `address:port`. */
  readonly srflx: string | null
  /** Whether a relay candidate was allocated. */
  readonly relay: boolean
  /** udp / tcp / tls to the TURN server — from the loopback's stats, else the candidate. */
  readonly relayProtocol: string | null
  /** The URL the browser attributed the srflx / relay candidate to (the ICE event `url`). */
  readonly eventUrl: string | null
  /** Relay loopback outcome; null for a STUN endpoint, which cannot relay. */
  readonly relayConnected: boolean | null
  readonly rttMs: number | null
  readonly timedOut: boolean
  readonly error: string | null
}

export interface NatCheckResult {
  readonly destinations: readonly string[]
  readonly verdict: NatMappingVerdict
  readonly error: string | null
}

/** Queried in addition to the configured STUN servers until two distinct destinations exist. */
export const FALLBACK_STUN_URLS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
]

export function schemeOf(url: string): IceEndpointScheme {
  const lower = url.toLowerCase()
  if (lower.startsWith('turns:')) return 'turns'
  if (lower.startsWith('turn:')) return 'turn'
  if (lower.startsWith('stun:') || lower.startsWith('stuns:')) return 'stun'
  return 'other'
}

export function transportOf(url: string): string | null {
  const m = /[?&]transport=([a-z]+)/i.exec(url)
  return m?.[1]?.toLowerCase() ?? null
}

/** One row per URL: an entry's `urls` may be a string or a list. */
export function flattenIceServers(servers: readonly IceServerEntry[]): readonly IceEndpoint[] {
  const out: IceEndpoint[] = []
  for (const s of servers) {
    const urls: readonly string[] = typeof s.urls === 'string' ? [s.urls] : s.urls
    for (const url of urls) {
      if (out.some((e) => e.id === url)) continue
      out.push({
        id: url,
        url,
        ...(s.username !== undefined ? { username: s.username } : {}),
        ...(s.credential !== undefined ? { credential: s.credential } : {}),
        scheme: schemeOf(url),
        transport: transportOf(url),
        hasCredentials: s.credential !== undefined,
      })
    }
  }
  return out
}

export function endpointRowFromProbe(
  endpoint: IceEndpoint,
  gather: GatherResult,
  loopback: RelayLoopbackResult | null,
): EndpointTestRow {
  const srflx = gather.candidates.find((c) => c.candidate.type === 'srflx')
  const relay = gather.candidates.find((c) => c.candidate.type === 'relay')
  const mapped =
    srflx !== undefined && srflx.candidate.address !== null && srflx.candidate.port !== null
      ? `${srflx.candidate.address}:${String(srflx.candidate.port)}`
      : null
  return {
    id: endpoint.id,
    url: endpoint.url,
    scheme: endpoint.scheme,
    transport: endpoint.transport,
    srflx: mapped,
    relay: relay !== undefined,
    relayProtocol: loopback?.relayProtocol ?? relay?.relayProtocol ?? null,
    eventUrl: relay?.url ?? srflx?.url ?? null,
    relayConnected: loopback?.connected ?? null,
    rttMs: loopback?.rttMs ?? null,
    timedOut: gather.timedOut,
    error: gather.error ?? loopback?.error ?? null,
  }
}

const GATHER_TIMEOUT_MS = 6000
const LOOPBACK_TIMEOUT_MS = 8000

function configOf(e: IceEndpoint): readonly IceServerConfig[] {
  return [
    {
      url: e.url,
      ...(e.username !== undefined ? { username: e.username } : {}),
      ...(e.credential !== undefined ? { credential: e.credential } : {}),
    },
  ]
}

/** Gather against ONE endpoint; for a TURN endpoint, also prove the relay forwards. */
export async function testEndpoint(endpoint: IceEndpoint): Promise<EndpointTestRow> {
  const cfg = configOf(endpoint)
  const gather = await gatherCandidates(cfg, 'all', GATHER_TIMEOUT_MS)
  const canRelay = endpoint.scheme === 'turn' || endpoint.scheme === 'turns'
  const loopback = canRelay ? await relayLoopback(cfg, LOOPBACK_TIMEOUT_MS) : null
  return endpointRowFromProbe(endpoint, gather, loopback)
}

/** The STUN destinations the NAT check queries: configured first, public fallbacks to reach two. */
export function natCheckDestinations(endpoints: readonly IceEndpoint[]): readonly string[] {
  const configured = distinctStunDestinations(endpoints.map((e) => e.url))
  const out = [...configured]
  for (const url of distinctStunDestinations(FALLBACK_STUN_URLS)) {
    if (out.length >= 2) break
    if (!out.includes(url)) out.push(url)
  }
  return out
}

export function srflxObservations(gather: GatherResult): readonly SrflxObservation[] {
  const out: SrflxObservation[] = []
  for (const c of gather.candidates) {
    const p = c.candidate
    if (p.type !== 'srflx' || p.address === null || p.port === null || p.protocol === null) continue
    out.push({
      address: p.address,
      port: p.port,
      protocol: p.protocol,
      relatedAddress: p.relatedAddress,
      relatedPort: p.relatedPort,
      url: c.url,
    })
  }
  return out
}

export async function runNatCheck(
  endpoints: readonly IceEndpoint[],
  t: UiTextFn = defaultUiText,
): Promise<NatCheckResult> {
  const destinations = natCheckDestinations(endpoints)
  const gather = await gatherCandidates(
    destinations.map((url) => ({ url })),
    'all',
    GATHER_TIMEOUT_MS,
  )
  return {
    destinations,
    verdict: compareSrflxMappings(srflxObservations(gather), destinations.length, t),
    error: gather.error,
  }
}
