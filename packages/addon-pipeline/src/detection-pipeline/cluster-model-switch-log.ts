/**
 * One line per camera when a CLUSTER-scoped step starts running another model
 * for it (D658).
 *
 * A cluster row change reaches a running session without a re-attach: the
 * runner overwrites a cluster-scoped step's model from the row on every
 * dispatch (`resolveInputSteps`, TTL `CLUSTER_MODEL_TTL_MS`). What was missing
 * was a per-camera trace of it. `cluster step model changed` is one line per
 * NODE, and it dates the READ — not the first vector a camera actually made
 * with the new encoder. This line is written from the EXECUTABLE tree, whose
 * model ids are the variants that will run, so it dates exactly that.
 *
 * The first model a camera is seen with is recorded silently: a runner that
 * just booted has nothing to compare against, and a line per camera per boot
 * says nothing.
 */
import type { IScopedLogger } from '@camstack/types'
import type { ExecutableStep, ExecutableTree } from './pipeline/tree-builder.js'

function* clusterScopedSteps(steps: readonly ExecutableStep[]): Generator<ExecutableStep> {
  for (const step of steps) {
    if (step.definition.modelScope === 'cluster') yield step
    yield* clusterScopedSteps(step.children)
  }
}

export class ClusterModelSwitchLog {
  /** `deviceId|stepId` → the model that step last ran for that camera. */
  private readonly lastRun = new Map<string, string>()

  constructor(private readonly logger: Pick<IScopedLogger, 'info'>) {}

  /** Record what `tree` runs for `deviceId`; say so when a cluster step changed model. */
  note(deviceId: number, tree: ExecutableTree): void {
    if (deviceId <= 0) return
    for (const step of clusterScopedSteps(tree.roots)) {
      const key = `${String(deviceId)}|${step.stepId}`
      const previous = this.lastRun.get(key)
      if (previous === step.modelId) continue
      this.lastRun.set(key, step.modelId)
      if (previous === undefined) continue
      this.logger.info(
        'cluster-scoped step re-provisioned for this camera — now runs the new model',
        {
          tags: { deviceId },
          meta: { stepId: step.stepId, from: previous, to: step.modelId },
        },
      )
    }
  }
}

/** The part of a wire step this log walks. */
interface InputStepLike {
  readonly addonId: string
  readonly enabled: boolean
  readonly children?: readonly InputStepLike[]
}

function* enabledStepIds(steps: readonly InputStepLike[]): Generator<string> {
  for (const step of steps) {
    if (!step.enabled) continue
    yield step.addonId
    if (step.children) yield* enabledStepIds(step.children)
  }
}

/** The enabled steps of `steps` (any depth) whose cluster model is unknown. */
export function unknownStepsNamed(
  steps: readonly InputStepLike[],
  unknown: ReadonlyMap<string, string>,
): string[] {
  if (unknown.size === 0) return []
  return [...enabledStepIds(steps)].filter((id) => unknown.has(id))
}

/**
 * One line per (camera, step) while a cluster-scoped step is REFUSED because
 * the owner has not answered which model the cluster runs (D658). Said once per
 * episode: when every step becomes known the memory is cleared, so the next
 * episode is said again.
 */
export class ClusterUnknownRefusalLog {
  private said = new Set<string>()

  constructor(private readonly logger: Pick<IScopedLogger, 'warn'>) {}

  note(
    deviceId: number,
    steps: readonly InputStepLike[],
    unknown: ReadonlyMap<string, string>,
  ): void {
    if (unknown.size === 0) {
      if (this.said.size > 0) this.said = new Set()
      return
    }
    if (deviceId <= 0) return
    for (const stepId of enabledStepIds(steps)) {
      const reason = unknown.get(stepId)
      if (reason === undefined) continue
      const key = `${String(deviceId)}|${stepId}`
      if (this.said.has(key)) continue
      this.said = new Set(this.said).add(key)
      this.logger.warn(
        'cluster-scoped step refused for this camera — the owner has not answered which model the cluster runs',
        { tags: { deviceId }, meta: { stepId, reason } },
      )
    }
  }
}
