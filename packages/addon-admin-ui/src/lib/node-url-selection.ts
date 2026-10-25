/**
 * `?node=` — one contract for every page that shows ONE node at a time.
 *
 * ## Why this is shared rather than per page
 *
 * The Cluster page put its selection in the URL on 2026-08-28
 * (`docs/ui/admin-patterns.md`, "the selection lives in `?node=`"); the Addons
 * page kept its in `useState`. Two consequences, and the second is the one
 * that bites: switching node on Addons was not linkable, and a link that said
 * `?node=agent-a` opened the HUB's addon list with nothing saying so.
 * From 2026-08-30 a system-event notification about an available update taps
 * straight into these pages, so the parameter has to be one the target
 * actually parses — a `?node=` nobody reads is worse than no link at all.
 *
 * Both pages use the library `NodePicker` for the fleet strip; Nodes passes
 * `allowOffline` so a dead agent stays selectable, Addons keeps the default
 * (offline disabled). What they share here is the parameter name, the
 * ordering, and what happens when the id names nothing.
 *
 * ## What happens to a stale id
 *
 * `requested` wins whenever it names a node that EXISTS — including an offline
 * one, so a reload while diagnosing a dead agent does not bounce back to the
 * hub. When it names nothing (a node that left the cluster, a week-old
 * notification, a bookmark) the page falls through to the default node AND is
 * told so, via {@link NodeSelection.staleNodeId}. Falling through silently is
 * what the notification links made unacceptable: the operator taps "update
 * available on agent-a", lands on the hub, and has no way to know.
 */

/** The query parameter naming the node a page is scoped to. */
export const NODE_PARAM = 'node'

/**
 * The minimum a node has to be for this module to order and resolve it.
 *
 * Structural on purpose: the Cluster page's `NodeData` and the library's
 * `ClusterNode` are different shapes from different queries, and both satisfy
 * this. A field is added here when this module starts reading it, never
 * speculatively.
 */
export interface SelectableNode {
  readonly id: string
  readonly name: string
  readonly isHub: boolean
  readonly isOnline: boolean
}

/** How the node on screen was arrived at. */
export type NodeSelectionOutcome =
  /** The URL named it and it exists. */
  | 'requested'
  /** The URL named nothing; the default (hub, else first) is on screen. */
  | 'default'
  /** The URL named a node this cluster does not have. See `staleNodeId`. */
  | 'stale'
  /** There are no nodes at all. */
  | 'empty'

export interface NodeSelection<TNode extends SelectableNode> {
  readonly node: TNode | null
  readonly outcome: NodeSelectionOutcome
  /**
   * The id the URL asked for when this cluster has no such node — the string
   * a page puts in front of the operator. `null` in every other outcome.
   */
  readonly staleNodeId: string | null
}

/**
 * Hub first, then online agents, then offline ones, alphabetical within each
 * group.
 *
 * The hub leads because it is the node that hosts the cap routing to every
 * other one: when the cluster is wrong, it is the first thing anybody looks
 * at. Offline nodes sink rather than disappear — a node that is not answering
 * is precisely what an operator opens a node page to find.
 */
export function orderNodes<TNode extends SelectableNode>(
  nodes: readonly TNode[],
): readonly TNode[] {
  return [...nodes].toSorted((a, b) => {
    if (a.isHub !== b.isHub) return a.isHub ? -1 : 1
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * Which node the page should show, given what the URL asked for, and whether
 * the URL asked for something this cluster does not have.
 *
 * Pure. `node` is `null` only when there are no nodes at all.
 */
export function resolveNodeSelection<TNode extends SelectableNode>(
  nodes: readonly TNode[],
  requested: string | null,
): NodeSelection<TNode> {
  const ordered = orderNodes(nodes)
  const fallback = ordered[0] ?? null
  if (fallback === null) return { node: null, outcome: 'empty', staleNodeId: null }
  if (requested === null || requested.length === 0) {
    return { node: fallback, outcome: 'default', staleNodeId: null }
  }
  const asked = ordered.find((node) => node.id === requested)
  if (asked !== undefined) return { node: asked, outcome: 'requested', staleNodeId: null }
  return { node: fallback, outcome: 'stale', staleNodeId: requested }
}
