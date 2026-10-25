/**
 * hub-address — the ONE reading of "at which address is this hub reached, for
 * what?", one resolver per ROLE, over the hub's own `local-network` palette
 * (`getConnectionEndpoints`) and the operator's role flags (Network page).
 *
 * There is no environment variable for this answer (D729). The hub enumerates
 * its interfaces, knows its own listen port, honours the operator's allowlist
 * and knows its tunnel and mesh names — every input the automatic answer
 * needs. A variable that restated it could only drift from it.
 *
 * ## Roles (D734)
 *
 * An address — a DETECTED endpoint or an operator-entered CUSTOM address —
 * carries role flags, the same way for both:
 *
 * - `appConnections` (many) — what the CamStack apps try when connecting.
 *   Automatic: every LAN IPv4 address plus the public tunnel — unless the
 *   tunnel's address is not stable (a Quick tunnel, D860).
 * - `notificationTaps` (one) — ONLY where tapping a notification opens.
 *   Automatic: the CamStack app link (D709); a hub address may be flagged.
 * - `publicEndpoint` (one) — every URL that must work from OUTSIDE the home
 *   network: sign-in links, OIDC / OAuth2 callbacks, the passkey relying
 *   party, account linking, and the notification centre's action buttons,
 *   attachment / media links and admin links. Automatic: the public tunnel,
 *   then the mesh, then the LAN. Never the app link, and never an address
 *   that is re-issued on its own (`stable: false`, a Quick tunnel — D860).
 * - `internal` (one) — what agents and LAN devices download from (addon
 *   bundles, models, a camera relay's broker host, Home Assistant media).
 *   Automatic: a LAN IPv4 literal, then any plausible LAN address, then the
 *   mesh. Never a public tunnel: it is a detour off the LAN for traffic that
 *   never left it.
 *
 * A single-valued role is stored as ONE URL, so "at most one address carries
 * it" holds by construction, not by a check. A flag wins outright; no flag is
 * automatic. Automatic picks only among DETECTED endpoints — a custom address
 * serves exactly the roles it is flagged with. Loopback and the app link are
 * never an internal or public-endpoint answer: loopback names whoever dials
 * it, and the app link is not a hub address. `null` means nothing qualifies —
 * the caller must say so rather than substitute `127.0.0.1`.
 */
import type { z } from 'zod'
import type { ConnectionEndpoint, HubAddressRoleSchema } from './local-network.cap.js'
import { CAMSTACK_APP_LINK_ORIGIN, isAppLinkBase } from './viewer-link-url.js'

export const HUB_ADDRESS_ROLES = [
  'appConnections',
  'notificationTaps',
  'internal',
  'publicEndpoint',
] as const
export type HubAddressRole = z.infer<typeof HubAddressRoleSchema>
/** The roles at most one address carries. */
export type SingleHubAddressRole = Exclude<HubAddressRole, 'appConnections'>
export const SINGLE_HUB_ADDRESS_ROLES: readonly SingleHubAddressRole[] = [
  'notificationTaps',
  'internal',
  'publicEndpoint',
]

export function isSingleHubAddressRole(role: HubAddressRole): role is SingleHubAddressRole {
  return role !== 'appConnections'
}

/** The operator's role flags, as stored. `null` / `[]` = automatic. */
export interface HubAddressFlags {
  readonly appConnections: readonly string[]
  readonly notificationTaps: string | null
  readonly internal: string | null
  readonly publicEndpoint: string | null
}

