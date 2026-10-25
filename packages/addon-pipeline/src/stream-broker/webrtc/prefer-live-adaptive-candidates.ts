import type { CamProfile } from '@camstack/types'

export function isDerivedBrokerId(brokerId: string): boolean {
  const slash = brokerId.indexOf('/')
  if (slash < 0) return false
  return brokerId.slice(slash + 1).startsWith('derived:')
}

/**
 * Adaptive live walks every registered broker for a device. When no profile
 * slot is bound, Map insertion order wins — and a derived materialized at
 * boot is often first, so the picture attaches to a transcode whose source
 * profile is empty (618, 2026-08-17).
 *
 * Prefer brokers that currently own a profile tier. If none do, drop
 * unassigned deriveds so a native pull can win. If the derived is the only
 * broker, keep it (better a stream than a throw).
 */
export function preferLiveAdaptiveCandidates<
  T extends { readonly brokerId: string; readonly tier: CamProfile | null },
>(candidates: readonly T[]): T[] {
  if (candidates.length <= 1) return [...candidates]
  const assigned = candidates.filter((c) => c.tier !== null)
  if (assigned.length > 0) return assigned
  const natives = candidates.filter((c) => !isDerivedBrokerId(c.brokerId))
  return natives.length > 0 ? natives : [...candidates]
}
