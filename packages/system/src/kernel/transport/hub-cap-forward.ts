/**
 * `$hub-cap-fwd` — the hub-side Moleculer service that lets a REMOTE agent reach
 * a cap the hub routes (hub-in-process, a hub-local UDS child like `stream-broker`
 * / `settings-store`, or even another agent via the hub's resolver).
 *
 * It is the exact symmetric inverse of `$agent-cap-fwd` (hub→agent forward,
 * `agent-cap-dispatch-service.ts`): where the agent service fans a hub-dispatched
 * call into the agent's own UDS subtree, THIS service fans an agent-originated
 * call into the HUB's routing (`onUnownedCall`). Without it a forked addon on an
 * agent that calls `ctx.api.<hubCap>.<method>` falls to raw Moleculer service
 * discovery for `${cap}.*` — which does NOT exist, because hub-local addon
 * runners register NO Moleculer service (UDS-only) — and 30s-deadlines
 * (`trpc-links.ts` "discovery deadline exceeded"). See
 * docs/superpowers/2026-07-02-crossnode-hub-cap-forward-design.md.
 *
 * The `forward` handler simply invokes the hub's EXISTING `onUnownedCall`
 * handler (`createParentUnownedCallHandler`) — the same battle-tested path the
 * hub already uses to route its own forked children's unowned calls
 * (resolver-first: hub-in-process → hub-local-uds → remote; broker-fallback for
 * the hub's `$`-core services). So the agent gets the hub's full routing for
 * free, with no duplication.
 */

import type { ServiceSchema, Context } from 'moleculer'
import type { CapCallInput } from './child-cap-protocol.js'

/** The Moleculer service name the hub registers for agent→hub cap forwarding. */
export const HUB_CAP_FWD_SERVICE = '$hub-cap-fwd' as const

/** The Moleculer action (service.action) for hub cap forwarding. */
export const HUB_CAP_FWD_ACTION: string = `${HUB_CAP_FWD_SERVICE}.forward`

/**
 * Params envelope an agent sends to `$hub-cap-fwd.forward`. Mirrors
 * {@link CapCallInput} (the hub's onUnownedCall input): `capName` + `method` are
 * required; `args` passes through; `deviceId` / `nodeId` are optional routing
 * hints the hub's resolver honours.
 */
export interface HubCapForwardParams {
  readonly capName: string
  readonly method: string
  readonly args: unknown
  readonly deviceId?: number
  readonly nodeId?: string
  /**
   * Native-only routing hint (see `CapCallOutMessage.native`). An agent has no
   * native authority of its own, so a forked wrapper on an agent asking for a
   * per-device native forwards the question here. It MUST survive the envelope:
   * without it the hub resolves the cap NAME, i.e. the wrapper the caller is
   * trying to skip.
   */
  readonly native?: boolean
  /**
   * The ORIGINATING addon, stamped by the AGENT's `LocalChildRegistry` off the
   * child connection the call arrived on (D787) — the agent-side equivalent of
   * what the hub's own registry stamps for a hub-local child. The hub believes
   * it only from a node that joined the mesh (D802: challenge–response; in
   * `transition` an unauthenticated node is tolerated) and only when that
   * node's registered manifest hosts the runner ({@link HubCapForwardOptions}).
   * Absent → the call is anonymous, and an owner-checked cap refuses it.
   */
  readonly callerAddonId?: string
}

/** How the hub decides whether an agent's caller stamp is believable. */
export interface HubCapForwardOptions {
  /**
   * Is `callerAddonId` (a runner id) actually running on `nodeId`, the agent
   * this request came from? A stamp that fails the check is DROPPED — the call
   * proceeds anonymous, it is not refused here. Omitted → stamps are trusted
   * as the cluster secret already authenticates the node.
   */
  readonly isCallerOnNode?: (nodeId: string, callerAddonId: string) => boolean
  /** Told about a dropped stamp — a misrouted or lying runner deserves a line. */
  readonly onRejectedCaller?: (nodeId: string, callerAddonId: string) => void
}

