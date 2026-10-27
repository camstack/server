/**
 * The host's siblings offered first in every Customize source selector (D951).
 *
 * The input is the candidates the destination ALREADY accepts (its type, cap
 * and quantity fit — `partitionSourceDevices`), so this function holds no
 * knowledge of any extension: it only asks which of them live in the host's
 * container. A plug's switch, power sensor and energy sensor are siblings; a
 * fitting sensor in another room is not. A suggestion is a presentation, never
 * a link (D356): the operator still picks it.
 */
import type { SourceCandidateDevice } from './source-selector-model'

export interface SiblingSuggestions {
  /** The container the suggestions come from — the heading names it. */
  readonly container: string
  /** Fitting devices of that container: the host's siblings, then those under the host. */
  readonly devices: readonly SourceCandidateDevice[]
}

/** 0 = a sibling (same parent as the host), 1 = under the host itself, null = not related. */
function rank(
  candidate: SourceCandidateDevice,
  hostId: number,
  hostParentId: number | null,
): 0 | 1 | null {
  if (hostParentId !== null && candidate.parentDeviceId === hostParentId) return 0
  if (candidate.parentDeviceId === hostId) return 1
  return null
}

/**
 * The fitting siblings of `hostId`, best first; null when the host lives in no
 * container the fleet knows, or none of its siblings fit.
 */
export function siblingSuggestions(
  compatible: readonly SourceCandidateDevice[],
  fleet: readonly SourceCandidateDevice[],
  hostId: number,
): SiblingSuggestions | null {
  const host = fleet.find((row) => row.id === hostId)
  const hostParentId = host?.parentDeviceId ?? null
  const container = fleet.find((row) => row.id === (hostParentId ?? hostId))
  if (host === undefined || container === undefined) return null
  const ranked = compatible
    .flatMap((candidate) => {
      const place = rank(candidate, hostId, hostParentId)
      return place === null ? [] : [{ candidate, place }]
    })
    .toSorted((a, b) => a.place - b.place || a.candidate.name.localeCompare(b.candidate.name))
  if (ranked.length === 0) return null
  return {
    container: container.name,
    devices: ranked.map((row) => row.candidate),
  }
}
