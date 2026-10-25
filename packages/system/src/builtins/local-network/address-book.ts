/**
 * The Network page's address book, as pure functions: custom addresses plus
 * the role flags carried by detected and custom addresses alike.
 *
 * ## Storage (D734)
 *
 * One key per role: `appConnectionUrls` (`appConnections`, many),
 * `notificationTapUrl` (`notificationTaps`), `publicEndpointUrl`
 * (`publicEndpoint`) and `internalUrl` (`internal`). A single-valued role is
 * one URL — at most one address carries it, by construction. `''` / `[]` is
 * automatic. The custom addresses are `customAddresses` (url + label).
 *
 * The keys of the earlier role names (`viewerBaseUrls`, `notificationBaseUrl`,
 * `signInBaseUrl`, `agentBaseUrl`) are not read: a value stored under one is
 * ignored, and that role is automatic until the operator flags it again
 * (D734 — one install, re-set by hand, no migration code).
 *
 * ## A flag on an address that is in no row
 *
 * A flagged detected address can disappear (a DHCP move) while it still wins
 * its role. {@link normalizeAddressBook} turns every single-valued flag that
 * names neither a detected address, a custom one nor the app link into a
 * custom address carrying that role, on every read; the next write persists
 * the result — so the address shows as a custom row instead of vanishing.
 */
import {
  CAMSTACK_APP_LINK_ORIGIN,
  type ConnectionEndpoint,
  type HubAddressBook,
  type HubAddressFlags,
  type HubAddressRole,
  type HubAddressRow,
  isAppLinkBase,
  resolveHubAddressRoles,
  type SingleHubAddressRole,
} from '@camstack/types'
import { z } from 'zod'

export interface CustomAddress {
  readonly baseUrl: string
  readonly label: string
}

const CustomAddressListSchema = z.array(z.object({ baseUrl: z.string(), label: z.string() }))

/** The address-book keys of the addon's stored settings. */
export interface StoredAddressSettings {
  readonly customAddresses: unknown
  readonly appConnectionUrls: readonly string[]
  readonly notificationTapUrl: string
  readonly publicEndpointUrl: string
  readonly internalUrl: string
}

export interface AddressBookState {
  readonly custom: readonly CustomAddress[]
  readonly flags: HubAddressFlags
}

/** The label a flag promoted to a custom address is given. */
const PROMOTED_LABEL: Readonly<Record<SingleHubAddressRole, string>> = {
  notificationTaps: 'Notification taps address',
  internal: 'Internal address',
  publicEndpoint: 'Public endpoint',
}

const SINGLE_ROLES: readonly SingleHubAddressRole[] = [
  'notificationTaps',
  'internal',
  'publicEndpoint',
]

function flagOf(value: string): string | null {
  return value === '' ? null : value
}

/** Parse the stored custom list; a malformed store reads as empty, never throws. */
export function parseCustomAddresses(raw: unknown): readonly CustomAddress[] {
  const parsed = CustomAddressListSchema.safeParse(raw ?? [])
  return parsed.success ? parsed.data : []
}

/**
 * The address book as it stands: stored custom addresses, plus every
 * single-valued flag that names neither a detected address, a custom one nor
 * the app link, promoted to a custom address (see the module doc).
 */
export function normalizeAddressBook(
  stored: StoredAddressSettings,
  detectedUrls: ReadonlySet<string>,
): AddressBookState {
  const flags: HubAddressFlags = {
    appConnections: stored.appConnectionUrls,
    notificationTaps: flagOf(stored.notificationTapUrl),
    internal: flagOf(stored.internalUrl),
    publicEndpoint: flagOf(stored.publicEndpointUrl),
  }
  const custom = [...parseCustomAddresses(stored.customAddresses)]
  for (const role of SINGLE_ROLES) {
    const url = flags[role]
    if (url === null || isAppLinkBase(url) || detectedUrls.has(url)) continue
    if (custom.some((c) => c.baseUrl === url)) continue
    custom.push({ baseUrl: url, label: PROMOTED_LABEL[role] })
  }
  return { custom, flags }
}

