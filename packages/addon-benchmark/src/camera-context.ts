/**
 * Resolving a camera to the coordinates the pipeline actually works in.
 *
 * The pipeline's unit of work is `(camera → node → deviceKey)`, resolved by
 * two owners: `pipelineOrchestrator.resolvePipeline` for the STRUCTURE, and
 * the per-`(node, deviceKey)` provisioning for the model. The Detection
 * Pipeline tab used to invent its tree from
 * `schema.slots[].addons[].defaultModelId` — one model per step, node-wide —
 * which no camera necessarily runs, and it had one dropdown (node) for three
 * coordinates.
 *
 * This module holds the pure half so the rules are assertable. Nothing here
 * derives a model: an absent `modelId` from `resolvePipeline` means "the
 * executing node resolves its own format default", and it stays absent. A
 * second model resolution in a second place is exactly the failure
 * `scripts/check-step-model-single-owner.ts` was written for.
 */
import type { PipelineStepInputOutput } from './benchmark-schemas.js'
import { translate } from './i18n/index.js'

/** One probed accelerator from `pipelineOrchestrator.getNodeInferenceDevices`. */
export interface NodeDevice {
  readonly key: string
  readonly backend: string
  readonly device: string
  readonly format: string
  readonly available: boolean
}

/** The `(backend, device)` a camera is LIVE on, from `getCameraStatuses`. */
export interface LiveEngine {
  readonly backend: string
  readonly device: string
}

/**
 * The node's roster is the authority on how a device is spelled — `cpu` is
 * `cpu`, not `cpu:cpu`, and only the roster knows that. Compose the
 * documented `<backend>:<device>` form only when the roster does not list
 * the engine the camera claims (a stale status, or a device that went away);
 * the caller marks that case rather than substituting another device.
 */
export function deviceKeyOf(
  engine: LiveEngine | undefined,
  devices: readonly NodeDevice[],
): string | undefined {
  if (!engine) return undefined
  const match = devices.find((d) => d.backend === engine.backend && d.device === engine.device)
  return match ? match.key : `${engine.backend}:${engine.device}`
}

/** A step as `resolvePipeline` returns it — `modelId` optional by design. */
export interface ResolvedStep {
  readonly addonId: string
  readonly modelId?: string
  readonly enabled: boolean
  readonly children?: readonly ResolvedStep[]
  readonly settings?: Readonly<Record<string, unknown>>
}

/**
 * Project the resolved tree onto the run payload's step shape. A pure
 * rename: no model is chosen, defaulted or substituted here.
 */
export function resolvedStepsToRunSteps(
  steps: readonly ResolvedStep[],
): readonly PipelineStepInputOutput[] {
  return steps.map((s) => ({
    addonId: s.addonId,
    ...(s.modelId ? { modelId: s.modelId } : {}),
    enabled: s.enabled,
    children: resolvedStepsToRunSteps(s.children ?? []),
    ...(s.settings && Object.keys(s.settings).length > 0 ? { settings: { ...s.settings } } : {}),
  }))
}

export interface ResolvedStepLine {
  readonly depth: number
  readonly addonId: string
  /** `'node default'` when `resolvePipeline` left the model to the node. */
  readonly modelLabel: string
  readonly enabled: boolean
}

/** Flatten the resolved tree for a read-only render. */
export function describeResolvedSteps(
  steps: readonly ResolvedStep[],
  depth = 0,
): readonly ResolvedStepLine[] {
  return steps.flatMap((s) => [
    {
      depth,
      addonId: s.addonId,
      modelLabel: s.modelId ?? translate('common.nodeDefault'),
      enabled: s.enabled,
    },
    ...describeResolvedSteps(s.children ?? [], depth + 1),
  ])
}
