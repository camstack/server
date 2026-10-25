/**
 * Core-capability mesh bridge.
 *
 * The hub's CORE routers — hand-written single-impl routers plus the
 * handful of service-backed cap routers — are mounted only as the hub's
 * tRPC `appRouter`. No addon registers a provider for them, so
 * `addon-service-factory` never publishes a Moleculer service exposing
 * their actions. A forked addon calling `ctx.api.<coreCap>.<method>`
 * therefore falls through `localProviderLink` into `brokerTransportLink`,
 * whose load-balanced discovery wait has no deadline — the call hangs
 * forever (this was the `export-alexa` `redetectHubUrl` hang).
 *
 * `buildCoreCapService` walks the appRouter, picks the core namespaces,
 * and wraps each query/mutation as a `$core-caps.<kebab-cap>.<method>`
 * Moleculer action invoked through a trusted-mesh tRPC caller. With the
 * service mounted on the hub node, `brokerTransportLink` resolves and
 * routes the call exactly like any addon-provided cap.
 */

import { type CoreCapAction, type CoreCapCallOrigin, createCoreCapService } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import { Errors, type ServiceSchema } from 'moleculer'
import {
  authorizeRemoteUpdatePackage,
  type RemoteUpdateGrantDeps,
} from './remote-addon-update-grant.js'
import type { HttpRequestCensus } from './http-request-census.js'
import { getHttpRequestCensus } from './http-request-census.singleton.js'
import { HUB_SERVICE_CAP_NAMES, capNameToNamespace } from './server-provided-caps.js'
import { createMeshTrpcContext } from './trpc.context.js'
import { createCallerFactory } from './trpc.middleware.js'
import type { AppRouter } from './trpc.router.js'

/**
 * appRouter namespaces that back the CORE API surface and must be
 * reachable cross-process: every server-provided hub-service cap
 * (`HUB_SERVICE_CAP_NAMES`, the single source shared with
 * `buildServerProviders`) plus the hand-written core routers from
 * `trpc.router.ts`, minus the deliberate exclusions below.
 *
 * Excluded on purpose:
 *  - `auth` — issuing service / scoped tokens over the trusted mesh
 *    would let any forked addon mint admin credentials. Addons must
 *    not perform authentication operations; this stays hub-local.
 *  - `repl` — `repl.execute` runs code in the hub process (`vm` is no
 *    boundary). The admin UI's REPL reaches it over HTTP tRPC as an admin
 *    session; nothing calls it over the mesh, and a mesh caller must never
 *    be able to (D802, security plan §1).
 *  - `live`, `systemEvents` — listed in `NEVER_BRIDGED_CAPS`
 *    (`trpc-links.ts`). They are hub-only push streams, not
 *    request/reply, and the worker side fast-fails on them by design.
 */
const CORE_NAMESPACES: ReadonlySet<string> = new Set<string>([
  // Service-backed cap routers (no addon provider) — derived, never copied.
  ...HUB_SERVICE_CAP_NAMES.map(capNameToNamespace),
  // Hand-written single-impl core routers.
  'capabilities',
  'notifications',
  'logs',
  'hwaccel',
  'streamProbe',
  'eventBusProxy',
  'addonSettingsRaw',
])

/**
 * Bridged namespaces another NODE may not call (D802) — only the hub's own
 * runners may. `logs` reads the hub's whole log store, `addonSettingsRaw` every
 * addon's raw config (tokens included). No addon calls either over the mesh
 * (they read their own settings through the settings door), so refusing them
 * to an agent costs nothing and takes them off the LAN.
 */
export const REMOTE_DENIED_NAMESPACES: ReadonlySet<string> = new Set<string>([
  'logs',
  'addonSettingsRaw',
])

/** Moleculer error `type` of a bridged call another node may not make. */
export const CORE_CAP_REMOTE_FORBIDDEN_TYPE = 'CORE_CAP_REMOTE_FORBIDDEN'

/**
 * Hub-core procedure paths another node may call after {@link REMOTE_DENIED_NAMESPACES}.
 * Seeded from armed transport census on the live hub (2026-10): remote agents
 * (`mesh:<agent>`) called none of these; hub runners used this surface only.
 */
