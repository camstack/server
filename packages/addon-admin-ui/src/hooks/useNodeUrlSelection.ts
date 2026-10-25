/**
 * The `?node=` selection, bound to the address bar.
 *
 * The resolution itself is pure and lives in `lib/node-url-selection.ts`; this
 * is only the router binding, kept in one place so the Cluster and Addons
 * pages cannot drift on the two details that are easy to get wrong:
 *
 *  - **`replace: true`.** Switching node must not stack history entries the
 *    back button has to walk out of.
 *  - **Every OTHER param survives.** The Addons page has none today, but a
 *    selector that rebuilt the query from scratch would silently drop a
 *    `?tab=` the moment one is added.
 *
 * Component state is deliberately not an option here: it resets on every
 * navigation, is not linkable, and — since 2026-08-30 — is not addressable by
 * the system-event notification that taps into these pages.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

import type { NodeSelection, SelectableNode } from '../lib/node-url-selection'
import { NODE_PARAM, resolveNodeSelection } from '../lib/node-url-selection'

export interface NodeUrlSelection<TNode extends SelectableNode> {
  readonly selection: NodeSelection<TNode>
  readonly selectNode: (nodeId: string) => void
  /**
   * The raw id the URL asked for, before it was resolved against a topology
   * that may not have arrived yet. A page that has to act on the link BEFORE
   * it knows the fleet (the Addons page's on-mount update check) reads this;
   * everything else reads {@link NodeSelection}.
   */
  readonly requestedNodeId: string | null
}

export function useNodeUrlSelection<TNode extends SelectableNode>(
  nodes: readonly TNode[],
): NodeUrlSelection<TNode> {
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get(NODE_PARAM)
  // Resolved from the topology every render rather than mirrored into state: a
  // second copy of the selection would disagree with the URL the moment a node
  // is forgotten, and the operator would be looking at a node the address bar
  // says he is not.
  const selection = useMemo(() => resolveNodeSelection(nodes, requested), [nodes, requested])
  const selectNode = useCallback(
    (nodeId: string): void => {
      const next = new URLSearchParams(searchParams)
      next.set(NODE_PARAM, nodeId)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )
  return { selection, selectNode, requestedNodeId: requested }
}
