/**
 * "Connect a phone" — which hub origin a phone should be handed, and the
 * central link that hands it over.
 *
 * The link is `https://camstack.zentik.app/connect?hub=<origin>`: the domain
 * the viewer app already claims as a Universal Link / App Link
 * (docs/design/2026-08-19-central-link-redirect.md §2.1), carrying ONLY the
 * hub origin. No token, no credentials — the app signs in afterwards with the
 * usual login. §3.3 of that design states what the central page accepts as a
 * `hub=` seed: an origin only, no credentials, no path, no query, no fragment.
 * `toHubOrigin` enforces exactly that here, so the hub never mints a link the
 * page would have to reject.
 *
 * The candidates come from `localNetwork.getConnectionEndpoints` — the hub's
 * own palette, never re-derived from `window.location` (the page origin is a
 * relay's under the Home Assistant mount, D373). Order for a PHONE differs
 * from the SDK race order: a phone is carried off the LAN, so the address
 * that keeps working away from home goes first — the public tunnel, then the
 * mesh (Tailscale MagicDNS), then the LAN.
 *
 * Which candidate is pre-selected is the hub's `publicEndpoint` role (D734,
 * `local-network.getAddresses().roles.publicEndpoint`): the address the
 * operator chose for everything that must work away from home, which is what
 * a phone is. The ranking above only orders the rest of the list.
 */
import type { ConnectionEndpoint } from '@camstack/types'
import { CAMSTACK_APP_LINK_ORIGIN, toAppLinkHubOrigin } from '@camstack/types'

/** The central link domain + intent path the viewer app claims. */
export const CENTRAL_CONNECT_URL = `${CAMSTACK_APP_LINK_ORIGIN}/connect`

/** Coarse reachability class of a candidate, best-for-a-phone first. */
export type PhoneCandidateTier = 'public' | 'mesh' | 'lan' | 'lan-ipv6'

export interface PhoneCandidate {
  /** Normalised origin (`scheme://host[:port]`) the link carries. */
  readonly origin: string
  /** The hub's own label for the endpoint (e.g. "Public tunnel"). */
  readonly label: string
  readonly tier: PhoneCandidateTier
  /** `false` when the origin is plain `http:` — see {@link isSecureOrigin}. */
  readonly secure: boolean
  /** Mirrors the endpoint's `plausible` flag (VPN/docker/link-local = false). */
  readonly plausible: boolean
}

const TIER_RANK: Readonly<Record<PhoneCandidateTier, number>> = {
  public: 0,
  mesh: 1,
  lan: 2,
  'lan-ipv6': 3,
}

/**
 * Classify an endpoint for a phone, or `null` when it is no phone route.
 * The mesh entry is `kind: 'public'` with `interfaceKind: 'vpn'` — that is how
 * `buildEndpoints` (system/local-network) tells it apart from the tunnel.
 */
export function classifyPhoneTier(endpoint: ConnectionEndpoint): PhoneCandidateTier | null {
  switch (endpoint.kind) {
    case 'public':
      return endpoint.interfaceKind === 'vpn' ? 'mesh' : 'public'
    case 'lan-ipv4':
      return 'lan'
    case 'lan-ipv6':
      return 'lan-ipv6'
    // An operator-entered address flagged for the viewer: it is meant for
    // clients, and it is usually the one that works away from home.
    case 'custom':
      return 'public'
    case 'loopback':
    case 'app-link':
      return null
  }
}

/**
 * Reduce a base URL to the bare origin the central page accepts, or `null`
 * when it cannot be one: not http(s), carries credentials, or does not parse.
 * A path/query/fragment on the base is dropped — `<base>` is an origin by
 * contract (§3.3), and the viewer is mounted under it by the central page.
 */
export function toHubOrigin(baseUrl: string): string | null {
  return toAppLinkHubOrigin(baseUrl)
}

export function isSecureOrigin(origin: string): boolean {
  return origin.startsWith('https://')
}

/**
 * Phone candidates from the hub's endpoint palette: loopback and unparseable
 * entries dropped, duplicates (same origin) collapsed to the first, ordered
 * public tunnel → mesh → LAN IPv4 → LAN IPv6. Within a tier a plausible
 * endpoint precedes an implausible one, then the hub's own `priority`.
 */
export function rankPhoneCandidates(
  endpoints: readonly ConnectionEndpoint[],
): readonly PhoneCandidate[] {
  const ranked = endpoints
    .flatMap((endpoint) => {
      const tier = classifyPhoneTier(endpoint)
      const origin = toHubOrigin(endpoint.baseUrl)
      if (tier === null || origin === null) return []
      return [{ endpoint, tier, origin }]
    })
    .toSorted(
      (a, b) =>
        TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
        Number(b.endpoint.plausible) - Number(a.endpoint.plausible) ||
        a.endpoint.priority - b.endpoint.priority,
    )

  const seen = new Set<string>()
  return ranked.flatMap(({ endpoint, tier, origin }) => {
    if (seen.has(origin)) return []
    seen.add(origin)
    return [
      {
        origin,
        label: endpoint.label,
        tier,
        secure: isSecureOrigin(origin),
        plausible: endpoint.plausible,
      },
    ]
  })
}

/**
 * The candidate in force: the operator's pick in this card when it is still in
 * the list, else the hub's public endpoint (`preferredOrigin`) when it is in
 * the list, else the best-ranked one. A pick that vanished (tunnel went down,
 * interface gone) falls back rather than rendering a link to an address the
 * hub no longer advertises. `null` only for an empty list.
 */
export function selectPhoneCandidate(
  candidates: readonly PhoneCandidate[],
  pickedOrigin: string | null,
  preferredOrigin: string | null = null,
): PhoneCandidate | null {
  for (const wanted of [pickedOrigin, preferredOrigin]) {
    if (wanted === null) continue
    const origin = toHubOrigin(wanted)
    const match = candidates.find((c) => c.origin === origin)
    if (match !== undefined) return match
  }
  return candidates[0] ?? null
}

/** `https://camstack.zentik.app/connect?hub=<origin>` — the origin only. */
export function buildConnectLink(origin: string): string {
  const url = new URL(CENTRAL_CONNECT_URL)
  url.searchParams.set('hub', origin)
  return url.toString()
}
