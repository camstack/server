/**
 * CapRouteResolver — builds a live CapRouteSnapshot from injected deps and
 * dispatches a resolved CapRoute to the appropriate transport.
 *
 * Layer boundary: this file lives in `@camstack/kernel` and MUST NOT import
 * from `server/backend`. All server-side state is injected via narrow named
 * interfaces (NodeCapAuthority, InProcessProviderLookup, BrokerHandle).
 *
 * Wire conventions (kept here as the single source of truth):
 *
 *   remote-moleculer dispatch
 *     action  : `${addonId}.${capName}.${method}`
 *     params  : methodArgs (passed through)
 *     options : { nodeID: route.nodeId, timeout: 60_000 }
 *     note    : addonId is resolved by NodeCapAuthority.getAddonId(nodeId, cap)
 *
 *   agent-child-forward dispatch
 *     service : `$agent-cap-fwd`
 *     action  : `$agent-cap-fwd.forward`
 *     params  : { capName, method, args, childId, deviceId? }
 *     options : { nodeID: route.agentNodeId, timeout: 60_000 }
 *     note    : Task 6's agent-side service MUST register the Moleculer service
 *               `$agent-cap-fwd` with action `forward` that accepts this shape
 *               and fans the call over UDS to route.childId.
 */

import { CALLER_STAMPED_CAPABILITIES } from '@camstack/types/addon'
import type { ServiceDiscoveryBroker } from '../moleculer/resilient-cap-call.js'
import { callWithServiceDiscovery } from '../moleculer/resilient-cap-call.js'
import { capActionName } from './cap-action-name.js'
import type {
  CapRoute,
  CapRouteOpts,
  CapRouteSnapshot,
  HubLocalUdsRoute,
  InProcessProviderRef,
} from './cap-route.js'
import { CapRouteError, classifyCapRoute } from './cap-route.js'
import type { CapCallInput } from './child-cap-protocol.js'
import { PeerAnsweredError } from './peer-answered-error.js'

// ---------------------------------------------------------------------------
// HubLocalChildDispatcher — minimal interface for UDS child dispatch
// ---------------------------------------------------------------------------

/**
 * Minimal surface of LocalChildRegistry that the resolver needs.
 * Keeping a narrow interface here prevents the resolver from depending on the
 * full LocalChildRegistry class and avoids `as unknown as` casts in tests.
 * The real `LocalChildRegistry` structurally satisfies this interface.
 */
