/**
 * What the assist must ask, read from the server rather than typed here — for
 * the camera of the OPEN frame. Three reads, all already owned by the Pipeline
 * page; `resolveAssistDetector` collapses them and refuses to guess. The model
 * is the accelerator's — a camera carries none (D927).
 */
import type { PipelineSchema } from '@camstack/types'
import {
  usePipelineExecutorGetSchema,
  usePipelineOrchestratorGetCameraStatuses,
  usePipelineOrchestratorGetNodeInferenceDevices,
} from '@camstack/ui-library'
import { useMemo } from 'react'
import { type AssistDetector, resolveAssistDetector } from './lib/retrain-assist-defaults.js'

export interface AssistDetectorState {
  readonly detector: AssistDetector
  /** The detection node's step catalog — the teacher candidates come from it. */
  readonly schema: PipelineSchema | undefined
}

export function useAssistDetector(deviceId: number | null): AssistDetectorState {
  const cameraStatuses = usePipelineOrchestratorGetCameraStatuses(
    { deviceIds: deviceId === null ? [] : [deviceId] },
    { enabled: deviceId !== null, staleTime: 30_000 },
  )
  const detectionNodeId = cameraStatuses.data?.[0]?.detection?.nodeId ?? null
  const nodeDevices = usePipelineOrchestratorGetNodeInferenceDevices(
    { nodeId: detectionNodeId ?? '' },
    { enabled: detectionNodeId !== null, staleTime: 30_000 },
  )
  const nodeSchema = usePipelineExecutorGetSchema(
    { nodeId: detectionNodeId ?? '' },
    { enabled: detectionNodeId !== null, staleTime: 30_000 },
  )
  const detector = useMemo(
    () =>
      resolveAssistDetector({
        status: cameraStatuses.data?.[0],
        nodeDevices: nodeDevices.data,
        schema: nodeSchema.data,
      }),
    [cameraStatuses.data, nodeDevices.data, nodeSchema.data],
  )
  return { detector, schema: nodeSchema.data }
}