export const REMOTE_PRIVILEGE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'addons.listCapabilityProviders',
  'nodes.topology',
  'integrations.getByAddonId',
  'addons.list',
  'system.getLoggingSettings',
  'addons.setCapabilityProviderEnabled',
  'system.getSiteLocation',
])

/** The one path outside the allowlist a node may call, under {@link authorizeRemoteUpdatePackage}. */
export const REMOTE_UPDATE_PACKAGE_PATH = 'addons.updatePackage'

/**
 * When true, remote bridged calls outside {@link REMOTE_PRIVILEGE_ALLOWLIST} are
 * logged once per `(nodeId, path)` per process — still admin, not refused.
 */
export const REMOTE_PRIVILEGE_LOG_ONLY = false

/** Sink for {@link observeRemotePrivilege}; wired at hub boot. */
export type RemotePrivilegeLogSink = Pick<IScopedLogger, 'warn'>

let remotePrivilegeLogSink: RemotePrivilegeLogSink | null = null

/** Attach the warn sink used by {@link observeRemotePrivilege}. */
export function setRemotePrivilegeLogSink(sink: RemotePrivilegeLogSink | null): void {
  remotePrivilegeLogSink = sink
}

const remotePrivilegeObserved = new Set<string>()

/** Clears dedupe state and the sink — tests only. */
export function __resetRemotePrivilegeObservationForTests(): void {
  remotePrivilegeObserved.clear()
  remotePrivilegeLogSink = null
}

function remotePrivilegeKey(nodeId: string, path: string): string {
  return `${nodeId}\0${path}`
}

function warnRemotePrivilegeOnce(nodeId: string, path: string, message: string): void {
  const key = remotePrivilegeKey(nodeId, path)
  if (remotePrivilegeObserved.has(key)) return
  remotePrivilegeObserved.add(key)
  remotePrivilegeLogSink?.warn(message, {
    meta: { nodeId, path, principal: `node:${nodeId}` },
  })
}

/**
 * One warn per `(nodeId, path)` while {@link REMOTE_PRIVILEGE_LOG_ONLY} is on.
 * Call only after {@link REMOTE_DENIED_NAMESPACES} has passed.
 */
export function observeRemotePrivilege(nodeId: string, path: string): void {
  if (!REMOTE_PRIVILEGE_LOG_ONLY) return
  warnRemotePrivilegeOnce(
    nodeId,
    path,
    `mesh privilege: node:${nodeId} called ${path} (log-only; still allowed)`,
  )
}

/**
 * One warn per `(nodeId, path)` when enforcement refuses a path not on
 * {@link REMOTE_PRIVILEGE_ALLOWLIST}. Call immediately before throwing.
 */
export function observeRemotePrivilegeRefused(nodeId: string, path: string): void {
  warnRemotePrivilegeOnce(
    nodeId,
    path,
    `mesh privilege: node:${nodeId} called ${path} (refused; not on grant)`,
  )
}

/**
 * camelCase → kebab-case. Mirrors `toKebab` in `trpc-links.ts` so the
 * action name matches what `brokerTransportLink` derives from `op.path`.
 */
function toKebab(name: string): string {
  return name.replace(/[A-Z]/g, (m, i: number) => (i > 0 ? '-' : '') + m.toLowerCase())
}

/**
 * Every hub-core cap NAME as it can arrive on the wire — both the appRouter
 * namespace (`streamProbe`) and its kebab form (`stream-probe`, the cap
 * definition `name`). {@link isCoreServiceCapName} checks membership.
 */
const CORE_CAP_NAMES: ReadonlySet<string> = new Set<string>([
  ...CORE_NAMESPACES,
  ...[...CORE_NAMESPACES].map(toKebab),
])

/**
 * True when `capName` is a hub-core `$`-service cap (served by `$core-caps` /
 * the hand-written core routers, NOT by any addon provider). The `onUnownedCall`
 * handler uses this as the SINGLE discriminant for its broker fallback: a
 * resolver miss on a core cap is legitimately routed via the broker; a miss on
 * anything else means an addon provider is not registered yet. Derived from the
 * already-maintained {@link CORE_NAMESPACES} — a new addon cap is covered with
 * zero changes here.
 */
