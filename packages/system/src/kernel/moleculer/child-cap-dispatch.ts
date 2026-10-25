import type { CapCallInput } from '../transport/child-cap-protocol.js'

/** A cap method, resolved structurally from a provider object at dispatch time. */
type CapMethod = (args: unknown) => unknown

/** Type guard narrowing a dynamically-read provider member to a callable method. */
function isCapMethod(value: unknown): value is CapMethod {
  return typeof value === 'function'
}

/**
 * Injected lookups that the dispatcher uses to resolve cap providers. A provider
 * is an opaque object whose methods are resolved structurally (via {@link isCapMethod})
 * at the UDS dispatch boundary. Returning `null`/`undefined` signals "no provider
 * registered".
 */
export interface ChildCapDispatchDeps {
  /**
   * Resolve a singleton/system-scoped provider by cap name. `addonId` is a
   * PROVIDER-SELECTION hint for grouped runners where multiple co-located
   * addons register the SAME cap (e.g. two `network-access` providers in the
   * `net-access` group): when it matches a hosted addon's provider, return
   * that one; otherwise fall back to the cap's sole/first provider (an
   * `addonId` that names no hosted provider is method DATA, not routing —
   * e.g. `addons.restartAddon({ addonId })`).
   */
  getSingletonProvider(capName: string, addonId?: string): object | null | undefined
  /** Resolve a device-scoped provider by cap name and device id. */
  getDeviceProvider(capName: string, deviceId: number): object | null | undefined
  /**
   * Predicate: is `(capName, method)` a COLLECTION cap's array-returning
   * method? Such methods aggregate a UNION across every registered provider,
   * so a provider that doesn't implement one must contribute `[]` (graceful
   * skip) — the dispatcher returns `[]` instead of throwing "method not found".
   * The hub-side `concatCollection` / `concatArrayMethod` does this skip
   * locally, but a hub→child UDS proxy fabricates a callable for every property
   * so the absence is only observable HERE, on the child that owns the real
   * (possibly partial) provider. For singleton caps and non-array methods a
   * missing method is a genuine bug and still throws.
   */
  isCollectionListMethod(capName: string, method: string): boolean
  /**
   * Predicate: is `(capName, method)` declared `optionalMethod`?
   *
   * The absence of such a method is a FACT about that provider, never a bug —
   * `videoclips.getPlaybackOptions` at the recorder's `analytics` source is a
   * time WINDOW with no file behind it. The hub's `callSource` already has the
   * named refusal, but its `typeof fn !== 'function'` check is VACUOUS across
   * a process boundary: the UDS proxy fabricates a callable for every
   * property, so the check passes, the call crosses, and the absence is only
   * observable here. Without this the honest answer arrived as
   * `INTERNAL_SERVER_ERROR` — the same signature as a method somebody forgot.
   */
  isProviderOptionalMethod(capName: string, method: string): boolean
}

/**
 * Prefix the hub matches to turn a child-side "declared optional, not served"
 * into a `NOT_IMPLEMENTED`. A prefix rather than an error subclass because the
 * error crosses a UDS boundary as a plain message.
 */
export const CAP_METHOD_NOT_IMPLEMENTED = 'CAP_METHOD_NOT_IMPLEMENTED'

/**
 * Extract a string `addonId` out of arbitrary method args — the fallback
 * provider-selection hint for calls that arrive WITHOUT the out-of-band
 * `CapCallMessage.addonId` (e.g. a sibling child's unowned collection call
 * forwarded by the parent, where the raw input still carries `addonId`).
 */
function extractArgsAddonId(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const raw: unknown = Reflect.get(args, 'addonId')
  return typeof raw === 'string' ? raw : undefined
}

/**
 * Creates a unified dispatcher that routes a {@link CapCallInput} to either a
 * device-scoped or singleton provider, then invokes the requested method.
 *
 * Pure module — no Moleculer, no broker, no addon-runner dependency.
 */
export function createChildCapDispatch(
  deps: ChildCapDispatchDeps,
): (call: CapCallInput) => Promise<unknown> {
  return async (call: CapCallInput): Promise<unknown> => {
    const { capName, method, args, deviceId } = call

    // Provider-selection hint: prefer the out-of-band `call.addonId` (set by
    // the hub's per-provider proxy after the collection mount stripped it
    // from the args), else fall back to an `addonId` still present IN the
    // args (sibling unowned calls forwarded by the parent).
    const addonId = call.addonId ?? extractArgsAddonId(args)

    // ── Resolve provider ──────────────────────────────────────────────────
    // `deviceId` is a routing HINT, not a hard requirement. Prefer a
    // device-scoped provider that owns this device; fall back to the
    // singleton. A singleton cap (pipeline-runner.attachCamera) carries
    // `deviceId` as a METHOD ARGUMENT, not a provider key — resolving it
    // device-only would spuriously 404 the call. Mirrors the parent-side
    // `LocalChildRegistry.resolveChildId` two-tier resolution.
    let provider: object | null | undefined
    if (deviceId !== undefined) {
      provider =
        deps.getDeviceProvider(capName, deviceId) ?? deps.getSingletonProvider(capName, addonId)
      if (provider == null) {
        throw new Error(
          `child-cap-dispatch: no provider for '${capName}' (device '${String(deviceId)}' or singleton)`,
        )
      }
    } else {
      provider = deps.getSingletonProvider(capName, addonId)
      if (provider == null) {
        throw new Error(`child-cap-dispatch: no singleton provider for '${capName}'`)
      }
    }

    // ── Resolve method (dynamic read → type-guard narrow, no cast) ─────────
    const fn: unknown = Reflect.get(provider, method)
    if (!isCapMethod(fn)) {
      // Graceful skip for a COLLECTION cap's list method: the hub unions the
      // result across every provider, so a provider that doesn't implement one
      // contributes an empty array rather than erroring the whole fan-out. Only
      // collection array methods degrade this way — a missing singleton/non-array
      // method is a real bug and still throws below.
      if (deps.isCollectionListMethod(capName, method)) {
        return []
      }
      // Declared `optionalMethod`: a NAMED refusal, not an internal error.
      if (deps.isProviderOptionalMethod(capName, method)) {
        throw new Error(
          `${CAP_METHOD_NOT_IMPLEMENTED}: '${capName}.${method}' is declared optional and this provider does not serve it`,
        )
      }
      throw new Error(`child-cap-dispatch: method '${method}' not found on provider '${capName}'`)
    }

    // ── Invoke — match the call(provider, args) convention used by both
    //    device-cap-proxy and addon-service-factory. The full args object
    //    (including deviceId when present) is forwarded as-is.
    return await fn.call(provider, args)
  }
}