export interface HubLocalChildDispatcher {
  /** Returns the childId that provides the cap, or null. */
  resolveChildId(capName: string, deviceId?: number): string | null
  /** Forwards a cap call to a specific child by id. */
  callCapOnChild(childId: string, input: CapCallInput): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Injected authority interfaces (defined here — NOT imported from server/backend)
// ---------------------------------------------------------------------------

/**
 * Minimal view of the cluster node registry needed to build a CapRouteSnapshot.
 * The concrete implementation (HubNodeRegistry) lives in server/backend and is
 * wired in by Task 4/5. Keeping this interface in kernel prevents a layering
 * inversion.
 */
export interface NodeCapAuthority {
  /** Returns true if the given node's latest manifest includes the given cap. */
  nodeKnowsCap(nodeId: string, capName: string): boolean
  /** Returns true if the given nodeId is an agent (bare id, no '/' separator). */
  nodeIsAgent(nodeId: string): boolean
  /** Returns true if the given node is currently connected/online. */
  nodeOnline(nodeId: string): boolean
  /** Returns all nodeIds currently in the registry. */
  listNodeIds(): readonly string[]
  /**
   * Returns the addonId for the provider that registered (nodeId, capName).
   * Used to build the Moleculer action `${addonId}.${capName}.${method}`.
   * Returns null when the node does not host the cap (should not happen if
   * nodeKnowsCap is true, but guard defensively).
   */
  getAddonId(nodeId: string, capName: string): string | null
  /**
   * Returns the childId (runner id) of the agent's UDS child that provides
   * the given cap. Only meaningful when nodeIsAgent(nodeId) is true.
   * Returns null when unknown.
   */
  getAgentChildId(agentNodeId: string, capName: string): string | null
  /**
   * Returns true if the (nodeId, capName, deviceId?) tuple is a device-scoped
   * NATIVE cap (vs. a system/manifest cap). When true, the remote-moleculer
   * dispatcher uses `capActionName(addonId, cap, method, true)` which expands to
   * `${addonId}.native-provider.${cap}.${method}` instead of the plain system-cap
   * action `${addonId}.${cap}.${method}`.
   * Implementations that do not track native caps should return false.
   */
  isNativeCap(nodeId: string, capName: string, deviceId?: number): boolean
}

/**
 * Injected lookup for providers that live in the hub host process.
 * Returns a ready-to-invoke InProcessProviderRef, or null if the cap is not
 * hosted in-process.
 */
export type InProcessProviderLookup = (capName: string) => InProcessProviderRef | null

// ---------------------------------------------------------------------------
// CapRouteResolverDeps — single named options object for the constructor
// ---------------------------------------------------------------------------

export interface CapRouteResolverDeps {
  /** The hub's own Moleculer nodeId (e.g. `'hub'`). */
  readonly hubNodeId: string
  /**
   * Minimal Moleculer broker surface: `call` + `waitForServices`.
   * Used for remote-moleculer and agent-child-forward dispatches.
   */
  readonly broker: ServiceDiscoveryBroker
  /**
   * Local UDS child dispatcher — routes hub-local-uds dispatches.
   * May be null when the UDS server failed to start.
   */
  readonly hubLocalRegistry: HubLocalChildDispatcher | null
  /**
   * Authority over which nodes are online and which caps they know.
   * Decouples the resolver from the concrete HubNodeRegistry class.
   */
  readonly nodeAuthority: NodeCapAuthority
  /**
   * Lookup for hub-in-process providers.
   * Decouples the resolver from CapabilityRegistry.
   */
  readonly inProcessProviders: InProcessProviderLookup
  /**
   * Optional NODE-ACCURATE lookup for providers physically resident on the
   * hub node — consulted ONLY when a call is EXPLICITLY pinned to the hub.
   * `inProcessProviders` may resolve the cluster-elected ACTIVE singleton
   * (a remote-proxy provider registered in the hub registry), which must not
   * satisfy a `nodePin('hub')`. See `CapRouteSnapshot.hubResidentProvides`.
   */
  readonly hubResidentProviders?: InProcessProviderLookup
  /**
   * Per-cap-method RPC timeout (ms). Lets a long-running cap method (e.g.
   * `model-convert.convert`, minutes) override the default 60s remote/forward
   * timeout that would otherwise kill it mid-run. Returns undefined to use the
   * default. Resolved from the cap definition's `methods[method].timeoutMs`.
   */
  readonly capTimeoutMs?: (capName: string, method: string) => number | undefined
}

// ---------------------------------------------------------------------------
// Agent-child-forward wire types (documented for Task 6)
// ---------------------------------------------------------------------------

/**
 * Params envelope sent to the agent's `$agent-cap-fwd.forward` Moleculer action.
 *
 * Task 6 MUST register a Moleculer service named `$agent-cap-fwd` with an
 * action `forward` that receives this payload, resolves `childId` in its own
 * LocalChildRegistry, and dispatches over UDS to that child.
 */
export interface AgentCapForwardParams {
  readonly capName: string
  readonly method: string
  readonly args: unknown
  /**
   * Optional: the hub cannot resolve which forked child under the agent provides the cap.
   * The agent resolves its own child locally (Task 6). Present when the hub authority
   * happens to know it, absent (undefined) when not.
   */
  readonly childId?: string
  readonly deviceId?: number
  /**
   * Out-of-band PROVIDER-selection hint — the twin of `CapCallMessage.addonId`
   * (Task 7.5a). A GROUPED runner (`execution.group`) on an AGENT can host two
   * co-located addons registering the SAME collection cap, exactly like the
   * hub-local-uds case (`LocalChildRegistry.toCapCall`'s `addonId`, threaded by
   * `buildCapCallFn`'s hub-local branch). Before this field existed, the hub had
   * no channel to carry the selector across the hub→agent envelope — grouped-
   * runner provider selection worked on the hub and silently fell back to
   * "whichever provider is first" on an agent. Absent → the agent dispatch falls
   * back to its sole provider for the cap (same fallback `child-cap-dispatch.ts`
   * already has for a call that never carried the hint).
   */
  readonly addonId?: string
}

/** The Moleculer service name that Task 6's agent registers. */
export const AGENT_CAP_FWD_SERVICE = '$agent-cap-fwd' as const

/** The Moleculer action (service.action) for agent cap forwarding. */
export const AGENT_CAP_FWD_ACTION: string = `${AGENT_CAP_FWD_SERVICE}.forward`

/** Default timeout for remote Moleculer cap calls (ms). */
const REMOTE_CALL_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Helper: parse a numeric deviceId out of arbitrary method args
// ---------------------------------------------------------------------------

export function extractDeviceId(args: unknown): number | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const raw: unknown = Reflect.get(args, 'deviceId')
  return typeof raw === 'number' ? raw : undefined
}

