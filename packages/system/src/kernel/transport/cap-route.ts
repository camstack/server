/**
 * Discriminated union describing HOW a capName call should be dispatched.
 * Every variant carries `capName` so a resolved route is a self-contained
 * dispatch descriptor.  `method` is a dispatch-time concern supplied separately
 * to the dispatcher — it does not belong on the route.
 *
 * This file is intentionally import-free — no broker/registry deps — so it can
 * be imported from both the hub and agent without pulling the full kernel graph.
 */

// ---------------------------------------------------------------------------
// Shared fields present on every route variant
// ---------------------------------------------------------------------------

export interface CapRouteBase {
  readonly capName: string
}

// ---------------------------------------------------------------------------
// hub-in-process
// ---------------------------------------------------------------------------

/**
 * A typed thunk that invokes a method on a provider that lives in the current
 * process. Using an invoker thunk instead of a raw `object` avoids `as`-casts
 * at every dispatch site: the resolver builds the thunk once (knowing the
 * provider's concrete type), and every consumer calls `ref.invoke(method, args)`
 * without any type assertion.
 */
export type CapInvoker = (method: string, args: unknown) => Promise<unknown>

export interface InProcessProviderRef {
  readonly invoke: CapInvoker
}

export interface HubInProcessRoute extends CapRouteBase {
  readonly kind: 'hub-in-process'
  readonly ref: InProcessProviderRef
}

// ---------------------------------------------------------------------------
// hub-local-uds
// ---------------------------------------------------------------------------

export interface HubLocalUdsRoute extends CapRouteBase {
  readonly kind: 'hub-local-uds'
  readonly childId: string
}

// ---------------------------------------------------------------------------
// remote-moleculer
// ---------------------------------------------------------------------------

export interface RemoteMoleculerRoute extends CapRouteBase {
  readonly kind: 'remote-moleculer'
  readonly nodeId: string
}

// ---------------------------------------------------------------------------
// agent-child-forward
// ---------------------------------------------------------------------------

export interface AgentChildForwardRoute extends CapRouteBase {
  readonly kind: 'agent-child-forward'
  readonly agentNodeId: string
  /** Optional: the hub cannot resolve which forked child under an agent provides the cap.
   * The agent resolves its own child locally (Task 6). */
  readonly childId?: string
}

// ---------------------------------------------------------------------------
// CapRoute union
// ---------------------------------------------------------------------------

export type CapRoute =
  | HubInProcessRoute
  | HubLocalUdsRoute
  | RemoteMoleculerRoute
  | AgentChildForwardRoute

// ---------------------------------------------------------------------------
// CapRouteError
// ---------------------------------------------------------------------------

export type CapRouteReason = 'no-provider' | 'node-offline' | 'cap-unknown' | 'transport-failed'

export interface RejectedRoute {
  readonly kind: string
  readonly why: string
}

export interface CapRouteErrorDetail {
  readonly reason: CapRouteReason
  readonly nodeId?: string
  readonly rejected: readonly RejectedRoute[]
}

function buildMessage(
  capName: string,
  method: string | undefined,
  detail: CapRouteErrorDetail,
): string {
  const call = method !== undefined ? `${capName}.${method}` : capName
  const target = detail.nodeId !== undefined ? ` to node ${detail.nodeId}` : ''
  const rejectedStr = detail.rejected.map((r) => `${r.kind}=${r.why}`).join('; ')
  const rejectedClause = rejectedStr.length > 0 ? ` (rejected: ${rejectedStr})` : ''
  return `${call} not routable${target}: ${detail.reason}${rejectedClause}`
}

export class CapRouteError extends Error {
  readonly reason: CapRouteReason
  readonly nodeId: string | undefined
  readonly rejected: readonly RejectedRoute[]

