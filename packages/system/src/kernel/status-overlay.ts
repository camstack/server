/**
 * status-overlay.ts — the D13 overlay for a CLAIMED cap's `getStatus` (D663,
 * ruling S3).
 *
 * When a composition or a customization claims fields of a device's cap, the
 * hub mirror holds the merged truth and the native provider's own `getStatus`
 * is the wrong answer for EVERY caller — the tRPC router, the status aggregate,
 * a wrapper's `native: true` call, an exporter polling from a forked child.
 * The registry's per-device resolvers wrap the provider they would have
 * returned (here); the three transport entries that resolve a cap call by name
 * ask the same question through `transport/claimed-get-status.ts`. Both import
 * the types from here so neither imports the other.
 *
 * The wrap is a `Proxy`, never a spread. The HA feeder's native is built by the
 * hub's `nativeFallback` as `new Proxy({}, { get })`: an EMPTY target whose
 * every property is a forwarding function. Its spread is `{}` — `wakeForStream`
 * and `reset` vanish and `requireDeviceScoped` answers NOT_IMPLEMENTED for every
 * non-status method of a claimed cap. A class-instance provider loses its
 * prototype methods the same way.
 */
import type { StatusOverlay, StatusOverlayAnswer } from '@camstack/types'

export type { StatusOverlay, StatusOverlayAnswer }

/** The answer for a device KNOWN to carry no claim — the old path, no overlay. */
export const UNCLAIMED: StatusOverlayAnswer = { kind: 'unclaimed' }

const GET_STATUS = 'getStatus'

/** Resolves the device's claims first, then answers. What every consumer awaits. */
export type ClaimedStatusResolver = (
  capName: string,
  deviceId: number,
) => Promise<StatusOverlayAnswer>

/**
 * Wrap `provider` so that `getStatus` awaits the overlay, re-read at CALL time
 * (a claim released between resolve and call falls back to the native's own
 * `getStatus`; a device whose claims are not yet known has them resolved
 * first), and every other property is the provider's own.
 *
 * Other properties are read off the TARGET with the target as receiver, and a
 * function is bound to it: a class instance's methods then see their real
 * `this` — a Proxy as `this` would break `#private` fields and prototype
 * getters. The HA-shaped forwarding Proxy is unaffected either way.
 */
export function overlayGetStatus<T extends object>(
  provider: T,
  answer: () => Promise<StatusOverlayAnswer>,
): T {
  return new Proxy<T>(provider, {
    get(target, prop): unknown {
      if (prop === GET_STATUS) {
        return async (...args: unknown[]): Promise<unknown> => {
          const current = await answer()
          if (current.kind === 'claimed') return current.slice
          // Not yet known is "not reported", never the native (D315, D49).
          if (current.kind === 'unknown') return null
          const native: unknown = Reflect.get(target, prop, target)
          if (typeof native !== 'function') {
            throw new Error(
              'getStatus: the claim was released and the native provider implements no getStatus',
            )
          }
          return await native.apply(target, args)
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
