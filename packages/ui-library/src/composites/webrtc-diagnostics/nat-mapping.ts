/**
 * The cheap client-side NAT mapping check.
 *
 * One peer connection asks two STUN destinations (two servers, or one server
 * on two ports) for its server-reflexive address. Both requests leave from the
 * SAME local socket, so:
 *  - the same public `address:port` from both ⇒ the NAT reuses one mapping for
 *    every destination (endpoint-independent): a srflx candidate is usable by a
 *    peer, direct media can work;
 *  - a different public port per destination ⇒ endpoint-dependent mapping
 *    ("symmetric NAT"): the mapping the hub would need is never the one STUN
 *    saw, so only a TURN relay reaches this browser.
 *
 * Browsers drop a srflx candidate identical to one already gathered, so two
 * servers agreeing usually shows as ONE candidate. That is reported as
 * `likely`, never `confirmed`, because it cannot be told apart from the second
 * server simply not answering.
 */
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text'

export interface SrflxObservation {
  readonly address: string
  readonly port: number
  readonly protocol: string
  /** The local base (`raddr` / `rport`); `0.0.0.0` / `0` when the browser hides it. */
  readonly relatedAddress: string | null
  readonly relatedPort: number | null
  /** The STUN URL that produced it (`RTCPeerConnectionIceEvent.url`), when reported. */
  readonly url: string | null
}

export type NatMappingKind = 'endpoint-independent' | 'endpoint-dependent' | 'unknown'
export type NatMappingConfidence = 'confirmed' | 'likely' | 'none'

export interface NatMappingVerdict {
  readonly kind: NatMappingKind
  readonly confidence: NatMappingConfidence
  readonly reason: string
  /** Distinct public mappings seen per local base, e.g. `["203.0.113.7:61000"]`. */
  readonly mappings: readonly string[]
}

function isHiddenBase(o: SrflxObservation): boolean {
  return (
    o.relatedAddress === null ||
    o.relatedAddress === '0.0.0.0' ||
    o.relatedAddress === '::' ||
    o.relatedPort === null ||
    o.relatedPort === 0
  )
}

function baseKey(o: SrflxObservation): string {
  // A hidden base groups by public address: the comparison then assumes one
  // local socket per public IP, which fails only for a multi-homed host
  // behind the same NAT — rare, and named in the reason below.
  return isHiddenBase(o)
    ? `public:${o.address}`
    : `base:${o.relatedAddress ?? '?'}:${String(o.relatedPort ?? '?')}`
}

function unknown(reason: string, mappings: readonly string[] = []): NatMappingVerdict {
  return { kind: 'unknown', confidence: 'none', reason, mappings }
}

/**
 * The distinct STUN destinations (`stun:host:port`) among the given URLs —
 * the number the check needs to be at least two. TURN URLs are excluded:
 * this check is about plain STUN binding.
 */
export function distinctStunDestinations(urls: readonly string[]): readonly string[] {
  const out: string[] = []
  for (const url of urls) {
    const m = /^stuns?:([^?]+)/i.exec(url.trim())
    if (m === null) continue
    const dest = `stun:${(m[1] ?? '').toLowerCase()}`
    if (!out.includes(dest)) out.push(dest)
  }
  return out
}

export function compareSrflxMappings(
  observations: readonly SrflxObservation[],
  stunDestinationsQueried: number,
  t: UiTextFn = defaultUiText,
): NatMappingVerdict {
  const udp = observations.filter((o) => o.protocol.toLowerCase() === 'udp')
  if (stunDestinationsQueried < 2) {
    return unknown(
      t(
        'uiLibrary.natMapping.needTwo',
        'needs two STUN destinations to compare; only one was queried',
      ),
    )
  }
  if (udp.length === 0) {
    return unknown(
      t(
        'uiLibrary.natMapping.noSrflx',
        'no server-reflexive candidate: STUN unreachable or blocked from this browser',
      ),
    )
  }
  const groups = new Map<string, SrflxObservation[]>()
  for (const o of udp) {
    const key = baseKey(o)
    groups.set(key, [...(groups.get(key) ?? []), o])
  }
  const mappings = [...new Set(udp.map((o) => `${o.address}:${String(o.port)}`))]
  for (const group of groups.values()) {
    const distinct = new Set(group.map((o) => `${o.address}:${String(o.port)}`))
    if (distinct.size > 1) {
      return {
        kind: 'endpoint-dependent',
        confidence: 'confirmed',
        reason: t(
          'uiLibrary.natMapping.symmetric',
          'one local socket got {{count}} different public mappings — symmetric NAT: only a TURN relay reaches this browser',
          { count: distinct.size },
        ),
        mappings,
      }
    }
  }
  const confirmed = [...groups.values()].some(
    (group) => new Set(group.map((o) => o.url).filter((u) => u !== null)).size >= 2,
  )
  return {
    kind: 'endpoint-independent',
    confidence: confirmed ? 'confirmed' : 'likely',
    reason: confirmed
      ? t('uiLibrary.natMapping.confirmedSame', 'two STUN destinations saw the same public mapping')
      : t(
          'uiLibrary.natMapping.likelySame',
          'one public mapping across the STUN destinations (the browser drops an identical second candidate, so the second answer cannot be told from no answer)',
        ),
    mappings,
  }
}
