/**
 * viewer-link-url — the ONE builder for a link that opens a VIEWER page
 * (a camera at an instant, the events timeline, the notification centre),
 * and the one definition of the "CamStack app link" address (D709).
 *
 * The address a link points at is the endpoint the operator FLAGS for
 * notifications on the admin Network page (`local-network`'s notification
 * endpoint — one flag, one store). Among the addresses that page lists,
 * `local-network` adds one generic entry: the app link,
 * `https://camstack.zentik.app`, and that entry carries the flag BY DEFAULT.
 * Two forms follow from which address is flagged:
 *
 * - `app` — the app link is flagged:
 *   `https://camstack.zentik.app/<path>?<query>&hub=<hub origin>`. The central
 *   domain the native app claims as a Universal Link / App Link
 *   (docs/design/2026-08-19-central-link-redirect.md): on a phone with the app
 *   it opens the app on that page; anywhere else the hosted viewer opens and
 *   `hub=` tells it which hub to talk to. `hub=` is filled automatically from
 *   the hub's own best public HTTPS address ({@link pickAppLinkHub}).
 * - `hub` — one of the hub's own addresses is flagged:
 *   `<hub base>/viewer/camstack/<path>?<query>` (the pre-D709 form).
 *
 * The paths are the viewer's own routes, verbatim (§2.3 of that design), and
 * only the families the app claims in its AASA (`camstack/web-server/
 * app-links.ts`): `/camera/*`, `/events*`, `/notifications*`. A destination
 * is a typed union rather than a free path so a caller cannot mint a central
 * link the domain would 404.
 *
 * The admin UI is NOT a viewer destination: the central site hosts the
 * viewer only, so an admin page (an addon update row → `/system/addons`)
 * always points at the hub itself — see `system-event-tap-url.ts`. Nor is the
 * app link a HUB address: signed media and action-button links never use it.
 */
import type { ConnectionEndpoint } from './local-network.cap.js'

/** The central link domain the viewer app claims (Universal Links / App Links). */
export const CAMSTACK_APP_LINK_ORIGIN = 'https://camstack.zentik.app'

/** Where the hub serves the viewer SPA. */
export const HUB_VIEWER_MOUNT = '/viewer/camstack'

/** Which form a viewer link takes — see the module header. */
export type ViewerLinkForm = 'hub' | 'app'

/**
 * The base a viewer link is built on. `hub`: the flagged hub address (null =
 * none reachable — no link). `app`: the hub origin to carry as `hub=` (null =
 * none known — the link is still minted, without `hub=`; the central page then
 * asks once, design §5).
 */
export interface ViewerLinkBase {
  readonly form: ViewerLinkForm
  readonly hubBaseUrl: string | null
}

/** A viewer page a link may open. One member per AASA-claimed route family. */
export type ViewerDestination =
  | {
      readonly kind: 'camera'
      readonly deviceId: number
      /** Recorded seek instant (`?at=`), epoch ms. Absent = live. */
      readonly atMs?: number
    }
  | { readonly kind: 'events' }
  | { readonly kind: 'notifications' }

export interface ViewerLinkInput {
  readonly base: ViewerLinkBase
  readonly destination: ViewerDestination
}

/** True when `baseUrl` names the CamStack app link rather than a hub address. */
export function isAppLinkBase(baseUrl: string | null | undefined): boolean {
  if (baseUrl === null || baseUrl === undefined || baseUrl === '') return false
  try {
    return new URL(baseUrl).origin === CAMSTACK_APP_LINK_ORIGIN
  } catch {
    return false
  }
}

/**
 * The fields of `local-network.getNotificationEndpoint` a viewer link reads.
 * `appLinkHub` is absent on a pre-D709 hub, which never flags the app link.
 */
export interface NotificationLinkEndpoint {
  readonly baseUrl: string | null
  readonly resolved: string | null
  readonly appLinkHub?: string | null
}

/**
 * The base a viewer link is built on, from the flagged notification address:
 * the effective address is the explicit choice, else AUTO's `resolved`. The
 * one reading of that answer — the NC's tap and the Network page's preview
 * both go through it.
 */
export function viewerLinkBaseOf(endpoint: NotificationLinkEndpoint): ViewerLinkBase {
  const flagged = endpoint.baseUrl ?? endpoint.resolved
  return isAppLinkBase(flagged)
    ? { form: 'app', hubBaseUrl: endpoint.appLinkHub ?? null }
    : { form: 'hub', hubBaseUrl: flagged }
}

/**
 * Reduce a base URL to the bare origin the central page accepts as `hub=`,
 * or `null` when it cannot be one: not http(s), carries credentials, or does
 * not parse. A path/query/fragment is dropped — the central page mounts the
 * viewer under the origin itself.
 */
export function toAppLinkHubOrigin(baseUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.hostname === '') return null
  return parsed.origin
}

/**
 * The hub address an app link carries as `hub=`, chosen from the hub's OWN
 * advertised palette so it always agrees with what the Network page lists:
 * the public tunnel first, then the mesh (Tailscale MagicDNS) — HTTPS only,
 * because the app and the hosted viewer reach it from off the LAN. `null`
 * when the hub advertises neither.
 */
export function pickAppLinkHub(endpoints: readonly ConnectionEndpoint[]): string | null {
  const rank = (e: ConnectionEndpoint): number | null => {
    if (e.kind !== 'public' || !e.baseUrl.startsWith('https://')) return null
    if (e.interfaceKind === 'public') return 0
    if (e.interfaceKind === 'vpn') return 1
    return null
  }
  const ranked = endpoints
    .flatMap((e) => {
      const r = rank(e)
      const origin = toAppLinkHubOrigin(e.baseUrl)
      return r === null || origin === null ? [] : [{ r, p: e.priority, origin }]
    })
    .toSorted((a, b) => a.r - b.r || a.p - b.p)
  return ranked[0]?.origin ?? null
}

interface ViewerRoute {
  readonly path: string
  readonly query: readonly (readonly [string, string])[]
}

/** The viewer route for a destination, or null when it names nothing. */
function viewerRoute(destination: ViewerDestination): ViewerRoute | null {
  switch (destination.kind) {
    case 'camera': {
      if (!Number.isInteger(destination.deviceId) || destination.deviceId <= 0) return null
      const at = destination.atMs
      return {
        path: `/camera/${String(destination.deviceId)}`,
        query: at !== undefined && Number.isFinite(at) ? [['at', String(Math.trunc(at))]] : [],
      }
    }
    case 'events':
      return { path: '/events', query: [] }
    case 'notifications':
      return { path: '/notifications', query: [] }
  }
}

function encodeQuery(query: readonly (readonly [string, string])[]): string {
  if (query.length === 0) return ''
  return `?${query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
}

/**
 * The link for a viewer destination, or `null` when none can be minted: an
 * unknown destination, or the `hub` form with no reachable base (a dead link
 * is worse than none).
 */
export function buildViewerLink(input: ViewerLinkInput): string | null {
  const route = viewerRoute(input.destination)
  if (route === null) return null
  const raw = input.base.hubBaseUrl
  const base = raw === null ? '' : raw.replace(/\/+$/, '')
  if (input.base.form === 'app') {
    const origin = base === '' ? null : toAppLinkHubOrigin(base)
    const query = origin === null ? route.query : [...route.query, ['hub', origin] as const]
    return `${CAMSTACK_APP_LINK_ORIGIN}${route.path}${encodeQuery(query)}`
  }
  if (base === '' || isAppLinkBase(base)) return null
  return `${base}${HUB_VIEWER_MOUNT}${route.path}${encodeQuery(route.query)}`
}
