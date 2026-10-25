/**
 * Packages the privileged helper will install (D326).
 *
 * The helper process reads `scripts/docker/pkg-allowlist.json` (baked into
 * the image). This module is the runner-side copy of the same list, so an
 * unknown package is refused before a socket write. Keep them identical —
 * `scripts/check-pkg-allowlist.ts` fails CI when they drift.
 */
export type SystemPackageManager = 'apt' | 'apk' | 'dnf' | 'brew'

export type DistroPackageManager = Exclude<SystemPackageManager, 'brew'>

export const DISTRO_PACKAGE_ALLOWLIST: Readonly<Record<DistroPackageManager, readonly string[]>> = {
  apt: ['smbclient'],
  apk: ['samba-client'],
  dnf: ['samba-client'],
}

export function packageIsAllowlisted(manager: SystemPackageManager, packageName: string): boolean {
  if (manager === 'brew') return true
  if (packageName.length === 0) return false
  // One token, Debian-style. Anything with shell metacharacters is a
  // different question than "install this package".
  if (!/^[a-zA-Z0-9][a-zA-Z0-9+._-]*$/.test(packageName)) return false
  const list = DISTRO_PACKAGE_ALLOWLIST[manager]
  return list.includes(packageName)
}
