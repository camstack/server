/**
 * When `assignProfile` locks `auto: false` (putting a derived on `low`), a
 * later catalog blip can empty the other slots. Auto-rank must not overwrite
 * the operator's slot, but EMPTY slots should still take unused eligible
 * natives — otherwise the camera stays dark until someone clicks the
 * dropdowns again (618 / 1438).
 */
import { CAM_PROFILE_ORDER, type CamProfile } from '@camstack/types'

export function fillEmptyProfileSlots(
  current: Partial<Record<CamProfile, string>>,
  autoRanked: Partial<Record<CamProfile, string>>,
): Partial<Record<CamProfile, string>> {
  const used = new Set<string>()
  for (const profile of CAM_PROFILE_ORDER) {
    const id = current[profile]
    if (id) used.add(id)
  }
  const ranked: string[] = []
  for (const profile of CAM_PROFILE_ORDER) {
    const id = autoRanked[profile]
    if (id && !ranked.includes(id)) ranked.push(id)
  }
  const next: Partial<Record<CamProfile, string>> = { ...current }
  for (const profile of CAM_PROFILE_ORDER) {
    if (next[profile]) continue
    const candidate = ranked.find((id) => !used.has(id))
    if (!candidate) continue
    next[profile] = candidate
    used.add(candidate)
  }
  return next
}