export function isCoreServiceCapName(capName: string): boolean {
  return CORE_CAP_NAMES.has(capName)
}

/** A tRPC procedure node — distinguished from a router by `_def.procedure`. */
interface ProcedureNode {
  readonly _def: { readonly procedure?: unknown; readonly type?: unknown }
}

function isProcedureNode(value: unknown): value is ProcedureNode {
  // A built tRPC procedure is a callable object — `_def.procedures`
  // stores the procedure function directly, not a wrapper object.
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const def: unknown = (value as { _def?: unknown })._def
  return (
    def !== null && typeof def === 'object' && (def as { procedure?: unknown }).procedure === true
  )
}

interface DiscoveredProcedure {
  readonly path: string
  readonly type: string
}

/**
 * Recursively flatten a tRPC router record to dotted procedure paths.
 * Robust to both layouts tRPC v11 may use for `_def.procedures`: a
 * nested record of sub-routers, or a flat record already keyed by
 * dotted path (a flat key simply yields its key verbatim).
 */
function collectProcedures(
  record: Readonly<Record<string, unknown>>,
  prefix: string,
  out: DiscoveredProcedure[],
): void {
  for (const [key, value] of Object.entries(record)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key
    if (isProcedureNode(value)) {
      const type = value._def.type
      out.push({ path, type: typeof type === 'string' ? type : 'query' })
    } else if (value !== null && typeof value === 'object') {
      collectProcedures(value as Readonly<Record<string, unknown>>, path, out)
    }
  }
}

type ProcedureInvoker = (input: unknown) => Promise<unknown>

/**
 * The MESH plane of the transport census.
 *
 * A `$core-caps` action is a `createCaller` invocation: it touches no socket,
 * builds no request, and was therefore invisible to any transport instrument by
 * construction. This is the whole in-process plane — `createDirectCaller`
 * exists in `addon-api-factory.ts` but no production call site builds one, so
 * wrapping here counts every mesh entry into the hub router.
 *
 * Disarmed it is one boolean read: `observe` returns before it looks at
 * anything, and the `principal` string is built INSIDE the guard.
 */
function countMeshCall(census: HttpRequestCensus, path: string, origin: CoreCapCallOrigin): void {
  if (!census.armed) return
  census.observe({
    plane: 'mesh',
    kind: 'call',
    procedures: [path],
    // A mesh call has no socket and no user-agent. Both render as the named
    // unknown rather than as a blank, which would read as a logging defect.
    userAgent: null,
    ip: null,
    principal: describeMeshOrigin(origin),
  })
}

/**
 * `mesh:<node> via <action>` — the closest thing an in-process call has to a
 * principal. Never a token: there is none, the mesh context is trusted by
 * construction (`createMeshTrpcContext`).
 */
export function describeMeshOrigin(origin: CoreCapCallOrigin): string {
  const node = origin.nodeId ?? 'unknown'
  return origin.caller === null ? `mesh:${node}` : `mesh:${node} via ${origin.caller}`
}

/**
 * Navigate the decorated caller record (a recursive proxy) to the
 * procedure function at `path`. Every node on the proxy is callable,
 * so navigation uses `Reflect.get` across both objects and functions.
 */
function resolveInvoker(caller: unknown, path: string): ProcedureInvoker | null {
  let node: unknown = caller
  for (const segment of path.split('.')) {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return null
    // Documented boundary: `node` is an object or function past the
    // guard above; `Reflect.get` is typed for `object` targets.
    node = Reflect.get(node as object, segment)
  }
  return typeof node === 'function' ? (node as ProcedureInvoker) : null
}

/** Options of {@link buildCoreCapService}. */
export interface CoreCapServiceBuildOptions {
  /**
   * The hub's own Moleculer node id. A call whose origin is another node runs
   * under the principal `node:<id>` and may not reach
   * {@link REMOTE_DENIED_NAMESPACES} or paths outside
   * {@link REMOTE_PRIVILEGE_ALLOWLIST}. Omitted → every origin is treated as the
   * hub's own (single-node test brokers).
   */
  readonly ownNodeId?: string
  /**
   * The scoped grant for `addons.updatePackage` (D842). Present → a node may call
   * that one path, on its own node and to the hub's recorded version only;
   * absent → the path stays refused like any other outside the allowlist.
   */
  readonly remoteUpdateGrant?: RemoteUpdateGrantDeps
}

