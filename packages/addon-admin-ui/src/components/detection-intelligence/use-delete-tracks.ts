/**
 * Shared, feature-detected `deleteTracks` mutation selector for the Detection
 * Intelligence Events page.
 *
 * The generated `usePipelineAnalyticsDeleteTracks` hook is `undefined` at
 * runtime on a host ui-library that predates the framework train (before the
 * `deleteTracks` cap router landed). A stable, MODULE-SCOPE selector picks the
 * real hook or a no-op disabled hook ONCE, so every consumer always calls the
 * same hook slot regardless (rules-of-hooks safe). Both `EventsSection` (batch
 * delete) and `EventDetailPanel` (whole-track delete) import from here so the
 * detection + fallback live in exactly one place.
 */
import { usePipelineAnalyticsDeleteTracks } from '@camstack/ui-library'

export interface DeleteTracksVariables {
  readonly deviceId: number
  readonly trackIds: string[]
  // The generated tRPC input carries an index signature; mirror it so the real
  // and disabled hooks are both structurally assignable to the selector type.
  readonly [key: string]: unknown
}

export interface DeleteTracksMutation {
  readonly mutateAsync: (vars: DeleteTracksVariables) => Promise<unknown>
  readonly isPending: boolean
}

/** True when the deployed host ui-library carries the `deleteTracks` cap hook. */
export const DELETE_TRACKS_AVAILABLE = typeof usePipelineAnalyticsDeleteTracks === 'function'

/** Tooltip shown on the disabled Delete controls until the cap router lands. */
export const DELETE_UNAVAILABLE_TITLE = 'Track deletion arrives with the next server update'

function useDisabledDeleteTracks(): DeleteTracksMutation {
  return {
    mutateAsync: async (): Promise<never> => {
      throw new Error('deleteTracks unavailable')
    },
    isPending: false,
  }
}

/**
 * The delete-tracks mutation hook — the real generated hook when present,
 * else a stable disabled stub. Resolved ONCE at module load.
 */
export const useDeleteTracksMutation: () => DeleteTracksMutation = DELETE_TRACKS_AVAILABLE
  ? usePipelineAnalyticsDeleteTracks
  : useDisabledDeleteTracks