  /**
   * @param cause  Optional original error that triggered this routing failure.
   *               Stored as `Error.cause` (TC39 standard option, Node 16.9+).
   *               Dispatchers wrapping transport errors MUST pass the original.
   */
  constructor(
    capName: string,
    method: string | undefined,
    detail: CapRouteErrorDetail,
    cause?: Error,
  ) {
    super(buildMessage(capName, method, detail), cause !== undefined ? { cause } : undefined)
    this.name = 'CapRouteError'
    this.reason = detail.reason
    this.nodeId = detail.nodeId
    this.rejected = detail.rejected
  }
}

// ---------------------------------------------------------------------------
// CapRouteSnapshot — injected predicate/accessor interface (pure, no I/O)
// ---------------------------------------------------------------------------

/**
 * A read-only snapshot of the registry state needed to classify a route.
 * All fields are predicates or accessors — no live broker/registry deps.
 *
 * `getInProcessProviderRef` is OPTIONAL: the plan's table-driven test literal
 * omits it because none of the 4 plan cases hit the hub-in-process branch.
 * When present, the function calls it; when absent (or returns null), the
 * hub-in-process branch falls through to a `no-provider` CapRouteError instead
 * of using an unsafe cast.  This keeps the union type-safe without casts.
 *
 * `listKnownNodeIds` is OPTIONAL: used for singleton resolution (no nodeId
 * given) to find a remote node that knows the cap. When absent, remote
 * singleton resolution is skipped (no remote-moleculer route for singletons).
 *
 * `getHubLocalChildId` is OPTIONAL: resolves the runner childId of the
 * hub-local child that provides this cap. When absent or returns null, the
 * hub-local-uds branch falls through to a `no-provider` CapRouteError.
 *
 * `getAgentChildId` is OPTIONAL: resolves the runner childId of the agent's
 * child that provides this cap. When absent or returns null, the
 * agent-child-forward branch falls through to a `no-provider` CapRouteError.
 */
export interface CapRouteSnapshot {
  /** The nodeId that represents the hub itself in the mesh. */
  readonly hubNodeId: string
  /**
   * Returns true if a hub-local UDS child process provides this cap.
   * The optional `deviceId` is a routing hint for device-scoped native caps:
   * a child that owns only a specific device's cap will match on (capName, deviceId)
   * while a singleton provider (no deviceId on the descriptor) matches on capName alone.
   */
  readonly hubLocalChildProvides: (cap: string, deviceId?: number) => boolean
  /** Returns true if the hub host process provides this cap in-process. */
  readonly hubInProcessProvides: (cap: string) => boolean
  /** Returns true if the given node knows (registers) the given cap. */
  readonly nodeKnowsCap: (nodeId: string, cap: string) => boolean
  /** Returns true if the given nodeId is an agent node (not a hub-local child). */
  readonly nodeIsAgent: (nodeId: string) => boolean
  /** Returns true if the given node is currently online/reachable. */
  readonly nodeOnline: (nodeId: string) => boolean
  /**
   * Optional: resolves a concrete InProcessProviderRef for an in-process cap.
   * Required to actually produce a HubInProcessRoute.  When absent or returns
   * null, classifyCapRoute throws no-provider rather than casting.
   */
  readonly getInProcessProviderRef?: (cap: string) => InProcessProviderRef | null
  /**
   * Optional NODE-ACCURATE variant of `hubInProcessProvides`, consulted ONLY
   * for an EXPLICIT hub pin (`opts.nodeId === hubNodeId`). Returns true only
   * when a provider physically resident on the hub node exists.
   *
   * Rationale: `hubInProcessProvides` may be backed by the cluster-elected
   * ACTIVE singleton — which can be a REMOTE-proxy provider registered in the
   * hub registry. That is correct for UNPINNED dispatch (election adherence)
   * but must NOT satisfy an explicit `nodePin('hub')`: dispatching the remote
   * proxy as "hub-in-process" silently executes the call on another node
   * (the shm frame-plane cross-node decoder-session storm). When absent,
   * classifyExplicitNode falls back to `hubInProcessProvides` (legacy).
   */
  readonly hubResidentProvides?: (cap: string) => boolean
  /**
   * Optional: resolves the InProcessProviderRef of a HUB-RESIDENT provider
   * (paired with `hubResidentProvides` — same node-accuracy contract). Used
   * instead of `getInProcessProviderRef` when `hubResidentProvides` is set.
   */
  readonly getHubResidentProviderRef?: (cap: string) => InProcessProviderRef | null
  /**
   * Optional: enumerates all known remote nodeIds for singleton cap resolution
   * (the case where no explicit nodeId is given by the caller).
   */
  readonly listKnownNodeIds?: () => readonly string[]
  /**
   * Optional: resolves the runner childId of the hub-local child that provides this cap.
   * The optional `deviceId` is a routing hint for device-scoped native caps (same semantics
   * as `hubLocalChildProvides`).
   */
  readonly getHubLocalChildId?: (cap: string, deviceId?: number) => string | null
  /** Optional: resolves the runner childId of the agent's child that provides this cap. */
  readonly getAgentChildId?: (agentNodeId: string, cap: string) => string | null
}

