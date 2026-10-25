import type { ServiceSchema } from 'moleculer'
import { deserializeTypedArrays } from './typed-array-serde.js'

/**
 * Narrow view of the Moleculer action `Context`. Moleculer's published
 * `Context` type chains through `eventemitter2` (no `types` field), so a direct
 * `Context` annotation resolves to `error` and trips `no-unsafe-*`; this local
 * shape is the same one-site narrowing `moleculer.service.ts` applies to the
 * broker.
 *
 * `nodeID` and `caller` are read for ATTRIBUTION only — never for a gate. A
 * mesh call has no HTTP request behind it, so without them the in-process plane
 * of the transport census could name a plane but never a caller.
 */
interface ActionContext {
  readonly params?: unknown
  /** The node that created this context, i.e. the calling node. */
  readonly nodeID?: unknown
  /** The action or event that issued the call, when Moleculer knows one. */
  readonly caller?: unknown
}

/**
 * Who issued a `$core-caps` action. Both fields are `null` when Moleculer did
 * not carry the information — never blank, so an absent origin reads as absent
 * rather than as a formatting defect.
 */
export interface CoreCapCallOrigin {
  readonly nodeId: string | null
  readonly caller: string | null
}

/**
 * Default Moleculer service name for the hub core-capability bridge.
 *
 * `$`-prefixed so it never collides with an addon id (addon services
 * take their name from `declaration.id`). It is still a regular,
 * discoverable service — `findServiceCandidates` in `trpc-links.ts`
 * scans every entry returned by `registry.getServiceList()`.
 */
export const CORE_CAP_SERVICE_NAME = '$core-caps'

/**
 * A single hub core-capability procedure, ready to expose as a
 * Moleculer action.
 *
 * `actionName` must be the kebab-cased `<capName>.<method>` pair the
 * worker-side `brokerTransportLink` resolves: it parses `op.path`,
 * kebab-cases the namespace and looks for a service action ending in
 * `.<capName>.<method>` (see `findServiceCandidates`). Mounting the
 * action as `system.info` makes Moleculer register it as
 * `$core-caps.system.info`, which matches that suffix lookup.
 */
export interface CoreCapAction {
  /** Kebab-cased `<capName>.<method>` — e.g. `system.info`, `addon-settings-raw.getGlobal`. */
  readonly actionName: string
  /**
   * Invoke the underlying tRPC procedure with a trusted mesh context.
   *
   * `origin` is diagnostics only — the transport census uses it to name the
   * caller of an in-process call, which has no request and therefore no other
   * identity. No implementation may gate on it.
   */
  readonly invoke: (input: unknown, origin: CoreCapCallOrigin) => Promise<unknown> | unknown
}

export interface CoreCapServiceOptions {
  /** Moleculer service name. Defaults to {@link CORE_CAP_SERVICE_NAME}. */
  readonly serviceName?: string
  readonly actions: readonly CoreCapAction[]
}

/**
 * Wrap the hub's core (non-addon) tRPC procedures as a single Moleculer
 * service so forked addons and remote agents can reach them through
 * `ctx.api.<coreCap>.<method>`.
 *
 * Core routers (`system`, `addons`, `capabilities`, `nodes`, …) are
 * mounted only as the hub's tRPC routers — no addon registers a
 * provider for them, so `addon-service-factory` never gives them a
 * Moleculer service. Without this bridge a forked addon's
 * `ctx.api.<coreCap>` falls through `localProviderLink` into
 * `brokerTransportLink`, whose load-balanced discovery wait has no
 * deadline, and hangs forever.
 *
 * Mirrors `createAddonService`: each action deserializes typed arrays
 * and normalizes Moleculer's `{}` (empty params) back to `undefined`
 * so void-input procedures don't receive a spurious empty object.
 */
export function createCoreCapService(options: CoreCapServiceOptions): ServiceSchema {
  const actions: Record<string, { handler: (ctx: ActionContext) => Promise<unknown> }> = {}

  for (const { actionName, invoke } of options.actions) {
    actions[actionName] = {
      handler: async (ctx: ActionContext): Promise<unknown> => {
        const raw = deserializeTypedArrays(ctx.params)
        const params =
          raw !== null && typeof raw === 'object' && Object.keys(raw as object).length === 0
            ? undefined
            : raw
        return invoke(params, readOrigin(ctx))
      },
    }
  }

  return {
    name: options.serviceName ?? CORE_CAP_SERVICE_NAME,
    actions,
  }
}

/** Structural read of the calling node/action. Anything unrecognised is `null`. */
function readOrigin(ctx: ActionContext): CoreCapCallOrigin {
  return { nodeId: asName(ctx.nodeID), caller: asName(ctx.caller) }
}

function asName(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
