/**
 * The step switch matrix and the three writers (D1065) the cluster, node and
 * accelerator controls share. One query: the controls and the explanation of
 * their effect come from the same answer, and every write refetches it.
 *
 * The view keeps `pending` and `error` apart from `ready`: a matrix that has
 * not answered is not a matrix with every step off.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  usePipelineOrchestratorGetStepSwitches,
  usePipelineOrchestratorSetClusterStepMode,
  usePipelineOrchestratorSetDeviceStepEnabled,
  usePipelineOrchestratorSetNodeStepEnabled,
} from '@dominevo/ui-library'
import type { StepClusterMode } from '@dominevo/types'
import type { StepSwitchRow } from './step-switches-model'

const POLL_MS = 15_000

export type StepSwitchesView =
  | { readonly status: 'pending' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly rows: readonly StepSwitchRow[] }

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

export function useStepSwitches(fallbackError: string): StepSwitchesView {
  const query = usePipelineOrchestratorGetStepSwitches(undefined, { refetchInterval: POLL_MS })
  if (query.data !== undefined) return { status: 'ready', rows: query.data.steps }
  if (query.isError) return { status: 'error', message: errorText(query.error, fallbackError) }
  return { status: 'pending' }
}

export interface StepSwitchWriters {
  readonly setClusterMode: (stepId: string, mode: StepClusterMode | null) => void
  readonly setNodeEnabled: (nodeId: string, stepId: string, enabled: boolean | null) => void
  readonly setDeviceEnabled: (
    nodeId: string,
    deviceKey: string,
    stepId: string,
    enabled: boolean | null,
  ) => void
  readonly isPending: boolean
  /** The last failed write's message; null when the last write succeeded. */
  readonly error: string | null
}

export function useStepSwitchWriters(fallbackError: string): StepSwitchWriters {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: [['pipelineOrchestrator', 'getStepSwitches']] })
    void queryClient.invalidateQueries({
      queryKey: [['pipelineOrchestrator', 'getNodeInferenceDevices']],
    })
  }
  const handlers = {
    onSuccess: (): void => setError(null),
    onError: (e: unknown): void => setError(errorText(e, fallbackError)),
    onSettled: refresh,
  }
  const cluster = usePipelineOrchestratorSetClusterStepMode(handlers)
  const node = usePipelineOrchestratorSetNodeStepEnabled(handlers)
  const device = usePipelineOrchestratorSetDeviceStepEnabled(handlers)
  return {
    setClusterMode: (stepId, mode) => cluster.mutate({ stepId, mode }),
    setNodeEnabled: (agentNodeId, stepId, enabled) => node.mutate({ agentNodeId, stepId, enabled }),
    setDeviceEnabled: (agentNodeId, deviceKey, stepId, enabled) =>
      device.mutate({ agentNodeId, deviceKey, stepId, enabled }),
    isPending: cluster.isPending || node.isPending || device.isPending,
    error,
  }
}