/**
 * Build the `$core-caps` Moleculer service schema from the hub
 * appRouter. Query + mutation procedures in {@link CORE_NAMESPACES} are
 * exposed; subscriptions are skipped (the broker transport is
 * request/reply only).
 *
 * Each call runs under a principal naming its origin (D802): `mesh` for the
 * hub's own runners, `node:<nodeId>` for another node.
 */
export function buildCoreCapService(
  appRouter: AppRouter,
  census: HttpRequestCensus = getHttpRequestCensus(),
  options: CoreCapServiceBuildOptions = {},
): ServiceSchema {
  const callerFactory = createCallerFactory(appRouter)
  const callers = new Map<string, unknown>()
  const callerFor = (principal: string): unknown => {
    let caller = callers.get(principal)
    if (caller === undefined) {
      caller = callerFactory(createMeshTrpcContext(principal))
      callers.set(principal, caller)
    }
    return caller
  }

  const discovered: DiscoveredProcedure[] = []
  collectProcedures(appRouter._def.procedures, '', discovered)

  const actions: CoreCapAction[] = []
  for (const { path, type } of discovered) {
    const dot = path.indexOf('.')
    if (dot < 0) continue
    const namespace = path.slice(0, dot)
    if (!CORE_NAMESPACES.has(namespace)) continue
    if (type === 'subscription') continue
    if (resolveInvoker(callerFor('mesh'), path) === null) continue

    const method = path.slice(dot + 1)
    actions.push({
      actionName: `${toKebab(namespace)}.${method}`,
      invoke: async (input, origin) => {
        countMeshCall(census, path, origin)
        const remoteNode = remoteOrigin(origin, options.ownNodeId)
        if (remoteNode !== null && REMOTE_DENIED_NAMESPACES.has(namespace)) {
          throw new Errors.MoleculerClientError(
            `"${path}" is not callable from another node (caller "${remoteNode}")`,
            403,
            CORE_CAP_REMOTE_FORBIDDEN_TYPE,
          )
        }
        if (remoteNode !== null) {
          if (REMOTE_PRIVILEGE_LOG_ONLY) {
            observeRemotePrivilege(remoteNode, path)
          } else if (path === REMOTE_UPDATE_PACKAGE_PATH && options.remoteUpdateGrant) {
            const decision = await authorizeRemoteUpdatePackage(
              remoteNode,
              input,
              options.remoteUpdateGrant,
            )
            if (!decision.allowed) {
              throw new Errors.MoleculerClientError(
                `"${path}" refused for caller "${remoteNode}": ${decision.reason ?? 'not permitted'}`,
                403,
                CORE_CAP_REMOTE_FORBIDDEN_TYPE,
              )
            }
          } else if (!REMOTE_PRIVILEGE_ALLOWLIST.has(path)) {
            observeRemotePrivilegeRefused(remoteNode, path)
            throw new Errors.MoleculerClientError(
              `"${path}" is not on the remote privilege grant (caller "${remoteNode}")`,
              403,
              CORE_CAP_REMOTE_FORBIDDEN_TYPE,
            )
          }
        }
        const invoke = resolveInvoker(
          callerFor(remoteNode === null ? 'mesh' : `node:${remoteNode}`),
          path,
        )
        if (invoke === null) throw new Error(`$core-caps: "${path}" is not invocable`)
        return invoke(input)
      },
    })
  }

  return createCoreCapService({ actions })
}

/** The calling node when it is not the hub itself; `null` for the hub's own calls. */
function remoteOrigin(origin: CoreCapCallOrigin, ownNodeId: string | undefined): string | null {
  if (ownNodeId === undefined || origin.nodeId === null) return null
  return origin.nodeId === ownNodeId ? null : origin.nodeId
}
