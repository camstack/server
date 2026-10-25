/**
 * Per-(node,device) provisioning stage — attaches `modelId` + `settings` onto
 * the resolved (structure-only) step tree from the per-(node,device) BASE
 * (`inferenceDevices[node][deviceKey].steps`) and the camera's settings-only
 * layer (`cameraSettings[cam].stepSettings`, camera-semantic keys).
 *
 * A model is chosen by the accelerator that runs it (D927): `modelId` comes
 * from the base alone — a step left with no `modelId` lets the executor
 * resolve its own format default at runtime. `settings` merges base then the
 * camera layer (camera keys win). The camera layer has no `modelId` field, so
 * no caller can hand one in.
 *
 * Purity: a fresh immutable tree is returned; the input array is never mutated.
 * Recurses into `children`. When BOTH base and override are empty the return is
 * the SAME reference (byte-identical no-op — the executor format-default path).
 */
import type {
  DeviceStepConfig,
  PipelineStepInputOutput,
  RunnerJumpStepProvisioning,
} from '@camstack/types'

/** One step's camera layer: settings only — a camera never carries a model (D927). */
export interface CameraStepLayer {
  readonly settings?: Readonly<Record<string, unknown>>
}

/**
 * Merge base then the camera layer for one step. Camera keys win; undefined =
 * inherit. `modelId` and `jumpDeviceKey` are per-(node,device) BASE concepts
 * ONLY, so both are taken from `base` verbatim.
 */
function resolveStep(
  base: DeviceStepConfig | undefined,
  override: CameraStepLayer | undefined,
): DeviceStepConfig | undefined {
  if (!base && !override) return undefined
  const modelId = base?.modelId
  const settings =
    base?.settings || override?.settings ? { ...base?.settings, ...override?.settings } : undefined
  const jumpDeviceKey = base?.jumpDeviceKey
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(settings ? { settings } : {}),
    ...(jumpDeviceKey !== undefined ? { jumpDeviceKey } : {}),
  }
}

/**
 * Attach modelId + settings onto each step from the per-(node,device) BASE and
 * the camera's settings layer. Pure/immutable; recurses into children. Empty
 * base+override ⇒ same reference.
 */
export function applyDeviceProvisioning(
  steps: readonly PipelineStepInputOutput[],
  base: Readonly<Record<string, DeviceStepConfig>>,
  override: Readonly<Record<string, CameraStepLayer>>,
): readonly PipelineStepInputOutput[] {
  if (Object.keys(base).length === 0 && Object.keys(override).length === 0) return steps
  return steps.map((step): PipelineStepInputOutput => {
    const cfg = resolveStep(base[step.addonId], override[step.addonId])
    const children = step.children
      ? applyDeviceProvisioning(step.children, base, override)
      : step.children
    if (!cfg && children === step.children) return step
    return {
      ...step,
      ...(cfg?.modelId !== undefined ? { modelId: cfg.modelId } : {}),
      ...(cfg?.settings ? { settings: cfg.settings } : {}),
      ...(cfg?.jumpDeviceKey !== undefined ? { jumpDeviceKey: cfg.jumpDeviceKey } : {}),
      ...(children !== undefined ? { children } : {}),
    }
  })
}

/**
 * What each step of `steps` would run with had the camera been elected onto
 * the device whose `base` / `override` these are — as a flat
 * `stepId → { modelId?, settings? }` map (D650). It IS
 * {@link applyDeviceProvisioning} over the same resolved tree, flattened, so a
 * jump target and the elected device are provisioned by one rule. The runner
 * REPLACES a jumped subtree's `modelId` / `settings` with these, so the
 * elected device's base never follows a step across (the camera layer is the
 * same on every device). `jumpDeviceKey` is dropped: it
 * names where a step leaves the ELECTED device for, and means nothing on the
 * target. A step with neither field is absent (it runs the format default).
 */
export function provisionDeviceSteps(
  steps: readonly PipelineStepInputOutput[],
  base: Readonly<Record<string, DeviceStepConfig>>,
  override: Readonly<Record<string, CameraStepLayer>>,
): Record<string, RunnerJumpStepProvisioning> {
  const out: Record<string, RunnerJumpStepProvisioning> = {}
  const walk = (list: readonly PipelineStepInputOutput[]): void => {
    for (const step of list) {
      if (step.modelId !== undefined || step.settings !== undefined) {
        out[step.addonId] = {
          ...(step.modelId !== undefined ? { modelId: step.modelId } : {}),
          ...(step.settings !== undefined ? { settings: step.settings } : {}),
        }
      }
      walk(step.children ?? [])
    }
  }
  walk(applyDeviceProvisioning(steps, base, override))
  return out
}