// ---------------------------------------------------------------------------
// Helper: parse an explicit node pin out of arbitrary method args
// ---------------------------------------------------------------------------

/**
 * Extract an inline `nodeId` string from a cap call's args — the per-call node
 * pin a forked addon expresses by carrying `nodeId` in the input (the SAME way
 * device-scoped caps carry `deviceId`, and the way the generated cap-router on
 * the hub already honours an inline pin). Mirrors {@link extractDeviceId}.
 *
 * This is the routing source for hub→remote-node EXECUTION pinning (e.g. the
 * benchmark addon running a synthetic/decoder workload ON a chosen agent). The
 * out-of-band `nodePin(op.context)` path does NOT survive the forked addon →
 * hub UDS link chain, so `onUnownedCall` reads the inline pin instead. Provider
 * methods that don't declare `nodeId` simply ignore the extra field (they
 * destructure the fields they need); methods that DO declare it (e.g.
 * `getEngineProvisioning({nodeId})`) still receive it unchanged.
 */
export function extractNodeId(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const raw: unknown = Reflect.get(args, 'nodeId')
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

// ---------------------------------------------------------------------------
// Helper: merge a caller-identity hint into a cap call's args
// ---------------------------------------------------------------------------

/**
 * Stamp the CALLER identity into a cap call's args — the SAME "provider
 * destructures what it needs and ignores the rest" convention
 * {@link extractNodeId} already relies on for the inline `nodeId` pin.
 *
 * The stamp is the transport's, never the caller's (D787):
 *  - a stamp (`callerAddonId` known to the transport) OVERWRITES whatever the
 *    args carry under that key;
 *  - NO stamp STRIPS the key: a call that crossed a wire with no identity the
 *    transport can vouch for must not arrive carrying a claimed one. The
 *    keychain owner-checks on this field, and until 2026-10-08 an unstamped
 *    call let a child's own `callerAddonId` through untouched.
 *
 * Hub-main in-process contexts that bypass tRPC (addon-registry's stated
 * transports) never reach this function. Co-located broker/agent callers
 * stamp here inside `localProviderLink` before the zero-copy invoke.
 * A non-object `args` (or `null`/array) is returned unchanged: there
 * is nowhere to attach a key, and nowhere one could hide.
 */
export function stampCallerAddonId(args: unknown, callerAddonId: string | undefined): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  if (callerAddonId !== undefined) return { ...args, callerAddonId }
  if (!Object.prototype.hasOwnProperty.call(args, 'callerAddonId')) return args
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'callerAddonId') rest[key] = value
  }
  return rest
}

