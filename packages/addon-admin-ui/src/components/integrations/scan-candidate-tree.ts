/**
 * A scan lists gateways and the devices found behind them in one flat array;
 * a child names its gateway through `parentStableId`. The modal shows each
 * child nested under its gateway. A child whose gateway is not in the list
 * (another provider's group, or not found this time) stays at the top level.
 */
export interface TreeCandidate {
  readonly stableId: string
  readonly parentStableId?: string | undefined
}

export interface CandidateNode<C extends TreeCandidate> {
  readonly candidate: C
  readonly children: readonly CandidateNode<C>[]
}

export function buildCandidateTree<C extends TreeCandidate>(
  candidates: readonly C[],
): readonly CandidateNode<C>[] {
  const byId = new Map<string, C>()
  for (const c of candidates) byId.set(c.stableId, c)

  // A parent chain that loops back on itself would hide every member of the
  // loop; break it by keeping the first member seen at the top level.
  const parentOf = (c: C): C | null => {
    const parentId = c.parentStableId
    if (parentId === undefined || parentId === c.stableId) return null
    const parent = byId.get(parentId)
    if (parent === undefined) return null
    const seen = new Set<string>([c.stableId])
    let cursor: C | undefined = parent
    while (cursor !== undefined) {
      if (seen.has(cursor.stableId)) return null
      seen.add(cursor.stableId)
      cursor = cursor.parentStableId === undefined ? undefined : byId.get(cursor.parentStableId)
    }
    return parent
  }

  const childrenOf = new Map<string, C[]>()
  const roots: C[] = []
  for (const c of candidates) {
    const parent = parentOf(c)
    if (parent === null) {
      roots.push(c)
      continue
    }
    const list = childrenOf.get(parent.stableId) ?? []
    list.push(c)
    childrenOf.set(parent.stableId, list)
  }

  const toNode = (c: C): CandidateNode<C> => ({
    candidate: c,
    children: (childrenOf.get(c.stableId) ?? []).map(toNode),
  })
  return roots.map(toNode)
}

/** Every candidate of a node and its descendants, flattened (for counts). */
export function flattenCandidateNodes<C extends TreeCandidate>(
  nodes: readonly CandidateNode<C>[],
): readonly C[] {
  return nodes.flatMap((n) => [n.candidate, ...flattenCandidateNodes(n.children)])
}
