/**
 * A stored model pin naming a model DELETED from its step's catalog is reset to
 * the default (D725) — here, and nowhere else.
 *
 * Two stores hold a step's `modelId` pin, and the orchestrator owns both (a
 * camera carries no model, D927):
 *
 *   - per (node, device)  `agentSettings[node].inferenceDevices[key].steps[step].modelId`
 *   - cluster rows        the `clusterModel:<step>` global settings
 *
 * A pin is reset when its id is in `REMOVED_MODEL_IDS` for that step AND no
 * registered custom model (Model Studio) carries that id for that step. The pin
 * is dropped from the store — never rewritten to the default's id — so the step
 * follows whatever its default is from then on, and the UI stops showing a
 * model nobody can serve. Each reset is one WARN line naming the old id.
 *
 * What this does NOT do: resolve. `resolveModelForFormat` still passes an
 * unknown id through as a custom model, and a bulk pass pinned to one is still
 * refused rather than substituted (D54). Reset happens to the STORE, before
 * anything is resolved.
 */
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  type CustomModelDescriptor,
  clusterModelSettingKey,
  errMsg,
  type IScopedLogger,
  isRemovedModelId,
  type StoredKeyRead,
} from '@camstack/types'
import type { AgentSettingsMapBlob } from './orchestrator-store-schemas.js'

/** Is `modelId` a registered custom model for `stepId`? */
export type IsRegisteredCustomModel = (stepId: string, modelId: string) => boolean

/** One pin the reset cleared. */
export type ResetModelPin =
  | {
      readonly scope: 'node-device'
      readonly nodeId: string
      readonly deviceKey: string
      readonly stepId: string
      readonly modelId: string
    }
  | {
      readonly scope: 'cluster'
      readonly stepId: string
      readonly modelId: string
    }

/** A pure sweep's answer: the next blob, and what it cleared. */
export interface PinSweepResult<T> {
  readonly next: T
  readonly cleared: readonly ResetModelPin[]
}

/** The one predicate: a pin to a deleted catalog id that no custom model owns. */
export function pinNamesRemovedModel(
  stepId: string,
  modelId: string | undefined,
  isCustom: IsRegisteredCustomModel,
): modelId is string {
  return modelId !== undefined && isRemovedModelId(stepId, modelId) && !isCustom(stepId, modelId)
}

/** The fields a stored step config can carry — both stores' shapes fit it. */
interface PinnableStep {
  readonly modelId?: string
  readonly settings?: Readonly<Record<string, unknown>>
  readonly jumpDeviceKey?: string
}

/**
 * Drop the `modelId` of every step in `steps` that names a removed model. A
 * step left with no field at all is dropped (an empty `{}` config says
 * nothing). `onClear` is told each cleared `(stepId, modelId)`. `null` when
 * nothing was cleared.
 */
function stripStepPins(
  steps: Readonly<Record<string, PinnableStep>>,
  isCustom: IsRegisteredCustomModel,
  onClear: (stepId: string, modelId: string) => void,
): Readonly<Record<string, PinnableStep>> | null {
  let changed = false
  const next: Record<string, PinnableStep> = {}
  for (const [stepId, cfg] of Object.entries(steps)) {
    if (!pinNamesRemovedModel(stepId, cfg.modelId, isCustom)) {
      next[stepId] = cfg
      continue
    }
    changed = true
    onClear(stepId, cfg.modelId)
    const { modelId: _dropped, ...rest } = cfg
    if (Object.keys(rest).length > 0) next[stepId] = rest
  }
  return changed ? next : null
}

/** The per-(node, device) store, swept. Pure; `next === blob` when nothing changed. */
export function sweepAgentSettingsPins(
  blob: AgentSettingsMapBlob,
  isCustom: IsRegisteredCustomModel,
): PinSweepResult<AgentSettingsMapBlob> {
  const cleared: ResetModelPin[] = []
  let changed = false
  const next: Record<string, AgentSettingsMapBlob[string]> = {}
  for (const [nodeId, settings] of Object.entries(blob)) {
    const devices = settings.inferenceDevices
    if (devices === undefined) {
      next[nodeId] = settings
      continue
    }
    let nodeChanged = false
    const nextDevices: Record<string, (typeof devices)[string]> = {}
    for (const [deviceKey, entry] of Object.entries(devices)) {
      const steps =
        entry.steps === undefined
          ? null
          : stripStepPins(entry.steps, isCustom, (stepId, modelId) =>
              cleared.push({
                scope: 'node-device',
                nodeId,
                deviceKey,
                stepId,
                modelId,
              }),
            )
      if (steps === null) {
        nextDevices[deviceKey] = entry
        continue
      }
      nodeChanged = true
      const { steps: _old, ...rest } = entry
      nextDevices[deviceKey] = Object.keys(steps).length > 0 ? { ...rest, steps } : rest
    }
    if (!nodeChanged) {
      next[nodeId] = settings
      continue
    }
    changed = true
    next[nodeId] = { ...settings, inferenceDevices: nextDevices }
  }
  return { next: changed ? next : blob, cleared }
}

/**
 * The cluster rows to clear: each `clusterModel:<step>` whose stored value
 * names a removed model. `readStored` answers the stored value, or `undefined`
 * for a key nobody wrote. Returns the settings patch (`key → null`, the way the
 * settings form clears a select) and the pins it clears.
 */
