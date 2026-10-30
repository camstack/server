import type { DiscoveredChildDevice } from '@camstack/types'

import { buildCandidateTree, type CandidateNode } from './scan-candidate-tree'

export interface CandidateRow {
  readonly candidate: DiscoveredChildDevice
  readonly depth: number
}

type Node = CandidateNode<DiscoveredChildDevice & { readonly stableId: string }>

/**
 * Candidates in tree order (a parent, then its children), each with its
 * nesting depth. Reuses the scan tree builder; a child whose parent is not in
 * the list stays at the top level.
 */
export function orderCandidatesAsTree(
  candidates: readonly DiscoveredChildDevice[],
): readonly CandidateRow[] {
  const keyed = candidates.map((c) => ({ ...c, stableId: c.childNativeId }))
  const byId = new Map(candidates.map((c) => [c.childNativeId, c]))
  const walk = (nodes: readonly Node[], depth: number): CandidateRow[] =>
    nodes.flatMap((n) => {
      const original = byId.get(n.candidate.childNativeId)
      return original === undefined
        ? []
        : [{ candidate: original, depth }, ...walk(n.children, depth + 1)]
    })
  return walk(buildCandidateTree(keyed), 0)
}

/** What tells two same-named rows apart: the model and the device id tail. */
export function candidateDistinguisher(candidate: DiscoveredChildDevice): string {
  const model = candidate.metadata?.['model']
  const tail = candidate.childNativeId.split(':').pop() ?? ''
  const parts = [typeof model === 'string' ? model : '', tail].filter((p) => p.length > 0)
  return parts.join(' · ')
}
