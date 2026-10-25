/**
 * Same-location suggestions on the Customize cards (D749). The RULE — which
 * devices a room suggests, and that a container family is suggested only by
 * the child it stands for — is the library's `sameLocationSuggestions`, the
 * same one the linked-devices field applies; this file only adapts it to the
 * cards' fleet read and candidate lists.
 *
 * A suggestion is a presentation, never a write (D356): the cards add a
 * suggested device only through the pick the operator makes.
 */
import {
  partitionSuggested,
  type SuggestedPartition,
  sameLocationSuggestions,
} from '@camstack/ui-library'
import type { Known } from '../known'
import type { CandidateDevice } from './assignment-candidates'

export interface RoomSuggestions {
  /** The host's location — the heading says where the suggestions come from. */
  readonly location: string
  /** The fleet's suggested device ids; a card intersects them with ITS candidates. */
  readonly ids: ReadonlySet<number>
  /** Suggested child id → its container's name: a child is named after its container. */
  readonly containers: ReadonlyMap<number, string>
}

/** The room's suggestions; null while the fleet has not answered or the host has no location. */
export function roomSuggestionsOf(
  fleet: Known<readonly CandidateDevice[]>,
  location: string | null | undefined,
): RoomSuggestions | null {
  if (fleet.kind !== 'known' || typeof location !== 'string' || location.length === 0) return null
  const ids = sameLocationSuggestions(fleet.value, location)
  const byId = new Map(fleet.value.map((d) => [d.id, d]))
  const containers = new Map<number, string>()
  for (const id of ids) {
    const parentId = byId.get(id)?.parentDeviceId
    const parent = parentId === null || parentId === undefined ? undefined : byId.get(parentId)
    if (parent !== undefined && parent.type === 'container') containers.set(id, parent.name)
  }
  return { location, ids, containers }
}

/** A card's candidates, the room's valid ones first. Without a room, everything is "others". */
export function splitByRoom<T>(
  items: readonly T[],
  room: RoomSuggestions | null,
  idOf: (item: T) => number,
): SuggestedPartition<T> {
  return partitionSuggested(items, room?.ids ?? new Set<number>(), idOf)
}

/** The container a suggested child lives in, or null. */
export function suggestionContainer(room: RoomSuggestions | null, id: number): string | null {
  return room?.containers.get(id) ?? null
}

/** How many of a card's answered candidates the room suggests; 0 until they answered. */
export function suggestedCount<T>(
  items: Known<readonly T[]>,
  room: RoomSuggestions | null,
  idOf: (item: T) => number,
): number {
  return items.kind === 'known' ? splitByRoom(items.value, room, idOf).suggested.length : 0
}
