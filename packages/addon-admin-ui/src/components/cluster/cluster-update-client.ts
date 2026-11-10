import { useMemo } from 'react'
import type {
  ClusterUpdateJob,
  ClusterUpdateOptions,
  ClusterUpdatePlan,
  StartClusterUpdateResult,
} from '@camstack/types'
import { useSystem } from '@camstack/ui-library'

/** The three calls the dialog makes. Injected in specs; the page uses the hub client. */
export interface ClusterUpdateClient {
  readonly preview: (options: ClusterUpdateOptions) => Promise<ClusterUpdatePlan>
  readonly start: (options: ClusterUpdateOptions) => Promise<StartClusterUpdateResult>
  readonly readJob: (jobId: string | undefined) => Promise<ClusterUpdateJob | null>
}

/** Schedules the next job read. Specs capture the callback instead of waiting. */
export interface ClusterUpdateClock {
  readonly later: (ms: number, tick: () => void) => () => void
}

export const clusterUpdateClock: ClusterUpdateClock = {
  later: (ms, tick) => {
    const id = setTimeout(tick, ms)
    return () => clearTimeout(id)
  },
}

export function useHubClusterUpdateClient(): ClusterUpdateClient {
  const { trpcClient } = useSystem()
  return useMemo(
    (): ClusterUpdateClient => ({
      preview: (options) => trpcClient.clusterUpdate.previewClusterUpdate.query(options),
      start: (options) => trpcClient.clusterUpdate.startClusterUpdate.mutate(options),
      readJob: (jobId) =>
        trpcClient.clusterUpdate.getClusterUpdateJob.query(jobId === undefined ? {} : { jobId }),
    }),
    [trpcClient],
  )
}