export const AUTOMATIC_HUB_ADDRESS_FLAGS: HubAddressFlags = {
  appConnections: [],
  notificationTaps: null,
  internal: null,
  publicEndpoint: null,
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/

function hostnameOf(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

function trimSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function isMesh(endpoint: ConnectionEndpoint): boolean {
  return endpoint.kind === 'public' && endpoint.interfaceKind === 'vpn'
}

function isTunnel(endpoint: ConnectionEndpoint): boolean {
  return endpoint.kind === 'public' && endpoint.interfaceKind === 'public'
}

function isPlausibleLan(endpoint: ConnectionEndpoint): boolean {
  return (endpoint.kind === 'lan-ipv4' || endpoint.kind === 'lan-ipv6') && endpoint.plausible
}

function isLanIpv4Literal(endpoint: ConnectionEndpoint): boolean {
  if (endpoint.kind !== 'lan-ipv4' || !endpoint.plausible) return false
  const host = hostnameOf(endpoint.baseUrl)
  return host !== null && IPV4_LITERAL.test(host)
}

function isUnstable(endpoint: ConnectionEndpoint): boolean {
  return endpoint.stable === false
}

/** Lower = better; `null` = never this role's AUTOMATIC answer. */
function autoRankFor(
  role: 'internal' | 'publicEndpoint',
  endpoint: ConnectionEndpoint,
): number | null {
  // Automatic picks among detected hub addresses only: loopback names the
  // dialler, the app link is no hub address, a custom address serves only the
  // roles it is flagged with.
  if (endpoint.kind === 'loopback' || endpoint.kind === 'app-link' || endpoint.kind === 'custom') {
    return null
  }
  if (hostnameOf(endpoint.baseUrl) === null) return null
  // An address that is re-issued on its own (a Quick tunnel) is never an
  // AUTOMATIC answer: a sign-in link, an OIDC callback or a notification
  // button built on it dies at the next respawn. An explicit flag still wins.
  if (isUnstable(endpoint)) return null
  if (role === 'internal') {
    if (isLanIpv4Literal(endpoint)) return 0
    if (isPlausibleLan(endpoint)) return 1
    if (isMesh(endpoint)) return 2
    return null
  }
  if (isTunnel(endpoint)) return 0
  if (isMesh(endpoint)) return 1
  if (isLanIpv4Literal(endpoint)) return 2
  if (isPlausibleLan(endpoint)) return 3
  return null
}

const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '::1', '[::1]', '::', '[::]'])

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (LOOPBACK_HOSTS.has(h) || h.endsWith('.localhost')) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

export type HubAddressCheck =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate an operator-typed address: an http(s) URL with a host, no
 * credentials, no path, and never loopback (it would name whoever dials it).
 * Answers the normalised origin (`scheme://host[:port]`).
 */
export function validateCustomAddress(raw: string): HubAddressCheck {
  const trimmed = raw.trim()
  if (trimmed === '')
    return { ok: false, reason: 'Enter an address, e.g. https://192.0.2.20:4443.' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'Not a URL — include http:// or https://.' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'Use an http:// or https:// address.' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'The address must not carry a user name or password.' }
  }
  if (parsed.hostname === '') return { ok: false, reason: 'The address has no host.' }
  if (isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      reason:
        'A loopback address names whoever dials it, never this hub — use an address other machines reach.',
    }
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, reason: 'Enter only the address (scheme, host and port), without a path.' }
  }
  return { ok: true, baseUrl: parsed.origin }
}

/** The reason a plain-http public endpoint is refused unless accepted. */
export const PUBLIC_ENDPOINT_HTTP_REASON =
  'The public endpoint needs an https:// address: passkeys and most identity providers refuse a plain-http origin. Accept http only when sign-in and notification links never leave your own network.'

/**
 * May `baseUrl` carry `role`? The address check above, plus two role rules:
 * the app link carries `notificationTaps` only (it is not a hub address), and
 * a plain-http address carries `publicEndpoint` only when the operator
 * explicitly accepted it (`acceptInsecureHttp`) — a LAN-only password
 * sign-in works over http, a passkey or an OIDC callback does not.
 */
export function checkRoleAddress(
  role: HubAddressRole,
  baseUrl: string,
  options: { readonly acceptInsecureHttp?: boolean } = {},
): HubAddressCheck {
  if (isAppLinkBase(baseUrl)) {
    return role === 'notificationTaps'
      ? { ok: true, baseUrl: CAMSTACK_APP_LINK_ORIGIN }
      : {
          ok: false,
          reason: 'The CamStack app link is not a hub address — only notification taps can use it.',
        }
  }
  const check = validateCustomAddress(baseUrl)
  if (!check.ok) return check
  if (
    role === 'publicEndpoint' &&
    check.baseUrl.startsWith('http:') &&
    options.acceptInsecureHttp !== true
  ) {
    return { ok: false, reason: PUBLIC_ENDPOINT_HTTP_REASON }
  }
  return check
}

