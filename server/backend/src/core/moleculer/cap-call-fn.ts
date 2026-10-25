/**
 * cap-call-fn — the per-(cap, node) dispatcher behind every CapabilityRegistry
 * provider proxy the hub builds in `applyNodeManifest`.
 *
 * Extracted from `MoleculerService` so its routing branches are unit-testable
 * in isolation (the closure that lived inline could only be exercised by
 * standing up a full broker). It closes a UDS-migration gap: the inline
 * version hand-rolled a `broker.call` for any non-hub-local provider, so an
 * AGENT-hosted addon cap (a UDS child of the agent, NOT a Moleculer service)
 * resolved to a Moleculer node that does not exist → `waitForServices` waited
 * its full 30s discovery timeout → "Services waiting is timed out". The fix
 * routes everything that isn't a hub-local child through the unified
 * `CapRouteResolver`, which classifies an agent node as `agent-child-forward`
 * (hub → agent over Moleculer → agent's UDS child) and a direct remote as
 * `remote-moleculer`.
 */
import { CALLER_STAMPED_CAPABILITIES } from '@camstack/types'
import type { CallFn, CapRoute, CapRouteOpts, CapCallInput } from '@camstack/system'

/** Minimal LocalChildRegistry surface this dispatcher needs (per-child UDS). */
export interface CapCallFnLocalChild {
  childProvides(childId: string, capName: string, deviceId?: number): boolean
  callCapOnChild(childId: string, input: CapCallInput): Promise<unknown>
}

/** Minimal CapRouteResolver surface this dispatcher needs. */
export interface CapCallFnResolver {
  resolveCapRoute(capName: string, opts: CapRouteOpts): CapRoute
  dispatch(
    route: CapRoute,
    method: string,
    args: unknown,
    addonId?: string,
    callerAddonId?: string,
  ): Promise<unknown>
}

export interface CapCallFnDeps {
  /** The capability this dispatcher routes. */
  readonly capName: string
  /**
   * The addonId of the provider this dispatcher fronts. Carried as the
   * out-of-band provider-selection hint on the UDS cap-call so a GROUPED
   * runner hosting two providers of the SAME collection cap (e.g.
   * `network-access` from cloudflare-tunnel AND tailscale-ingress in the
   * `net-access` group) dispatches to the provider the hub resolved — the
   * collection mount strips `addonId` from the method args before the call.
   */
  readonly addonId?: string
  /** The registering node's id (the agent node for agent-hosted providers). */
  readonly nodeId: string
  /**
   * Runner id of the hub-local UDS child that owns this provider, or `null`
   * for agent-hosted / remote providers. Only hub-local children are reachable
   * over UDS.
   */
  readonly udsChildId: string | null
  /** Live getter for the UDS child registry (`null` if the UDS server is down). */
  readonly getLocalChildRegistry: () => CapCallFnLocalChild | null
  /** Live getter for the resolver (`null` before `onModuleInit` builds it). */
  readonly getResolver: () => CapCallFnResolver | null
  /** Legacy Moleculer call — used ONLY in the pre-init window (no resolver yet). */
  readonly legacyBrokerCall: (
    method: string,
    params: unknown,
    targetNodeId: string,
  ) => Promise<unknown>
  /** Optional diagnostic hook fired the first time this cap routes over UDS. */
  readonly onUdsRoute?: (capName: string) => void
}

/** Extract a numeric `deviceId` routing hint out of arbitrary method args. */
function extractDeviceId(params: unknown): number | undefined {
  if (params === null || typeof params !== 'object') return undefined
  const raw: unknown = Reflect.get(params, 'deviceId')
  return typeof raw === 'number' ? raw : undefined
}

/**
 * Hub in-process builtins state `callerAddonId` in args (see
 * `AddonRegistryService.inProcessRecordsTransport`). A registry proxy routes
 * over UDS; without lifting this to {@link CapCallInput.callerAddonId} the
 * child strips the claim (`stampCallerAddonId` with no wire stamp) and records
 * refuses `no-caller`.
 */
function extractStatedCallerAddonId(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined
  const raw: unknown = Reflect.get(params, 'callerAddonId')
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/**
 * Build the `CallFn` (`(method, params, targetNodeId?) => Promise`) for one
 * registered provider. See module docs for the routing rationale.
 */
export function buildCapCallFn(deps: CapCallFnDeps): CallFn {
  return async (method: string, params: unknown, targetNodeId?: string): Promise<unknown> => {
    const deviceId = extractDeviceId(params)

    // ── Hub-local child: route per-child over UDS (collection-safe — keyed by
    //    the specific child, not by capName which would collapse a collection
    //    cap onto the first child). NEVER fall back to Moleculer: a hub-local
    //    child is not a Moleculer service, so a broker call would wait the full
    //    discovery timeout for a node that never appears. If the child isn't
    //    currently providing the cap, fail fast.
    if (deps.udsChildId !== null && targetNodeId === undefined) {
      const registry = deps.getLocalChildRegistry()
      if (registry !== null && registry.childProvides(deps.udsChildId, deps.capName, deviceId)) {
        deps.onUdsRoute?.(deps.capName)
        const statedCaller = CALLER_STAMPED_CAPABILITIES.includes(deps.capName)
          ? extractStatedCallerAddonId(params)
          : undefined
        const input: CapCallInput = {
          capName: deps.capName,
          method,
          args: params,
          ...(deviceId !== undefined ? { deviceId } : {}),
          ...(deps.addonId !== undefined ? { addonId: deps.addonId } : {}),
          ...(statedCaller !== undefined ? { callerAddonId: statedCaller } : {}),
        }
        return registry.callCapOnChild(deps.udsChildId, input)
      }
      throw new Error(
        `hub-local child "${deps.udsChildId}" does not currently provide cap "${deps.capName}"`,
      )
    }

    // ── Agent-hosted or explicit remote: delegate to the unified resolver.
    // `deps.addonId` rides along as the out-of-band provider-selection hint
    // (Task 7.5a) — the twin of the `addonId: deps.addonId` stamped onto the
    // hub-local UDS input above. Only `agent-child-forward` routes consume it
    // (`CapRouteResolver.dispatch`'s addonId param); a `remote-moleculer` route
    // already encodes the provider in its Moleculer action name, so passing it
    // there is a harmless no-op.
    const resolver = deps.getResolver()
    if (resolver !== null) {
      const statedCaller = CALLER_STAMPED_CAPABILITIES.includes(deps.capName)
        ? extractStatedCallerAddonId(params)
        : undefined
      const route = resolver.resolveCapRoute(deps.capName, {
        nodeId: targetNodeId ?? deps.nodeId,
        ...(deviceId !== undefined ? { deviceId } : {}),
      })
      return resolver.dispatch(route, method, params, deps.addonId, statedCaller)
    }

    // ── Pre-init window (resolver not yet constructed): legacy Moleculer call.
    return deps.legacyBrokerCall(method, params, targetNodeId ?? deps.nodeId)
  }
}
