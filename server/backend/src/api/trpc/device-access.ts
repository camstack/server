/**
 * "What may THIS caller do on THIS device?" — the per-device answer a device
 * card needs to draw its controls enabled or disabled-with-a-reason.
 *
 * It is not a second scope check: it runs the SAME `authorizeProcedure` the
 * `protectedProcedure` middleware runs, over the SAME scopes
 * ({@link enforcedScopesOf}), against a canonical device method per access
 * flavour. So the card and the hub cannot disagree about whether the device
 * is in the caller's grant; the hub still checks every real call.
 *
 * Pure module — no tRPC machinery — so the spec exercises it directly.
 */
import { METHOD_ACCESS_MAP } from '@camstack/server/system'
import type { CredentialScope } from '@camstack/types'
import { personSessionScopes } from '../../auth/person-session-scopes.js'
import { authorizeProcedure } from './principal-authorization.js'
import type { DeviceScopeLookup } from './scope-access.js'
import type { AuthenticatedAgent } from './trpc.context.js'

/** A device-scope `view` method with the `viewer` role (the auto-injected getStatus). */
export const DEVICE_VIEW_PROBE = 'switch.getStatus'
/**
 * A device-scope `create` method with the `viewer` role: what a device command
 * needs (device in the grant, `create` access, no viewer feature). A grant
 * narrowed to one capability (`capability:<name>`) is answered for `switch`
 * only; the hub refuses the other capabilities' commands on the real call.
 */
export const DEVICE_COMMAND_PROBE = 'switch.setState'

/** What the caller may do on one device. */
export interface DeviceAccess {
  readonly view: boolean
  readonly command: boolean
}

function assertProbe(path: string, access: 'view' | 'create'): void {
  const meta = METHOD_ACCESS_MAP[path]
  if (meta === undefined || meta.capScope !== 'device' || meta.access !== access) {
    throw new Error(
      `device-access: probe '${path}' is not a device-scope ${access} method (codegen drift)`,
    )
  }
}
assertProbe(DEVICE_VIEW_PROBE, 'view')
assertProbe(DEVICE_COMMAND_PROBE, 'create')

/**
 * The scopes the middleware authorizes a caller with. A person (interactive,
 * non-admin) is decided by the viewer row alone (D921); a token keeps its rows.
 */
export function enforcedScopesOf(user: AuthenticatedAgent): readonly CredentialScope[] {
  const raw = user.scopes ?? []
  return user.interactive === true && !user.isAdmin ? personSessionScopes(raw) : raw
}

/** {@link DeviceAccess} for `user` on `deviceId`, decided by the hub's own matcher. */
export function deviceAccessOf(
  user: AuthenticatedAgent,
  deviceId: number,
  lookup: DeviceScopeLookup | undefined,
): DeviceAccess {
  const scopes = enforcedScopesOf(user)
  const input = { deviceId }
  return {
    view: authorizeProcedure(scopes, DEVICE_VIEW_PROBE, input, lookup).ok,
    command: authorizeProcedure(scopes, DEVICE_COMMAND_PROBE, input, lookup).ok,
  }
}
