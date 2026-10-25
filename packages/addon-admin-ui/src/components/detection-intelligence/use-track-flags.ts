/**
 * Shared, feature-detected `setTrackFlags` mutation selector for the per-track
 * operator flags (`markForTrain`, `debug`).
 *
 * Same shape and the same reason as `use-delete-tracks.ts`: the generated
 * `usePipelineAnalyticsSetTrackFlags` hook is `undefined` at runtime on a host
 * `ui-library` that predates the framework train carrying the cap method. A
 * MODULE-SCOPE selector resolves the real hook or a disabled stub ONCE, so every
 * consumer always calls the same hook slot (rules-of-hooks safe).
 */
import { usePipelineAnalyticsSetTrackFlags } from '@camstack/ui-library'

/** The partial patch: an omitted key is left untouched by the server. */
export interface TrackFlagsPatchInput {
  readonly markForTrain?: boolean
  readonly debug?: boolean
  readonly favourited?: boolean
}

export interface SetTrackFlagsVariables {
  readonly deviceId: number
  readonly trackId: string
  readonly flags: TrackFlagsPatchInput
  // The generated tRPC input carries an index signature; mirror it so the real
  // and disabled hooks are both structurally assignable to the selector type.
  readonly [key: string]: unknown
}

/** Resolved state after a write — both flags present, absent already collapsed. */
export interface TrackFlagsResult {
  readonly trackId: string
  readonly markForTrain: boolean
  readonly debug: boolean
  readonly favourited: boolean
}

export interface SetTrackFlagsMutation {
  readonly mutateAsync: (vars: SetTrackFlagsVariables) => Promise<unknown>
  readonly isPending: boolean
}

/** True when the deployed host ui-library carries the `setTrackFlags` cap hook. */
export const TRACK_FLAGS_AVAILABLE = typeof usePipelineAnalyticsSetTrackFlags === 'function'

/** Tooltip shown on the disabled toggles until the cap router lands. */
export const TRACK_FLAGS_UNAVAILABLE_TITLE = 'Track flags arrive with the next server update'

function useDisabledSetTrackFlags(): SetTrackFlagsMutation {
  return {
    mutateAsync: async (): Promise<never> => {
      throw new Error('setTrackFlags unavailable')
    },
    isPending: false,
  }
}

/**
 * The set-track-flags mutation hook — the real generated hook when present,
 * else a stable disabled stub. Resolved ONCE at module load.
 */
export const useSetTrackFlagsMutation: () => SetTrackFlagsMutation = TRACK_FLAGS_AVAILABLE
  ? usePipelineAnalyticsSetTrackFlags
  : useDisabledSetTrackFlags

/**
 * Narrow an unknown mutation result to the resolved flag pair.
 *
 * The response is the AUTHORITY on what the toggles now show — a click is a
 * request, not a state change. A malformed reply yields `null` so the caller
 * leaves the toggle where the server last put it rather than inventing a state.
 */
export function toTrackFlagsResult(value: unknown): TrackFlagsResult | null {
  if (typeof value !== 'object' || value === null) return null
  if (
    !('trackId' in value) ||
    !('markForTrain' in value) ||
    !('debug' in value) ||
    !('favourited' in value)
  ) {
    return null
  }
  const { trackId, markForTrain, debug, favourited } = value
  if (typeof trackId !== 'string') return null
  if (
    typeof markForTrain !== 'boolean' ||
    typeof debug !== 'boolean' ||
    typeof favourited !== 'boolean'
  ) {
    return null
  }
  return { trackId, markForTrain, debug, favourited }
}
