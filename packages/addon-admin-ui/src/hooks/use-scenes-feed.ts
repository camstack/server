/**
 * useScenesFeed — the camera scenes shown on Library → Scenes.
 *
 * **One query for the whole selection, not one per camera.** This was a
 * `useQueries` fan-out — one React Query and one browser → hub →
 * post-analysis round trip PER CAMERA, every 30 seconds, to read an in-memory
 * merge the owner already held. `sceneMonitor.listScenesBatch` asks the same
 * question of the set in one call; the per-device work at the owner is
 * identical.
 *
 * The poll STAYS: the push slice keeps rows fresh and this is the safety net
 * behind it. What changed is the size of the question, not how often it is asked.
 *
 * **A camera that cannot answer is not a camera with no scenes.** `scene-monitor`
 * is a `defaultActive` wrapper, so every camera is asked; a camera whose provider
 * is absent (pipeline-analytics not deployed, or the post-processing node down)
 * cannot be read. That must not render as an empty list — silence reading as
 * "nothing configured" is this feature's whole failure mode — so the batch gives
 * every requested id a row and marks the unreadable ones `status: null`. They
 * are counted and surfaced, separately from the rows.
 */
import { useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import type { SceneCameraResult } from '../pages/scenes.helpers.js'

/** The push slice keeps rows fresh; this poll is the safety net behind it. */
const POLL_MS = 30_000

export interface ScenesFeed {
  readonly results: readonly SceneCameraResult[]
  readonly isLoading: boolean
  /** Cameras whose scene status could not be read. Reported, never silently dropped. */
  readonly unreachableCount: number
}

/** What one batch answer yields once the unreadable rows are separated out. */
interface ScenesBatch {
  readonly results: readonly SceneCameraResult[]
  readonly unreachableCount: number
}

const EMPTY: ScenesBatch = { results: [], unreachableCount: 0 }

export function useScenesFeed(deviceIds: readonly number[]): ScenesFeed {
  const system = useSystem()

  // An empty selection is a request for nothing, and asks nothing.
  const enabled = deviceIds.length > 0
  const key = [...deviceIds].sort((a, b) => a - b)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['scenes-feed', key] as const,
    enabled,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    // One failed attempt is enough to call a provider absent; retrying three
    // times turns a missing addon into a stall.
    retry: false,
    queryFn: async (): Promise<ScenesBatch> => {
      const answer = await system.trpcClient.sceneMonitor.listScenesBatch.query({
        deviceIds: key,
      })
      const results: SceneCameraResult[] = []
      let unreachableCount = 0
      for (const row of answer) {
        if (row.status === null) {
          unreachableCount++
          continue
        }
        results.push({ deviceId: row.deviceId, monitors: row.status.monitors })
      }
      return { results, unreachableCount }
    },
  })

  // The whole call failing is EVERY requested camera unreachable — the same
  // thing the fan-out reported when every one of its queries errored. Losing
  // this would make a dead post-analysis addon render as a fleet with no
  // scenes configured, which is the failure this hook exists to avoid.
  const settled = data ?? (isError ? { results: [], unreachableCount: key.length } : EMPTY)

  return {
    results: settled.results,
    isLoading: enabled && isLoading,
    unreachableCount: settled.unreachableCount,
  }
}
