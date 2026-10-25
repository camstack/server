import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { Node, NodeChange } from '@xyflow/react'
import { usePersistedFlowLayout } from '../use-persisted-flow-layout'

const KEY = 'test-flow-layout'

function makeNodes(): Node[] {
  return [
    { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } },
    { id: 'b', position: { x: 100, y: 0 }, data: { label: 'B' } },
  ]
}

function positionCommit(id: string, x: number, y: number): NodeChange {
  return { id, type: 'position', position: { x, y }, dragging: false }
}

describe('usePersistedFlowLayout', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('seeds node positions from the computed layout', () => {
    const nodes = makeNodes()
    const { result } = renderHook(() => usePersistedFlowLayout(KEY, nodes))
    expect(result.current.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 0, y: 0 })
    expect(result.current.nodes.find((n) => n.id === 'b')?.position).toEqual({ x: 100, y: 0 })
  })

  it('applies a committed drag and persists it to localStorage', () => {
    const nodes = makeNodes()
    const { result } = renderHook(() => usePersistedFlowLayout(KEY, nodes))

    act(() => {
      result.current.onNodesChange([positionCommit('a', 42, 24)])
    })

    expect(result.current.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 42, y: 24 })
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    expect(stored).toMatchObject({ a: { x: 42, y: 24 } })
  })

  it('re-hydrates a saved drag on a fresh mount (saved position wins)', () => {
    localStorage.setItem(KEY, JSON.stringify({ a: { x: 42, y: 24 } }))
    const nodes = makeNodes()
    const { result } = renderHook(() => usePersistedFlowLayout(KEY, nodes))
    // 'a' adopts the saved position; 'b' (no saved position) falls back to computed.
    expect(result.current.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 42, y: 24 })
    expect(result.current.nodes.find((n) => n.id === 'b')?.position).toEqual({ x: 100, y: 0 })
  })

  it('resetLayout clears saved positions and restores the computed layout', () => {
    const nodes = makeNodes()
    const { result } = renderHook(() => usePersistedFlowLayout(KEY, nodes))

    act(() => {
      result.current.onNodesChange([positionCommit('a', 5, 5)])
    })
    expect(result.current.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 5, y: 5 })

    act(() => {
      result.current.resetLayout()
    })
    expect(result.current.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 0, y: 0 })
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('ignores a saved position for a node absent from the computed layout', () => {
    localStorage.setItem(KEY, JSON.stringify({ ghost: { x: 9, y: 9 }, a: { x: 3, y: 3 } }))
    const nodes = makeNodes()
    const { result } = renderHook(() => usePersistedFlowLayout(KEY, nodes))
    expect(result.current.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(result.current.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 3, y: 3 })
  })
})
