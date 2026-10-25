/**
 * Live training corpus selection → export filter + frame keep rule.
 *
 * Shared by `resolveRetrainTrainingCorpus` so plan/start and the annotated
 * archive agree on which frames a selection includes.
 */
import type { RetrainExportFilter, RetrainTrainingCorpusSelection } from '@camstack/types'
import type { RetrainExportManifest } from './retrain-export.js'
import { workStateOf } from './retrain-corpus-query.js'

export type TrainingCorpusWorkState = RetrainTrainingCorpusSelection['workState']

/**
 * Export filter that loads the membership set for a selection.
 * `complete` uses `workState` so the plan is already narrowed; the other
 * modes load every copy in the collections and keep via {@link keepTrainingCorpusFrame}.
 */
export function exportFilterForTrainingCorpus(
  selection: RetrainTrainingCorpusSelection,
): RetrainExportFilter {
  const collectionIds = [...selection.collectionIds]
  if (selection.workState === 'complete') {
    return { collectionIds, workState: 'complete' }
  }
  return { collectionIds }
}

/** Whether a manifest frame belongs under the selection's work-state rule. */
export function keepTrainingCorpusFrame(
  frame: RetrainExportManifest['frames'][number],
  workState: TrainingCorpusWorkState,
): boolean {
  const state = workStateOf(frame, frame.annotations.length)
  switch (workState) {
    case 'complete':
      return state === 'complete'
    case 'annotated_or_complete':
      return state === 'annotated' || state === 'complete'
    case 'any_annotated':
      // Annotated boxes, or complete hard negatives (legacy annotated export).
      return frame.annotations.length > 0 || frame.complete
  }
}