/** Where a role's address came from. */
export type HubAddressSource = 'flagged' | 'auto' | 'none'

export interface HubAddressRoleResolution {
  /** The address flagged for the role, or `null` for automatic. */
  readonly flagged: string | null
  /** The address in use, or `null` when nothing qualifies. */
  readonly resolved: string | null
  readonly source: HubAddressSource
}

export interface HubAppConnectionsResolution {
  /** The addresses flagged `appConnections`, or empty for automatic. */
  readonly flagged: readonly string[]
  /** What the apps race right now (may be empty when nothing is up). */
  readonly resolved: readonly string[]
  readonly source: HubAddressSource
}

/** A stored flag that still validates (stored values are external data). */
function validFlag(role: HubAddressRole, flag: string | null): string | null {
  if (flag === null || flag === '') return null
  // A public-endpoint flag was checked (and http accepted) on write; honour it.
  const check = checkRoleAddress(role, flag, { acceptInsecureHttp: true })
  return check.ok ? check.baseUrl : null
}

function pickAuto(
  endpoints: readonly ConnectionEndpoint[],
  role: 'internal' | 'publicEndpoint',
): string | null {
  const ranked = endpoints
    .flatMap((endpoint) => {
      const rank = autoRankFor(role, endpoint)
      return rank === null ? [] : [{ rank, priority: endpoint.priority, endpoint }]
    })
    .toSorted((a, b) => a.rank - b.rank || a.priority - b.priority)
  const best = ranked[0]
  return best === undefined ? null : trimSlash(best.endpoint.baseUrl)
}

function resolveHubRole(
  endpoints: readonly ConnectionEndpoint[],
  role: 'internal' | 'publicEndpoint',
  flag: string | null,
): HubAddressRoleResolution {
  const flagged = validFlag(role, flag)
  if (flagged !== null) return { flagged, resolved: flagged, source: 'flagged' }
  const auto = pickAuto(endpoints, role)
  return { flagged: null, resolved: auto, source: auto === null ? 'none' : 'auto' }
}

/** `internal`: what agents and LAN devices download from. */
export function resolveInternalAddress(
  endpoints: readonly ConnectionEndpoint[],
  flags: HubAddressFlags,
): HubAddressRoleResolution {
  return resolveHubRole(endpoints, 'internal', flags.internal)
}

/**
 * `publicEndpoint`: every URL that must work off the LAN — sign-in links, OIDC
 * / OAuth2 callbacks, the relying party, and notification buttons,
 * attachments, media and admin links.
 */
export function resolvePublicEndpoint(
  endpoints: readonly ConnectionEndpoint[],
  flags: HubAddressFlags,
): HubAddressRoleResolution {
  return resolveHubRole(endpoints, 'publicEndpoint', flags.publicEndpoint)
}

/** `notificationTaps`: the flagged address, else the CamStack app link (D709). */
export function resolveNotificationTapAddress(flags: HubAddressFlags): HubAddressRoleResolution {
  const flagged = validFlag('notificationTaps', flags.notificationTaps)
  if (flagged !== null && !isAppLinkBase(flagged)) {
    return { flagged, resolved: flagged, source: 'flagged' }
  }
  return { flagged: null, resolved: CAMSTACK_APP_LINK_ORIGIN, source: 'auto' }
}

/** AUTO app connections: LAN IPv4 + the public tunnel. Never IPv6, mesh, loopback or custom. */
export function isDefaultAppConnectionEndpoint(endpoint: ConnectionEndpoint): boolean {
  if (isUnstable(endpoint)) return false
  if (endpoint.kind === 'lan-ipv4') return true
  return endpoint.kind === 'public' && endpoint.interfaceKind === 'public'
}

/**
 * The endpoints the apps race: the flagged ones that are in `endpoints`
 * (which carries the custom addresses flagged `appConnections`), else AUTO. A flagged
 * set none of which is currently up falls back to AUTO rather than racing
 * nothing.
 */
