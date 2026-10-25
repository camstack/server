import type { AddonCallInput, AddonSettingsMethod } from '../transport/child-cap-protocol.js'
import type { CustomActionRegistry } from '../custom-action-registry.js'
import type { ICamstackAddon, AddonDataPlaneEndpoint } from '@camstack/types'

/**
 * Serializable HTTP route descriptor sent from a forked child to the hub over
 * UDS. The `handler` function on the live `IAddonHttpRoute` is intentionally
 * OMITTED — MsgPack (the UDS frame codec) cannot encode a function, and the
 * hub re-binds dispatch through the `addon-routes` cap's `invoke` method
 * anyway. Mirrors the `addonRoutesCapability.getRoutes` output schema.
 */
export interface SerializableRouteDescriptor {
  readonly method: string
  readonly path: string
  readonly access?: string
  readonly description?: string
  readonly rateLimit?: string
}

/**
 * Resolved `addon-routes` provider lookup — the live provider object the addon
 * registered (`buildAddonRouteProvider(...)`). Returning `null`/`undefined`
 * means the addon registered no routes.
 */
export type RouteProviderLookup = (addonId: string) => object | null | undefined

/** Injected lookups the addon-call dispatcher uses to resolve addon-level surfaces. */
export interface ChildAddonCallDispatchDeps {
  /** Resolve the live `addon-routes` provider an addon registered, by addon id. */
  getRouteProvider: RouteProviderLookup
  /** The runner-wide custom-action registry (populated during the init loop). */
  customActions: CustomActionRegistry
  /** Resolve the loaded addon instance by id — used for the `settings` surface. */
  getAddonInstance: (addonId: string) => ICamstackAddon | null
  /** Resolve an addon's live HTTP data-plane endpoints (published by its
   *  `ctx.dataPlane` facility). Empty when the addon serves no data-plane. */
  getDataPlanes: (addonId: string) => readonly AddonDataPlaneEndpoint[]
  /**
   * Swap the secret VIEWS a form sent as action input for their values,
   * through the owner addon's own `ctx.secrets` (D789). Absent → the input is
   * parsed as it arrived.
   */
  resolveSecretViews?: (addonId: string, args: unknown) => Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Strip the (non-serializable) `handler` from a route descriptor, keeping only
 * the keys the hub needs to mount + describe the route. The hub bridges actual
 * dispatch through the `addon-routes` cap's `invoke` method, so the handler
 * never needs to cross the wire.
 */
function toSerializableRoute(route: unknown): SerializableRouteDescriptor {
  if (!isRecord(route)) {
    throw new Error('child-addon-call: getRoutes() returned a non-object route descriptor')
  }
  const method = route['method']
  const path = route['path']
  if (typeof method !== 'string' || typeof path !== 'string') {
    throw new Error('child-addon-call: route descriptor missing method/path')
  }
  const access = route['access']
  const description = route['description']
  const rateLimit = route['rateLimit']
  return {
    method,
    path,
    ...(typeof access === 'string' ? { access } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof rateLimit === 'string' ? { rateLimit } : {}),
  }
}

/** Settings-method params as the hub packs them into `AddonCallInput.args`. */
interface SettingsArgs {
  readonly overlay?: Record<string, unknown>
  readonly cap?: string
  readonly patch?: Record<string, unknown>
  readonly deviceId?: number
  /** The node the UI is asking about — lets an addon serving a cluster-central
   *  per-node config scope to that node rather than assuming its own. */
  readonly nodeId?: string
}

/**
 * Dispatch a `target: 'settings'` addon-call to the loaded addon instance.
 * Mirrors the (removed) `<addonId>.settings.<method>` Moleculer action. The
 * inner `method` switch is also exhaustive (`never` check) so a new settings
 * method added to `AddonSettingsMethod` must be handled here too. Returns the
 * raw method result; the hub reshapes get-results and acks updates.
 */
async function dispatchSettings(
  addon: ICamstackAddon,
  addonId: string,
  method: AddonSettingsMethod,
  args: SettingsArgs,
): Promise<unknown> {
  switch (method) {
    case 'getGlobalSettings':
      return typeof addon.getGlobalSettings === 'function'
        ? ((await addon.getGlobalSettings(args.overlay, args.cap, args.nodeId)) ?? null)
        : null
    case 'updateGlobalSettings':
      if (typeof addon.updateGlobalSettings !== 'function') {
        throw new Error(
          `child-addon-call: addon "${addonId}" does not implement updateGlobalSettings`,
        )
      }
      // A settings call that reaches an addon is the OPERATOR's (D787).
      if (typeof addon.updateGlobalSettingsAsOperator === 'function') {
        await addon.updateGlobalSettingsAsOperator(args.patch ?? {}, args.nodeId)
      } else {
        await addon.updateGlobalSettings(args.patch ?? {}, args.nodeId)
      }
      return { success: true as const }
    case 'getIntegrationSettings':
      // No update twin: the writer is `updateGlobalSettings` (same store, same
      // bare key). See `addon-settings.cap.ts`.
      return typeof addon.getIntegrationSettings === 'function'
        ? ((await addon.getIntegrationSettings(args.nodeId)) ?? null)
        : null
    case 'getDeviceSettings':
      return typeof addon.getDeviceSettings === 'function' && typeof args.deviceId === 'number'
        ? ((await addon.getDeviceSettings(args.deviceId)) ?? null)
        : null
    case 'updateDeviceSettings':
      if (typeof addon.updateDeviceSettings !== 'function') {
        throw new Error(
          `child-addon-call: addon "${addonId}" does not implement updateDeviceSettings`,
        )
      }
      if (typeof args.deviceId !== 'number') {
        throw new Error(
          `child-addon-call: addon "${addonId}" updateDeviceSettings missing deviceId`,
        )
      }
      await addon.updateDeviceSettings(args.deviceId, args.patch ?? {})
      return { success: true as const }
    default: {
      const _exhaustive: never = method
      throw new Error(`child-addon-call: unhandled settings method "${String(_exhaustive)}"`)
    }
  }
}

/**
 * Creates the addon-level dispatcher the addon-runner wires to
 * `LocalChildClient.onAddonCall`. Routes a {@link AddonCallInput} to one of the
 * exhaustive {@link AddonCallTarget} surfaces (routes / custom / settings) —
 * everything the per-addon Moleculer broker used to carry before the UDS
 * migration removed it. The `target` switch is exhaustive (`never` check): a
 * new surface added to the protocol union that isn't dispatched here is a
 * COMPILE ERROR — the guard that makes a "missed link" impossible.
 *
 * Pure module — no Moleculer, no broker, no addon-runner dependency.
 */
export function createChildAddonCallDispatch(
  deps: ChildAddonCallDispatchDeps,
): (call: AddonCallInput) => Promise<unknown> {
  return async (call: AddonCallInput): Promise<unknown> => {
    const { addonId, target } = call

    switch (target) {
      case 'routes': {
        const provider = deps.getRouteProvider(addonId)
        if (provider == null) {
          throw new Error(`child-addon-call: addon "${addonId}" has no addon-routes provider`)
        }
        const getRoutes: unknown = Reflect.get(provider, 'getRoutes')
        if (typeof getRoutes !== 'function') {
          throw new Error(
            `child-addon-call: addon "${addonId}" addon-routes provider has no getRoutes()`,
          )
        }
        const live: unknown = await getRoutes.call(provider)
        if (!Array.isArray(live)) {
          throw new Error(
            `child-addon-call: addon "${addonId}" getRoutes() did not return an array`,
          )
        }
        return live.map(toSerializableRoute)
      }
      case 'custom': {
        const action = call.action
        if (typeof action !== 'string' || action.length === 0) {
          throw new Error(`child-addon-call: addon "${addonId}" custom call missing action name`)
        }
        const entry = deps.customActions.resolve(addonId, action)
        if (entry === null) {
          throw new Error(`child-addon-call: addon "${addonId}" has no custom action "${action}"`)
        }
        // Validation happens HERE, in the process that owns the schemas. The
        // hub registers a forked catalog from the descriptor in the register
        // frame (schemas stripped — MsgPack cannot carry them), so its own
        // `input.parse` is a passthrough for a forked addon; the only real
        // parse is this one. A refusal names the action and the issue rather
        // than surfacing as a handler TypeError three frames deeper (D444).
        const args =
          deps.resolveSecretViews !== undefined
            ? await deps.resolveSecretViews(addonId, call.args)
            : call.args
        const parsedInput = entry.spec.input.safeParse(args)
        if (!parsedInput.success) {
          throw new Error(
            `child-addon-call: addon "${addonId}" custom action "${action}" rejected its input — ` +
              parsedInput.error.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; '),
          )
        }
        // `call.caller` is present ONLY when the hub forwarded an authenticated
        // caller for a `caller:'required'` action; `undefined` otherwise (and
        // for any legacy hub that never sends the field). The child registry's
        // handler already accepts + forwards the optional second argument.
        const result = await entry.handler(parsedInput.data, call.caller)
        return entry.spec.output.parse(result)
      }
      case 'settings': {
        const method = call.method
        if (method == null) {
          throw new Error(`child-addon-call: addon "${addonId}" settings call missing method`)
        }
        const addon = deps.getAddonInstance(addonId)
        if (addon == null) {
          throw new Error(`child-addon-call: addon "${addonId}" not loaded on this node`)
        }
        const args = (call.args ?? {}) as SettingsArgs
        return dispatchSettings(addon, addonId, method, args)
      }
      case 'data-planes': {
        // Live endpoint descriptors the addon's `ctx.dataPlane` facility
        // published. Plain serializable data (prefix/access/baseUrl/secret) —
        // the hub uses them to set up its reverse-proxy.
        return deps.getDataPlanes(addonId)
      }
      default: {
        const _exhaustive: never = target
        throw new Error(`child-addon-call: unhandled addon-call target "${String(_exhaustive)}"`)
      }
    }
  }
}
