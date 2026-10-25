/**
 * D927 — a model is chosen by the accelerator that runs it; a camera only
 * turns steps on or off. The pure judgements behind
 * `scripts/check-no-camera-model-layer.ts`, kept here so a spec can feed them
 * fixtures.
 */
import { z } from 'zod'
import { isModelScopedStepSettingKey } from '../../packages/types/src/types/agent-pipeline-settings.ts'

/**
 * A key that names a model or a model-bound threshold (the `minConfidence*`
 * floors). The SAME judgement the store refuses with and the camera UI hides
 * fields by (`withoutModelScopedFields` in the ui-library) — one list, not two.
 */
export function isModelScopedKey(key: string): boolean {
  return isModelScopedStepSettingKey(key)
}

/** Unwrap optional / nullable / default / readonly / catch wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema
  for (let i = 0; i < 16; i++) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch
    ) {
      current = current.unwrap()
      continue
    }
    return current
  }
  return current
}

/** Every object key reachable in `schema` (objects, arrays, records' values, unions), dotted. */
export function reachableKeys(schema: z.ZodType, prefix = ''): readonly string[] {
  const node = unwrap(schema)
  if (node instanceof z.ZodObject) {
    return Object.entries(node.shape).flatMap(([key, child]) => {
      const here = prefix === '' ? key : `${prefix}.${key}`
      return child instanceof z.ZodType ? [here, ...reachableKeys(child, here)] : [here]
    })
  }
  if (node instanceof z.ZodArray) {
    const element = node.element
    return element instanceof z.ZodType ? reachableKeys(element, `${prefix}[]`) : []
  }
  if (node instanceof z.ZodRecord) {
    const value = node.valueType
    return value instanceof z.ZodType ? reachableKeys(value, `${prefix}{}`) : []
  }
  if (node instanceof z.ZodUnion) {
    return node.options.flatMap((option) =>
      option instanceof z.ZodType ? reachableKeys(option, prefix) : [],
    )
  }
  return []
}

/** The keys a camera-scoped method input carries that only an accelerator may carry. */
export function cameraScopedModelKeys(input: z.ZodType): readonly string[] {
  const keys = reachableKeys(input)
  if (!keys.includes('deviceId')) return []
  return keys.filter((path) => isModelScopedKey(path.split('.').pop()?.replace(/\W/g, '') ?? ''))
}

/** The top-level keys of a camera's stored settings that are not allowed (only toggles + settings). */
export function foreignCameraSettingsKeys(schema: z.ZodType): readonly string[] {
  const node = unwrap(schema)
  if (!(node instanceof z.ZodObject)) return ['<not an object>']
  return Object.keys(node.shape).filter((k) => k !== 'stepToggles' && k !== 'stepSettings')
}

/** The retired per-camera model surface (D927): no production source may name it again. */
export const RETIRED_CAMERA_MODEL_IDENTIFIERS = [
  'stepOverridesByDevice',
  'pipelineByAgent',
  'setCameraStepOverride',
  'getCameraStepOverrides',
  'setCameraPipelineForAgent',
  'CameraStepOverridePatch',
  'clearCameraOverridesForNode',
  'clearModelBoundDeviceOverrides',
  'clearCameraModelPins',
  'DeviceOverrideMirror',
] as const

/**
 * Components that let an operator CHOOSE a model. A file that renders one
 * camera's pipeline may not use one (D927): the camera shows the model each
 * accelerator runs, read-only, and links to the accelerator's cell.
 */
export const MODEL_PICKER_COMPONENTS = [
  'ModelPicker',
  'StepModelRow',
  'AgentStepEditor',
  'GroupedModelSelector',
  'InferenceConfigSelector',
  'PipelineBuilder',
  'PipelineStep',
  'ModelSelector',
  'ModelSelectorAdapter',
  'TrainingBaseModelPicker',
] as const

/** The UI trees that render ONE camera (the device page). Repo-relative. */
export const CAMERA_SCOPED_UI_DIRS = ['packages/addon-admin-ui/src/components/device'] as const

/** The model-picking components a source file names, in order of first appearance. */
export function modelPickersNamedIn(source: string): readonly string[] {
  const re = new RegExp(`\\b(${MODEL_PICKER_COMPONENTS.join('|')})\\b`, 'g')
  return [...new Set([...source.matchAll(re)].map((m) => m[1] ?? ''))]
}