/** The stored-settings patch that persists `state`. */
export function addressBookPatch(state: AddressBookState): {
  readonly customAddresses: readonly CustomAddress[]
  readonly appConnectionUrls: readonly string[]
  readonly notificationTapUrl: string
  readonly publicEndpointUrl: string
  readonly internalUrl: string
} {
  return {
    customAddresses: state.custom,
    appConnectionUrls: state.flags.appConnections,
    notificationTapUrl: state.flags.notificationTaps ?? '',
    publicEndpointUrl: state.flags.publicEndpoint ?? '',
    internalUrl: state.flags.internal ?? '',
  }
}

export function withCustomAddress(state: AddressBookState, entry: CustomAddress): AddressBookState {
  const exists = state.custom.some((c) => c.baseUrl === entry.baseUrl)
  const custom = exists
    ? state.custom.map((c) => (c.baseUrl === entry.baseUrl ? entry : c))
    : [...state.custom, entry]
  return { ...state, custom }
}

/** Drop a custom address and every flag it carried (those roles turn automatic). */
export function withoutCustomAddress(state: AddressBookState, baseUrl: string): AddressBookState {
  const clear = (flag: string | null): string | null => (flag === baseUrl ? null : flag)
  return {
    custom: state.custom.filter((c) => c.baseUrl !== baseUrl),
    flags: {
      appConnections: state.flags.appConnections.filter((u) => u !== baseUrl),
      notificationTaps: clear(state.flags.notificationTaps),
      internal: clear(state.flags.internal),
      publicEndpoint: clear(state.flags.publicEndpoint),
    },
  }
}

/** Every role back to automatic for `role`. */
export function withRoleAutomatic(state: AddressBookState, role: HubAddressRole): AddressBookState {
  return role === 'appConnections'
    ? { ...state, flags: { ...state.flags, appConnections: [] } }
    : { ...state, flags: { ...state.flags, [role]: null } }
}

/**
 * Flag or unflag `baseUrl` for `role`. A single-valued role flagged here moves
 * off every other address (it is one URL); unflagging the address that carries
 * it returns the role to automatic. The app link flagged for notification
 * taps IS the automatic answer, stored as automatic — one representation.
 * `appConnections` toggles inside the set; toggling while automatic starts
 * from the automatic set (`autoApp`) so the other addresses keep racing.
 */
export function withRoleFlag(
  state: AddressBookState,
  role: HubAddressRole,
  baseUrl: string,
  enabled: boolean,
  autoApp: readonly string[],
): AddressBookState {
  if (role === 'appConnections') {
    const current = state.flags.appConnections.length === 0 ? autoApp : state.flags.appConnections
    const without = current.filter((u) => u !== baseUrl)
    const appConnections = enabled ? [...without, baseUrl] : without
    return { ...state, flags: { ...state.flags, appConnections } }
  }
  if (role === 'notificationTaps' && isAppLinkBase(baseUrl)) {
    return withRoleAutomatic(state, role)
  }
  if (enabled) return { ...state, flags: { ...state.flags, [role]: baseUrl } }
  return state.flags[role] === baseUrl ? withRoleAutomatic(state, role) : state
}

/** What a row may be flagged with. */
export function eligibleRoles(endpoint: ConnectionEndpoint): readonly HubAddressRole[] {
  if (endpoint.kind === 'loopback') return []
  if (endpoint.kind === 'app-link') return ['notificationTaps']
  return ['appConnections', 'notificationTaps', 'internal', 'publicEndpoint']
}

export const CUSTOM_ADDRESS_PRIORITY = 200

