/**
 * The role this binary actually runs — the product first, the store second.
 *
 * Since ADR-0402's second half the role is no longer a free choice in either
 * product:
 *
 *   - the VIEWER product is a viewer by construction. Its setup window has no
 *     role picker, so the persisted `role` key is not an input at all: a store
 *     left over from a hub install, a corrupt one, an absent one and an honest
 *     `"viewer"` all mean the same thing here. This is the security-relevant
 *     half — a viewer that read `hub` out of a stale store would append
 *     `ignore-certificate-errors` and accept ANY certificate for the LAN hub it
 *     loads, which is exactly what ADR-0402 exists to stop;
 *   - the NODE product offers hub and agent only, so a store still holding the
 *     retired `viewer` role is coerced to `hub`. It never runs a role its own
 *     UI cannot express — one tray, one window, one certificate posture. That
 *     coercion re-arms the switch for such a store, which is safe ONLY because
 *     `isRoleRetiredByProduct` sends that install back to the setup window
 *     before any window loads a remote origin. Keep the two together.
 */
import type { DesktopProduct } from '../product/desktop-product'
import type { NodeRole } from '../types'

/** The effective role: what the product allows, given what the store holds. */
export function roleForProduct(product: DesktopProduct, storedRole: NodeRole): NodeRole {
  if (product === 'viewer') return 'viewer'
  return storedRole === 'viewer' ? 'hub' : storedRole
}

/**
 * Whether the persisted role is one this product no longer runs. True only for
 * a node install whose store still says `viewer`: the operator picked a role
 * that has since become its own product, so the shell asks again instead of
 * silently booting them into a hub.
 */
export function isRoleRetiredByProduct(product: DesktopProduct, storedRole: NodeRole): boolean {
  return product === 'node' && storedRole === 'viewer'
}
