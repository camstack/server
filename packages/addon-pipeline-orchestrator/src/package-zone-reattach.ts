/**
 * Re-attach a placed camera after its `package` zone rules changed.
 *
 * A package zone flips the toggle-less `package-detection` root on or off
 * (`applyPackageZoneActivation`), which changes the step TREE, so the live
 * attach must be re-resolved rather than wait for the next natural attach.
 * It goes through the one owner of an attach's steps (D650) on the device the
 * camera is already elected onto — a bare re-resolve here used to gate on the
 * node DEFAULT format and drop the device's provisioning and jump roster.
 */
import { errMsg, type IScopedLogger, type RunnerCameraConfig } from '@camstack/types'
import { type AttachPipelineOutcome, withAttachPipeline } from './attach-pipeline.js'
import type { PlacementLedger } from './placement-ledger.js'

export interface PackageZoneReattachDeps {
  readonly ledger: Pick<PlacementLedger, 'getAssignment' | 'getConfig' | 'setConfig'>
  /** `PlacementService.resolveAttachPipelineOnDevice`. */
  readonly resolveAttachPipeline: (input: {
    readonly deviceId: number
    readonly nodeId: string
    readonly deviceKey: string | undefined
  }) => Promise<AttachPipelineOutcome>
  readonly attachOn: (nodeId: string, config: RunnerCameraConfig) => Promise<void>
  readonly logger: IScopedLogger
}

/** No-op for a camera that is not placed or has no ledger config. Never throws. */
export async function reattachAfterPackageZoneChange(
  deps: PackageZoneReattachDeps,
  deviceId: number,
): Promise<void> {
  const assignment = deps.ledger.getAssignment(deviceId)
  const cached = deps.ledger.getConfig(deviceId)
  if (!assignment || !cached) return
  const nodeId = assignment.agentNodeId
  try {
    const outcome = await deps.resolveAttachPipeline({
      deviceId,
      nodeId,
      deviceKey: cached.deviceKey,
    })
    if (outcome.kind === 'root-refused') {
      // The live attach is kept rather than replaced by one without its root.
      deps.logger.error(
        'package zone-rule re-attach refused — the elected device cannot run the camera root',
        {
          tags: { deviceId, nodeId },
          meta: {
            deviceKey: outcome.deviceKey ?? null,
            droppedRoots: outcome.droppedRoots.join(','),
          },
        },
      )
      return
    }
    const next = withAttachPipeline(cached, outcome.pipeline)
    deps.ledger.setConfig(deviceId, next)
    await deps.attachOn(nodeId, next)
  } catch (err: unknown) {
    deps.logger.warn('package zone-rule change re-dispatch failed', {
      tags: { deviceId, nodeId },
      meta: { error: errMsg(err) },
    })
  }
}