/** A custom address as a palette entry (`kind: 'custom'`). */
export function customEndpoint(entry: CustomAddress): ConnectionEndpoint {
  return {
    label: entry.label === '' ? 'Custom address' : entry.label,
    baseUrl: entry.baseUrl,
    kind: 'custom',
    interfaceKind: 'other',
    plausible: true,
    plausibleReason: '',
    priority: CUSTOM_ADDRESS_PRIORITY,
  }
}

/**
 * The palette a client races: the detected endpoints plus the custom
 * addresses flagged `appConnections` (a detected URL is never listed twice).
 */
export function withAppConnectionCustomEndpoints(
  detected: readonly ConnectionEndpoint[],
  state: AddressBookState,
): ConnectionEndpoint[] {
  const known = new Set(detected.map((e) => e.baseUrl))
  const wanted = new Set(state.flags.appConnections)
  const extra = state.custom
    .filter((c) => wanted.has(c.baseUrl) && !known.has(c.baseUrl))
    .map(customEndpoint)
  return [...detected, ...extra]
}

/** Where a twin sorts relative to its plain-HTTP row: straight after it. */
const HTTPS_TWIN_PRIORITY_STEP = 0.5

/**
 * The HTTPS counterpart of every LAN address advertised over plain HTTP
 * (D859): `http://<lan>:<httpPort>` gains `https://<lan>:<httpsPort>`, the hub's
 * TLS listener, as its own row straight after it. The twin is an ordinary
 * detected LAN row — ticked, unticked and flagged like any other, on by default
 * (a LAN row is an automatic app connection). A phone that does not trust the
 * hub's local CA fails that candidate in the race it already runs; one that
 * does reaches it. Only the app-connection palette and the table carry twins:
 * the palette `internal` and `publicEndpoint` resolve over never does, so those
 * roles keep their answer. Rows already on https (LAN HTTP off), the public
 * tunnel, the mesh, custom addresses and loopback have no twin.
 */
export function withLanHttpsCounterparts(
  palette: readonly ConnectionEndpoint[],
  httpsPort: number,
): ConnectionEndpoint[] {
  const known = new Set(palette.map((e) => e.baseUrl))
  const out: ConnectionEndpoint[] = []
  for (const endpoint of palette) {
    out.push(endpoint)
    if (endpoint.kind !== 'lan-ipv4' && endpoint.kind !== 'lan-ipv6') continue
    const twin = httpsTwinOf(endpoint, httpsPort)
    if (twin === null || known.has(twin.baseUrl)) continue
    known.add(twin.baseUrl)
    out.push(twin)
  }
  return out
}