/** Hub in-process transports state identity in args; lift it for the UDS wire field. */
function wireCallerAddonId(
  capName: string,
  args: unknown,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined) return explicit
  if (!CALLER_STAMPED_CAPABILITIES.includes(capName)) return undefined
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const raw: unknown = Reflect.get(args, 'callerAddonId')
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

// ---------------------------------------------------------------------------
// CapRouteResolver
// ---------------------------------------------------------------------------

export class CapRouteResolver {
  private readonly hubNodeId: string
  private readonly broker: ServiceDiscoveryBroker
  private readonly hubLocalRegistry: HubLocalChildDispatcher | null
  private readonly nodeAuthority: NodeCapAuthority
  private readonly inProcessProviders: InProcessProviderLookup
  private readonly hubResidentProviders?: InProcessProviderLookup
  private readonly capTimeoutMs?: (capName: string, method: string) => number | undefined
  private readonly snapshot: CapRouteSnapshot

  constructor(deps: CapRouteResolverDeps) {
    this.hubNodeId = deps.hubNodeId
    this.broker = deps.broker
    this.hubLocalRegistry = deps.hubLocalRegistry
    this.nodeAuthority = deps.nodeAuthority
    this.inProcessProviders = deps.inProcessProviders
    this.hubResidentProviders = deps.hubResidentProviders
    this.capTimeoutMs = deps.capTimeoutMs
    this.snapshot = this.buildSnapshot()
  }

  /** Per-call RPC timeout: the cap method's declared override, else the default. */
  private callTimeout(capName: string, method: string): number {
    return this.capTimeoutMs?.(capName, method) ?? REMOTE_CALL_TIMEOUT_MS
  }

  // -------------------------------------------------------------------------
  // resolveCapRoute — classify using the pre-built snapshot
  // -------------------------------------------------------------------------

  resolveCapRoute(capName: string, opts: CapRouteOpts): CapRoute {
    return classifyCapRoute(capName, opts, this.snapshot)
  }

  // -------------------------------------------------------------------------
  // resolveHubLocalUdsRoute — hub-local NATIVE child route, ignoring any
  // in-hub provider that shadows the cap name.
  // -------------------------------------------------------------------------

  /**
   * Resolve the hub-local-uds route for a cap owned by a forked hub-local
   * child, IGNORING any in-hub provider registered for the same cap name.
   *
   * `resolveCapRoute` gives Priority 1 to `hub-in-process`: when an in-hub
   * provider (e.g. a wrapper) is registered for the cap, the route always
   * classifies as `hub-in-process` and the hub-local-uds NATIVE child is never
   * reached. That is correct for the generic dispatch path (the wrapper is the
   * active provider), but WRONG for the native-cap fallback
   * (`setNativeFallback`), whose contract is to reach the NATIVE provider in
   * the forked vendor child so a wrapper can delegate to it. A wrapper cap
   * with a forked native (today: `snapshot`) otherwise resolves to the wrapper
   * itself, the native is never invoked, and the wrapper silently falls
   * through to its secondary strategy.
   *
   * This method consults ONLY the hub-local-child authority
   * (`hubLocalChildProvides` + `getHubLocalChildId`, both deviceId-aware), so
   * it returns the native child route regardless of any in-process shadow.
   * Returns null when no hub-local child owns `(capName, deviceId)` — the
   * caller then falls through to its remote-resolution branch.
   */
  resolveHubLocalUdsRoute(capName: string, deviceId?: number): HubLocalUdsRoute | null {
    if (!this.snapshot.hubLocalChildProvides(capName, deviceId)) return null
    const childId = this.snapshot.getHubLocalChildId?.(capName, deviceId) ?? null
    if (childId === null) return null
    return { kind: 'hub-local-uds', capName, childId }
  }

  // -------------------------------------------------------------------------
  // dispatch — route the call to the appropriate transport
  // -------------------------------------------------------------------------

