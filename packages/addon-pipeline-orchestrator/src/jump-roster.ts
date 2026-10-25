/**
 * The same-node jump roster a camera's attach carries (D650).
 *
 * The runner jumps a DETAIL step off the elected device when that device's
 * format cannot run it (`addon-pipeline/src/pipeline-runner/device-jump.ts`).
 * This module builds the roster it jumps within — and it is the ONE place that
 * does, so the consumers cannot disagree about it:
 *
 *  - `resolveAttachPipeline` (`attach-pipeline.ts`) gates the resolve on its
 *    formats (`jumpTargetKeys`), so a detail step is kept only when a device
 *    the runner can actually reach ships a build;
 *  - the same function provisions every entry for THIS camera (`steps`), so a
 *    jumped step runs the TARGET's model and settings — the elected device's
 *    base and override never follow it across;
 *  - the attach carries it as `RunnerCameraConfig.inferenceDevices`.
 *
 * Ownership of the model: the orchestrator alone decides which model the
 * operator chose for a (node, device, camera) — `applyDeviceProvisioning`, for
 * the elected device and every jump target alike. The runner only picks the
 * target; the executor only resolves that choice against the target pool's
 * format (`resolveModelForFormat`, absent ⇒ the format default).
 */
import type { RunnerInferenceDevice } from '@camstack/types'
import { buildInferenceDeviceRoster } from './inference-device-model.js'

export interface JumpRosterInput {
  /** The elected device; absent ⇒ default pool, nothing to jump from. */
  readonly deviceKey: string | undefined
  /** Enabled∧available devices of the node, `deviceKey → weight` (the balancer's set). */
  readonly eligible: Readonly<Record<string, number>>
  /** `deviceKey → maxSessions`. */
  readonly caps: Readonly<Record<string, number>>
}

/**
 * The roster (unprovisioned), or `undefined` when there is no jump to make: no
 * elected device, or fewer than two eligible devices on the node.
 */
export function buildJumpRoster(input: JumpRosterInput): RunnerInferenceDevice[] | undefined {
  if (!input.deviceKey || Object.keys(input.eligible).length < 2) return undefined
  return buildInferenceDeviceRoster(input.eligible, input.caps)
}

/** The roster devices a detail step may jump TO — every entry except the elected one. */
export function jumpTargetKeys(
  roster: readonly RunnerInferenceDevice[] | undefined,
  electedDeviceKey: string | undefined,
): readonly string[] {
  return (roster ?? []).map((d) => d.deviceKey).filter((k) => k !== electedDeviceKey)
}