export function selectAppConnectionEndpoints(
  endpoints: readonly ConnectionEndpoint[],
  flags: HubAddressFlags,
): ConnectionEndpoint[] {
  const auto = endpoints.filter(isDefaultAppConnectionEndpoint)
  if (flags.appConnections.length === 0) return auto
  const wanted = new Set(flags.appConnections)
  const explicit = endpoints.filter((e) => wanted.has(e.baseUrl))
  return explicit.length > 0 ? explicit : auto
}

/** `appConnections`: what the apps try when connecting. */
export function resolveAppConnections(
  endpoints: readonly ConnectionEndpoint[],
  flags: HubAddressFlags,
): HubAppConnectionsResolution {
  const wanted = new Set(flags.appConnections)
  const selected = selectAppConnectionEndpoints(endpoints, flags)
  const usedFlags = selected.some((e) => wanted.has(e.baseUrl))
  return {
    flagged: flags.appConnections,
    resolved: selected.map((e) => e.baseUrl),
    source: selected.length === 0 ? 'none' : usedFlags ? 'flagged' : 'auto',
  }
}

/** Every role's answer. */
export interface HubAddressRoles {
  readonly appConnections: HubAppConnectionsResolution
  readonly notificationTaps: HubAddressRoleResolution
  readonly internal: HubAddressRoleResolution
  readonly publicEndpoint: HubAddressRoleResolution
}

/**
 * Every role at once, each through its own resolver. `appPalette` is what
 * the apps race (it carries the custom addresses flagged `appConnections`);
 * `hubPalette` is the detected HTTPS palette `internal` and `publicEndpoint`
 * resolve over.
 */
export function resolveHubAddressRoles(
  appPalette: readonly ConnectionEndpoint[],
  hubPalette: readonly ConnectionEndpoint[],
  flags: HubAddressFlags,
): HubAddressRoles {
  return {
    appConnections: resolveAppConnections(appPalette, flags),
    notificationTaps: resolveNotificationTapAddress(flags),
    internal: resolveInternalAddress(hubPalette, flags),
    publicEndpoint: resolvePublicEndpoint(hubPalette, flags),
  }
}

/** The bare hostname of a base URL, or `null` when it does not parse. */
export function hubAddressHostname(baseUrl: string | null): string | null {
  return baseUrl === null ? null : hostnameOf(baseUrl)
}

/**
 * How a client finds a hub on the LAN (D838): the hub publishes ONE mDNS
 * service for its HTTPS endpoint. `_camstack._tcp` carries the hub's `internal`
 * address in `url`, and nothing secret — finding a hub grants nothing, every
 * client still signs in. The mesh channel stays retired (D826).
 */
export const HUB_MDNS_SERVICE_TYPE = 'camstack'
/** The fully-qualified name a client browses for. */
export const HUB_MDNS_QUERY_NAME = '_camstack._tcp.local'
/** The TXT keys of the advertisement. Every value is public. */
export const HUB_MDNS_TXT_KEYS = {
  nodeId: 'nodeId',
  version: 'version',
  role: 'role',
  url: 'url',
} as const
export const HUB_MDNS_ROLE = 'hub'

/**
 * How a hub finds agents to pair (D857): every agent publishes ONE mDNS service for its API
 * port, paired or not. The TXT record carries only public facts. Finding an agent grants
 * nothing: pairing still needs the six-digit code confirmed on both screens.
 */
export const AGENT_MDNS_SERVICE_TYPE = 'camstack-agent'
/** The fully-qualified name a hub browses for. */
export const AGENT_MDNS_QUERY_NAME = '_camstack-agent._tcp.local'
/** The TXT keys of the agent advertisement. Every value is public. */
export const AGENT_MDNS_TXT_KEYS = {
  nodeId: 'nodeId',
  version: 'version',
  /** `unpaired` | `pending` | `paired`. */
  state: 'state',
  /** First 16 hex chars of the SHA-256 of the agent's mesh leaf; present once paired. */
  keyFingerprint: 'fp',
} as const
