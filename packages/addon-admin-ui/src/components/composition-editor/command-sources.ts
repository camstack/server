/**
 * Who a command or a template slot may be wired to, and which of them the
 * picker suggests first. A suggestion is a presentation, never a link (D356):
 * nothing here picks a device — the operator does, in the shared picker.
 */
import { compositionSourceKey, type CompositionSourceRef, DeviceType } from '@camstack/types'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  candidateDetail,
} from '../device/customize/assignments/assignment-candidates'
import type { RoomSuggestions } from '../device/customize/assignments/room-suggestions'

/** The fleet row a source ref names, or null. */
export function fleetRowOf(
  fleet: readonly CandidateDevice[],
  ref: CompositionSourceRef,
): CandidateDevice | null {
  const key = compositionSourceKey(ref)
  return (
    fleet.find((d) => compositionSourceKey({ addonId: d.addonId, stableId: d.stableId }) === key) ??
    null
  )
}

/** Every device that can be a source: a container is never a pick, its children are (D356). */
export function deviceCandidates(
  fleet: readonly CandidateDevice[],
  excluded: ReadonlySet<string> = new Set(),
): readonly AssignmentCandidate[] {
  return fleet
    .filter(
      (d) =>
        d.type !== DeviceType.Container &&
        !excluded.has(compositionSourceKey({ addonId: d.addonId, stableId: d.stableId })),
    )
    .map((d) => ({
      deviceId: d.id,
      ref: { addonId: d.addonId, stableId: d.stableId },
      name: d.name,
      detail: candidateDetail(d.integration, d.location),
      meta: d.type,
      caps: [],
      value: null,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

/**
 * The devices to suggest next to a device already chosen: those in its container
 * (its siblings), or — when it lives in none — those in its location. The
 * anchor itself is offered only when `includeAnchor` (a command often calls
 * the very entity the card reads). Null when nothing relates to the anchor.
 */
export function entitySuggestions(
  fleet: readonly CandidateDevice[],
  anchor: CompositionSourceRef | null,
  includeAnchor: boolean,
): RoomSuggestions | null {
  if (anchor === null) return null
  const row = fleetRowOf(fleet, anchor)
  if (row === null) return null
  const byId = new Map(fleet.map((d) => [d.id, d]))
  const parent =
    row.parentDeviceId === null || row.parentDeviceId === undefined
      ? undefined
      : byId.get(row.parentDeviceId)
  const related = (d: CandidateDevice): boolean => {
    if (d.type === DeviceType.Container) return false
    if (parent !== undefined) return d.parentDeviceId === parent.id
    const place = row.location ?? ''
    return place !== '' && d.location === place
  }
  const place = parent?.name ?? row.location ?? ''
  const ids = new Set(
    fleet.filter((d) => related(d) && (includeAnchor || d.id !== row.id)).map((d) => d.id),
  )
  if (ids.size === 0 || place === '') return null
  const containers = new Map(
    [...ids].flatMap((id): readonly (readonly [number, string])[] => {
      const owner = byId.get(id)?.parentDeviceId
      const container = owner === null || owner === undefined ? undefined : byId.get(owner)
      return container !== undefined && container.type === DeviceType.Container
        ? [[id, container.name] as const]
        : []
    }),
  )
  return { location: place, ids, containers }
}