export function clusterRowsToReset(
  readStored: (key: string) => unknown,
  isCustom: IsRegisteredCustomModel,
): {
  readonly patch: Readonly<Record<string, null>>
  readonly cleared: readonly ResetModelPin[]
} {
  const patch: Record<string, null> = {}
  const cleared: ResetModelPin[] = []
  for (const { stepId } of CLUSTER_MODEL_SCOPED_STEPS) {
    const key = clusterModelSettingKey(stepId)
    const value = readStored(key)
    if (typeof value !== 'string' || !pinNamesRemovedModel(stepId, value, isCustom)) continue
    patch[key] = null
    cleared.push({ scope: 'cluster', stepId, modelId: value })
  }
  return { patch, cleared }
}

/** What a sweep needs from the orchestrator. */
export interface RemovedModelPinResetDeps {
  /** The registered custom models; THROWS when the registry cannot be read. */
  readonly listCustomModels: () => Promise<readonly CustomModelDescriptor[]>
  /** The per-(node, device) and per-camera stores' own sweep. */
  readonly resetStoredPins: (isCustom: IsRegisteredCustomModel) => Promise<readonly ResetModelPin[]>
  /** Three-way read of one orchestrator global key. */
  readonly readStoredGlobalKey: (key: string) => Promise<StoredKeyRead>
  /** The orchestrator's own settings write (the path an operator's change takes). */
  readonly updateGlobalSettings: (patch: Record<string, unknown>) => Promise<void>
  /** Hot-reload the cameras placed on a node whose base pin was cleared. */
  readonly redispatchNode: (nodeId: string) => Promise<void>
  readonly logger: IScopedLogger
}

/** Why a sweep ran — logged with every pin it clears. */
export type PinResetTrigger = 'boot' | 'node-device-write' | 'cluster-row-write'

/**
 * Run one sweep over both stores. A custom-model registry that cannot be
 * read resets NOTHING (D49: a failed read changes nothing) — the next trigger
 * tries again. Never throws; returns the pins it cleared.
 */
export async function resetRemovedModelPins(
  deps: RemovedModelPinResetDeps,
  trigger: PinResetTrigger,
): Promise<readonly ResetModelPin[]> {
  let custom: readonly CustomModelDescriptor[]
  try {
    custom = await deps.listCustomModels()
  } catch (err: unknown) {
    deps.logger.warn('removed-model pin reset skipped — custom model registry unreadable', {
      meta: { trigger, error: errMsg(err) },
    })
    return []
  }
  const isCustom: IsRegisteredCustomModel = (stepId, modelId) =>
    custom.some((d) => d.stepId === stepId && d.entry.id === modelId)

  try {
    const stored = await deps.resetStoredPins(isCustom)
    const cluster = await resetClusterRows(deps, isCustom)
    const cleared = [...stored, ...cluster]
    for (const pin of cleared) logResetPin(deps.logger, pin, trigger)
    await redispatchAffected(deps, cleared)
    deps.logger.debug('removed-model pin reset: swept', {
      meta: { trigger, cleared: cleared.length },
    })
    return cleared
  } catch (err: unknown) {
    deps.logger.warn('removed-model pin reset failed', {
      meta: { trigger, error: errMsg(err) },
    })
    return []
  }
}

async function resetClusterRows(
  deps: RemovedModelPinResetDeps,
  isCustom: IsRegisteredCustomModel,
): Promise<readonly ResetModelPin[]> {
  const stored = new Map<string, unknown>()
  for (const { stepId } of CLUSTER_MODEL_SCOPED_STEPS) {
    const key = clusterModelSettingKey(stepId)
    const read = await deps.readStoredGlobalKey(key)
    // An unreadable row is left alone: unknown is not "removed".
    if (read.kind === 'present') stored.set(key, read.value)
  }
  const { patch, cleared } = clusterRowsToReset((key) => stored.get(key), isCustom)
  if (cleared.length > 0) await deps.updateGlobalSettings({ ...patch })
  return cleared
}

function logResetPin(logger: IScopedLogger, pin: ResetModelPin, trigger: PinResetTrigger): void {
  const message = 'model pin reset: removed model → step default'
  if (pin.scope === 'node-device') {
    logger.warn(message, {
      tags: { nodeId: pin.nodeId },
      meta: {
        scope: pin.scope,
        trigger,
        step: pin.stepId,
        removedModelId: pin.modelId,
        // The runtime overwrites `tags.nodeId` with the logging runner's id, so
        // the pin's node is named in meta too.
        nodeId: pin.nodeId,
        deviceKey: pin.deviceKey,
      },
    })
    return
  }
  logger.warn(message, {
    meta: {
      scope: pin.scope,
      trigger,
      step: pin.stepId,
      removedModelId: pin.modelId,
    },
  })
}

async function redispatchAffected(
  deps: RemovedModelPinResetDeps,
  cleared: readonly ResetModelPin[],
): Promise<void> {
  const nodes = new Set<string>()
  for (const pin of cleared) {
    if (pin.scope === 'node-device') nodes.add(pin.nodeId)
  }
  for (const nodeId of nodes) await deps.redispatchNode(nodeId)
}
