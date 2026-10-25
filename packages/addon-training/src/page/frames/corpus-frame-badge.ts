/**
 * Badge chrome for a corpus grid tile — exclusive work-state partition (§4.2).
 */
import type { RetrainFrameWorkState } from '@camstack/types'

export interface CorpusFrameBadge {
  readonly labelKey: 'todo' | 'inProgress' | 'complete'
  readonly variant: 'default' | 'success' | 'warning'
}

/** Map server `workState` to badge variant and the key of its copy. */
export function corpusFrameBadge(workState: RetrainFrameWorkState): CorpusFrameBadge {
  switch (workState) {
    case 'unannotated':
      return { labelKey: 'todo', variant: 'default' }
    case 'annotated':
      return { labelKey: 'inProgress', variant: 'warning' }
    case 'complete':
      return { labelKey: 'complete', variant: 'success' }
  }
}
