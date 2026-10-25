import type { PipelineDefaultStep } from '@camstack/types'

/**
 * Flatten a step tree into a list of enabled video steps (DFS).
 * Audio-classifier steps are excluded — they run independently
 * via the audio pipeline, not the video inference pool.
 */
export function flattenEnabledVideoSteps(
  steps: readonly PipelineDefaultStep[],
): readonly PipelineDefaultStep[] {
  const result: PipelineDefaultStep[] = []
  const walk = (nodes: readonly PipelineDefaultStep[]): void => {
    for (const step of nodes) {
      if (!step.enabled) continue
      if (step.slot === 'audio-classifier') continue
      result.push(step)
      if (step.children?.length) {
        walk(step.children)
      }
    }
  }
  walk(steps)
  return result
}

/**
 * The steps that EXECUTE in a `plane: 'frame'` dispatch (two-plane design),
 * mirroring the executor's frame-plane skip in `executeChildren`: every
 * enabled top-level step runs at the root; a CHILD runs only when its catalog
 * definition is itself root-plane (`isDetailStep(addonId)` false). The walk
 * continues only through steps that execute — a skipped detail child's
 * descendants ride ITS per-track detail-subtree call, never this one.
 * Disabled and audio-classifier steps execute on neither plane.
 */
export function collectFramePlaneSteps(
  steps: readonly PipelineDefaultStep[],
  isDetailStep: (addonId: string) => boolean,
): readonly PipelineDefaultStep[] {
  const result: PipelineDefaultStep[] = []
  const walk = (nodes: readonly PipelineDefaultStep[], topLevel: boolean): void => {
    for (const step of nodes) {
      if (!step.enabled) continue
      if (step.slot === 'audio-classifier') continue
      if (!topLevel && isDetailStep(step.addonId)) continue
      result.push(step)
      if (step.children?.length) {
        walk(step.children, false)
      }
    }
  }
  walk(steps, true)
  return result
}

/** Result of {@link pruneUnrunnableDetailSteps}. */
export interface DetailStepPruneResult {
  readonly steps: PipelineDefaultStep[]
  /** addonIds of the removed detail subtrees, for the caller's once-log. */
  readonly prunedAddonIds: readonly string[]
  /** Every addonId INSIDE a removed subtree, its top included — none of them runs here. */
  readonly removedAddonIds: readonly string[]
}

/**
 * Immutably remove from a frame-plane dispatch tree every enabled DETAIL
 * subtree (at any depth below the top level) that `isUnrunnable` — judged
 * WHOLE at its top, because its children ride its call (D657).
 * Those steps can never load into the dispatch device's pool — leaving them
 * in the tree makes `ensureModelsForSteps` fail the whole call on a format
 * build that does not exist. They are NOT dropped work: each runs later as
 * its own detail-subtree dispatch, where the device-jump resolver
 * (`resolveStepDevice`) places it on a same-node device that can run it, or
 * warns no-candidate loudly. Runnable detail children are kept so their
 * models pre-warm the device pool as before. Disabled subtrees are kept
 * verbatim (never walked — `ensureModelsForSteps` skips them anyway).
 */
export function pruneUnrunnableDetailSteps(
  steps: readonly PipelineDefaultStep[],
  isDetailStep: (addonId: string) => boolean,
  isUnrunnable: (subtree: PipelineDefaultStep) => boolean,
): DetailStepPruneResult {
  const prunedAddonIds: string[] = []
  const removedAddonIds: string[] = []
  const collect = (step: PipelineDefaultStep): void => {
    removedAddonIds.push(step.addonId)
    for (const child of step.children ?? []) collect(child)
  }
  const walk = (
    nodes: readonly PipelineDefaultStep[],
    topLevel: boolean,
  ): PipelineDefaultStep[] => {
    const kept: PipelineDefaultStep[] = []
    for (const step of nodes) {
      if (!step.enabled) {
        kept.push(step)
        continue
      }
      if (!topLevel && isDetailStep(step.addonId) && isUnrunnable(step)) {
        prunedAddonIds.push(step.addonId)
        collect(step)
        continue
      }
      kept.push(step.children?.length ? { ...step, children: walk(step.children, false) } : step)
    }
    return kept
  }
  return { steps: walk(steps, true), prunedAddonIds, removedAddonIds }
}
