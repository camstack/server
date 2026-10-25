import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CameraDetectionSource } from '@camstack/types'
import {
  usePipelineOrchestratorGetCameraDetectionSource,
  usePipelineOrchestratorSetCameraDetectionSource,
} from '@camstack/ui-library'

const QUERY_KEY = [['pipelineOrchestrator', 'getCameraDetectionSource']] as const

/**
 * A camera's root-detector pick: read and written through the orchestrator's
 * own cap — the one authority (D62) — never through the contributed settings
 * aggregate.
 *
 * The picked value stays on screen from the click until the server has been
 * RE-READ. Dropping it when the mutation resolves shows the old value for the
 * length of the refetch — the operator's "it snapped back, I changed it a
 * second time". A refused write clears it and says why.
 */
export function useCameraDetectionSource(deviceId: number) {
  const queryClient = useQueryClient()
  const query = usePipelineOrchestratorGetCameraDetectionSource(
    { deviceId },
    { refetchOnMount: 'always' },
  )
  const mutation = usePipelineOrchestratorSetCameraDetectionSource()
  const [picked, setPicked] = useState<CameraDetectionSource | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = useCallback(
    async (source: CameraDetectionSource): Promise<void> => {
      setError(null)
      setPicked(source)
      try {
        await mutation.mutateAsync({ deviceId, source })
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not change the root detector')
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      } finally {
        setPicked(null)
      }
    },
    [deviceId, mutation, queryClient],
  )

  // `undefined` while the read has not answered; `null` is a hub that has no answer to give.
  const view = query.data ?? null
  return {
    view,
    isLoading: query.isLoading,
    source: picked ?? view?.source ?? null,
    saving: picked !== null,
    error,
    pick,
  }
}
