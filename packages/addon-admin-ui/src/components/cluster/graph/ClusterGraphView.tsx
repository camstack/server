import { useMemo, useState, useCallback, useRef } from 'react'
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react'
import { useSearchFieldHotkey, Button, Input } from '@camstack/ui-library'
import type { ClusterGraph } from './build-cluster-graph'
import type { NodeBoxData } from './NodeBox'
import { NodeBox } from './NodeBox'
import { usePersistedFlowLayout } from '../../../lib/use-persisted-flow-layout'
import { useTranslation } from 'react-i18next'

const NODE_TYPES = { nodeBox: NodeBox } as const

/** localStorage key for the user-dragged cluster-graph node layout. */
const LAYOUT_STORAGE_KEY = 'camstack-cluster-graph-layout'

const NODE_WIDTH = 360
const NODE_HEIGHT_ESTIMATE = 300
const NODE_GAP_X = 120
const NODE_GAP_Y = 40

export interface ClusterGraphViewProps {
  readonly graph: ClusterGraph
  readonly onOpenNodeDetail?: (nodeId: string) => void
}

/** Compute simple left-to-right layout: hubs on the left (stacked vertically), agents stacked on the right.
 *  I4: Multiple hubs stack vertically rather than overlapping at {x:0, y:0}. */
function computePositions(
  nodeIds: readonly string[],
  isHub: readonly boolean[],
): ReadonlyMap<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  let agentIndex = 0
  let hubIndex = 0
  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i]
    if (id === undefined) continue
    if (isHub[i]) {
      positions.set(id, { x: 0, y: hubIndex * (NODE_HEIGHT_ESTIMATE + NODE_GAP_Y) })
      hubIndex++
    } else {
      positions.set(id, {
        x: NODE_WIDTH + NODE_GAP_X,
        y: agentIndex * (NODE_HEIGHT_ESTIMATE + NODE_GAP_Y),
      })
      agentIndex++
    }
  }
  return positions
}

function matchesFilter(filter: string, nodeData: NodeBoxData): boolean {
  if (filter === '') return true
  const lower = filter.toLowerCase()
  if (nodeData.identity.name.toLowerCase().includes(lower)) return true
  return nodeData.runners.some(
    (r) =>
      r.name.toLowerCase().includes(lower) ||
      r.addonId.toLowerCase().includes(lower) ||
      r.caps.some(
        (c) => c.name.toLowerCase().includes(lower) || c.addonId.toLowerCase().includes(lower),
      ),
  )
}

export function ClusterGraphView({ graph, onOpenNodeDetail }: ClusterGraphViewProps) {
  const searchFieldRef = useRef<HTMLInputElement>(null)
  useSearchFieldHotkey(searchFieldRef)
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  // I1: expandAllValue=true means expand; expandAllNonce increments on each click.
  const [expandAllValue, setExpandAllValue] = useState(false)
  const [expandAllNonce, setExpandAllNonce] = useState(0)

  const handleExpandAll = useCallback((): void => {
    setExpandAllValue(true)
    setExpandAllNonce((n) => n + 1)
  }, [])

  const handleCollapseAll = useCallback((): void => {
    setExpandAllValue(false)
    setExpandAllNonce((n) => n + 1)
  }, [])

  const handleOpenNodeDetail = useCallback(
    (nodeId: string): void => {
      onOpenNodeDetail?.(nodeId)
    },
    [onOpenNodeDetail],
  )

  const positions = useMemo(() => {
    const ids = graph.nodes.map((n) => n.nodeId)
    const hubs = graph.nodes.map((n) => n.isHub)
    return computePositions(ids, hubs)
  }, [graph.nodes])

  const computedNodes = useMemo<Node<NodeBoxData>[]>(() => {
    return graph.nodes.map((n) => {
      const pos = positions.get(n.nodeId) ?? { x: 0, y: 0 }
      // I1: inject expand-all signal into each node's data.
      const nodeData: NodeBoxData = {
        ...n,
        onOpenNodeDetail: handleOpenNodeDetail,
        expandAllValue,
        expandAllNonce,
      }
      const hidden = filter !== '' && !matchesFilter(filter, nodeData)
      // m1: 'nodeBox' type is already narrowed by Node<NodeBoxData> annotation; no `as const` needed.
      const node: Node<NodeBoxData> = {
        id: n.nodeId,
        type: 'nodeBox',
        position: pos,
        data: nodeData,
        hidden,
      }
      return node
    })
  }, [graph.nodes, positions, handleOpenNodeDetail, filter, expandAllValue, expandAllNonce])

  // Draggable + localStorage-persisted node positions. The computed layout above
  // seeds un-moved nodes; a user drag overrides per node and survives reloads.
  const { nodes, onNodesChange, resetLayout } = usePersistedFlowLayout(
    LAYOUT_STORAGE_KEY,
    computedNodes,
  )

  const rfEdges = useMemo<Edge[]>(() => {
    return graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: 'moleculer', // i18n-ignore: transport name
      style: e.online ? {} : { strokeDasharray: '5,5', opacity: 0.4 },
      animated: false,
    }))
  }, [graph.edges])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Density controls bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background shrink-0">
        <Input
          ref={searchFieldRef}
          type="search"
          placeholder={t(
            'graph.clusterGraphView.filterByNodeRunnerCap',
            'Filter by node / runner / cap…',
          )}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 text-xs border border-border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <Button
          variant="unstyled"
          type="button"
          onClick={handleExpandAll}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
        >
          {t('graph.clusterGraphView.expandAll', 'Expand all')}
        </Button>
        <Button
          variant="unstyled"
          type="button"
          onClick={handleCollapseAll}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
        >
          {t('graph.clusterGraphView.collapseAll', 'Collapse all')}
        </Button>
        <Button
          variant="unstyled"
          type="button"
          onClick={resetLayout}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
          title={t(
            'graph.clusterGraphView.restoreTheAutomaticLayoutDiscarding',
            'Restore the automatic layout, discarding dragged positions',
          )}
        >
          {t('graph.clusterGraphView.resetLayout', 'Reset layout')}
        </Button>
      </div>

      <div className="flex-1 min-h-0 border-t border-border overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          nodesDraggable
          nodeTypes={NODE_TYPES}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  )
}
