/**
 * device-call-redirect.ts — the ONE function every transport entry that
 * resolves a cap call BY NAME asks before it routes a device-scoped call
 * (D963). The sibling of `claimed-get-status.ts`, and for the same reason:
 * there is no single chokepoint. The three entries dispatch straight to the
 * owning runner —
 *   1. `LocalChildRegistry`'s sibling short-circuit,
 *   2. `createParentUnownedCallHandler`,
 *   3. `MoleculerService.callCapabilityOnNode` —
 * and each would hand a media-player command to the native cap even when the
 * device's remote binds that role. The registry's own resolvers wrap the
 * provider instead (`device-call-redirect.ts` in the kernel root).
 * `scripts/check-claimed-get-status.ts` fails when a production file that
 * resolves by name does not call this.
 *
 * `null` means "not redirected — route as before". A non-null answer IS the
 * call's answer. A redirect that fails throws; the caller sees the failure.
 */
import type { DeviceCall, DeviceCallAnswer } from '@camstack/types'
import { extractDeviceId } from './cap-route-resolver.js'

/** The registry's questions, as an entry holds them. */
export interface DeviceCallRedirectHook {
  covers(capName: string, method: string): boolean
  attempt(call: DeviceCall): Promise<DeviceCallAnswer>
}

/**
 * What the entry knows about the call; `deviceId` wins over one inside `args`.
 * `args` may be a thunk: an entry that forwards a raw frame decodes nothing
 * (D448), so the args are materialised only for a method the hook covers.
 */
export interface DeviceCallRedirectInput {
  readonly capName: string
  readonly method: string
  readonly deviceId?: number
  readonly args?: unknown | (() => unknown)
}

export interface DeviceCallRedirectResult {
  readonly result: unknown
}

export async function answerDeviceCallRedirect(
  hook: DeviceCallRedirectHook | undefined,
  call: DeviceCallRedirectInput,
): Promise<DeviceCallRedirectResult | null> {
  if (hook === undefined || !hook.covers(call.capName, call.method)) return null
  const args = typeof call.args === 'function' ? call.args() : call.args
  const deviceId = call.deviceId ?? extractDeviceId(args)
  if (deviceId === undefined) return null
  const answer = await hook.attempt({ capName: call.capName, method: call.method, deviceId, args })
  return answer.kind === 'redirected' ? { result: answer.result } : null
}
