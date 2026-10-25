/**
 * The Auto tune writes, as a pure transform of the orchestrator's agent
 * settings blob (D745). The plan runs it on the current blob to SHOW the diff;
 * the apply runs the same function inside the blob's read-modify-write.
 *
 * What changes — and nothing else:
 *  - node level (`agentSettings[node].inferenceDevices[deviceKey].steps`): the
 *    object-detection `modelId` of every recommended device is set; the
 *    `modelId` pin of every other in-scope step is removed (each runs its
 *    step default again); every model-bound threshold (and its binding key) is
 *    removed from every device's step `settings`, so the running model's own
 *    defaults apply (D738–D741). `enabled`, `weight`, `maxSessions`,
 *    `jumpDeviceKey` and every other setting are kept.
 *  - never a camera: a camera carries no model and no model-bound threshold
 *    (D927), so there is nothing per camera to clear.
 *  - never: `stepToggles`, devices' enablement, pins of
 *    embedding steps (cluster-scoped, changing one forces a re-index).
 *  - never anything on a KEPT (node, device) — a custom-registry detector pin,
 *    or an accelerator of its group (D786).
 */
import { modelBindingKey } from '@camstack/types'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'

/** The root detector step. */
export const DETECTOR_STEP_ID = 'object-detection'

/** Steps whose `modelId` pin Auto tune never touches. */
export function isModelPinKept(stepId: string): boolean {
  return stepId.endsWith('-embedding')
}

/** One recommended device: the detector model it gets, and its effective enablement. */
export interface DetectorTarget {
  readonly deviceKey: string
  readonly modelId: string
  /** Written only when the device has no stored entry yet (made explicit). */
  readonly effectiveEnabled: boolean
}

/** What the diff is computed from. */
export interface AutoTuneDiffInput {
  /** Nodes the plan writes on (skipped nodes are absent). */
  readonly touchedNodes: ReadonlySet<string>
  /** `nodeId → its recommended devices`. */
  readonly targets: ReadonlyMap<string, readonly DetectorTarget[]>
  /** `stepId → its model-bound setting keys` (from the catalogs' config schemas). */
  readonly boundKeysByStep: Readonly<Record<string, readonly string[]>>
  /** `node|deviceKey` written by nothing (D786). Absent ⇒ none. */
  readonly keptDevices?: ReadonlySet<string>
  /** Is this model id a custom-registry model? Absent ⇒ none is. */
  readonly isCustomModel?: (modelId: string) => boolean
}

/** The `keptDevices` key of one (node, device). */
export function keptDeviceKey(nodeId: string, deviceKey: string): string {
  return `${nodeId}|${deviceKey}`
}

function isKeptDevice(input: AutoTuneDiffInput, nodeId: string, deviceKey: string): boolean {
  return input.keptDevices?.has(keptDeviceKey(nodeId, deviceKey)) === true
}

/** A model pin before → after on one device. */
export interface ModelPinChange {
  readonly stepId: string
  readonly before: string | null
  readonly after: string | null
}

/** Thresholds removed from one step's settings. */
export interface ThresholdClear {
  readonly stepId: string
  readonly keys: readonly string[]
}

/** Every change on one (node, device). */
export interface NodeDeviceChange {
  readonly nodeId: string
  readonly deviceKey: string
  readonly madeExplicit: boolean
  readonly modelPins: readonly ModelPinChange[]
  readonly thresholds: readonly ThresholdClear[]
}

type Settings = Readonly<Record<string, unknown>>

function boundKeysFor(input: AutoTuneDiffInput, stepId: string): readonly string[] {
  return input.boundKeysByStep[stepId] ?? []
}

/** The model-bound keys present in `settings` (values or bindings), and the rest. */
function stripBound(
  settings: Settings | undefined,
  boundKeys: readonly string[],
): { readonly kept: Record<string, unknown> | undefined; readonly removed: readonly string[] } {
  if (settings === undefined) return { kept: undefined, removed: [] }
  const kept: Record<string, unknown> = { ...settings }
  const removed: string[] = []
  for (const key of boundKeys) {
    for (const k of [key, modelBindingKey(key)]) {
      if (k in kept) {
        delete kept[k]
        removed.push(k)
      }
    }
  }
  return { kept, removed: removed.toSorted() }
}

