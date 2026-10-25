/**
 * useKeyEventsFeed — the Detection Intelligence Events page feed.
 *
 * **One query for the whole selection, not one per camera.** This was a
 * `useQueries` fan-out — one React Query and one browser → hub →
 * post-analysis round trip PER selected device, every 30 seconds.
 * `pipelineAnalytics.getKeyEventsBatch` asks the same question of the set in
 * one call: the store queries are unchanged and still run per camera inside the
 * owner (each is `where deviceId` + a `firstSeen` range against its own index,
 * and `limit` is still PER CAMERA), so only the transport collapses.
 *
 * The poll STAYS, and `useEventsLiveRefresh` still invalidates the
 * `['events-feed']` key root to push live updates ahead of it.
 *
 * The per-camera arrays are flattened by the pure `mergeKeyEvents` helper and
 * sorted importance-desc by `sortKeyEvents`. The `deviceId` now rides ON the
 * row from the server rather than being stamped from the fan-out key — which
 * only worked because there was one query per camera.
 *
 * Calls the vanilla tRPC client off `useSystem().trpcClient` (the
 * `PathBrowser.tsx` / `backend.ts` precedent) rather than a generated hook.
 */
import { useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { type KeyEventRow, mergeKeyEvents, sortKeyEvents } from './key-events-merge.js'

const PER_CAMERA_LIMIT = 200
const STALE_MS = 30_000

export interface KeyEventsFeedInput {
  readonly deviceIds: readonly number[]
  readonly since: number
  readonly until: number
  readonly minImportance?: number
  readonly classFilter?: string
}

export interface KeyEventsFeed {
  /** Merged across cameras, importance-desc default. */
  readonly rows: readonly KeyEventRow[]
  readonly isLoading: boolean
}

const NO_LANES: readonly (readonly KeyEventRow[])[] = []

export function useKeyEventsFeed(input: KeyEventsFeedInput): KeyEventsFeed {
  const system = useSystem()

  // An empty selection is a request for nothing, and asks nothing.
  const enabled = input.deviceIds.length > 0
  const key = [...input.deviceIds].sort((a, b) => a - b)

  const { data, isLoading } = useQuery({
    queryKey: [
      'events-feed',
      key,
      input.since,
      input.until,
      input.minImportance ?? null,
      input.classFilter ?? null,
    ] as const,
    enabled,
    staleTime: STALE_MS,
    refetchInterval: STALE_MS,
    queryFn: async (): Promise<readonly (readonly KeyEventRow[])[]> => {
      const answer = await system.trpcClient.pipelineAnalytics.getKeyEventsBatch.query({
        deviceIds: key,
        since: input.since,
        until: input.until,
        limit: PER_CAMERA_LIMIT,
        ...(input.minImportance !== undefined ? { minImportance: input.minImportance } : {}),
        ...(input.classFilter !== undefined ? { classFilter: input.classFilter } : {}),
      })
      // Still one lane per camera: `mergeKeyEvents` is the pure helper that
      // flattens them, and a caller that renders one camera's lane needs to
      // know which camera a row came from.
      return answer.map((lane) => lane.events.map((e) => ({ ...e, deviceId: lane.deviceId })))
    },
  })

  return {
    rows: sortKeyEvents(mergeKeyEvents(data ?? NO_LANES), 'importance'),
    isLoading: enabled && isLoading,
  }
}
