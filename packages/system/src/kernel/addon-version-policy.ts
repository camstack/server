/**
 * Which version an installed addon should be running (D942).
 *
 * The hub's target is the registry dist-tag `latest`. An agent's target is
 * the hub's installed version — never the registry, and never "strictly
 * newer". A missing target is an unreadable authority: a failed read changes
 * nothing (D49), including never a move downward because the registry or the
 * hub could not be asked.
 */

export const ADDON_VERSION_REASON_REGISTRY_LATEST =
  'installed version differs from registry latest' as const

export const ADDON_VERSION_REASON_HUB = 'agent follows the hub installed version' as const

export type AddonVersionReason =
  | typeof ADDON_VERSION_REASON_REGISTRY_LATEST
  | typeof ADDON_VERSION_REASON_HUB

export type AddonVersionMove =
  | { readonly move: false }
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
 */
export function decideAddonVersionMove(
  installed: string | null,
  target: string | null,
  reason: AddonVersionReason,
): AddonVersionMove {
  if (target === null || target.length === 0) return { move: false }
  if (installed !== null && installed === target) return { move: false }
  return { move: true, from: installed ?? 'absent', to: target, reason }
}