function pinInScope(stepId: string): boolean {
  return !isModelPinKept(stepId)
}

type StoredStep = {
  readonly modelId?: string
  readonly settings?: Settings
  readonly jumpDeviceKey?: string
}

type StoredDevice = NonNullable<AgentSettingsMapBlob[string]['inferenceDevices']>[string]

/** Rebuild one stored step without the in-scope pin and bound keys. */
function scrubStep(
  stepId: string,
  step: StoredStep,
  boundKeys: readonly string[],
  targetModel: string | undefined,
): {
  readonly next: StoredStep | null
  readonly pin: ModelPinChange | null
  readonly cleared: readonly string[]
} {
  const before = step.modelId ?? null
  let modelId: string | undefined = step.modelId
  if (stepId === DETECTOR_STEP_ID) {
    if (targetModel !== undefined) modelId = targetModel
  } else if (pinInScope(stepId)) {
    modelId = undefined
  }
  const { kept, removed } = stripBound(step.settings, boundKeys)
  const after = modelId ?? null
  const next: StoredStep = {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(kept !== undefined && Object.keys(kept).length > 0 ? { settings: kept } : {}),
    ...(step.jumpDeviceKey !== undefined ? { jumpDeviceKey: step.jumpDeviceKey } : {}),
  }
  return {
    next: Object.keys(next).length > 0 ? next : null,
    pin: before !== after ? { stepId, before, after } : null,
    cleared: removed,
  }
}

/** The node-level transform. Returns the next blob and every change it made. */
export function applyNodeAutoTune(
  blob: AgentSettingsMapBlob,
  input: AutoTuneDiffInput,
): { readonly next: AgentSettingsMapBlob; readonly changes: readonly NodeDeviceChange[] } {
  const next: AgentSettingsMapBlob = { ...blob }
  const changes: NodeDeviceChange[] = []
  for (const nodeId of [...input.touchedNodes].toSorted()) {
    const entry = blob[nodeId]
    const targets = new Map((input.targets.get(nodeId) ?? []).map((t) => [t.deviceKey, t]))
    const stored = entry?.inferenceDevices ?? {}
    const deviceKeys = [...new Set([...Object.keys(stored), ...targets.keys()])].toSorted()
    const nextDevices: Record<string, StoredDevice> = {}
    for (const deviceKey of deviceKeys) {
      const device = stored[deviceKey]
      if (isKeptDevice(input, nodeId, deviceKey)) {
        if (device !== undefined) nextDevices[deviceKey] = device
        continue
      }
      const target = targets.get(deviceKey)
      const steps = { ...device?.steps }
      if (target !== undefined && steps[DETECTOR_STEP_ID] === undefined) {
        steps[DETECTOR_STEP_ID] = {}
      }
      const nextSteps: Record<string, StoredStep> = {}
      const pins: ModelPinChange[] = []
      const thresholds: ThresholdClear[] = []
      for (const stepId of Object.keys(steps).toSorted()) {
        const step = steps[stepId]
        if (step === undefined) continue
        const scrubbed = scrubStep(stepId, step, boundKeysFor(input, stepId), target?.modelId)
        if (scrubbed.next !== null) nextSteps[stepId] = scrubbed.next
        if (scrubbed.pin !== null) pins.push(scrubbed.pin)
        if (scrubbed.cleared.length > 0) thresholds.push({ stepId, keys: scrubbed.cleared })
      }
      const madeExplicit = device === undefined
      const base: StoredDevice =
        device !== undefined
          ? (({ steps: _steps, ...rest }) => rest)(device)
          : { enabled: target?.effectiveEnabled ?? false }
      nextDevices[deviceKey] = {
        ...base,
        ...(Object.keys(nextSteps).length > 0 ? { steps: nextSteps } : {}),
      }
      if (pins.length > 0 || thresholds.length > 0) {
        changes.push({ nodeId, deviceKey, madeExplicit, modelPins: pins, thresholds })
      }
    }
    if (entry === undefined && deviceKeys.length === 0) continue
    next[nodeId] = {
      ...(entry ?? { maxCameras: null }),
      ...(deviceKeys.length > 0 ? { inferenceDevices: nextDevices } : {}),
    }
  }
  return { next, changes }
}
