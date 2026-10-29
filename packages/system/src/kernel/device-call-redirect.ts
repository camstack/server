/**
 * device-call-redirect.ts — wraps a device's provider so a covered method asks
 * the redirect first (D963). The sibling of `status-overlay.ts`: the same
 * `Proxy`, never a spread, for the same reason — the HA feeder's native is an
 * EMPTY target whose every property is a forwarding function, and a class
 * instance's methods live on its prototype.
 *
 * A method the redirect does not cover is the provider's own, bound to it. A
 * covered one asks first; `not-redirected` calls the provider with the args as
 * they came, `redirected` answers the redirect's result and the provider is
 * never called.
 */
import type { DeviceCall, DeviceCallAnswer } from '@camstack/types'

export interface DeviceCallRedirectView {
  covers(method: string): boolean
  attempt(call: DeviceCall): Promise<DeviceCallAnswer>
}

export function redirectDeviceCalls<T extends object>(
  provider: T,
  capName: string,
  deviceId: number,
  view: DeviceCallRedirectView,
): T {
  return new Proxy<T>(provider, {
    get(target, prop): unknown {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (typeof prop !== 'string' || !view.covers(prop)) return value.bind(target)
      return async (...args: unknown[]): Promise<unknown> => {
        const answer = await view.attempt({
          capName,
          method: prop,
          deviceId,
          args: args[0],
        })
        if (answer.kind === 'redirected') return answer.result
        return await value.apply(target, args)
      }
    },
  })
}
