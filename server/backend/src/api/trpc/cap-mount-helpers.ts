/**
 * Small helpers for wiring capability routers to the `CapabilityRegistry`
 * in `trpc.router.ts`. These functions don't generate code — they just
 * remove boilerplate from the mount lambdas we pass to `createCapRouter_X`.
 *
 * When to use what:
 *   - `requireSingleton(registry, name)` — singleton caps with no custom
 *     composition. Returns the active provider or null (the codegen'd
 *     router itself throws PRECONDITION_FAILED when null).
 *   - `concatCollection(providers, method)` — collection caps whose
 *     methods return arrays and where the desired behaviour is "union of
 *     every provider's contribution" (e.g. `turn-provider.getTurnServers`).
 *
 * Collections that route by an input key (e.g. `webrtc` picking the
 * provider responsible for a given `streamId`) are NOT covered here —
 * they have app-specific routing logic that belongs in the mount.
 */

import type { CapabilityRegistry } from '@camstack/system'
import type { CapabilityProviderMap } from '@camstack/types'
import { TRPCError } from '@trpc/server'

/**
 * Fetch the currently active singleton provider for a capability.
 * Returns null if no provider is registered; the downstream codegen'd
 * router surfaces this as `PRECONDITION_FAILED` to the caller.
 */
export function requireSingleton<K extends keyof CapabilityProviderMap>(
  registry: CapabilityRegistry | null,
  capName: K,
): CapabilityProviderMap[K] | null {
  return registry?.getSingleton(capName) ?? null
}

/**
 * Build a per-device dispatcher that satisfies the singleton-provider
 * shape but resolves the actual implementation lazily via
 * `registry.getNativeProvider(capName, deviceId)` on every method call.
 *
 * Use for device-scoped caps that have NO system-level wrapper (PTZ,
 * reboot, doorbell, brightness, motion-trigger, switch, …) — drivers
 * register per-device native providers via
 * `DeviceContext.registerNativeCap`, and this helper bridges the cap-
 * router's "fetch a singleton then call methods on it" flow into a
 * "resolve native by deviceId per call" flow.
 *
 * Method input MUST carry `deviceId: number`. Methods without that
 * field (auto-injected `getStatus({deviceId})` for caps with a status
 * block, every business method that follows the cap-definition
 * convention) work transparently.
 *
 * Throws PRECONDITION_FAILED with a device-specific message when no
 * native provider exists for the requested deviceId — much friendlier
 * than the singleton fallthrough's "no provider" generic error.
 */
export function requireDeviceScoped<K extends keyof CapabilityProviderMap>(
  registry: CapabilityRegistry | null,
  capName: K,
): CapabilityProviderMap[K] | null
// Runtime cap-router builder (BIG PLAN 2) resolves device-native caps by a
// dynamic `string` name (it iterates `ALL_CAPABILITY_DEFINITIONS`, not
// string literals). The proxy dispatcher works for ANY cap name — it only
// uses `capName` in error messages + the per-device native lookup — so a
// string-accepting overload is sound. Returns the loose structural shape
// the dynamic builder consumes.
export function requireDeviceScoped(
  registry: CapabilityRegistry | null,
  capName: string,
): Readonly<Record<string, (input: unknown) => unknown>> | null
export function requireDeviceScoped(registry: CapabilityRegistry | null, capName: string): unknown {
  if (!registry) return null
  // The Proxy is the singleton stand-in. Each property access returns
  // a function that, on call, looks up the per-device native and
  // forwards the call. No caching — the lookup is cheap (Map.get) and
  // re-doing it per call lets devices come/go without stale refs.
  const dispatcher = new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined
        return async (input: { deviceId?: number } & Record<string, unknown>) => {
          const deviceId = input?.deviceId
          if (typeof deviceId !== 'number') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `${String(capName)}.${prop}: input must carry numeric "deviceId"`,
            })
          }
          // Fast path (unchanged): a per-device native provider registered for
          // the exact (cap, deviceId) pair.
          let provider = registry.getNativeProvider<Record<string, (i: unknown) => unknown>>(
            capName,
            deviceId,
          )
          // D13 fallback: a device cap may be served by a WRAPPER / system
          // provider bound to this device (e.g. the `autotrack` builtin
          // registers a SINGLETON `ptz-autotrack` wrapper — no native). Consult the unified
          // per-device resolver `getProviderForDevice` (native OR device-bound
          // system) BEFORE the synthesize fallback + the final throw. This
          // never runs when a native was found, keeping the fast path intact.
          if (!provider) {
            provider = registry.getProviderForDevice<Record<string, (i: unknown) => unknown>>(
              capName,
              deviceId,
            )
          }
          if (!provider) {
            // No native and no device-bound provider. There used to be one more
            // branch here: SYNTHESIZE a `getStatus` out of device-links, so a
            // cap with no provider at all still answered. Wiring was deleted on
            // 2026-08-08 — a composed device's caps are native to it, so there
            // is nothing to conjure and the honest answer is the error.
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `Capability "${String(capName)}" not registered for device ${deviceId}`,
            })
          }
          const fn = provider[prop]
          if (typeof fn !== 'function') {
            throw new TRPCError({
              code: 'NOT_IMPLEMENTED',
              message: `Capability "${String(capName)}" provider for device ${deviceId} does not implement "${prop}"`,
            })
          }
          // The provider's answer, verbatim. `getStatus` used to be run through
          // a read-time device-link overlay here — a second authority writing a
          // field the provider owns, which is the field-level form of the sin
          // D62 bans at feature level. Deleted with wiring on 2026-08-08.
          return await fn.call(provider, input)
        }
      },
    },
  )
  return dispatcher
}

// ── Method-on-provider callable types ────────────────────────────────

/**
 * A key on T whose value is a function with array / promise-array return.
 * An optional method counts too: a provider that omits it contributes nothing.
 */
type ArrayReturningMethodKey<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (
    ...args: infer _A
  ) => readonly unknown[] | Promise<readonly unknown[]>
    ? K
    : never
}[keyof T]

/**
 * Build a method that fan-outs a call to every provider in a collection
 * and concatenates their array results. Useful for contribution-style
 * caps where each provider adds to a shared pool.
 */
export function concatCollection<T extends object, K extends ArrayReturningMethodKey<T>>(
  providers: readonly T[],
  method: K,
): NonNullable<T[K]> extends (
  ...args: infer A
) => readonly (infer R)[] | Promise<readonly (infer R)[]>
  ? (...args: A) => Promise<readonly R[]>
  : never {
  const wrapper = async (...args: unknown[]): Promise<readonly unknown[]> => {
    const results = await Promise.all(
      providers.map(async (p): Promise<readonly unknown[]> => {
        const member = Reflect.get(p, method)
        if (typeof member !== 'function') return []
        // `Reflect.apply` returns `any`; funnel through unknown.
        const out: unknown = await Reflect.apply(member, p, args)
        if (!Array.isArray(out)) return []
        const arr: readonly unknown[] = out
        return arr
      }),
    )
    return results.flat()
  }
  // Type-level bridge: the runtime wrapper signature (unknown → Promise<unknown[]>)
  // matches the declared generic conditional return; TypeScript's
  // conditional types can't be narrowed inside a function body, so this
  // boundary assertion is required.
  return wrapper as NonNullable<T[K]> extends (
    ...args: infer A
  ) => readonly (infer R)[] | Promise<readonly (infer R)[]>
    ? (...args: A) => Promise<readonly R[]>
    : never
}
