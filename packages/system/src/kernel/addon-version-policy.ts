/**
 * Which version an installed addon should be running (D942).
 *
 * The hub's target is the registry dist-tag `latest`. An agent's target is
 * the hub's installed version — never the registry, and never "strictly
 * newer". A missing target is an unreadable authority: a failed read changes
 * nothing (D49), including never a move downward because the registry or the
 * hub could not be asked.
 */

import type { UnmetRequirement } from '@camstack/types'

export const ADDON_VERSION_REASON_REGISTRY_LATEST =
  'installed version differs from registry latest' as const

export const ADDON_VERSION_REASON_HUB = 'agent follows the hub installed version' as const

export type AddonVersionReason =
  | typeof ADDON_VERSION_REASON_REGISTRY_LATEST
  | typeof ADDON_VERSION_REASON_HUB

export type AddonVersionMove =
  | { readonly move: false }
  /** A move that would happen but for a requirement the target declares and the install does not meet (D988). */
  | { readonly move: false; readonly blockedBy: readonly UnmetRequirement[] }
  | {
      readonly move: true
      readonly from: string
      readonly to: string
      readonly reason: AddonVersionReason
    }

/**
 * Move when `installed` is not `target`. `target === null` (or empty) means
 * the authority could not be read — keep whatever is installed.
 * `installed === null` with a known target is a first install of that target.
 *
 * `unmet` is what the TARGET declares and this node does not meet (computed by
 * the caller from the target's `camstack.requires`). A move that would happen
 * is held and says why; a node that is already on the target has nothing to hold.
 */
export function decideAddonVersionMove(
  installed: string | null,
  target: string | null,
  reason: AddonVersionReason,
  unmet: readonly UnmetRequirement[] = [],
): AddonVersionMove {
  if (target === null || target.length === 0) return { move: false }
  if (installed !== null && installed === target) return { move: false }
  if (unmet.length > 0) return { move: false, blockedBy: unmet }
  return { move: true, from: installed ?? 'absent', to: target, reason }
}
