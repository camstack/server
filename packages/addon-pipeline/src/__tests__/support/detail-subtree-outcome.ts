import type { RunDetailSubtreeResult } from '@camstack/types'
import type { DetailSubtreeOutcome } from '../../pipeline-runner/detail-subtree.js'

/** Narrow a {@link DetailSubtreeOutcome} to a successful subtree result. */
export function assertDetailSubtreeResult(
  outcome: DetailSubtreeOutcome | null,
): asserts outcome is RunDetailSubtreeResult {
  if (outcome === null || !('details' in outcome)) {
    throw new Error('expected RunDetailSubtreeResult')
  }
}
