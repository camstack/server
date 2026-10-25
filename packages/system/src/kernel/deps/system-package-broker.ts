import type { SystemPackageManager } from './system-package-allowlist.js'
import { packageIsAllowlisted } from './system-package-allowlist.js'

export interface PackageInstallRequest {
  readonly addonId: string
  readonly binary: string
  readonly manager: SystemPackageManager
  readonly packageName: string
}

export interface PackageInstallResult {
  readonly ok: boolean
  readonly error?: string
}

export type PackageInstallDecision =
  | { readonly kind: 'helper' }
  | { readonly kind: 'local' }
  | { readonly kind: 'refuse'; readonly reason: 'not-allowlisted' | 'helper-unavailable' }

/**
 * Who is allowed to run the package manager for this request.
 *
 * Apt/apk/dnf need root. In the CamStack container that is the
 * `camstack-pkgd` helper, not the runner and not hub-main (both uid
 * 1001). Brew is owned by the logged-in user, so it stays in-process.
 */
export function decidePackageInstall(input: {
  readonly manager: SystemPackageManager
  readonly packageName: string
  readonly helperAvailable: boolean
}): PackageInstallDecision {
  if (input.manager === 'brew') return { kind: 'local' }
  if (!packageIsAllowlisted(input.manager, input.packageName)) {
    return { kind: 'refuse', reason: 'not-allowlisted' }
  }
  if (!input.helperAvailable) return { kind: 'refuse', reason: 'helper-unavailable' }
  return { kind: 'helper' }
}
