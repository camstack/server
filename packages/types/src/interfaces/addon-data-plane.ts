import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RouteAccess } from './addon-routes.js'

/**
 * Per-listener shared-secret header the hub injects on every reverse-proxied
 * data-plane request and the addon's framework wrapper validates — so only the
 * hub can reach the addon's `127.0.0.1` listener. Defined here (shared by the
 * core proxy and the kernel listener) to keep both off a kernel↔core import.
 */
export const DATAPLANE_SECRET_HEADER = 'x-camstack-dataplane-secret'

/**
 * Addon HTTP **data-plane** — a generic, framework-level mechanism for an addon
 * to serve HTTP responses of ANY shape (files with `Range`, live streams, large
 * dynamic payloads) through the **hub's own port**, with the **addon producing
 * the bytes itself**.
 *
 * Why this exists (vs the `addon-routes` control plane): control routes return a
 * small JSON/redirect envelope captured over the unary UDS cap channel — fine for
 * APIs, wrong for media (the cap channel must not carry bytes, and an envelope
 * can't stream). The data plane instead binds a `127.0.0.1` HTTP listener IN THE
 * ADDON'S OWN PROCESS and lets the hub **reverse-proxy** to it: the handler gets
 * the REAL Node `req`/`res`, so HTTP `Range`, backpressure and client-disconnect
 * are handled natively by the addon; the hub only authenticates and pipes.
 *
 * Properties: same HTTPS/cert/origin as the admin-ui (no mixed content, no CORS,
 * no extra cert prompt), framework auth at the hub (scoped token / addon scope /
 * session cookie), no absolute filesystem path ever crosses the wire, and the
 * model extends to remote agents (the hub proxies the agent's data-plane URL).
 */
export interface AddonDataPlane {
  /**
   * Host a data-plane reachable at `/addon/<addonId>/<prefix>/*` through the hub.
   * Binds a localhost listener in this process and registers it with the hub.
   * Returns a handle; `dispose()` (also run automatically on shutdown) tears the
   * listener down and deregisters it.
   */
  serve(options: AddonDataPlaneServeOptions): Promise<AddonDataPlaneHandle>
}

/** A data-plane request handler — the REAL Node http req/res. The addon streams
 *  directly (`res.writeHead(...)`, `stream.pipe(res)`); the framework owns only
 *  transport in front of it (auth + reverse-proxy). */
export type DataPlaneHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * The share-view scope kinds a share-link token can carry. The hub mints
 * and validates them (`ShareViewGrantSchema` builds its
 * enum from this list); a data plane names the kinds it ACCEPTS in `share`.
 */
export const SHARE_VIEW_KINDS = ['grid-view', 'events-view'] as const
export type ShareViewKind = (typeof SHARE_VIEW_KINDS)[number]

export interface AddonDataPlaneServeOptions {
  /** URL namespace under `/addon/<addonId>/`, e.g. `'playback'`. A request's
   *  remaining path after the prefix reaches the handler verbatim (the handler
   *  sees `req.url` = `/<rest>`). */
  readonly prefix: string
  /** Hub-side auth requirement enforced BEFORE proxying. Same semantics as an
   *  `addon-routes` route's `access`. */
  readonly access: RouteAccess
  /** The addon's request handler — real `IncomingMessage`/`ServerResponse`. */
  readonly handler: DataPlaneHandler
  /**
   * Share-token scope kinds this plane serves. ABSENT means a share-link
   * token is refused here (403), whatever `access` says: a share link is a
   * bearer credential for one view of a few devices, not a session, and a
   * plane that never read the scope headers would serve every device to it.
   * A plane that opts in receives `x-camstack-share-kind` and
   * `x-camstack-share-devices` (comma-separated device ids) set by the hub —
   * never by the client — and MUST refuse a device outside that list.
   */
  readonly share?: readonly ShareViewKind[]
}

export interface AddonDataPlaneHandle {
  /** Internal localhost base URL the hub proxies to (diagnostics/logging). */
  readonly baseUrl: string
  /** The prefix this handle serves. */
  readonly prefix: string
  /** Stop the listener for this prefix and deregister it from the hub. */
  dispose(): Promise<void>
}

/**
 * Serializable descriptor the hub pulls from the addon (over the UDS `data-planes`
 * call, mirroring `routes`) to set up its reverse-proxy. The `secret` is a
 * per-listener shared token the hub injects on every proxied request and the
 * addon's framework wrapper checks — so only the hub can reach the `127.0.0.1`
 * listener. It travels ONLY over the trusted hub↔addon channel, never to a client.
 */
export interface AddonDataPlaneEndpoint {
  readonly prefix: string
  readonly access: RouteAccess
  /** `http://127.0.0.1:<port>` for a hub-local addon; the agent's reachable
   *  origin for a remote node. */
  readonly baseUrl: string
  readonly secret: string
  /** See {@link AddonDataPlaneServeOptions.share}. */
  readonly share?: readonly ShareViewKind[]
}
