/**
 * The topology map of one mesh: nodes laid out by role, links coloured by their
 * link quality (good / fair / poor / unknown). Clicking a node selects it.
 */
import '@xyflow/react/dist/style.css'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { useMemo } from 'react'
import { useThemeMode, useUiText } from '@camstack/ui-library'
import type { MeshTopology } from '@camstack/types'
import { layoutMesh, meshEdges } from './mesh-map-model'

export interface MeshMapProps {
  readonly topology: MeshTopology
  readonly selectedKey: string | null
  readonly onSelect: (nodeKey: string) => void
}

type MeshNodeData = { label: string; online: boolean; selected: boolean } & Record<string, unknown>

/** The library's own look for a node; the stock node styles carry fixed colours. */
function MeshNodeBox({ data }: NodeProps<Node<MeshNodeData>>) {
  const tone = data.selected
    ? 'border-primary text-foreground'
    : data.online
      ? 'border-border text-foreground'
      : 'border-border-subtle text-foreground-disabled'
  return (
    <div className={`rounded-md border bg-surface px-2 py-1 text-xs ${tone}`}>
      <Handle type="target" position={Position.Top} className="opacity-0" isConnectable={false} />
      {data.label}
      <Handle
        type="source"
        position={Position.Bottom}
        className="opacity-0"
        isConnectable={false}
      />
    </div>
  )
}

const NODE_TYPES = { mesh: MeshNodeBox }

/** The stock controls and background carry fixed colours; point them at the theme. */
const FLOW_THEME =
  '[--xy-controls-button-background-color-default:var(--color-surface)] [--xy-controls-button-background-color-hover-default:var(--color-surface-hover)] [--xy-controls-button-color-default:var(--color-foreground)] [--xy-controls-button-border-color-default:var(--color-border)] [--xy-background-pattern-dot-color-default:var(--color-border)] [--xy-background-color-default:transparent]'

export function MeshMap({ topology, selectedKey, onSelect }: MeshMapProps) {
  const t = useUiText()
  // The stock `light` / `dark` class would redefine the theme tokens; follow the admin's mode.
  const { resolvedMode } = useThemeMode()
  const nodes = useMemo<Node[]>(() => {
    const points = layoutMesh(topology.nodes)
    return topology.nodes.map((n) => {
      const p = points.find((pt) => pt.nodeKey === n.nodeKey)
      return {
        id: n.nodeKey,
        position: { x: p?.x ?? 0, y: p?.y ?? 0 },
        type: 'mesh',
        data: { label: n.label, online: n.online, selected: n.nodeKey === selectedKey },
        draggable: false,
        connectable: false,
      }
    })
  }, [topology.nodes, selectedKey])
  const edges = useMemo<Edge[]>(
    () =>
      meshEdges(topology).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'straight',
        style: { stroke: e.stroke, strokeWidth: 2 },
      })),
    [topology],
  )
  return (
    <div
      className="h-full min-h-72 w-full"
      role="img"
      aria-label={t('uiLibrary.deviceMesh.mapLabel', 'Mesh topology map')}
    >
      <ReactFlow
        nodes={nodes}
        nodeTypes={NODE_TYPES}
        colorMode={resolvedMode}
        className={FLOW_THEME}
        edges={edges}
        onNodeClick={(_, node) => onSelect(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