/**
 * Drop a `caller` the forwarded args carry. `caller` is the USER identity the
 * hub's tRPC router injects for `caller: 'required'` methods
 * (`cap-router-builder.ts`), and providers trust it — `keychainAdmin.reveal`
 * reads `input.caller.userId`. A call that arrives over the mesh has no user
 * session behind it, so whatever `caller` it carries is forged (D802). The
 * args' `callerAddonId` is overwritten or stripped further down by
 * `stampCallerAddonId`; `caller` had no such guard.
 */
export function stripForwardedCaller(args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  if (!Object.prototype.hasOwnProperty.call(args, 'caller')) return args
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'caller') rest[key] = value
  }
  return rest
}

/**
 * Narrow Moleculer's loosely-typed `ctx.params` to {@link HubCapForwardParams}
 * without unsafe casts — mirrors `agent-cap-dispatch-service.ts:narrowParams`.
 */
function narrowParams(raw: unknown): HubCapForwardParams {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(
      '$hub-cap-fwd.forward: invalid params — capName and method are required strings',
    )
  }
  const capName: unknown = Reflect.get(raw, 'capName')
  const method: unknown = Reflect.get(raw, 'method')
  if (typeof capName !== 'string' || typeof method !== 'string') {
    throw new Error(
      '$hub-cap-fwd.forward: invalid params — capName and method are required strings',
    )
  }
  const deviceId: unknown = Reflect.get(raw, 'deviceId')
  const nodeId: unknown = Reflect.get(raw, 'nodeId')
  const native: unknown = Reflect.get(raw, 'native')
  const callerAddonId: unknown = Reflect.get(raw, 'callerAddonId')
  return {
    capName,
    method,
    args: stripForwardedCaller(Reflect.get(raw, 'args')),
    deviceId: typeof deviceId === 'number' ? deviceId : undefined,
    nodeId: typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : undefined,
    native: native === true ? true : undefined,
    callerAddonId:
      typeof callerAddonId === 'string' && callerAddonId.length > 0 ? callerAddonId : undefined,
  }
}

/**
 * Handler that routes an agent-originated cap call through the hub's own
 * unowned-call routing. Structurally the hub's `onUnownedCall`.
 */
export type HubUnownedCallHandler = (input: CapCallInput) => Promise<unknown>

/**
 * Build the `$hub-cap-fwd` Moleculer `ServiceSchema`. The hub registers this on
 * its broker (only the hub registers it → an agent's `broker.call` for
 * `$hub-cap-fwd.forward` discovers it on the hub with no explicit nodeID pin).
 *
 * @param onUnownedCall  The hub's cap routing handler (from
 *                       `createParentUnownedCallHandler`). Reused verbatim so
 *                       forwarded calls route exactly like a hub-local child's.
 */
export function createHubCapForwardService(
  onUnownedCall: HubUnownedCallHandler,
  options: HubCapForwardOptions = {},
): ServiceSchema {
  return {
    name: HUB_CAP_FWD_SERVICE,
    actions: {
      forward: {
        handler: async (ctx: Context): Promise<unknown> => {
          const { capName, method, args, deviceId, nodeId, native, callerAddonId } = narrowParams(
            ctx.params,
          )
          const sender = typeof ctx.nodeID === 'string' ? ctx.nodeID : null
          let caller = callerAddonId
          if (
            caller !== undefined &&
            options.isCallerOnNode !== undefined &&
            (sender === null || !options.isCallerOnNode(sender, caller))
          ) {
            options.onRejectedCaller?.(sender ?? '(unknown node)', caller)
            caller = undefined
          }
          const input: CapCallInput = {
            capName,
            method,
            args,
            ...(deviceId !== undefined ? { deviceId } : {}),
            ...(nodeId !== undefined ? { nodeId } : {}),
            ...(native === true ? { native: true } : {}),
            ...(caller !== undefined ? { callerAddonId: caller } : {}),
          }
          return onUnownedCall(input)
        },
      },
    },
  }
}
