/**
 * Which detector the retrain assist must ask, and on which node.
 *
 * The Retrain page used to send `{ modelId: 'yolo26n', minScore: 0.3 }` with no
 * `nodeId` at all — three literals in a `.tsx`. Measured on the live hub on
 * 2026-09-16, all three were wrong for camera 101: it detects on
 * `MacMiniAgent.localdomain` (not the hub, where an unowned call lands) on
 * `coreml:all`, whose elected detector is `yolov9m-320`. `yolo26n` is the step
 * CATALOG default — the number a page reaches for when it has nobody to ask —
 * and no enabled accelerator on that node runs it. A proposal produced that way
 * is not the pipeline's opinion about the frame, which is the only reason the
 * operator presses the button.
 *
 * So the page asks the server, through the same chain every other admin surface
 * uses for a step's model:
 *
 *   1. `pipelineOrchestrator.getCameraStatuses` — WHERE detection runs right
 *      now (`detection.nodeId`) and on which accelerator (`detection.engine`).
 *      The live placement, not the operator's pin: a camera assigned by
 *      capacity runs where the balancer put it.
 *   2. `pipelineOrchestrator.getNodeInferenceDevices` — that accelerator's
 *      per-(node,device) model for the step, and its election. A model is
 *      chosen by the accelerator that runs it; a camera carries none (D927).
 *   3. `pipelineExecutor.getSchema` — the step catalog: the format defaults and
 *      the `defaultConfidence` of each model (D662).
 *
 * The model layers are collapsed by `resolveEffectiveStepModel` in
 * `@camstack/ui-library`, which is the ONE owner of that decision
 * (`scripts/check-step-model-single-owner.ts` exists because three surfaces
 * once each had their own copy and disagreed). Nothing here restates it.
 *
 * ## Unknown is an answer
 *
 * Every path that cannot produce all three values returns a NAMED gap instead
 * of a default, and the page disables Propose and says which gap it hit. A
 * threshold or a model invented here would be indistinguishable, on screen,
 * from the pipeline's own — which is exactly the failure this replaces.
 * `detection: null` is read as "this camera runs no detector" only when
 * `degraded` does not name the `detection` stage; when it does, the stage could
 * not be READ and nothing may be concluded from its absence.
 */

import type {
  CameraStatus,
  NodeInferenceDevice,
  PipelineAddonSchema,
  PipelineSchema,
} from '@camstack/types'
import { resolveEffectiveStepModel } from '@camstack/ui-library'

/** The root detector step — the one `proposeRetrainAnnotations` runs. */
export const OBJECT_DETECTION_STEP_ID = 'object-detection'

/** `pipelineOrchestrator.getNodeInferenceDevices`, as this module reads it. */
export interface NodeInferenceDeviceSnapshot {
  readonly nodeId: string
  /** `false` ⇒ the node never answered; its device list says nothing. */
  readonly reachable: boolean
  readonly devices: readonly NodeInferenceDevice[]
}

/** Why the assist cannot be asked. One value per distinguishable cause. */
export type AssistDetectorGap =
  /** A read has not answered yet. Never a conclusion. */
  | 'pending'
  /** The status call could not read the detection stage (timeout / rejection). */
  | 'placement-unreadable'
  /** The camera genuinely runs no detector — nothing to mirror. */
  | 'detection-off'
  /** The node that runs detection did not answer about its accelerators. */
  | 'node-unreachable'
  /** The node answered, and does not list the accelerator detection runs on. */
  | 'device-unknown'
  /** That node's catalog carries no object-detection step. */
  | 'step-unknown'
  /** The catalog has the step but no model this accelerator's format can run. */
  | 'no-model'

export interface ResolvedAssistDetector {
  readonly kind: 'resolved'
  /** The node `proposeRetrainAnnotations` must be pinned to. */
  readonly nodeId: string
  readonly modelId: string
  readonly minScore: number
}

export interface UnresolvedAssistDetector {
  readonly kind: 'unknown'
  readonly gap: AssistDetectorGap
}

export type AssistDetector = ResolvedAssistDetector | UnresolvedAssistDetector

export interface AssistDetectorInput {
  /** `getCameraStatuses` for the one camera, `undefined` while unanswered. */
  readonly status: CameraStatus | undefined
  readonly nodeDevices: NodeInferenceDeviceSnapshot | undefined
  readonly schema: PipelineSchema | undefined
}

/** The detector catalog entry on the node that runs detection, if it has one. */
function findCatalog(schema: PipelineSchema, addonId: string): PipelineAddonSchema | undefined {
  for (const slot of schema.slots) {
    const addon = slot.addons.find((a) => a.id === addonId)
    if (addon !== undefined) return addon
  }
  return undefined
}

/**
 * The model, threshold and node the assist must use for one camera — or the
 * named reason it cannot be known.
 */
export function resolveAssistDetector(input: AssistDetectorInput): AssistDetector {
  const { status, nodeDevices, schema } = input
  if (status === undefined) return { kind: 'unknown', gap: 'pending' }

  if (status.detection === null) {
    const unread = status.degraded.some((d) => d.stage === 'detection')
    return { kind: 'unknown', gap: unread ? 'placement-unreadable' : 'detection-off' }
  }
  const detection = status.detection

  if (nodeDevices === undefined || schema === undefined) {
    return { kind: 'unknown', gap: 'pending' }
  }
  if (!nodeDevices.reachable) return { kind: 'unknown', gap: 'node-unreachable' }

  const device = nodeDevices.devices.find(
    (d) => d.backend === detection.engine.backend && d.device === detection.engine.device,
  )
  if (device === undefined) return { kind: 'unknown', gap: 'device-unknown' }

  const catalog = findCatalog(schema, OBJECT_DETECTION_STEP_ID)
  if (catalog === undefined) return { kind: 'unknown', gap: 'step-unknown' }

  const modelId = resolveEffectiveStepModel({
    catalog,
    device,
    base: device.steps?.[OBJECT_DETECTION_STEP_ID]?.modelId,
  })
  if (modelId === undefined) return { kind: 'unknown', gap: 'no-model' }

  return {
    kind: 'resolved',
    nodeId: detection.nodeId,
    modelId,
    // The default in force for the model that RUNS, from THAT node's catalog —
    // resolved on the node (D662: the model's own floor, else the step's). The
    // step value is only the fallback for a runner that predates the per-model
    // field. Deliberately not a fold of the camera's per-class sliders
    // (`minConfidencePerson`, …): the assist filter is one number, and a
    // min-across-classes would be a rule this file invented and no other
    // surface applies.
    minScore:
      catalog.models.find((m) => m.id === modelId)?.defaultConfidence ?? catalog.defaultConfidence,
  }
}
