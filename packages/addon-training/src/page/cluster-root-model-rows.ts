/**
 * Build TrainingBaseModelPicker rows: trainable base models + every cluster
 * placement where each is the effective root detector. Pure over already-fetched
 * node snapshots — the caller loads devices + schema per online node.
 */
import type { TrainingBaseModel } from '@camstack/types'
import {
  clusterRootModelIds,
  mapRootDetectorPlacements,
  ROOT_DETECTOR_STEP_ID,
  type RootDetectorDeviceInput,
  type RootDetectorNodeInput,
  type StepModelCatalog,
  type TrainingBaseModelRow,
} from '@camstack/ui-library'

/** Structural slice of `pipelineExecutor.getSchema` this mapper reads. */
export interface SchemaSlotsLike {
  readonly slots: readonly {
    readonly addons: readonly {
      readonly id: string
      readonly slot?: string
      readonly defaultModelId?: string
      readonly defaultModelIdByFormat?: Readonly<Record<string, string>>
      readonly models: readonly {
        readonly id: string
        readonly formats: Readonly<Record<string, { readonly sizeMB: number }>>
        readonly legacy?: boolean
      }[]
    }[]
  }[]
}

export interface ClusterNodeSnapshot {
  readonly nodeId: string
  readonly devices: readonly RootDetectorDeviceInput[]
  readonly schema: SchemaSlotsLike
}

function objectDetectionCatalog(schema: SchemaSlotsLike):
  | (StepModelCatalog & {
      readonly slot?: string
    })
  | null {
  for (const slot of schema.slots) {
    for (const addon of slot.addons) {
      if (addon.id !== ROOT_DETECTOR_STEP_ID) continue
      if (typeof addon.defaultModelId !== 'string' || addon.defaultModelId.length === 0) {
        return null
      }
      return {
        defaultModelId: addon.defaultModelId,
        ...(addon.defaultModelIdByFormat !== undefined
          ? { defaultModelIdByFormat: addon.defaultModelIdByFormat }
          : {}),
        ...(addon.slot !== undefined ? { slot: addon.slot } : {}),
        models: addon.models.map((m) => ({
          id: m.id,
          formats: m.formats,
          ...(m.legacy === true ? { legacy: true } : {}),
        })),
      }
    }
  }
  return null
}

export function toRootDetectorNodes(
  snapshots: readonly ClusterNodeSnapshot[],
): readonly RootDetectorNodeInput[] {
  const out: RootDetectorNodeInput[] = []
  for (const snap of snapshots) {
    const catalog = objectDetectionCatalog(snap.schema)
    if (catalog === null) continue
    out.push({
      nodeId: snap.nodeId,
      devices: snap.devices,
      catalog,
    })
  }
  return out
}

export interface ClusterRootModelRows {
  readonly models: readonly TrainingBaseModelRow[]
  readonly clusterRootModelIds: readonly string[]
}

/** Join trainable catalog ids with cluster root placements. */
export function buildClusterRootModelRows(
  baseModels: readonly TrainingBaseModel[],
  snapshots: readonly ClusterNodeSnapshot[],
): ClusterRootModelRows {
  const placements = mapRootDetectorPlacements(toRootDetectorNodes(snapshots))
  const roots = clusterRootModelIds(placements)
  const models = baseModels.map((m) => ({
    modelId: m.modelId,
    label: m.label,
    ...(m.recommended ? { recommended: true as const } : {}),
    placements: placements.get(m.modelId) ?? [],
  }))
  return { models, clusterRootModelIds: roots }
}
