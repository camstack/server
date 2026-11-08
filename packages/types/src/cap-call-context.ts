/**
 * Per-call node pinning for `ctx.api` capability calls.
 *
 * A capability call normally resolves to its DEFAULT provider — a `singleton`
 * cap resolves to the hub, a device-scoped cap to the device's owning node. To
 * query a SPECIFIC node's provider instead (e.g. a remote agent's own
 * in-process `platform-probe` hardware, which the hub cannot probe), pin the
 * call to that node.
 *
 * The nodeId rides OUT-OF-BAND in the tRPC call context (NOT in the validated
 * method args), so capability method signatures stay `nodeId`-free — node
 * targeting is a property of the CALL, not of the method. The transport lifts
 * it from `op.context` onto the `CapCallInput.nodeId` field (`ipcParentLink`),
 * and the hub parent's `onUnownedCall` passes it to the `CapRouteResolver`,
 * which classifies a pinned agent node as `agent-child-forward`
 * (`$agent-cap-fwd.forward` → the agent's in-process provider).
 *
 * Usage at a call site:
 *
 *   await api.platformProbe.getCapabilities.query(undefined, nodePin(nodeId))
 */

import { CommandOriginClaimSchema, type CommandOriginClaim } from './audit/device-transition.js'

/** tRPC `op.context` key carrying a per-call node pin. */
export const CAP_NODE_PIN_CONTEXT_KEY = '__camstackNodePin'

/** The tRPC request-options shape produced by {@link nodePin}. */
export interface NodePinnedRequestOptions {
  readonly context: Readonly<Record<string, string>>
}

/**
 * Build the tRPC request options that pin a single capability call to `nodeId`.
 * Pass as the second argument to `.query(input, …)` / `.mutate(input, …)`.
 *
 * ## The id is normalised here, and it has to be
 *
 * A forked addon reads its own node from `ctx.kernel.localNodeId`, and inside a
 * worker that value is a RUNNER id — `hub/export-hap`, not `hub`. Routing
 * compares a pin against real node ids, so such a pin matches nothing and the
 * call fails with `no provider registered for cap "…"`. The local-first
 * resolver already guarded against this (`localNodeId.split('/')[0]`), which
 * made the hazard invisible: unpinned calls worked, and only an explicit pin —
 * the thing you reach for when you specifically need THIS node — silently
 * addressed a node that does not exist.
 *
 * Cost of it being missing: `addon-export-hap` pinned `decoder.getInfo` to its
 * own node to read the host's hardware-decode backend. It never once answered,
 * so every HomeKit egress transcode decoded in SOFTWARE — including 4K H.265 —
 * while D67's whole premise was that the decoder addon is the authority on
 * hardware. The warn said `decoding in SOFTWARE` and read as "this node has no
 * hardware", which was false.
 *
 * Normalising in the ONE constructor fixes every caller at once, which is why
 * it is here and not at the call sites.
 */
export function nodePin(nodeId: string): NodePinnedRequestOptions {
  return { context: { [CAP_NODE_PIN_CONTEXT_KEY]: toNodeId(nodeId) } }
}

/**
 * A runner id is `<nodeId>/<addonId>`; a node id has no slash. Taking the head
 * is idempotent, so passing an already-clean id costs nothing.
 */
export function toNodeId(idOrRunnerId: string): string {
  const head = idOrRunnerId.split('/')[0]
  return head === undefined || head.length === 0 ? idOrRunnerId : head
}

/**
 * Read a per-call node pin out of a tRPC `op.context` (transport side).
 * Returns the pinned nodeId, or `undefined` when no pin is present.
 */
export function readNodePin(context: unknown): string | undefined {
  if (context === null || typeof context !== 'object') return undefined
  const value: unknown = Reflect.get(context, CAP_NODE_PIN_CONTEXT_KEY)
  return typeof value === 'string' ? value : undefined
}

/** tRPC `op.context` key carrying a per-call command origin claim (D1022). */
export const CAP_COMMAND_ORIGIN_CONTEXT_KEY = '__camstackCommandOrigin'

/** The tRPC request-options shape produced by {@link commandOrigin}. */
export interface CommandOriginRequestOptions {
  readonly context: Readonly<Record<string, string | CommandOriginClaim>>
}

/**
 * Build the tRPC request options that state WHY a device command is being issued
 * (an action run, a scheduler). Pass as the second argument to `.mutate(input, …)`;
 * `base` (a {@link nodePin}) is kept, so both ride in one context.
 *
 * It is a claim about the call, never about the caller: the transport stamps WHO
 * the caller is (the addon id) and the audit records the claim as detail only.
 */
export function commandOrigin(
  claim: CommandOriginClaim,
  base?: { readonly context: Readonly<Record<string, string | CommandOriginClaim>> },
): CommandOriginRequestOptions {
  return { context: { ...(base?.context ?? {}), [CAP_COMMAND_ORIGIN_CONTEXT_KEY]: claim } }
}

/**
 * Read a command origin claim out of a tRPC `op.context` (transport side). A value
 * that is not a well-formed claim is dropped: the claim is detail, never trusted.
 */
export function readCommandOrigin(context: unknown): CommandOriginClaim | undefined {
  if (context === null || typeof context !== 'object') return undefined
  const parsed = CommandOriginClaimSchema.safeParse(Reflect.get(context, CAP_COMMAND_ORIGIN_CONTEXT_KEY))
  return parsed.success ? parsed.data : undefined
}
