/**
 * Minimal semver comparison — zero-dep (used by the starter, which must never
 * import from node_modules). Handles `MAJOR.MINOR.PATCH[-prerelease]`:
 * numeric segment compare, missing segments = 0, prerelease < its release,
 * prereleases of the same base compare lexically. Malformed segments compare
 * as 0 (best effort — never throws).
 */

type SemverParts = {
  readonly nums: readonly number[]
  readonly prerelease: string | null
}

function parse(version: string): SemverParts {
  const dashIdx = version.indexOf('-')
  const base = dashIdx === -1 ? version : version.slice(0, dashIdx)
  const prerelease = dashIdx === -1 ? null : version.slice(dashIdx + 1)
  const nums = base.split('.').map((seg) => {
    const n = Number.parseInt(seg, 10)
    return Number.isNaN(n) ? 0 : n
  })
  return { nums, prerelease }
}

/** Returns -1 when a < b, 0 when equal, 1 when a > b. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0
    const nb = pb.nums[i] ?? 0
    if (na < nb) return -1
    if (na > nb) return 1
  }
  if (pa.prerelease === null && pb.prerelease === null) return 0
  if (pa.prerelease === null) return 1
  if (pb.prerelease === null) return -1
  if (pa.prerelease < pb.prerelease) return -1
  if (pa.prerelease > pb.prerelease) return 1
  return 0
}
