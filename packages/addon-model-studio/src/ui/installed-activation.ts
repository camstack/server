/**
 * Pure helpers: which inference accelerators run a model (Pipeline matrix
 * effective chain), and how to write Activate onto `setAgentInferenceDevices`.
 *
 * Active ≠ explicit `steps[stepId].modelId` pin. Live hub example: GPU/NPU
 * carry `defaultModelId: yolov9m-320-int8` with empty `steps` — object-detection
 * still runs that model. The Installed tab must use the SAME
 * `resolveEffectiveStepModel` the matrix cell uses, or every seed looks idle
 * and Remove stays enabled on models the fleet is running.
 */
import { acceleratorShortLabel } from '@camstack/ui-library'
import type { DeviceStepConfig, NodeInferenceDevice } from '@camstack/types'
import {
  clusterModelSettingKey,
  isClusterScopedStep,
  type ClusterStepModels,
} from '@camstack/types'
import { resolveEffectiveStepModel, stepHasModelForFormat } from '@camstack/ui-library'

/** Minimal per-step catalog for effective-model resolution (from getSchema). */
export interface StepCatalogForActive {
  readonly id: string
  readonly slot?: string
  readonly defaultModelId: string
  readonly defaultModelIdByFormat?: Readonly<Record<string, string>>
  readonly models: readonly {
    readonly id: string
    readonly formats: Readonly<Record<string, { readonly sizeMB: number }>>
    readonly legacy?: boolean
  }[]
}

export interface ActiveAccelerator {
  readonly deviceKey: string
  /** Short label for the badge (`NPU`, `iGPU`, `ANE` — the shared short name). */
  readonly label: string
  readonly format: string
}

/**
 * Accelerators CONFIGURED to run `modelId` for `stepId`: the device is
 * ENABLED, its format's file is current on this node (`currentFormats`), and
 * its EFFECTIVE model — override/base pin → device election (detector) →
 * catalog format-default — is `modelId`.
 *
 * Without the first two checks a disabled CPU "ran" its format default
 * (yolo26n on the live hub) and the Installed tab hid Remove on a file no
 * device used. Configured is not loaded: what a pool holds RIGHT NOW comes
 * from `listLoadedEngines` (`installed-inventory.ts`).
 * Cluster-scoped steps are handled by {@link clusterPinsModel}, not here.
 */
export function acceleratorsRunningModel(
  devices: readonly NodeInferenceDevice[],
  stepId: string,
  modelId: string,
  catalog: StepCatalogForActive | null | undefined,
  currentFormats: ReadonlySet<string>,
): readonly ActiveAccelerator[] {
  if (catalog === null || catalog === undefined) return []
  if (isClusterScopedStep(stepId)) return []
  const out: ActiveAccelerator[] = []
  for (const d of devices) {
    if (!d.enabled) continue
    if (!currentFormats.has(d.format)) continue
    if (!stepHasModelForFormat(catalog.models, d.format)) continue
    const effective = resolveEffectiveStepModel({
      catalog,
      device: d,
      base: d.steps?.[stepId]?.modelId,
    })
    if (effective !== modelId) continue
    out.push({
      deviceKey: d.key,
      label: acceleratorShortLabel(d),
      format: d.format,
    })
  }
  return out
}

/** Cluster-scoped step: active when the cluster row equals `modelId`. */
export function clusterPinsModel(
  stepId: string,
  modelId: string,
  clusterModels: ClusterStepModels | null,
): boolean {
  if (!isClusterScopedStep(stepId)) return false
  if (clusterModels === null) return false
  return clusterModels[stepId] === modelId
}

export function clusterModelPatch(stepId: string, modelId: string): Record<string, string> {
  return { [clusterModelSettingKey(stepId)]: modelId }
}

/** One entry of the wholesale `setAgentInferenceDevices` payload. */
export type InferenceDevicesWriteMap = Record<
  string,
  {
    enabled: boolean
    weight: number
    maxSessions?: number
    steps?: Record<string, DeviceStepConfig>
  }
>

function writeEntryFromDevice(
  d: NodeInferenceDevice,
  steps: Record<string, DeviceStepConfig>,
  forceEnabled: boolean,
): InferenceDevicesWriteMap[string] {
  const hasSteps = Object.keys(steps).length > 0
  return {
    enabled: forceEnabled ? true : d.enabled,
    weight: Math.max(1, d.weight),
    ...(d.maxSessions !== null && d.maxSessions > 0 ? { maxSessions: d.maxSessions } : {}),
    ...(hasSteps ? { steps } : {}),
  }
}

/**
 * Read-patch-write sources for Activate: set `steps[stepId].modelId` on the
 * chosen deviceKeys (force-enabled), keep every other device as shown.
 */
export function patchStepModelOnDevices(
  devices: readonly NodeInferenceDevice[],
  stepId: string,
  modelId: string,
  targetKeys: readonly string[],
): InferenceDevicesWriteMap {
  const targets = new Set(targetKeys)
  const out: InferenceDevicesWriteMap = {}
  for (const d of devices) {
    const steps: Record<string, DeviceStepConfig> = { ...d.steps }
    if (targets.has(d.key)) {
      const prev = steps[stepId]
      steps[stepId] = {
        ...prev,
        modelId,
      }
    }
    out[d.key] = writeEntryFromDevice(d, steps, targets.has(d.key))
  }
  return out
}

/**
 * Settings save for one accelerator: write `modelId` + `settings` under the
 * selected device, and MOVE `settings` off every other device for the same
 * step (Pipeline matrix D62 — one authority per (node, step)).
 */
export function applyStepSettingsOnDevice(
  devices: readonly NodeInferenceDevice[],
  stepId: string,
  modelId: string,
  settings: Readonly<Record<string, unknown>>,
  selectedDeviceKey: string,
): InferenceDevicesWriteMap {
  const out: InferenceDevicesWriteMap = {}
  for (const d of devices) {
    const steps: Record<string, DeviceStepConfig> = { ...d.steps }
    if (d.key === selectedDeviceKey) {
      const prev = steps[stepId]
      steps[stepId] = {
        ...prev,
        modelId,
        settings: { ...settings },
      }
    } else {
      const cfg = steps[stepId]
      if (cfg?.settings !== undefined) {
        const { settings: _dropped, ...hardware } = cfg
        if (Object.keys(hardware).length > 0) steps[stepId] = hardware
        else delete steps[stepId]
      }
    }
    out[d.key] = writeEntryFromDevice(d, steps, d.key === selectedDeviceKey)
  }
  return out
}