function httpsTwinOf(endpoint: ConnectionEndpoint, httpsPort: number): ConnectionEndpoint | null {
  let parsed: URL
  try {
    parsed = new URL(endpoint.baseUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:') return null
  return {
    ...endpoint,
    label: `${endpoint.label} (HTTPS)`,
    baseUrl: `https://${parsed.hostname}:${httpsPort}`,
    priority: endpoint.priority + HTTPS_TWIN_PRIORITY_STEP,
  }
}

export interface AddressBookInputs {
  /** Detected endpoints in the scheme the rows are shown in. */
  readonly rowsPalette: readonly ConnectionEndpoint[]
  /** Detected endpoints over HTTPS — what `internal` and `publicEndpoint` resolve over. */
  readonly httpsPalette: readonly ConnectionEndpoint[]
  readonly appLink: ConnectionEndpoint
  readonly appLinkHub: string | null
  /** Where the hub's listeners answer (see {@link buildListenerOrigins}). */
  readonly listenerOrigins: readonly string[]
}

/** Every role's answer — the resolvers from `@camstack/types`, nothing else. */
export function resolveRoles(
  state: AddressBookState,
  appPalette: readonly ConnectionEndpoint[],
  httpsPalette: readonly ConnectionEndpoint[],
): HubAddressBook['roles'] {
  return resolveHubAddressRoles(
    withAppConnectionCustomEndpoints(appPalette, state),
    httpsPalette,
    state.flags,
  )
}

function flagsOn(state: AddressBookState, baseUrl: string): HubAddressRole[] {
  const out: HubAddressRole[] = []
  if (state.flags.appConnections.includes(baseUrl)) out.push('appConnections')
  for (const role of SINGLE_ROLES) if (state.flags[role] === baseUrl) out.push(role)
  return out
}

function inUseOn(roles: HubAddressBook['roles'], baseUrl: string): HubAddressRole[] {
  const out: HubAddressRole[] = []
  if (roles.appConnections.resolved.includes(baseUrl)) out.push('appConnections')
  for (const role of SINGLE_ROLES) if (roles[role].resolved === baseUrl) out.push(role)
  return out
}

/** The Addresses table: app link, detected rows, then custom-only rows. */
export function buildAddressBook(
  state: AddressBookState,
  inputs: AddressBookInputs,
): HubAddressBook {
  const roles = resolveRoles(state, inputs.rowsPalette, inputs.httpsPalette)
  const customUrls = new Set(state.custom.map((c) => c.baseUrl))
  const detectedUrls = new Set(inputs.rowsPalette.map((e) => e.baseUrl))
  const row = (endpoint: ConnectionEndpoint, detected: boolean): HubAddressRow => ({
    ...endpoint,
    detected,
    custom: customUrls.has(endpoint.baseUrl),
    // The app link is the AUTOMATIC notificationTaps answer — never a stored flag.
    flags: endpoint.kind === 'app-link' ? [] : flagsOn(state, endpoint.baseUrl),
    inUse:
      endpoint.kind === 'app-link'
        ? roles.notificationTaps.resolved === CAMSTACK_APP_LINK_ORIGIN
          ? ['notificationTaps']
          : []
        : inUseOn(roles, endpoint.baseUrl),
    eligible: eligibleRoles(endpoint),
  })
  const rows: HubAddressRow[] = [
    row(inputs.appLink, false),
    ...inputs.rowsPalette.map((e) => row(e, true)),
    ...state.custom
      .filter((c) => !detectedUrls.has(c.baseUrl))
      .map((c) => row(customEndpoint(c), false)),
  ]
  return { rows, roles, appLinkHub: inputs.appLinkHub, listenerOrigins: inputs.listenerOrigins }
}

export interface ListenerOriginInputs {
  /** The palette as the HTTPS listener serves it (`https://<ip>:<httpsPort>`). */
  readonly overHttps: readonly ConnectionEndpoint[]
  /** The palette with the LAN HTTP listener on; empty while it is off. */
  readonly overHttp: readonly ConnectionEndpoint[]
  readonly custom: readonly CustomAddress[]
  /** The local name when the hub serves it, over each listener. */
  readonly localNameOrigins: readonly string[]
}

const ORIGIN_KINDS: ReadonlySet<ConnectionEndpoint['kind']> = new Set([
  'lan-ipv4',
  'lan-ipv6',
  'public',
])

/**
 * Every origin a browser can really reach this hub at: the HTTPS listener's
 * `https://<lan>:<httpsPort>` AND, while the LAN HTTP listener is on,
 * `http://<lan>:<httpPort>`; plus the public and custom addresses. The rows
 * show `http://` only while LAN HTTP is on (native clients skip the private
 * certificate), so the https origin the admin UI is opened at is in no row —
 * a sign-in return (D794) matches against this list instead of falling back
 * to the public endpoint. Never loopback, never the app link.
 */
export function buildListenerOrigins(inputs: ListenerOriginInputs): readonly string[] {
  const out = new Set<string>()
  for (const e of [...inputs.overHttps, ...inputs.overHttp]) {
    if (ORIGIN_KINDS.has(e.kind)) out.add(e.baseUrl)
  }
  for (const c of inputs.custom) out.add(c.baseUrl)
  for (const o of inputs.localNameOrigins) out.add(o)
  return [...out]
}
