/**
 * Pure mapper: per-node inference devices → placements of each effective root
 * detector model. Training's base-model picker lists every `node · device`
 * where a trainable base is the cluster's object-detection root.
 *
 * Mirrors Model Studio's `acceleratorsRunningModel` decision (effective model
 * via {@link resolveEffectiveStepModel}) but aggregates across nodes and does
 * not gate on on-disk currency — "in use" here means the root the node would
 * run. ui-library must not import addon-model-studio; a sync guard can later
 * hold the two pure paths equal.
 */
import { acceleratorShortLabel, type AcceleratorIdentity } from '../accelerator-label'
import {
  resolveEffectiveStepModel,
  stepHasModelForFormat,
  type StepModelCatalog,
} from '../resolve-step-default-model'

/** Root detection step — the only step whose models are trainable bases. */
export const ROOT_DETECTOR_STEP_ID = 'object-detection' as const

export interface TrainingBaseModelPlacement {
  readonly nodeId: string
  readonly deviceKey: string
  /** Short accelerator label (`NPU`, `iGPU`, …); the row formats as `node · label`. */
  readonly label: string
}

export interface RootDetectorDeviceInput extends AcceleratorIdentity {
  readonly enabled: boolean
  readonly format: string
  readonly defaultModelId?: string
  readonly steps?: Readonly<Record<string, { readonly modelId?: string }>>
}

/** One online node's catalog + devices for root-detector placement. */
export interface RootDetectorNodeInput {
  readonly nodeId: string
  readonly devices: readonly RootDetectorDeviceInput[]
  /** Object-detection step catalog (`slot: 'detector'`). */
  readonly catalog: StepModelCatalog & { readonly slot?: string }
}

function comparePlacement(a: TrainingBaseModelPlacement, b: TrainingBaseModelPlacement): number {
  const byNode = a.nodeId.localeCompare(b.nodeId)
  if (byNode !== 0) return byNode
  const byLabel = a.label.localeCompare(b.label)
  if (byLabel !== 0) return byLabel
  return a.deviceKey.localeCompare(b.deviceKey)
}

/**
 * For each modelId that is the effective root on at least one enabled device,
 * the full list of placements (sorted by node, then device label).
 */
export function mapRootDetectorPlacements(
  nodes: readonly RootDetectorNodeInput[],
  stepId: string = ROOT_DETECTOR_STEP_ID,
): ReadonlyMap<string, readonly TrainingBaseModelPlacement[]> {
  const buckets = new Map<string, TrainingBaseModelPlacement[]>()
  for (const node of nodes) {
    for (const device of node.devices) {
      if (!device.enabled) continue
      if (!stepHasModelForFormat(node.catalog.models, device.format)) continue
      const effective = resolveEffectiveStepModel({
        catalog: node.catalog,
        device,
        base: device.steps?.[stepId]?.modelId,
      })
      if (effective === undefined) continue
      const list = buckets.get(effective) ?? []
      list.push({
        nodeId: node.nodeId,
        deviceKey: device.key,
        label: acceleratorShortLabel(device),
      })
      buckets.set(effective, list)
    }
  }
  const out = new Map<string, readonly TrainingBaseModelPlacement[]>()
  for (const [modelId, list] of buckets) {
    out.set(modelId, [...list].toSorted(comparePlacement))
  }
  return out
}

/** Model ids that appear as an effective root somewhere in the cluster. */
export function clusterRootModelIds(
  placements: ReadonlyMap<string, readonly TrainingBaseModelPlacement[]>,
): readonly string[] {
  return [...placements.keys()].toSorted((a, b) => a.localeCompare(b))
}

/**
 * Intersection of listed trainable models and cluster root detectors — the
 * Select-all-roots action. Order follows `trainableModelIds`.
 */
export function defaultSelectClusterRoots(
  trainableModelIds: readonly string[],
  clusterRootIds: readonly string[],
): readonly string[] {
  const roots = new Set(clusterRootIds)
  return trainableModelIds.filter((id) => roots.has(id))
}
