/** The host's room suggestions from the tab's ONE fleet read (shared, cached), only while a card can use them. */
import { useMemo } from 'react'
import { type RoomSuggestions, roomSuggestionsOf } from './room-suggestions'
import { useCandidateDevices } from './use-source-candidates'

export function useRoomSuggestions(
  location: string | null | undefined,
  enabled: boolean,
): RoomSuggestions | null {
  const hasRoom = typeof location === 'string' && location.length > 0
  const fleet = useCandidateDevices(enabled && hasRoom)
  return useMemo(
    () => (enabled ? roomSuggestionsOf(fleet, location) : null),
    [enabled, fleet, location],
  )
}
