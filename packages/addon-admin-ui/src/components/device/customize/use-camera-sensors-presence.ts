/**
 * Is the camera-sensors bridge (D672) on this hub, and what does it report for
 * this camera? Asked of its OWN authority: CS-1's `getCameraStatus` always
 * carries `cameraSensors`, so an answer without the key is an older server
 * (absent), and a failed read is unknown — never absent (D315). The registry
 * is asked first (`useCapabilityPresence`): only an ANSWERED "no
 * pipeline-orchestrator" makes it absent without asking the status at all.
 */
import type { CameraSensorsStatus } from '@camstack/types'
import {
  type CapabilityPresence,
  useCapabilityPresence,
  usePipelineOrchestratorGetCameraStatus,
} from '@camstack/ui-library'

const ORCHESTRATOR_CAP = 'pipeline-orchestrator'

export type CameraSensorsPresence = 'pending' | 'unknown' | 'absent' | 'present'

/** The one field of a camera status this read looks at. */
export interface CameraSensorsCarrier {
  readonly cameraSensors?: CameraSensorsStatus
}

export interface CameraStatusQueryView {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: CameraSensorsCarrier | undefined
}

/**
 * present ONLY when the status answered WITH a `cameraSensors` key (CS-1 always
 * populates it). A failed refetch that still holds that answer stays present.
 */
export function cameraSensorsPresence(query: CameraStatusQueryView): CameraSensorsPresence {
  if (query.data !== undefined) {
    return query.data.cameraSensors === undefined ? 'absent' : 'present'
  }
  if (query.status === 'pending') return 'pending'
  if (query.status === 'error') return 'unknown'
  return 'pending'
}

/** The registry's ANSWERED absence wins; anything else defers to the status read. */
export function resolveCameraSensorsPresence(
  orchestrator: CapabilityPresence,
  query: CameraStatusQueryView,
): CameraSensorsPresence {
  if (orchestrator === 'absent') return 'absent'
  return cameraSensorsPresence(query)
}

/**
 * How a re-read after a write ended. React Query's `refetch()` RESOLVES with an
 * error result instead of throwing, so a caller that only catches never learns
 * that the re-read failed — the outcome is answered here, once.
 */
export type CameraSensorsRefetchOutcome = 'answered' | 'failed'

export interface CameraSensorsRead {
  readonly presence: CameraSensorsPresence
  readonly status: CameraSensorsStatus | null
  /** Set when the status read failed and no answer is held. */
  readonly failureReason: string | null
  readonly refetch: () => Promise<CameraSensorsRefetchOutcome>
}

export interface RefetchResultView {
  readonly isError: boolean
}

export async function refetchOutcome(
  refetch: () => Promise<RefetchResultView>,
): Promise<CameraSensorsRefetchOutcome> {
  try {
    const result = await refetch()
    return result.isError ? 'failed' : 'answered'
  } catch {
    return 'failed'
  }
}

export function useCameraSensors(deviceId: number, isCamera: boolean): CameraSensorsRead {
  const orchestrator = useCapabilityPresence(ORCHESTRATOR_CAP)
  const query = usePipelineOrchestratorGetCameraStatus(
    { deviceId },
    { enabled: isCamera && orchestrator !== 'absent' },
  )
  const refetch = (): Promise<CameraSensorsRefetchOutcome> => refetchOutcome(query.refetch)
  const held = query.data !== undefined
  const failureReason = !held && query.status === 'error' ? (query.error?.message ?? null) : null
  if (!isCamera) return { presence: 'absent', status: null, failureReason: null, refetch }
  return {
    presence: resolveCameraSensorsPresence(orchestrator, {
      status: query.status,
      data: query.data,
    }),
    status: query.data?.cameraSensors ?? null,
    failureReason,
    refetch,
  }
}
