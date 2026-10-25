/**
 * usePersistedFlowLayout — makes a React Flow diagram draggable AND remembers
 * where the user dropped each node across reloads.
 *
 * Problem it solves: a `<ReactFlow nodes={...}>` given a `nodes` prop but NO
 * `onNodesChange` handler is "controlled" with nowhere to route drag deltas, so
 * nodes snap back and cannot be moved. This hook wires `useNodesState` +
 * `applyNodeChanges` so drags apply, seeds initial positions from the caller's
 * computed layout merged with any localStorage-saved positions, persists a
 * committed drag, and re-syncs fresh node `data` from the caller on every
 * render WITHOUT clobbering a user-dragged position.
 *
 * Topology-change safety: positions are keyed by node id. A node removed from
 * the computed layout is simply not rendered (its stale saved position is
 * ignored); a newly-added node with no saved position falls back to the
 * computed layout.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useNodesState, applyNodeChanges, type Node, type NodeChange } from '@xyflow/react'

interface StoredPosition {
  readonly x: number
  readonly y: number
}

export interface PersistedFlowLayout<NodeType extends Node> {
  readonly nodes: NodeType[]
  readonly onNodesChange: (changes: NodeChange<NodeType>[]) => void
  readonly resetLayout: () => void
}

function isStoredPosition(value: unknown): value is StoredPosition {
  if (typeof value !== 'object' || value === null) return false
  if (!('x' in value) || !('y' in value)) return false
  return typeof value.x === 'number' && typeof value.y === 'number'
}

function loadPositions(storageKey: string): ReadonlyMap<string, StoredPosition> {
  const positions = new Map<string, StoredPosition>()
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) return positions
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return positions
    for (const [id, value] of Object.entries(parsed)) {
      if (isStoredPosition(value)) {
        positions.set(id, { x: value.x, y: value.y })
      }
    }
  } catch (err) {
    console.warn(
      `Failed to parse flow layout from localStorage[${storageKey}]: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return positions
}

function persistPositions(
  storageKey: string,
  positions: ReadonlyMap<string, StoredPosition>,
): void {
  try {
    const record: Record<string, StoredPosition> = {}
    for (const [id, pos] of positions) {
      record[id] = pos
    }
    localStorage.setItem(storageKey, JSON.stringify(record))
  } catch (err) {
    console.warn(
      `Failed to persist flow layout to localStorage[${storageKey}]: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function withSavedPositions<NodeType extends Node>(
  computed: readonly NodeType[],
  saved: ReadonlyMap<string, StoredPosition>,
): NodeType[] {
  return computed.map((node) => {
    const savedPos = saved.get(node.id)
    if (savedPos === undefined) return { ...node }
    return { ...node, position: { x: savedPos.x, y: savedPos.y } }
  })
}

/**
 * Re-sync computed node data while preserving positions: an already-present
 * node keeps its current (possibly user-dragged) position; a fresh node adopts
 * its saved position if any, else the computed one.
 */
function reconcile<NodeType extends Node>(
  prev: readonly NodeType[],
  computed: readonly NodeType[],
  saved: ReadonlyMap<string, StoredPosition>,
): NodeType[] {
  const prevById = new Map(prev.map((node) => [node.id, node]))
  return computed.map((node) => {
    const existing = prevById.get(node.id)
    if (existing !== undefined) {
      return { ...node, position: existing.position }
    }
    const savedPos = saved.get(node.id)
    if (savedPos !== undefined) {
      return { ...node, position: { x: savedPos.x, y: savedPos.y } }
    }
    return { ...node }
  })
}

function isPositionCommit<NodeType extends Node>(change: NodeChange<NodeType>): boolean {
  return change.type === 'position' && change.dragging === false
}

export function usePersistedFlowLayout<NodeType extends Node>(
  storageKey: string,
  computedNodes: readonly NodeType[],
): PersistedFlowLayout<NodeType> {
  const savedRef = useRef<ReadonlyMap<string, StoredPosition>>(loadPositions(storageKey))
  const computedRef = useRef<readonly NodeType[]>(computedNodes)
  computedRef.current = computedNodes

  const [nodes, setNodes] = useNodesState<NodeType>(
    withSavedPositions(computedNodes, savedRef.current),
  )

  useEffect(() => {
    setNodes((prev) => reconcile(prev, computedNodes, savedRef.current))
  }, [computedNodes, setNodes])

  const onNodesChange = useCallback(
    (changes: NodeChange<NodeType>[]): void => {
      setNodes((current) => {
        const next = applyNodeChanges(changes, current)
        if (changes.some(isPositionCommit)) {
          const positions = new Map<string, StoredPosition>()
          for (const node of next) {
            positions.set(node.id, { x: node.position.x, y: node.position.y })
          }
          savedRef.current = positions
          persistPositions(storageKey, positions)
        }
        return next
      })
    },
    [setNodes, storageKey],
  )

  const resetLayout = useCallback((): void => {
    savedRef.current = new Map()
    try {
      localStorage.removeItem(storageKey)
    } catch (err) {
      console.warn(
        `Failed to clear flow layout from localStorage[${storageKey}]: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    setNodes(withSavedPositions(computedRef.current, new Map()))
  }, [setNodes, storageKey])

  return { nodes, onNodesChange, resetLayout }
}