// ---------------------------------------------------------------------------
// CapRouteOpts — named type for classifyCapRoute options
// ---------------------------------------------------------------------------

export interface CapRouteOpts {
  readonly nodeId?: string
  /** Numeric device id — a routing hint for device-scoped native caps. */
  readonly deviceId?: number
}

// ---------------------------------------------------------------------------
// classifyCapRoute — pure decision function, no I/O
// ---------------------------------------------------------------------------

/**
 * Classifies a (capName, opts) pair into a typed CapRoute dispatch descriptor.
 *
 * Precedence (explicit nodeId path):
 *   1. hub-in-process — hub node + hubInProcessProvides
 *   2. hub-local-uds  — hub node + hubLocalChildProvides
 *   3. node-offline   → CapRouteError{reason:'node-offline'}
 *   4. agent-child-forward — node is an agent AND nodeKnowsCap
 *   5. remote-moleculer — any other online non-agent node
 *
 * Singleton path (no nodeId):
 *   1. hub-in-process (hub provides in-process)
 *   2. hub-local-uds  (a hub-local UDS child provides it)
 *   3. remote-moleculer (any online, non-hub node that knows it)
 *   4. → CapRouteError{reason:'no-provider', rejected: all considered routes}
 *
 * PURE: no side effects, no async, no broker/registry imports.
 */
export function classifyCapRoute(
  capName: string,
  opts: CapRouteOpts,
  snapshot: CapRouteSnapshot,
): CapRoute {
  const rejected: RejectedRoute[] = []

  if (opts.nodeId !== undefined) {
    return classifyExplicitNode(capName, opts.nodeId, opts.deviceId, snapshot, rejected)
  }
  return classifySingleton(capName, opts.deviceId, snapshot, rejected)
}

