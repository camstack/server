/**
 * Which model a call ran, and whether a REPLAY may run at all (D56, D646).
 *
 * Pure — the provider hands in what it resolved, this answers. Two jobs:
 *
 *  - {@link checkReplayPin}: a replay over stored media must run EXACTLY the
 *    model it names, on the pool it names, or refuse. Live dispatch keeps its
 *    silent substitution (a degraded detector beats none); a replay that
 *    compares against what the camera stored would otherwise report a delta
 *    produced by a different encoder, and say nothing.
 *  - {@link resolveRootModelId}: the ROOT model a frame result is stamped with,
 *    so a stored track can say which model produced it and a later replay can
 *    name the original.
 */
import type { PipelineDefaultStep, PipelineStepInput } from '@camstack/types'

export type ReplayPinRefusal = 'model-not-servable' | 'device-not-servable'

export type ReplayPinVerdict =
  | { readonly kind: 'pinned' }
  | { readonly kind: 'refused'; readonly reason: ReplayPinRefusal; readonly detail: string }

export interface ReplayPinInput {
  /** The caller's tree, as sent. */
  readonly requested: readonly PipelineStepInput[]
  /** The RESOLVED steps that execute in this call (already plane-filtered). */
  readonly executing: readonly PipelineDefaultStep[]
  /** The pool the caller named; `undefined` ⇒ the node-default pool. */
  readonly requestedDeviceKey: string | undefined
  /** The pool the capability gate actually dispatches to. */
  readonly dispatchDeviceKey: string | undefined
  /** The format the executing steps were resolved for (for the refusal text). */
  readonly format: string
}

function requestedModels(steps: readonly PipelineStepInput[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  const walk = (nodes: readonly PipelineStepInput[]): void => {
    for (const step of nodes) {
      if (!step.enabled) continue
      // An absent pick is not recorded: `checkReplayPin` refuses it by name.
      if (step.modelId !== undefined) out.set(step.addonId, step.modelId)
      if (step.children !== undefined) walk(step.children)
    }
  }
  walk(steps)
  return out
}

export function checkReplayPin(input: ReplayPinInput): ReplayPinVerdict {
  if (
    input.requestedDeviceKey !== undefined &&
    input.dispatchDeviceKey !== input.requestedDeviceKey
  ) {
    return {
      kind: 'refused',
      reason: 'device-not-servable',
      detail:
        `device pool ${input.requestedDeviceKey} cannot run this tree ` +
        `(the capability gate would fall back to ${input.dispatchDeviceKey ?? 'the node default'})`,
    }
  }
  const asked = requestedModels(input.requested)
  for (const step of input.executing) {
    const want = asked.get(step.addonId)
    if (want === undefined || want.length === 0) {
      return {
        kind: 'refused',
        reason: 'model-not-servable',
        detail: `${step.addonId}: no model pinned by the caller (would run ${step.modelId}, ${input.format})`,
      }
    }
    if (want !== step.modelId) {
      return {
        kind: 'refused',
        reason: 'model-not-servable',
        detail: `${step.addonId}: asked for ${want}, this pool would run ${step.modelId} (${input.format})`,
      }
    }
  }
  return { kind: 'pinned' }
}

const PRIMARY_ROOT_STEP = 'object-detection'

/**
 * The root model a frame result reports: `object-detection` when it runs (it
 * is the detector the tracks come from), else the first enabled video root.
 * `undefined` when no root runs — never a fabricated id.
 */
export function resolveRootModelId(roots: readonly PipelineDefaultStep[]): string | undefined {
  const enabled = roots.filter((s) => s.enabled && s.slot !== 'audio-classifier')
  return primaryRootModelId(enabled.map((s) => ({ stepId: s.addonId, modelId: s.modelId })))
}

/** The step and model of the root a frame result is stamped with (D925). */
export interface TreeRootIdentity {
  readonly stepId: string
  readonly modelId: string
}

/**
 * The same rule over an EXECUTABLE tree's roots (D658): their model ids are the
 * pool variants that will run — after resolution, per-step loads and drops —
 * so this is what a live `runPipeline` stamps, with the root's step id beside
 * the model (D925). The tree holds only enabled video roots already.
 */
export function resolveTreeRoot(
  roots: readonly { readonly stepId: string; readonly modelId: string }[],
): TreeRootIdentity | undefined {
  const root = roots.find((s) => s.stepId === PRIMARY_ROOT_STEP) ?? roots[0]
  return root === undefined ? undefined : { stepId: root.stepId, modelId: root.modelId }
}

function primaryRootModelId(
  roots: readonly { readonly stepId: string; readonly modelId: string }[],
): string | undefined {
  const primary = roots.find((s) => s.stepId === PRIMARY_ROOT_STEP)
  return (primary ?? roots[0])?.modelId
}