  /**
   * @param addonId Optional out-of-band PROVIDER-selection hint (Task 7.5a):
   *   the addonId of the provider the CALLER already resolved (e.g.
   *   `buildCapCallFn`'s `deps.addonId` for a registered grouped-runner
   *   provider). Only meaningful for `agent-child-forward` — a `remote-moleculer`
   *   route already encodes the provider in its action name
   *   (`${addonId}.${cap}.${method}`, via `NodeCapAuthority.getAddonId`), and a
   *   `buildCapCallFn`'s direct UDS branch when it already knows the child.
   * @param callerAddonId Optional out-of-band CALLER-identity hint — the
   *   addon that ORIGINATED the call, distinct from `addonId` above (which
   *   names the resolved PROVIDER, not the caller). Set by
   *   `onUnownedCall` / `buildCapCallFn` from a stated in-process claim.
   *   `hub-in-process` merges it into `args`; `hub-local-uds` carries it on
   *   {@link CapCallInput.callerAddonId} so the child can stamp before invoke
   *   (without it, `stampCallerAddonId` strips an args-only claim).
   */
  async dispatch(
    route: CapRoute,
    method: string,
    args: unknown,
    addonId?: string,
    callerAddonId?: string,
  ): Promise<unknown> {
    try {
      return await this.dispatchInner(route, method, args, addonId, callerAddonId)
    } catch (err) {
      // CapRouteErrors (from classify or from dispatchInner validation) propagate unchanged.
      if (err instanceof CapRouteError) throw err
      // The call was ROUTED AND ANSWERED: a provider refusing by throwing is
      // its own sentence, never "not routable … transport-failed". In-process
      // there is no transport at all; over UDS the channel marks an answer.
      if (route.kind === 'hub-in-process' || err instanceof PeerAnsweredError) throw err

      // Everything else is a real transport failure: wrapped, with the cause.
      const nodeId = this.routeNodeId(route)
      const cause = err instanceof Error ? err : new Error(String(err))
      throw new CapRouteError(
        route.capName,
        method,
        {
          reason: 'transport-failed',
          nodeId,
          rejected: [{ kind: route.kind, why: cause.message }],
        },
        cause,
      )
    }
  }

  // -------------------------------------------------------------------------
  // private helpers
  // -------------------------------------------------------------------------

  /**
   * Inner dispatch: may throw CapRouteError (validation failures) or arbitrary
   * transport errors. The outer `dispatch` wraps non-CapRouteErrors.
   */
  private async dispatchInner(
    route: CapRoute,
    method: string,
    args: unknown,
    addonId?: string,
    callerAddonId?: string,
  ): Promise<unknown> {
    switch (route.kind) {
      case 'hub-in-process':
        return route.ref.invoke(method, stampCallerAddonId(args, callerAddonId))

      case 'hub-local-uds': {
        const registry = this.hubLocalRegistry
        if (registry === null) {
          throw new CapRouteError(route.capName, method, {
            reason: 'no-provider',
            rejected: [{ kind: 'hub-local-uds', why: 'UDS registry not available' }],
          })
        }
        const deviceId = extractDeviceId(args)
        const wireCaller = wireCallerAddonId(route.capName, args, callerAddonId)
        const input: CapCallInput = {
          capName: route.capName,
          method,
          args,
          ...(deviceId !== undefined ? { deviceId } : {}),
          ...(wireCaller !== undefined ? { callerAddonId: wireCaller } : {}),
        }
        return registry.callCapOnChild(route.childId, input)
      }

      case 'remote-moleculer': {
        const addonId = this.nodeAuthority.getAddonId(route.nodeId, route.capName)
        if (addonId === null) {
          throw new CapRouteError(route.capName, method, {
            reason: 'no-provider',
            nodeId: route.nodeId,
            rejected: [
              {
                kind: 'remote-moleculer',
                why: `no addonId known for ${route.nodeId}/${route.capName}`,
              },
            ],
          })
        }
        // Native device-scoped caps use a different Moleculer service name:
        // `${addonId}.native-provider.${cap}.${method}` vs plain `${addonId}.${cap}.${method}`.
        const deviceId = extractDeviceId(args)
        const isNative = this.nodeAuthority.isNativeCap(route.nodeId, route.capName, deviceId)
        const action = capActionName(addonId, route.capName, method, isNative)
        return callWithServiceDiscovery(this.broker, addonId, action, args, {
          nodeID: route.nodeId,
          timeout: this.callTimeout(route.capName, method),
        })
      }

      case 'agent-child-forward': {
        /*
         * Wire: hub calls the agent's `$agent-cap-fwd.forward` Moleculer action.
         * Service : `$agent-cap-fwd`  (AGENT_CAP_FWD_SERVICE)
         * Action  : `$agent-cap-fwd.forward`  (AGENT_CAP_FWD_ACTION)
         * Params  : AgentCapForwardParams
         * Options : { nodeID: route.agentNodeId, timeout: 60_000 }
         *
         * Task 6 MUST register a Moleculer service named `$agent-cap-fwd` on the
         * agent node with an action `forward` that:
         *   1. Resolves route.childId in the agent's own LocalChildRegistry.
         *   2. Dispatches the call over UDS to that child.
         *   3. Returns the child's response.
         */
        const deviceId = extractDeviceId(args)
        const params: AgentCapForwardParams = {
          capName: route.capName,
          method,
          args,
          ...(route.childId !== undefined ? { childId: route.childId } : {}),
          ...(deviceId !== undefined ? { deviceId } : {}),
          ...(addonId !== undefined ? { addonId } : {}),
        }
        return callWithServiceDiscovery(
          this.broker,
          AGENT_CAP_FWD_SERVICE,
          AGENT_CAP_FWD_ACTION,
          params,
          { nodeID: route.agentNodeId, timeout: this.callTimeout(route.capName, method) },
        )
      }
    }
  }