function classifyExplicitNode(
  capName: string,
  nodeId: string,
  deviceId: number | undefined,
  snap: CapRouteSnapshot,
  rejected: RejectedRoute[],
): CapRoute {
  const isHub = nodeId === snap.hubNodeId

  if (isHub) {
    // Priority 1: hub-in-process — NODE-ACCURATE when the snapshot provides
    // the hub-resident accessors. An explicit hub pin must never be served by
    // the elected-singleton lookup, whose provider object can be a REMOTE
    // proxy (see `hubResidentProvides` docs — the cross-node shm decode bug).
    const residentProvides = snap.hubResidentProvides
    const providesOnHub = residentProvides ?? snap.hubInProcessProvides
    const getRef =
      residentProvides !== undefined ? snap.getHubResidentProviderRef : snap.getInProcessProviderRef
    if (providesOnHub(capName)) {
      const ref = getRef?.(capName) ?? null
      if (ref !== null) {
        return { kind: 'hub-in-process', capName, ref }
      }
      // ref accessor absent or returned null — cannot build HubInProcessRoute safely
      rejected.push({ kind: 'hub-in-process', why: 'provider ref not available in snapshot' })
      throw new CapRouteError(capName, undefined, { reason: 'no-provider', nodeId, rejected })
    }

    // Priority 2: hub-local UDS child (deviceId-aware for device-scoped native caps)
    if (snap.hubLocalChildProvides(capName, deviceId)) {
      const childId = snap.getHubLocalChildId?.(capName, deviceId) ?? null
      if (childId !== null) {
        return { kind: 'hub-local-uds', capName, childId }
      }
      rejected.push({ kind: 'hub-local-uds', why: 'child id not resolvable from snapshot' })
      throw new CapRouteError(capName, undefined, { reason: 'no-provider', nodeId, rejected })
    }

    // Neither in-process nor hub-local child provides this cap — emit in priority order
    rejected.push({ kind: 'hub-in-process', why: 'hub does not provide this cap in-process' })
    rejected.push({ kind: 'hub-local-uds', why: 'no hub-local child provides this cap' })
    throw new CapRouteError(capName, undefined, { reason: 'no-provider', nodeId, rejected })
  }

  // Non-hub node — liveness first
  if (!snap.nodeOnline(nodeId)) {
    rejected.push({ kind: 'remote-moleculer', why: `node ${nodeId} is offline` })
    throw new CapRouteError(capName, undefined, { reason: 'node-offline', nodeId, rejected })
  }

  if (snap.nodeIsAgent(nodeId)) {
    // An agent hosts caps only via its UDS children (verified topology). If the
    // agent's registry doesn't know the cap, there is no provider — fail diagnostically
    // rather than emitting a remote-moleculer route that would fail opaquely at dispatch.
    if (snap.nodeKnowsCap(nodeId, capName)) {
      // The hub cannot resolve which forked child under the agent provides this cap —
      // the agent flattens its subtree into one merged manifest. The agent resolves its
      // own child locally (Task 6). childId is therefore optional: present when the
      // hub authority happens to know it, absent (undefined) otherwise.
      const childId = snap.getAgentChildId?.(nodeId, capName) ?? undefined
      return { kind: 'agent-child-forward', capName, agentNodeId: nodeId, childId }
    }
    rejected.push({
      kind: 'agent-child-forward',
      why: `agent ${nodeId} does not know cap ${capName}`,
    })
    throw new CapRouteError(capName, undefined, { reason: 'no-provider', nodeId, rejected })
  }

  // Non-agent online remote node: trust the cluster to route it.
  return { kind: 'remote-moleculer', capName, nodeId }
}

function classifySingleton(
  capName: string,
  deviceId: number | undefined,
  snap: CapRouteSnapshot,
  rejected: RejectedRoute[],
): CapRoute {
  // 1. hub-in-process
  if (snap.hubInProcessProvides(capName)) {
    const ref = snap.getInProcessProviderRef?.(capName) ?? null
    if (ref !== null) {
      return { kind: 'hub-in-process', capName, ref }
    }
    rejected.push({ kind: 'hub-in-process', why: 'provider ref not available in snapshot' })
  } else {
    rejected.push({ kind: 'hub-in-process', why: 'hub does not provide this cap in-process' })
  }

  // 2. hub-local-uds (deviceId-aware for device-scoped native caps)
  if (snap.hubLocalChildProvides(capName, deviceId)) {
    const childId = snap.getHubLocalChildId?.(capName, deviceId) ?? null
    if (childId !== null) {
      return { kind: 'hub-local-uds', capName, childId }
    }
    rejected.push({ kind: 'hub-local-uds', why: 'child id not resolvable from snapshot' })
  } else {
    rejected.push({ kind: 'hub-local-uds', why: 'no hub-local child provides this cap' })
  }

  // 3. remote-moleculer — scan known nodes
  const knownNodes = snap.listKnownNodeIds?.() ?? []
  for (const nodeId of knownNodes) {
    if (
      nodeId !== snap.hubNodeId &&
      snap.nodeOnline(nodeId) &&
      snap.nodeKnowsCap(nodeId, capName)
    ) {
      return { kind: 'remote-moleculer', capName, nodeId }
    }
  }
  rejected.push({ kind: 'remote-moleculer', why: 'no online remote node knows this cap' })

  throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected })
}