  private buildSnapshot(): CapRouteSnapshot {
    const hubLocalRegistry = this.hubLocalRegistry
    const nodeAuthority = this.nodeAuthority
    const inProcessProviders = this.inProcessProviders
    const hubResidentProviders = this.hubResidentProviders

    return {
      hubNodeId: this.hubNodeId,

      hubInProcessProvides: (cap: string): boolean => inProcessProviders(cap) !== null,

      ...(hubResidentProviders !== undefined
        ? {
            hubResidentProvides: (cap: string): boolean => hubResidentProviders(cap) !== null,
            getHubResidentProviderRef: (cap: string): InProcessProviderRef | null =>
              hubResidentProviders(cap),
          }
        : {}),

      hubLocalChildProvides: (cap: string, deviceId?: number): boolean =>
        hubLocalRegistry !== null && hubLocalRegistry.resolveChildId(cap, deviceId) !== null,

      nodeKnowsCap: (nodeId: string, cap: string): boolean =>
        nodeAuthority.nodeKnowsCap(nodeId, cap),

      nodeIsAgent: (nodeId: string): boolean => nodeAuthority.nodeIsAgent(nodeId),

      nodeOnline: (nodeId: string): boolean => nodeAuthority.nodeOnline(nodeId),

      listKnownNodeIds: (): readonly string[] => nodeAuthority.listNodeIds(),

      getInProcessProviderRef: (cap: string): InProcessProviderRef | null =>
        inProcessProviders(cap),

      getHubLocalChildId: (cap: string, deviceId?: number): string | null =>
        hubLocalRegistry !== null ? hubLocalRegistry.resolveChildId(cap, deviceId) : null,

      getAgentChildId: (agentNodeId: string, cap: string): string | null =>
        nodeAuthority.getAgentChildId(agentNodeId, cap),
    }
  }

  /** Extract a nodeId string from a route for error reporting, or undefined. */
  private routeNodeId(route: CapRoute): string | undefined {
    switch (route.kind) {
      case 'hub-in-process':
        return this.hubNodeId
      case 'hub-local-uds':
        return `${this.hubNodeId}/${route.childId}`
      case 'remote-moleculer':
        return route.nodeId
      case 'agent-child-forward':
        return route.agentNodeId
    }
  }
}
